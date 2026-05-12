#!/bin/bash
# Start River Dashboard + Cloudflare Tunnel
# Kill existing instances
pkill -f "python3 /root/.openclaw/workspace/river-dashboard/app.py" 2>/dev/null || true
pkill -f "cloudflared tunnel --url http://localhost:8899" 2>/dev/null || true
sleep 1

# Start Flask
cd /root/.openclaw/workspace/river-dashboard
nohup python3 app.py > /tmp/river-dashboard.log 2>&1 &
echo "Dashboard PID: $!"

# Start Cloudflare Tunnel
nohup cloudflared tunnel --url http://localhost:8899 > /tmp/cloudflared-river.log 2>&1 &
echo "Cloudflared PID: $!"

sleep 5
URL=$(grep -oP 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/cloudflared-river.log | head -1)
echo "Dashboard URL: $URL"
