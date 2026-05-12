# BN Smart Money Tracker

把 Binance Futures「聰明錢」訊號 + 訂單簿 / 大單 / 鏈上持有人結構，每 15 分鐘抓一次、寫成 JSON、推到 GitHub Pages 上做純前端視覺化。

線上版：以這個 repo 的 GitHub Pages 部署為準。

---

## 目前追蹤的 Symbol

| Symbol | CEX | 鏈上資料 | 前端顯示 |
|---|---|---|---|
| RIVER | ✅ | BSC | ✅ |
| BTC | ✅ | — | ✅ |
| ETH | ✅ | — | ✅ |
| SOL | ✅ | — | ✅ |
| SIREN | ✅ | BSC | 🙈 隱藏 |
| LIT | ✅ | BSC | 🙈 隱藏 |
| RAVE | ✅ | ETH | 🙈 隱藏 |
| PIPPIN | ✅ | — | 🙈 隱藏 |
| BEAT | ✅ | BSC | 🙈 隱藏 |
| POWER | ✅ | BSC | 🙈 隱藏 |

> 「隱藏」= 資料還是會抓並寫進 `data/`，只是前端按鈕列不顯示。要解除請編 [index.html](index.html) 的 `HIDDEN_SYMBOLS`。

---

## 資料來源

每個 symbol 每次收集會打以下幾個 API：

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
- 只跑在有設定鏈上合約地址的 symbol（見 `ONCHAIN_CONFIG`）

### 4. OKX DEX（透過本機 `onchainos` CLI）
- `onchainos token price-info <addr> --chain bsc` — 鏈上 5m / 1h / 4h 價格變化、交易筆數、量、24h 高低
- 同樣只跑鏈上幣

完整欄位清單 → [scripts/multi-collect.py](scripts/multi-collect.py)。

---

## 架構

```
┌────────────────────────────────────────────────────────────────┐
│  Server  (/root/.openclaw/workspace/)                          │
│                                                                │
│    cron: */15 * * * *                                          │
│      └─ multi-collect.py --all   ──► data/<sym>/*.json         │
│      └─ push-data.sh             ──► git commit + push         │
│                                                                │
└──────────────────────────────┬─────────────────────────────────┘
                               │ git push (squash 每 20 commits)
                               ▼
                  ┌────────────────────────┐
                  │  GitHub repo (main)    │
                  │   data/<sym>/*.json    │
                  │   data/symbols.json    │
                  │   index.html           │
                  └───────────┬────────────┘
                              │ GitHub Pages
                              ▼
                  ┌────────────────────────┐
                  │  Browser (static SPA)  │
                  │  lightweight-charts    │
                  └────────────────────────┘
```

- **無後端**：前端 `index.html` 直接 `fetch('data/<sym>/history_full.json')`，沒有 API server
- **環形緩衝**：每個 `history_full.json` 最多 3000 筆 ≈ 31 天（15 分鐘間隔）
- **Git 防膨脹**：[scripts/push-data.sh](scripts/push-data.sh) 超過 20 個 commit 就 orphan squash 後 force push

---

## 檔案結構

```
.
├── index.html                 # 前端（單檔，純 vanilla JS）
├── data/
│   ├── symbols.json           # 符號清單 + 最新價（push-data.sh 重生）
│   └── <symbol>/
│       ├── history_full.json  # 環形緩衝 ≤3000 筆
│       └── prev_row.json      # 最近一筆
├── scripts/
│   ├── multi-collect.py       # 抓資料、寫 JSON
│   ├── push-data.sh           # 複製 + commit + push
│   └── startup.sh             # 容器開機自啟（設 cron + 首次收集）
└── server/
    ├── app.py                 # 備用 Flask 版（目前未啟用）
    └── start.sh
```

---

## 本機開發

前端是純 static，直接起個 static server：

```bash
cd BN_Smart_Money_Tracker
python3 -m http.server 8000
# 開 http://localhost:8000
```

頁面會直接讀 repo 裡的 `data/*.json`，所以你看到的就是最近一次伺服器 push 的快照。

> ⚠️ [scripts/multi-collect.py](scripts/multi-collect.py) 的 `BASE_DIR` 寫死 `/root/.openclaw/workspace/data`，只能在採集伺服器上跑。要在本機抓資料的話需先改路徑。

---

## 隱藏 / 顯示某個 symbol

編 [index.html](index.html)：

```js
const HIDDEN_SYMBOLS = new Set(['siren','lit','rave','pippin','beat','power']);
```

加減就好，資料採集不受影響。

---

## 新增 symbol

1. 在 [scripts/multi-collect.py](scripts/multi-collect.py) 的 `ALL_SYMBOLS` 加上 `XXXUSDT`
2. 如果有鏈上資料，在 `ONCHAIN_CONFIG` 加 `bsc_addr` + `bsc_chain`
3. 在 [scripts/push-data.sh](scripts/push-data.sh) 的 `SYMBOLS` 跟 inline python 的 list 都加上小寫名
4. 等下次 cron 跑（或手動跑 `startup.sh`）

---

## 狀態檢查

最近一次採集時間：看 `data/<symbol>/prev_row.json` 的 `timestamp` 欄位（格式 `YYYY-MM-DD HH:MM`，時區 UTC+8）。

```bash
python3 -c "import json; print(json.load(open('data/river/prev_row.json'))['timestamp'])"
```

正常狀態下應該距現在不超過 15 分鐘。
