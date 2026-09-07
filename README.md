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
| ZEC/USDT | ✅ | — |
| MARSCOIN/USDT | ✅ | — |

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
│  alerts/recent.json    │    │                                 │
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

⚠️ **超過 10ms 不一定會立刻失敗**，所以不能用「沒掛掉」判斷安全。[官方文件](https://developers.cloudflare.com/workers/platform/limits/#cpu-time)：每個 isolate 有內建彈性容忍*偶爾*超標，但「If your Worker starts hitting the limit **consistently**, its execution will be terminated」。也就是說穩定超標的 invocation 是在寬限期內跑，隨時可能被開始終止。

**實測（2026-08-30 21:00，`wrangler tail`，`BATCH_SIZE = 1`）**：

| invocation | CPU | 說明 |
|---|---|---|
| cron orchestrator | 5ms | fan-out 8 batch + symbols.json |
| `/collect`（RIVER，batch 0） | **12ms** | ⚠️ 仍超標，見下 |
| `/collect`（BTC，batch 1） | 8-10ms | |
| `/collect`（其餘 6 個） | 5-6ms | |
| `/alerts`（8 symbols，state 15.5KB） | 5ms | 含 parse + z-score + stringify。拆掉 `recent` 前是 25.6KB / 9ms |

舊實測（2026-08-10，`BATCH_SIZE = 3`）是 13ms / 14ms，由 1 symbol 7ms、3 symbols 13.5ms 反推：固定開銷約 3.75ms，每個 symbol 約 3.25ms。`BATCH_SIZE = 3` 因此註定落在 13ms 附近。主因是 `appendDayShard` 讀回當日 shard 再字串串接寫回 —— 當日檔案隨時間變大，所以**同一份程式碼在深夜的 CPU 會比清晨高**，這正是下面那條設計準則要避免的 pattern，只是被 sharding 縮小到「單日」而非消除。

⚠️ **`BATCH_SIZE` 是這個專案最危險的一個常數**。調大它會等比放大每個 invocation 的 CPU，而超標不會立刻報錯（見上），所以改完當下看起來永遠是好的 —— 代價會在幾週後以整片停機的形式出現。見下方 2026-08-30 事故。

⚠️ batch 0 / batch 1 目前仍在 10-12ms。同一個 symbol 換到後面的 batch 就只要 5-6ms，所以這不是 RIVER 或 BTC 本身貴，而是**先抵達的 invocation 承擔了 isolate 初始化**。目前 8 個裡有 1-2 個超標（事故前是 3 個全超），靠寬限在跑，還沒解決。

歷史教訓（2026-05-14）：原本 cron 每次都 `JSON.parse` ~1.8MB 的 `history_full.json` 再 `JSON.stringify` 寫回 R2，當 history 累積到 3000 筆上限後，CPU 穩定超過 10ms，cron 連續失敗 10 次。改成每日 NDJSON 分片（純文字 append，當日檔 ≤ ~60KB）後 CPU 壓到 ms 級。

歷史教訓（2026-08-30，停機 5 小時）：上面那條「穩定超標隨時可能被開始終止」的警告在 8/10 就寫下了，8/30 15:15 兌現。Cloudflare 開始實際執行 10ms 上限，`BATCH_SIZE = 3` 的三個 `/collect` 全部 `outcome: exceededCpu` 被終止，orchestrator 從 service binding 收到 `HTTP 503`，連續 20 輪 cron 顆粒無收，直到 20:45 改成 `BATCH_SIZE = 1` 才恢復。

這次事故的三個 debug 陷阱，下次可以少走：

1. **外層全綠不代表沒事**。DO proxy `/health` 200、Caddy 正常、Binance 直連 200 —— 因為斷點在 Worker 內部，proxy 那層根本沒被打到。
2. **手動 `/run` 會成功，cron 卻失敗**。同一份程式碼、同一條路徑，差別只在 isolate 對*偶爾*超標的寬限：手動觸發是孤立的一次，落在寬限內；cron 每 15 分鐘固定超標，被判定為 consistently 而持續終止。所以「我手動打過了，是好的」不能用來排除 CPU 問題。
3. **`error` 欄的 `HTTP 503` 不在 proxy 的錯誤對照表裡**，它來自 `env.SELF.fetch`，是 Worker 打自己。錯誤訊息不帶 URL（`Error: HTTP 503`）就是這個來源的特徵 —— 帶 URL 的才是 Binance 那層（`fetchJson` 會附上）。

唯一能直接看到真相的是 `npx wrangler tail --format=json` 裡的 `outcome` 欄位，`exceededCpu` 寫得清清楚楚。狀態不明時先開 tail 等一輪 cron，比從外往內猜快得多。

**未來新功能設計準則**：cron 內**避免**讀 → parse → modify → stringify → 寫回的「讀寫大物件」pattern，尤其是會隨時間增長的累積資料。改用 append-only 或 sharding。

`alerts/state.json` 曾經是這個 pattern 的第二個實例：25.6KB，`/alerts` 跑到 9ms。其中 39%（10.1KB）是 `recent` 這份已觸發紀錄 —— 偵測邏輯從不讀它、只在觸發時 prepend，但它卻跟著被每 15 分鐘 parse + stringify 一次，一天 96 次，只為了大約 2 次的寫入。2026-08-30 把它拆成獨立的 `alerts/recent.json`，只在真的觸發的那一輪才讀寫，state 降到 15.5KB、CPU 降到 5ms。**判斷準則**：問「這個欄位在每次 cron 都會被讀嗎？」不會的話它就不該待在熱路徑的物件裡。

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

訊息長這樣（一輪只推一則，多個 symbol 分組）：

```
🔔 聰明錢異動 · 2026-08-11 14:15 (UTC+8)

🚨 LIT/USDT  $2.2947  -0.4% 24h
   多空比突破 2.0 0.6300 → 2.3790  (+1.749)

📈 BEAT/USDT  $2.6950  -21.3% 24h
   多單持倉 $3.90M → $5.20M  (+33.3%, 4.2σ)
   空單持倉 $2.99M → $2.10M  (-29.8%, 3.9σ)

開啟 dashboard
```

### 訊號怎麼判定

有兩種訊號，機制完全不同：**變化**（這個幣動得比平常劇烈）與**水位**（這個幣到了值得動作的位置）。

#### 1. 變化訊號 — 相對自己的波動

**門檻是相對於該 symbol 自己的波動，不是固定值。** 固定門檻在這個追蹤清單上必定失敗：BTC 的多空比幾乎不動，小幣整天在跳，同一個數字不是讓 LAB 洗版就是讓 BTC 永遠不響。

對每個 symbol 各自維護 24 小時（96 筆）的滾動窗口，算出「這個 symbol 的 15 分鐘變化量」的標準差，當前這一筆超過 **3.8σ** 才算異動。三個指標各自獨立判斷、各自冷卻：

| 指標 | 來源欄位 | 計分方式 | 絕對下限 |
|---|---|---|---|
| 多空比 | `sm_ls_ratio` | 絕對變化量 | ≥ 0.18 |
| 多單持倉 | `sm_long_pos_usdt` | 百分比變化 | ≥ 13% 且該邊 ≥ $0.5M |
| 空單持倉 | `sm_short_pos_usdt` | 百分比變化 | 同上 |

持倉用百分比是因為它的量級會差好幾個數量級；多空比本身是個比值，用絕對變化才有意義。

#### 2. 水位訊號（gate）— 小幣多空比突破 2.0

小幣的多空比站上 2 是值得動作的位置，**不管它是急拉上去還是慢慢磨上去的** —— 這是變化訊號抓不到的東西，所以獨立成一條規則。只看 `GATE_SYMBOLS`（river / lit / lab / beat / marscoin），不看 BTC/ETH/SOL：這訊號講的是小幣，而大盤穿越 2 太頻繁（BTC 有 29% 的時間在 2 以上）會把它淹掉。

兩個關鍵設計，都是被實際資料逼出來的：

- **看「跨越」不看「狀態」**：BEAT 有 **69%** 的時間待在 2 以上，用狀態判斷會每 15 分鐘報一次。只有「前一筆 < 2.0 且這一筆 ≥ 2.0」才算
- **跨越必須有幅度**（`GATE_MIN_DELTA` = 0.10）：101 天裡的 23 次原始跨越，超過一半是 `1.996 → 2.005` 這種在門檻線上抖動。用「單步漲幅」而不是「起點要夠低」來擋，是因為後者會漏掉 `1.999 → 4.200` 這種從邊緣直接暴衝的最大事件

gate 有自己的 12 小時冷卻，且**不需要暖機、不受收集中斷影響**（只比對前後兩筆，跨越 2 就是跨越 2）—— 新加的 symbol 隔天就受保護。同一輪若 gate 命中，會跳過該 symbol 的多空比變化檢查，兩者講的是同一件事。

### 防洗版的關卡

1. **絕對下限**：見上表。波動極小的 symbol 標準差會很小，任何抖動都算「幾十個 σ」，這道關卡把統計上很大但實質沒意義的變動擋掉
2. **冷卻期**：變化訊號同 symbol 同指標 **8 小時**、gate **12 小時**
3. **合併推播**：一輪觸發的所有訊號合成一則訊息，按 symbol 分組；gate 命中永遠排在最前面（它的 z 是 0，不排除的話會沉到最後）
4. **暖機期**：變化訊號要累積滿 8 小時（32 筆）才開始判斷；`/alerts/backfill` 可從 R2 既有資料直接補滿。gate 不受此限

另外收集中斷超過 40 分鐘（漏掉 2 次以上 cron）時，那一筆的變化量橫跨的時間跟建立標準差時的 15 分鐘不可比，會照常存進窗口但跳過該輪的**變化**評分（gate 仍照常）。

### 參數調整

全部集中在 `src/alerts.ts` 最上方的 tuning 區塊。觀察觸發頻率用 `GET /data/alerts.json`（最近 50 筆，含當時的 z 值）。

**調參數前先回測，不要用猜的。** 完整歷史可以從 `/data/<short>/days/*.ndjson` 拉下來（截至 2026-08-11 約 6 萬筆，涵蓋 5 月起），在本機重跑判斷邏輯就能算出任一組參數的實際通知量。這比事後觀察快得多，也避免了兩個真實踩過的坑：

- **樣本太短會得到相反的結論**：只看 3 天資料時，7 個幣沒有任何一個多空比超過 2，差點據此判定「突破 2」這個條件不可行；拉到 101 天後發現每個幣都超過 2 過，BTC 甚至到過 12.11
- **只看統計不看實際幅度會設錯門檻**：持倉下限一度從 10% 降到 3%，理由是「10% 讓 z-score 形同虛設」。實跑之後每天 8 則，因為 BTC/ETH 這種大盤 σ 很小，4% 的持倉變化就算 6σ —— 統計上反常，實際上沒有通知價值

現行參數（2026-08-11 定）回測結果約 **1.83 則/天**，其中 gate 佔 0.13 則/天（101 天 13 次）。

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

5. 從既有歷史補滿窗口，免得等 8 小時（一次一個 symbol，每個會補到 96 筆）：

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

`PROXY_TOKEN` 的值在本機 [proxy/.env](proxy/.env)（被 `proxy/.gitignore` 忽略，不在 repo 裡），DO 上則是 `/root/.openclaw/workspace/mac-proxy/.env` 的 `PROXY_SECRET`，兩者必須一致。取用時別讓它進到 shell history 或輸出：

```bash
TOKEN=$(grep '^PROXY_SECRET=' proxy/.env | cut -d= -f2-)
```

---

## 狀態檢查

```bash
curl https://smart-money-collector.andychien-design.workers.dev/data/symbols.json | jq
```

每筆 `last_ts` 距現在應該不超過 15 分鐘（UTC+8 字串格式 `YYYY-MM-DD HH:MM`）。

如果出現 `stale: true`，代表這一輪該 symbol 收集失敗，顯示的是上一輪的數字（dashboard 會把它淡化但仍可點）。`last_ts` 會停在上次成功的時間，`error` 欄記錄這輪的失敗原因。偶爾一兩輪屬正常；連續多輪就照下面的 `error` 對照排查。

`has_data: false` 只會出現在「從來沒收集成功過」的 symbol（例如剛加進 `SYMBOLS_META` 還沒跑過第一輪）。看 `error` 欄判斷：
- `Error: HTTP 503`（**不帶 URL**）— 這條不是 proxy 的問題。它來自 `env.SELF.fetch`，代表 `/collect` sub-invocation 被 Cloudflare 以 `exceededCpu` 終止。`wrangler tail` 看 `outcome` 確認，處理方式見上方「Worker CPU 預算」。注意帶 URL 的（`HTTP 503 ... for https://...`）才是下面那些 proxy / Binance 的狀況
- `HTTP 451` — Binance 開始封 DO 那台 IP（可能性低，DO Singapore IP 信譽乾淨）。換掉 DO 那台、或加更多出口
- `HTTP 530` / `HTTP 525` — Caddy 那層問題（cert 沒簽到、systemd 沒啟動）
- `HTTP 502` from proxy — proxy.mjs 連不到 Binance（DNS / network issue），少見
- `HTTP 403` from proxy — Worker `PROXY_TOKEN` 跟 DO `.env` 的 `PROXY_SECRET` 對不上
- `HTTP 5xx` from Binance — Binance 短暫故障，下個 cron 通常會恢復

debug 步驟與恢復方式 → [proxy/README.md](proxy/README.md)。

### 停機自動通知

2026-08-30 的停機之所以能撐五個小時沒被發現，是因為**從外面看什麼事都沒有**：symbols.json 照常回應，只是每筆都掛著 `stale: true`；dashboard 照常渲染上一輪的數字；沒有任何東西會開口。orchestrator 其實一直都知道 `ok` 是多少，只是從來沒說出來。

現在 `notifyOutage()`（[src/index.ts](smart-money-collector/src/index.ts)）會在**整輪全滅**時推 Telegram：

- 只在 `ok === 0` 時推。一兩個 symbol 失敗是常態（見上面的 `error` 對照表），為那個推播只會訓練我們忽略這個頻道
- 還沒好的話每 2 小時重推一次，不是每一輪 —— 五小時的停機是 3 則訊息而不是 20 則
- 恢復時推一則，講停了多久
- 看到不帶 URL 的 `Error: HTTP 503` 會在訊息裡直接點名 CPU 這個成因，因為那是這個系統裡唯一一個「看起來像 proxy 壞掉、其實不是」的錯誤

狀態存在 `alerts/outage.json`，**只在異常時才存在**。正常那一輪就是一次 R2 miss 然後直接 return，所以這個監控在健康路徑上幾乎不花 CPU —— 這點很重要，畢竟 CPU 正是這次的病根。整個函式包在 try/catch 裡：監控壞掉絕不能賠掉那一輪的資料。

沒設 `TG_BOT_TOKEN` / `TG_CHAT_ID` 的話這個功能靜默跳過，收集本身不受影響。

**盲點**：這條路徑靠 cron 有跑才成立。如果 Cloudflare 連 cron 都不觸發了（這次不是這種情況 —— orchestrator 有跑，是它的 `/collect` 全被砍），Worker 就沒有機會開口，那需要外部監控。曾經試過用 Claude Code 的雲端 routine 做這件事，但它的 egress proxy 擋掉了 `*.workers.dev`，連不到自己的端點，所以改走這條路。
