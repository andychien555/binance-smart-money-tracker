#!/usr/bin/env bash
# Stop the local proxy and cloudflared tunnel started by start.sh.
set -euo pipefail

echo "stopping proxy..."
pkill -f "node proxy.mjs" 2>/dev/null && echo "  proxy killed" || echo "  proxy not running"

echo "stopping cloudflared..."
pkill -f "cloudflared tunnel --url" 2>/dev/null && echo "  cloudflared killed" || echo "  cloudflared not running"
