# BN Smart Money Tracker

把 Binance Futures「聰明錢」訊號 + 訂單簿 / 大單 / 鏈上持有人結構，每 15 分鐘抓一次、寫進 Cloudflare R2，前端純 static 從 Worker 讀。

線上版：以這個 repo 的 GitHub Pages 部署為準。

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
│            └─ write to R2 bucket `smart-money-data`            │
│                                                                │
│    fetch handler (CORS-enabled JSON proxy)                     │
│      GET /data/symbols.json                                    │
│      GET /data/<short>/prev_row.json                           │
│      GET /data/<short>/history_full.json                       │
│      GET /run    (manual trigger)                              │
└──────────────────────────────┬─────────────────────────────────┘
                               │ R2 binding
                               ▼
                  ┌────────────────────────────┐
                  │  R2 bucket: smart-money-   │
                  │  data                      │
                  │   <SYMBOL>/prev_row.json   │
                  │   <SYMBOL>/history_full.   │
                  │   json (≤3000 筆)          │
                  │   symbols.json             │
                  │   meta.json                │
                  └────────────────────────────┘
                               ▲
                               │ fetch (CORS)
                  ┌────────────┴───────────┐
                  │  Browser (static SPA)  │
                  │  index.html            │
                  │  lightweight-charts    │
                  └────────────────────────┘
```

- **無後端 server / 無 GH Actions**：原本是 server cron + git push + GH Pages 讀 repo `data/`；現在改成 CF Worker cron + R2 物件儲存
- **環形緩衝**：每個 `history_full.json` 最多 3000 筆 ≈ 31 天（15 分鐘間隔）
- **CORS / cache**：Worker `/data/*` 路由附 `Access-Control-Allow-Origin: *` 和 `Cache-Control: public, max-age=30`

線上 Worker URL：`https://smart-money-collector.andychien-design.workers.dev`

---

## 檔案結構

```
.
├── index.html                          # 前端（單檔，純 vanilla JS）
├── smart-money-collector/              # Cloudflare Worker
│   ├── src/index.ts                    # scheduled + fetch handler
│   ├── wrangler.jsonc                  # cron + R2 binding 設定
│   ├── package.json
│   └── tsconfig.json
├── data/                               # （舊）Python collector 留下的歷史 JSON
└── server/                             # （舊）Flask 備用版，未啟用
```

舊的 `scripts/` Python collector 跟 `.github/workflows/collect.yml` 已移除（被 Worker 取代）。`data/` 跟 `server/` 是舊架構遺物，可以保留當 archive。

---

## 本機開發

### 前端

```bash
cd BN_Smart_Money_Tracker
python3 -m http.server 8000
# 開 http://localhost:8000
```

`index.html` 用 `DATA_BASE` 指向線上 Worker，所以本機開頁面也能看到即時資料。

### Worker

```bash
cd smart-money-collector
npx wrangler login                # 首次
npx wrangler dev --remote         # 跑在 CF edge，用真實 R2
```

dev server 起來後：
- `curl http://localhost:8787/run` — 手動觸發一次完整收集
- `curl "http://localhost:8787/__scheduled?cron=*/15+*+*+*+*"` — 模擬 cron 觸發

⚠️ `wrangler dev --remote` 的 R2 binding 是**真實 bucket**（不是沙盒），會寫入 production 資料。

### 直接查 R2

```bash
npx wrangler r2 object get smart-money-data/symbols.json --remote --pipe | jq
npx wrangler r2 object get smart-money-data/RIVERUSDT/prev_row.json --remote --pipe | jq
```

⚠️ 一定要加 `--remote`，預設是 `--local`（會撈本機 miniflare sandbox，永遠 not found）。

### Worker logs

```bash
cd smart-money-collector
npx wrangler tail
```

---

## 部署

```bash
cd smart-money-collector
npx wrangler deploy
```

Deploy 後 cron 自動上線，下一個 `*/15` 整點就會跑。R2 bucket `smart-money-data` 需事先建好。

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

編 [index.html](index.html) 裡的 `HIDDEN_SYMBOLS`：

```js
const HIDDEN_SYMBOLS = new Set(['siren','lit']);  // 短名
```

資料採集不受影響。

---

## 狀態檢查

```bash
curl https://smart-money-collector.andychien-design.workers.dev/data/symbols.json | jq
```

每筆 `last_ts` 距現在應該不超過 15 分鐘（UTC+8 字串格式 `YYYY-MM-DD HH:MM`）。
