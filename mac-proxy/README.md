# mac-proxy

Local Mac proxy + Cloudflare Tunnel，繞過 Binance 對 Cloudflare edge IP 的地理封鎖。Worker 不直接打 Binance，而是經這台 Mac 出去。

## 為什麼需要這個

2026-05-13 開始 Binance 對 Cloudflare edge 回 HTTP 451，Worker 直接 fetch Binance 全部失敗。Mac 本機 IP 不在 Binance 的封鎖名單，因此把 Worker 的 outbound 透過 CF Tunnel → 本機 proxy → Binance 繞過去。

## 架構

```
Worker cron → https://<tunnel>.trycloudflare.com/host-{fapi,www,web3}/...
           → Cloudflare Tunnel (cloudflared)
           → http://127.0.0.1:8787 (proxy.mjs)
           → https://{fapi.binance.com, www.binance.com, web3.binance.com}/...
```

Worker 端把 `https://fapi.binance.com` 等 base URL 改寫成 `${PROXY_BASE}/host-fapi` 等路徑（見 [smart-money-collector/src/index.ts](../smart-money-collector/src/index.ts) 的 `proxyUrl()`），並在 header 附 `X-Proxy-Token` 給 proxy 驗證。

Route prefix 對應：

| Prefix | Upstream host |
|---|---|
| `/host-fapi` | `https://fapi.binance.com` |
| `/host-www`  | `https://www.binance.com` |
| `/host-web3` | `https://web3.binance.com` |

⚠️ Prefix 不可跟 Binance 真實路徑 segment 撞名（例如曾經用 `/fapi` 結果 `https://fapi.binance.com/fapi/...` 的 `/fapi` segment 被誤吃掉）。

## 操作

### Mac 重開機 / cloudflared 掛了之後恢復

```bash
cd /Users/andychien/BN_Smart_Money_Tracker/mac-proxy
./start.sh
```

[start.sh](start.sh) 會：殺舊 process → 起 proxy → 起 cloudflared → 抓新的 trycloudflare URL → 寫進 Worker `PROXY_BASE` secret → 重新 deploy Worker → call `/run` 驗證 4/4。

### 關掉

```bash
./stop.sh
```

### 怎麼判斷壞了

- 開 dashboard 看「最近數據」時間，超過 15-30 分鐘沒更新就是壞了
- 或直接 `curl https://smart-money-collector.andychien-design.workers.dev/data/symbols.json` 看是不是出現 451 / proxy 錯誤
- 修復 → `./start.sh`

### Health check

```bash
curl http://127.0.0.1:8787/health        # 期望 "ok"
```

### Log

- `proxy.log` — proxy 每筆 request 的 `method url -> status`
- `tunnel.log` — cloudflared 連線狀態、tunnel URL

## 設計細節

### 為什麼 proxy 不轉發任意 request headers

CloudFront WAF（Binance 後端）會用 header 組合判定機器人。轉發 `User-Agent: curl/x.x.x` + 沒有 `Accept-Language` 之類組合直接 403。proxy 一律自己設一組正常的瀏覽器 UA，只放行少數必要 header：

- `clienttype` — Binance smart-money endpoint 需要
- `referer` — 同上
- `accept-encoding`、`accept-language` — 一般 web 行為

### 為什麼用 X-Proxy-Token

cloudflared quick tunnel URL 雖然不公開，但網址結構簡單、有被 scan 的風險。proxy 沒有 token 直接回 403，避免被當免費翻牆機濫用。Token 在 `.env`（已 gitignored）跟 Worker secret 各一份。

### 為什麼還在用 quick tunnel

Named tunnel 需要 CF 帳號裡有 domain，使用者目前沒買 domain，所以接受「重啟後 URL 會變、要重跑 `start.sh`」的代價。要升級 named tunnel 時：

1. CF 帳號加一個 domain（買或轉入）
2. `cloudflared tunnel login` → `tunnel create` → `tunnel route dns` → 寫 `config.yml`
3. URL 變固定，cron 重啟也不會變動

## 限制

1. Mac 必須開機（睡眠/關機時收不到資料）。建議 System Settings → Battery → Power Adapter → Prevent automatic sleeping
2. Quick tunnel URL 重啟後會變 → 手動跑 `start.sh` 同步
3. 沒設 launchd auto-start，重開機後要手動跑 `start.sh`
4. **Quick tunnel 連線不穩**：2026-05-13 觀察到 cloudflared 跑約 1.5 小時後進入永久 reconnect loop（`control stream encountered a failure` / `context canceled`），process 還活著但 tunnel 對外不可達（curl → HTTP 000，Worker → HTTP 530）。Process 不會自己死掉，所以單純 `pgrep` 沒用，要直接 curl tunnel URL 或看資料新鮮度判斷。長期解法是買 domain 升級 named tunnel，或寫一個 watchdog 定期 health-check tunnel URL、壞了就 `start.sh`

## 檔案

| 檔案 | 用途 |
|---|---|
| `proxy.mjs` | Node HTTP proxy，listen on 127.0.0.1:8787 |
| `.env` | `PROXY_SECRET`、`PORT` — gitignored |
| `start.sh` | 一鍵重啟全套 + 同步 Worker secret |
| `stop.sh` | 關掉 proxy + cloudflared |
| `proxy.log` | proxy 執行 log（自動生成） |
| `tunnel.log` | cloudflared 執行 log（自動生成） |
