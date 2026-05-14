# BN Smart Money Tracker

把 Binance Futures「聰明錢」訊號 + 訂單簿 / 大單 / 鏈上持有人結構，每 15 分鐘抓一次、寫進 Cloudflare R2，前端純 static 從 Worker 讀。

線上版：[https://smart-money-collector.andychien-design.workers.dev/](https://smart-money-collector.andychien-design.workers.dev/) — 前端 SPA 與 API 都由同一個 Cloudflare Worker 提供（static assets 走 `assets` binding，資料走 `/data/*` 路由）。

---

## 目前追蹤的 Symbol

| Symbol | CEX | 鏈上資料 |
|---|---|---|
| RIVER/USDT | ✅ | BSC |
| BTC/USDT | ✅ | — |
| ETH/USDT | ✅ | — |
| SOL/USDT | ✅ | — |

要加減 symbol 見下方「新增 symbol」。

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
│      └─ scheduled handler                                      │
│            ├─ fetch 3 binance hosts × 4 symbols                │
│            │   (透過 Mac proxy，見下)                          │
│            └─ write to R2 bucket `smart-money-data`            │
│                                                                │
│    fetch handler (CORS-enabled JSON proxy)                     │
│      GET /data/symbols.json                                    │
│      GET /data/<short>/prev_row.json                           │
│      GET /data/<short>/history_full.json                       │
│      GET /run    (manual trigger)                              │
└────┬──────────────────────────────────────────────┬────────────┘
     │ R2 binding                                   │ outbound fetch
     ▼                                              ▼
┌────────────────────────┐    ┌─────────────────────────────────┐
│ R2: smart-money-data   │    │ Cloudflare Tunnel               │
│  <SYMBOL>/prev_row     │    │ <id>.trycloudflare.com          │
│  <SYMBOL>/history_full │    └────────────────┬────────────────┘
│  symbols.json          │                     │ cloudflared
│  meta.json             │                     ▼
└──────────┬─────────────┘    ┌─────────────────────────────────┐
           ▲                  │ Mac proxy (mac-proxy/proxy.mjs) │
           │ fetch (CORS)     │ 127.0.0.1:8787                  │
┌──────────┴───────────┐      └────────────────┬────────────────┘
│ Browser (static SPA) │                       │
│  index.html          │                       ▼
│  lightweight-charts  │              ┌─────────────────┐
└──────────────────────┘              │ binance.com APIs│
                                      └─────────────────┘
```

- **無後端 server / 無 GH Actions**：原本是 server cron + git push + GH Pages 讀 repo `data/`；現在改成 CF Worker cron + R2 物件儲存
- **Mac proxy 中繼**：Binance 從 2026-05-13 起對 CF edge IP 回 451，所以 Worker 不直接打 Binance，改走 CF Tunnel → 本機 Mac proxy → Binance。詳見 [mac-proxy/README.md](mac-proxy/README.md)
- **環形緩衝**：每個 `history_full.json` 最多 3000 筆 ≈ 31 天（15 分鐘間隔）
- **CORS / cache**：Worker `/data/*` 路由附 `Access-Control-Allow-Origin: *` 和 `Cache-Control: public, max-age=30`

---

## 檔案結構

```
.
├── smart-money-collector/              # Cloudflare Worker（含前端 SPA）
│   ├── src/index.ts                    # scheduled handler + /data/* + /run
│   ├── public/index.html               # 前端（單檔，純 vanilla JS + lightweight-charts）
│   ├── scripts/seed-local-r2.sh        # 把線上 R2 抓回本機 miniflare（dev 用）
│   ├── wrangler.jsonc                  # cron + R2 binding + assets 設定
│   ├── package.json
│   └── tsconfig.json
├── mac-proxy/                          # 本機 proxy + CF Tunnel（繞 Binance 451）
│   ├── proxy.mjs                       # Node HTTP proxy
│   ├── start.sh / stop.sh              # 一鍵啟動 / 停止
│   └── README.md                       # 操作說明（必讀）
├── data/                               # （舊）Python collector 留下的歷史 JSON
├── scripts/                            # （舊）Python collector 的 shell wrapper
└── server/                             # （舊）Flask 備用版，未啟用
```

`.github/workflows/collect.yml`（舊 GH Actions cron）已移除，被 Worker cron 取代。`data/`、`scripts/`、`server/` 是 Python collector 時代的遺物，目前沒在用，保留當 archive。

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

⚠️ Worker 依賴兩個 secret：`PROXY_BASE`（Mac tunnel URL）、`PROXY_TOKEN`（proxy 驗證密鑰）。詳見 [mac-proxy/README.md](mac-proxy/README.md)。

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

編 [smart-money-collector/public/index.html](smart-money-collector/public/index.html) 裡的 `HIDDEN_SYMBOLS`：

```js
const HIDDEN_SYMBOLS = new Set(['siren','lit']);  // 短名
```

資料採集不受影響。改完 `npm run deploy` 上線。

---

## 狀態檢查

```bash
curl https://smart-money-collector.andychien-design.workers.dev/data/symbols.json | jq
```

每筆 `last_ts` 距現在應該不超過 15 分鐘（UTC+8 字串格式 `YYYY-MM-DD HH:MM`）。

如果出現 `has_data: false`，看 `error` 欄判斷：
- `HTTP 451` — Binance 又開始封 CF edge IP（極少見，目前已經透過 mac-proxy 繞過）
- `HTTP 530` — Cloudflare 連不到 Mac proxy（tunnel 死了 / cloudflared 進 reconnect loop）
- `HTTP 5xx` from Binance — Binance 短暫故障，下個 cron 通常會恢復

恢復方式 → 詳見 [mac-proxy/README.md](mac-proxy/README.md) 的「Mac 重開機 / cloudflared 掛了之後恢復」（直接跑 `mac-proxy/start.sh`）。
