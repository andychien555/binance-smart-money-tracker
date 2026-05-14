# mac-proxy — DigitalOcean 部署版

⚠️ **資料夾名稱保留 "mac-proxy" 是 historical**：proxy 原本跑在 Mac 上經 Cloudflare Tunnel 連回 Worker，2026-05-14 已遷到 DigitalOcean Singapore VPS。重新命名（成 `do-proxy/` 之類）等想清楚再做，避免動到 import path 跟現有 commit history。

`proxy.mjs` 本身沒改，這份 README 的內容已全部替換成 DO 部署 / 操作 / debug 流程。

## 為什麼需要這個

2026-05-13 起 Binance 對 Cloudflare edge anycast IP 回 HTTP 451。Cloudflare Workers 標準方案無法指定出口國家（Smart Placement 只是隨機落到不同 DC），所以把 Worker 的 outbound 透過獨立 VPS 中繼出去。DO Singapore (SGP1) IP 不在 Binance 封鎖名單，延遲低、IP 信譽乾淨。

## 架構

```
Worker cron  →  https://167.172.64.49.nip.io/host-{fapi,www,web3}/...
             →  Caddy on DO (443, Let's Encrypt 自動 cert)
             →  127.0.0.1:8787 (proxy.mjs, systemd binance-proxy.service)
             →  https://{fapi.binance.com, www.binance.com, web3.binance.com}/...
```

Worker 端把 `https://fapi.binance.com` 等 base URL 改寫成 `${PROXY_BASE}/host-fapi` 等路徑（見 [smart-money-collector/src/index.ts](../smart-money-collector/src/index.ts) 的 `proxyUrl()`），並在 header 附 `X-Proxy-Token` 給 proxy 驗證。

Route prefix 對應：

| Prefix | Upstream host |
|---|---|
| `/host-fapi` | `https://fapi.binance.com` |
| `/host-www`  | `https://www.binance.com` |
| `/host-web3` | `https://web3.binance.com` |

⚠️ Prefix 不可跟 Binance 真實路徑 segment 撞名（曾經用 `/fapi` 結果 `https://fapi.binance.com/fapi/...` 的 `/fapi` segment 被誤吃掉）。

## DO 機器資訊

| 項目 | 值 |
|---|---|
| 服務商 | DigitalOcean |
| 機房 | SGP1 (Singapore) |
| 規格 | Basic $6（1 vCPU / 1GB / 25GB SSD） |
| OS | Ubuntu 24.04 LTS |
| Hostname | `personal-sg1` |
| IP | `167.172.64.49`（固定） |
| Domain | `167.172.64.49.nip.io`（nip.io wildcard DNS，免費） |
| SSH | `ssh root@167.172.64.49`（用 Mac 本機 `~/.ssh/id_ed25519`） |
| Repo 路徑 | `/root/.openclaw/workspace/` |

## 在 DO 上的操作

### 看 service 狀態

```bash
systemctl status binance-proxy
systemctl status caddy
```

### 看 log

```bash
journalctl -u binance-proxy -n 50          # proxy 最近 50 行
journalctl -u binance-proxy -f             # 即時跟看
journalctl -u caddy -n 50                  # Caddy log
```

### 重啟 service

```bash
systemctl restart binance-proxy            # proxy 改了 / 卡死
systemctl reload caddy                     # Caddyfile 改了
systemctl restart caddy                    # 比較嚴重才用
```

### 改 proxy.mjs

DO 上有 repo 完整 clone，直接編輯：

```bash
nano /root/.openclaw/workspace/mac-proxy/proxy.mjs
systemctl restart binance-proxy
journalctl -u binance-proxy -n 5           # 確認啟動沒報錯
```

⚠️ 同份檔案也要 commit 進 repo（Mac 那邊 `git add proxy.mjs && git commit && git push`），DO 跟 Mac 兩邊版本同步靠人工，沒有自動 sync。

### 改 Caddy 設定（例如加新 domain / 新 route）

```bash
nano /etc/caddy/Caddyfile
systemctl reload caddy                     # reload 不會中斷服務
```

### 自己 curl 測 proxy（不經過 Worker）

```bash
# 本機直連
curl http://127.0.0.1:8787/health

# 經過 Caddy 走 HTTPS
curl https://167.172.64.49.nip.io/health

# 帶 token 打 Binance ping
curl -H "x-proxy-token: $(grep PROXY_SECRET /root/.openclaw/workspace/mac-proxy/.env | cut -d= -f2)" \
  https://167.172.64.49.nip.io/host-fapi/fapi/v1/ping
```

預期：`/health` → `ok`、Binance ping → `{}`。

## 怎麼判斷壞了

按優先順序：

1. **dashboard 看「最近數據」時間**：超過 15-30 分鐘沒更新就是壞了
2. **直接打 Worker `/run`**（在任何能上網的地方）：
   ```bash
   curl https://smart-money-collector.andychien-design.workers.dev/run
   ```
   `ok:4` = 全部通，`ok:0-3` = 看 `error` 欄
3. **拆層 debug**（按順序，從外到內找哪層斷）：
   ```bash
   # 外面打 HTTPS proxy
   curl https://167.172.64.49.nip.io/health
   # SSH 進 DO 看 Caddy
   systemctl status caddy
   # SSH 進 DO 看 proxy
   systemctl status binance-proxy
   curl http://127.0.0.1:8787/health
   ```

## 常見錯誤與恢復

| 症狀 | 原因 | 修法 |
|---|---|---|
| Worker `/run` 回 `HTTP 451` | DO IP 被 Binance 封了 | 換 DO droplet、或申請第二台輪流出口 |
| Worker `/run` 回 `HTTP 530` / `HTTP 525` | Caddy 沒回應 / cert 過期 | DO 上 `systemctl restart caddy`，看 journal 找原因 |
| Worker `/run` 回 `HTTP 403` | Worker `PROXY_TOKEN` ≠ DO `.env` `PROXY_SECRET` | 對齊兩邊值（Worker 改用 `wrangler secret put`，DO 改 `.env` 再 `systemctl restart binance-proxy`） |
| 外面 curl `nip.io` 連不上 | UFW 沒開 / DO network drop | 看 `ufw status` 確認 80/443 開、DO control panel 確認 instance running |
| `journalctl -u caddy` 一直跑 ACME challenge 失敗 | 80 port 沒開 / nip.io DNS 故障 | UFW 確認 80 開；nip.io 罕見壞，用 `dig 167.172.64.49.nip.io` 確認解析 |
| 完整重啟整套 | 不確定哪壞 | `systemctl restart binance-proxy caddy` |

## 怎麼新增 Binance 主機 / 路由 prefix

例：新增 `https://api.binance.com` 走 `/host-api`：

1. 編 `proxy.mjs` 的 `ROUTES`：
   ```js
   const ROUTES = {
     "/host-fapi": "https://fapi.binance.com",
     "/host-www": "https://www.binance.com",
     "/host-web3": "https://web3.binance.com",
     "/host-api": "https://api.binance.com",   // 新增
   };
   ```
2. DO 上：`systemctl restart binance-proxy` 套用
3. Mac 上：commit + push
4. Worker `src/index.ts` 的 `proxyUrl()` 加對應 replace：
   ```ts
   .replace("https://api.binance.com", `${env.PROXY_BASE}/host-api`)
   ```
5. 在 Mac 上 `cd smart-money-collector && npx wrangler deploy`

⚠️ 新 prefix 不可跟 upstream 的真實 path segment 撞名（見上）。

## 設計細節

### 為什麼 proxy 不轉發任意 request headers

CloudFront WAF（Binance 後端）會用 header 組合判定機器人。轉發 `User-Agent: curl/x.x.x` + 沒有 `Accept-Language` 之類組合直接 403。proxy 一律自己設一組正常的瀏覽器 UA，只放行少數必要 header：

- `clienttype` — Binance smart-money endpoint 需要
- `referer` — 同上
- `accept-encoding`、`accept-language` — 一般 web 行為

### 為什麼用 X-Proxy-Token

DO IP 雖然主要給 Worker 用，但網址是公開的（nip.io 可推測），有被當成免費翻牆機掃描的風險。proxy 沒有 token 直接回 403，並只在本機 listen `127.0.0.1`（外面只能經 Caddy 進來，Caddy 會帶 Worker 的 token header）。Token 在 DO `.env`（chmod 600）跟 Worker secret 各一份。

### 為什麼用 nip.io 而不買 domain

Let's Encrypt 需要合法 domain。`nip.io` 是免費 wildcard DNS（`<IP>.nip.io` 自動解析回 `<IP>`），不用買 domain 就能拿真 cert。要換真 domain 時：

1. 買 domain（CF / Cloudflare Registrar）
2. 加 A record 指向 `167.172.64.49`
3. 改 DO `/etc/caddy/Caddyfile` 把 `167.172.64.49.nip.io` 換成新 domain
4. `systemctl reload caddy`（Caddy 自動拿新 cert）
5. Mac 上 `echo "https://<new-domain>" | npx wrangler secret put PROXY_BASE` + `npx wrangler deploy`

### 為什麼用 systemd 而不是 nohup

`Restart=always` 自動拉回 crash 的 process，開機自動跑，log 進 journald（不用維護 log 檔），環境變數從 `EnvironmentFile=.env` 讀（secret 不寫進 unit）。systemd 的代價只是要寫一個 `.service` 檔，不是大問題。

## 檔案

| 檔案 | 用途 | 位置 |
|---|---|---|
| `proxy.mjs` | Node HTTP proxy，listen on 127.0.0.1:8787 | repo + DO `/root/.openclaw/workspace/mac-proxy/` |
| `.env` | `PROXY_SECRET`、`PORT` — gitignored，只在 DO 上 | DO `/root/.openclaw/workspace/mac-proxy/.env`（chmod 600） |
| `start.sh` / `stop.sh` | **舊版 Mac 用**，DO 上不使用（systemctl 取代） | repo only |
| systemd unit | `binance-proxy.service` | DO `/etc/systemd/system/binance-proxy.service` |
| Caddyfile | TLS / reverse proxy 設定 | DO `/etc/caddy/Caddyfile` |

## 歷史

- 2026-05-12：Worker 上線，直接打 Binance
- 2026-05-13 ~04:45 UTC：Binance 開始 451 CF edge IP
- 2026-05-13：上線 stopgap — Mac proxy + cloudflared quick tunnel（[commit 48672d9](https://github.com/andychien555/BN_Smart_Money_Tracker/commit/48672d9)）
- 2026-05-14：遷到 DO Singapore，棄用 cloudflared，加 Caddy + systemd 跟 nip.io cert
