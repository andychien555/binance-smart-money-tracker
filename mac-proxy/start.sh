#!/usr/bin/env bash
# Start the Mac proxy + Cloudflare Tunnel, then sync the tunnel URL into the
# Worker's PROXY_BASE secret and redeploy. Idempotent — kills any existing
# proxy/cloudflared processes before starting fresh.
#
# Usage:  ./start.sh
# Logs:   mac-proxy/proxy.log  and  mac-proxy/tunnel.log

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORKER_DIR="$(cd "$HERE/../smart-money-collector" && pwd)"

cd "$HERE"

if [[ ! -f .env ]]; then
	echo "ERROR: $HERE/.env not found (need PROXY_SECRET)" >&2
	exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

echo "[1/5] killing any existing proxy/cloudflared"
pkill -f "node proxy.mjs" 2>/dev/null || true
pkill -f "cloudflared tunnel --url" 2>/dev/null || true
sleep 1

echo "[2/5] starting proxy on :${PORT:-8787}"
nohup node proxy.mjs > proxy.log 2>&1 &
PROXY_PID=$!
sleep 1
if ! curl -fsS "http://127.0.0.1:${PORT:-8787}/health" >/dev/null; then
	echo "ERROR: proxy did not come up — see proxy.log" >&2
	exit 1
fi
echo "      proxy pid=$PROXY_PID"

echo "[3/5] starting cloudflared quick tunnel"
nohup cloudflared tunnel --url "http://localhost:${PORT:-8787}" > tunnel.log 2>&1 &
TUNNEL_PID=$!

echo "      waiting for tunnel URL..."
TUNNEL_URL=""
for i in {1..30}; do
	TUNNEL_URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' tunnel.log | head -1 || true)"
	[[ -n "$TUNNEL_URL" ]] && break
	sleep 1
done

if [[ -z "$TUNNEL_URL" ]]; then
	echo "ERROR: cloudflared did not publish a tunnel URL within 30s" >&2
	tail -20 tunnel.log >&2
	exit 1
fi
echo "      tunnel url: $TUNNEL_URL"

echo "[4/5] updating Worker PROXY_BASE secret + deploying"
cd "$WORKER_DIR"
echo "$TUNNEL_URL" | npx wrangler secret put PROXY_BASE >/dev/null
npx wrangler deploy >/dev/null
echo "      worker redeployed"

echo "[5/5] verifying end-to-end via /run"
sleep 2
RESULT="$(curl -fsS "https://smart-money-collector.andychien-design.workers.dev/run")"
OK_COUNT="$(echo "$RESULT" | python3 -c 'import json,sys;print(json.load(sys.stdin)["ok"])')"
echo "      collected: $OK_COUNT/4 symbols"

if [[ "$OK_COUNT" != "4" ]]; then
	echo "WARN: not all symbols collected — check response below" >&2
	echo "$RESULT" >&2
	exit 1
fi

echo
echo "OK — proxy pid=$PROXY_PID, cloudflared pid=$TUNNEL_PID"
echo "    tunnel: $TUNNEL_URL"
echo "    logs:   $HERE/proxy.log  $HERE/tunnel.log"
