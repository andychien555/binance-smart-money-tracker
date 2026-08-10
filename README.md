# BN Smart Money Tracker

把 Binance Futures「聰明錢」訊號 + 訂單簿 / 大單 / 鏈上持有人結構，每 15 分鐘抓一次、寫進 Cloudflare R2，前端純 static 從 Worker 讀。多空比與持倉出現異常變動時推 Telegram 通知，見「異動通知」。

線上版：[https://smart-money-collector.andychien-design.workers.dev/](https://smart-money-collector.andychien-design.workers.dev/) — 前端 SPA 與 API 都由同一個 Cloudflare Worker 提供（static assets 走 `assets` binding，資料走 `/data/*` 路由）。

---

## 目前追蹤的 Symbol

| Symbol | CEX | 鏈上資料 |
|---|---|---|
| RIVER/USDT | ✅ | BSC |
| BTC/USDT | ✅ | — |
| ETH/USDT | ✅ | — |
| SOL/USDT | ✅ | — |
| LIT/USDT | ✅ | — |
| LAB/USDT | ✅ | — |
| BEAT/USDT | ✅ | — |

要加減 symbol 見下方「新增 symbol」。前端要不要顯示是另一回事，見「隱藏 / 顯示某個 symbol」。

---

## 資料來源

每個 symbol 每 15 分鐘打以下 API：

### 1. Binance Smart Money（futures 衍生品專用）
- `bapi/futures/v1/public/future/smart-money/signal/overview` — 聰明錢即時概況：總交易員 / 多空交易員 / 鯨魚數 / 多空持倉 USDT / 平均開倉價 / 獲利比例 / 多空比
- `.../signal/details/stats?timeRange=30m` — 同樣指標的 30 分鐘變化

### 2. Binance Futures Public API（`fapi.binance.com`，無需 key）
- `/fapi/v1/ticker/24hr` — 價格、24h 漲跌幅、quote 量
- `/fapi/v1/openInterest` — 未平倉量
- `/fapi/v1/fundingRate` — 最新資金費率
- `/futures/data/globalLongShortAccountRatio` — 全市場帳戶多空比（1h）
- `/futures/data/topLongShortPositionRatio` — Top 交易員持倉多空比（1h）
- `/futures/data/takerlongshortRatio` — Taker 主動買賣比（1h）
- `/fapi/v1/depth?limit=20` — 訂單簿前 20 檔 → 算 bid/ask 總量、最大買賣牆、深度比
- `/fapi/v1/aggTrades?limit=200` — 近 200 筆聚合成交 → 大單 / 中單 計數、主動買 / 賣 量

### 3. Binance Web3 Wallet（鏈上代幣資訊）
- `web3.binance.com/bapi/defi/v4/.../market/token/dynamic/info` — 持幣人數、Top 10 集中度、KOL 持有人、Smart Money 持有人、池子流動性
- 只跑在有設定鏈上合約地址的 symbol（目前只有 RIVER）

完整欄位清單 → [smart-money-collector/src/index.ts](smart-money-collector/src/index.ts) 的 `row` 構造處。

---

## 架構

```
┌────────────────────────────────────────────────────────────────┐
│  Cloudflare Worker  (smart-money-collector)                    │
│                                                                │
│    cron trigger: */15 * * * *                                  │
│      └─ scheduled handler (orchestrator)                       │
│            ├─ GET /collect?batch=N  ×3  (self service-binding) │
│            │     └─ fetch 3 binance hosts × 3 symbols          │
│            │         (透過 DO proxy，見下) → R2                │
│            ├─ write symbols.json / meta.json                   │
│            └─ POST /alerts  (self service-binding)             │
│                  └─ z-score 判斷 → Telegram push               │
│                                                                │
│    fetch handler (CORS-enabled JSON proxy)                     │
│      GET /data/symbols.json                                    │
│      GET /data/alerts.json                                     │
│      GET /data/<short>/prev_row.json                           │
│      GET /data/<short>/days/index.json                         │
│      GET /data/<short>/days/<date>.ndjson                      │
│      GET /run    (manual trigger)                              │
└────┬──────────────────────────────────────────────┬────────────┘
     │ R2 binding                                   │ outbound HTTPS
     ▼                                              ▼  (+ Telegram)
┌────────────────────────┐    ┌─────────────────────────────────┐
│ R2: smart-money-data   │    │ DigitalOcean SGP1 (Singapore)   │
│  <SYMBOL>/prev_row     │    │ 167.172.64.49                   │
│  <SYMBOL>/days/index   │    │                                 │
│  <SYMBOL>/days/*.ndjson│    │ Caddy (443, Let's Encrypt)      │
│  symbols.json          │    │   └─ reverse_proxy → :8787      │
│  meta.json             │    │                                 │
│  alerts/state.json     │    │                                 │
           ▲                  │ systemd: binance-proxy.service  │
           │ fetch (CORS)     │   └─ node proxy.mjs (port 8787) │
┌──────────┴───────────┐      └────────────────┬────────────────┘
│ Browser (static SPA) │                       │
│  index.html          │                       ▼
│  lightweight-charts  │              ┌─────────────────┐
└──────────────────────┘              │ binance.com APIs│
                                      └─────────────────┘
```

- **無後端 server / 無 GH Actions**：原本是 server cron + git push + GH Pages 讀 repo `data/`；現在改成 CF Worker cron + R2 物件儲存
- **DO proxy 中繼**：Binance 從 2026-05-13 起對 CF edge anycast IP 回 451，所以 Worker 不直接打 Binance，改走 DO Singapore 機房（IP 信譽乾淨、Binance 200）→ Caddy HTTPS → Node proxy → Binance。詳見 [proxy/README.md](proxy/README.md)
- **每日 NDJSON 分片儲存**：每次 cron 只 append 一筆到當日 `<SYMBOL>/days/<YYYY-MM-DD>.ndjson`（純文字 append，不 parse 全量），歷史永久保留。前端依需要的時間區間決定要讀哪幾天的分片。設計理由見下方「Worker CPU 預算」。
- **CORS / cache**：Worker `/data/*` 路由附 `Access-Control-Allow-Origin: *` 和 `Cache-Control: public, max-age=30`
- **批次 fan-out**：CF Free plan 每次 invocation 上限 50 subrequests，一個 symbol 要 ~10-11 個，全部塞一次會爆。orchestrator 透過 self service-binding 把 symbol 分成每批 3 個各自打 `/collect?batch=N`，每批拿到全新的 subrequest 預算。異動判斷（`POST /alerts`）同理獨立一個 invocation，見下方「異動通知」

### Worker CPU 預算（重要）

Cloudflare Workers Free plan 對 **每次** invocation（cron `scheduled` 與 `fetch` 同等）有 **10ms CPU 上限**，超過會 `outcome: exceededCpu` 並中斷。Wall time（等 API 回應）不算 CPU，但 `JSON.parse` / `JSON.stringify` 大物件算。

歷史教訓（2026-05-14）：原本 cron 每次都 `JSON.parse` ~1.8MB 的 `history_full.json` 再 `JSON.stringify` 寫回 R2，當 history 累積到 3000 筆上限後，CPU 穩定超過 10ms，cron 連續失敗 10 次。改成每日 NDJSON 分片（純文字 append，當日檔 ≤ ~60KB）後 CPU 壓到 ms 級。

**未來新功能設計準則**：cron 內**避免**讀 → parse → modify → stringify → 寫回的「讀寫大物件」pattern，尤其是會隨時間增長的累積資料。改用 append-only 或 sharding。

---

## 檔案結構

```
.
├── smart-money-collector/              # Cloudflare Worker（含前端 SPA）
│   ├── src/index.ts                    # scheduled handler + /data/* + /run
│   ├── src/alerts.ts                   # 異動偵測（z-score）+ Telegram 推播
│   ├── test/alerts.spec.ts             # 偵測邏輯的單元測試（npm test）
│   ├── public/index.html               # 前端（單檔，純 vanilla JS + lightweight-charts）
│   ├── public/v2.html                  # 舊版前端（同一份 symbols.json / NDJSON 資料源）
│   ├── scripts/seed-local-r2.sh        # 把線上 R2 抓回本機 miniflare（dev 用）
│   ├── scripts/*.mjs                   # 一次性 R2 資料 migration（跑完即可留作紀錄）
│   ├── wrangler.jsonc                  # cron + R2 binding + assets 設定
│   ├── package.json
│   └── tsconfig.json
└── proxy/                              # proxy 原始碼（現役部署在 DO Singapore）
    ├── proxy.mjs                       # Node HTTP proxy（同一份在 DO /root/.openclaw/workspace/mac-proxy/）
    ├── start.sh / stop.sh              # 啟停腳本（DO 上用 systemctl 管）
    └── README.md                       # DO 部署 / 操作 / debug（必讀）
```

`.github/workflows/collect.yml`（舊 GH Actions cron）已移除，被 Worker cron 取代。舊 Python collector 時代的遺物（`data/`、`scripts/`、`server/`）已於 2026-06-19 清掉，需要時從 git history 找得回。

> proxy 資料夾原名 `mac-proxy/`（proxy 早期跑在 Mac 上），2026-06-19 改名為 `proxy/`。DO VPS 上的實際路徑仍是 `/root/.openclaw/workspace/mac-proxy/`（未動線上），故下方與 proxy README 中的 DO 操作絕對路徑維持原樣。

---

## 本機開發

前端與 Worker 同一個 process — `wrangler dev` 起來會同時 serve `public/index.html` 與 `/data/*` API。

### Remote 模式（接真實 R2 / 真實 cron）

```bash
cd smart-money-collector
npx wrangler login                # 首次
npm run dev                       # = wrangler dev --remote
# 開 http://localhost:8787 看前端
```

跑起來後：
- `http://localhost:8787/` — 前端 SPA
- `curl http://localhost:8787/run` — 手動觸發一次完整收集
- `curl "http://localhost:8787/__scheduled?cron=*/15+*+*+*+*"` — 模擬 cron 觸發

⚠️ `--remote` 的 R2 binding 是**真實 bucket**（不是 sandbox），手動觸發會寫入 production 資料。

### Local 模式（離線、用 seed 資料）

```bash
cd smart-money-collector
npm run dev:seed                  # 從線上 Worker 抓 symbols.json + 各 symbol 資料寫進 miniflare 本機 R2
npm run dev:local                 # = wrangler dev（純本機，不打 binance / 不寫線上 R2）
```

適合純前端 / Worker 路由的離線開發，不會跑採集也不會動到線上資料。

### 直接查 R2

```bash
npx wrangler r2 object get smart-money-data/symbols.json --remote --pipe | jq
npx wrangler r2 object get smart-money-data/RIVERUSDT/prev_row.json --remote --pipe | jq
# 列出某 symbol 有資料的日期
npx wrangler r2 object get smart-money-data/RIVERUSDT/days/index.json --remote --pipe | jq
# 看某日的 NDJSON（一行一筆）
npx wrangler r2 object get smart-money-data/RIVERUSDT/days/2026-05-14.ndjson --remote --pipe | tail -5
```

⚠️ 一定要加 `--remote`，預設是 `--local`（撈本機 miniflare sandbox，沒 seed 過就 not found）。

### Worker logs

```bash
cd smart-money-collector
npx wrangler tail
```

---

## 部署

```bash
cd smart-money-collector
npm run deploy                    # = wrangler deploy
```

Deploy 會同時上傳 `src/index.ts`（Worker 邏輯）跟 `public/`（前端 assets）。Cron 自動上線，下一個 `*/15` 整點就會跑。R2 bucket `smart-money-data` 需事先建好。

⚠️ Worker 依賴兩個 secret：`PROXY_BASE`（DO HTTPS URL，目前 `https://167.172.64.49.nip.io`）、`PROXY_TOKEN`（proxy 驗證密鑰，同時也是 `/alerts` 系列端點的內部驗證）。詳見 [proxy/README.md](proxy/README.md)。

另有兩個**選用** secret `TG_BOT_TOKEN` / `TG_CHAT_ID`，只影響異動推播，見「異動通知」。

---

## 新增 symbol

編 [smart-money-collector/src/index.ts](smart-money-collector/src/index.ts) 的 `SYMBOLS_META`：

```ts
const SYMBOLS_META: SymbolMeta[] = [
  { symbol: "RIVERUSDT", short: "river", label: "RIVER/USDT",
    onchain: { chain: "56", addr: "0x..." } },
  { symbol: "XXXUSDT",   short: "xxx",   label: "XXX/USDT" },  // 新增
];
```

- `symbol`：Binance futures 上的代號（含 USDT）
- `short`：URL 用的 lowercase id，前端 `currentSymbol` 用這個
- `label`：UI 顯示
- `onchain`（選用）：BSC chain id + 合約地址，沒設就跳過鏈上欄位

加完 `npx wrangler deploy` 上線。前端會自動從 `/data/symbols.json` 拿到新清單，不需要動。

---

## 隱藏 / 顯示某個 symbol

在 [smart-money-collector/src/index.ts](smart-money-collector/src/index.ts) 的 `SYMBOLS_META` 上加 `hidden`：

```ts
{ symbol: "XXXUSDT", short: "xxx", label: "XXX/USDT", hidden: true },
```

這個旗標會被寫進 `symbols.json`，兩份 dashboard（`/` 和 `/v2.html`）都讀同一份，所以只要改這一個地方。資料採集不受影響，`/data/xxx/…` 也照樣提供。改完 `npx wrangler deploy` 上線。

---

## 異動通知（Telegram）

每次收集完，orchestrator 會把這輪的數字丟給 `POST /alerts`（self service-binding，獨立 invocation），偵測到異動就推一則 Telegram 訊息。邏輯全在 [smart-money-collector/src/alerts.ts](smart-money-collector/src/alerts.ts)。

### 訊號怎麼判定

**門檻是相對於該 symbol 自己的波動，不是固定值。** 固定門檻在這個追蹤清單上必定失敗：BTC 的多空比幾乎不動，小幣整天在跳，同一個數字不是讓 LAB 洗版就是讓 BTC 永遠不響。

做法是對每個 symbol 各自維護一個 24 小時（96 筆）的滾動窗口，算出「這個 symbol 的 15 分鐘變化量」的標準差，當前這一筆超過 **2.5σ** 才算異動。追蹤三個指標：

| 指標 | 來源欄位 | 計分方式 |
|---|---|---|
| 多空比 | `sm_ls_ratio` | 絕對變化量 |
| 多單持倉 | `sm_long_pos_usdt` | 百分比變化 |
| 空單持倉 | `sm_short_pos_usdt` | 百分比變化 |

持倉用百分比是因為它的量級會差好幾個數量級；多空比本身是個比值，用絕對變化才有意義。

### 防洗版的四道關卡

1. **絕對下限**：多空比至少變動 0.05、持倉至少 3% 且該邊持倉 ≥ $0.5M。波動極小的 symbol 標準差會很小，任何抖動都算「幾十個 σ」，這道關卡把統計上很大但實質沒意義的變動擋掉。**下限要壓低到讓 σ 保持主導權**：持倉原本設 10%，實測 14 個檢查裡有 12 個由下限直接決定，等於 z-score 形同虛設（BTC 多單的 2.5σ 只有 1.6%，10% 是它 15σ 以上的事件，永遠不會響），2026-08-10 調成 3%
2. **冷卻期**：同一 symbol 同一指標 3 小時內只推一次
3. **合併推播**：一輪觸發的所有訊號合成一則訊息，按 symbol 分組，最強的訊號排最前
4. **暖機期**：累積滿 8 小時（32 筆）歷史才開始判斷；`/alerts/backfill` 可以從 R2 既有資料直接補滿

另外收集中斷超過 40 分鐘（漏掉 2 次以上 cron）時，那一筆的變化量橫跨的時間跟建立標準差時的 15 分鐘不可比，會照常存進窗口但跳過該輪評分。

### 參數調整

全部集中在 `src/alerts.ts` 最上方的 tuning 區塊（`Z_THRESHOLD`、`COOLDOWN_MS`、`MIN_LS_DELTA`、`MIN_POS_PCT`、`MIN_POS_USDT`、`WINDOW`）。

觀察觸發頻率用 `GET /data/alerts.json`，會列出最近 50 筆觸發記錄含當時的 z 值 — 這是調參數的依據。太吵就調高 `Z_THRESHOLD` 或拉長冷卻，太安靜就反過來。

### 設定步驟

1. Telegram 上找 [@BotFather](https://t.me/BotFather) → `/newbot` → 拿到 bot token
2. 拿 `chat.id`（`<TOKEN>` 直接替換掉，**不要留角括號**，`%3C...%3E` 是角括號被 URL 編碼的結果）：
   - **推到個人對話**：先傳一句話給自己的 bot，再開 `https://api.telegram.org/bot<TOKEN>/getUpdates`，取 `chat.id`（正數）
   - **推到群組**：把 bot 加進群組後，開 `https://api.telegram.org/bot<TOKEN>/getUpdates?allowed_updates=["my_chat_member"]`，取 `chat.id`（負數）。**`allowed_updates` 不能省** — bot 預設隱私模式（`can_read_all_group_messages: false`）讀不到群組裡的一般訊息，不指定的話 `getUpdates` 會是空的。隱私模式不影響發送，維持關閉狀態即可
   - 群組**建議用 supergroup**：一般群組升級成 supergroup 時 `chat.id` 會從 `-123456789` 變成 `-100` 開頭的長數字，舊 ID 失效、推播會靜默中斷
3. 設 secret 並部署：

```bash
cd smart-money-collector
npx wrangler secret put TG_BOT_TOKEN
npx wrangler secret put TG_CHAT_ID
npm run deploy
```

4. 測推播通道（`PROXY_TOKEN` 是既有的 proxy 密鑰）：

```bash
curl -H "x-internal-token: <PROXY_TOKEN>" \
  https://smart-money-collector.andychien-design.workers.dev/alerts/test
```

5. 從既有歷史補滿窗口，免得等 8 小時（一次一個 symbol）：

```bash
for s in river btc eth sol lit lab beat; do
  curl -H "x-internal-token: <PROXY_TOKEN>" \
    "https://smart-money-collector.andychien-design.workers.dev/alerts/backfill?symbol=$s"
done
```

兩個 TG secret **是選用的**：沒設的話異動照樣偵測、照樣寫進 `/data/alerts.json`，只是不推播。想先觀察一陣子訊號品質再開推播的話，可以先不設。

### 相關端點

| 端點 | 用途 |
|---|---|
| `GET /data/alerts.json` | 最近 50 筆觸發記錄，新的在前 |
| `POST /alerts` | 內部 fan-out 目標，需 `x-internal-token` |
| `GET /alerts/backfill?symbol=<short>` | 從 R2 既有分片補滿某 symbol 的窗口，需 token |
| `GET /alerts/test` | 送一則測試訊息確認 TG 通道，需 token |

`/alerts` 系列都要 `x-internal-token: <PROXY_TOKEN>`：不擋的話任何人都能灌假資料進滾動窗口，或是拿你的 bot 洗版。

---

## 狀態檢查

```bash
curl https://smart-money-collector.andychien-design.workers.dev/data/symbols.json | jq
```

每筆 `last_ts` 距現在應該不超過 15 分鐘（UTC+8 字串格式 `YYYY-MM-DD HH:MM`）。

如果出現 `stale: true`，代表這一輪該 symbol 收集失敗，顯示的是上一輪的數字（dashboard 會把它淡化但仍可點）。`last_ts` 會停在上次成功的時間，`error` 欄記錄這輪的失敗原因。偶爾一兩輪屬正常；連續多輪就照下面的 `error` 對照排查。

`has_data: false` 只會出現在「從來沒收集成功過」的 symbol（例如剛加進 `SYMBOLS_META` 還沒跑過第一輪）。看 `error` 欄判斷：
- `HTTP 451` — Binance 開始封 DO 那台 IP（可能性低，DO Singapore IP 信譽乾淨）。換掉 DO 那台、或加更多出口
- `HTTP 530` / `HTTP 525` — Caddy 那層問題（cert 沒簽到、systemd 沒啟動）
- `HTTP 502` from proxy — proxy.mjs 連不到 Binance（DNS / network issue），少見
- `HTTP 403` from proxy — Worker `PROXY_TOKEN` 跟 DO `.env` 的 `PROXY_SECRET` 對不上
- `HTTP 5xx` from Binance — Binance 短暫故障，下個 cron 通常會恢復

debug 步驟與恢復方式 → [proxy/README.md](proxy/README.md)。
