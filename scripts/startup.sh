#!/bin/bash
# Auto-start script for Smart Money Dashboard infrastructure
# Called on container/machine start

echo "[$(date -u)] Starting Smart Money infrastructure..."

# 0. Restore git config + credentials
git config --global user.name 'andychien555'
git config --global user.email 'andychien555@users.noreply.github.com'
git config --global credential.helper store
echo 'https://andychien555:YOUR_GITHUB_TOKEN_HERE@github.com' > ~/.git-credentials
if [ ! -d /tmp/binance-smart-money-tracker ]; then
  cd /tmp && git clone https://github.com/andychien555/binance-smart-money-tracker.git
fi
echo "[$(date -u)] Git repo ready"

# 1. Install + start cron (container rebuilds lose it)
which crontab >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq cron 2>/dev/null; }
service cron start 2>/dev/null || true
echo "[$(date -u)] Cron started"

# 2. Ensure crontab is set
crontab -l 2>/dev/null | grep -q 'multi-collect' || {
  echo '*/15 * * * * python3 /root/.openclaw/workspace/scripts/multi-collect.py --all >> /tmp/multi-collect.log 2>&1 && bash /root/.openclaw/workspace/scripts/push-data.sh >> /tmp/push-data.log 2>&1' | crontab -
  echo "[$(date -u)] Crontab installed"
}

# 3. Run an immediate data collect + push
python3 /root/.openclaw/workspace/scripts/multi-collect.py --all >> /tmp/multi-collect.log 2>&1
bash /root/.openclaw/workspace/scripts/push-data.sh >> /tmp/push-data.log 2>&1
echo "[$(date -u)] Initial data collect + push done"

echo "[$(date -u)] Startup complete"
