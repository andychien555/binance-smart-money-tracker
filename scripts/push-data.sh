#!/bin/bash
# Push latest data to GitHub Pages
REPO_DIR=/tmp/BN_Smart_Money_Tracker
DATA_SRC=/root/.openclaw/workspace/data
SYMBOLS="river btc eth sol siren lit rave pippin beat power"

cd "$REPO_DIR" || exit 1

# Copy latest data
for sym in $SYMBOLS; do
  mkdir -p data/$sym
  cp "$DATA_SRC/$sym/history_full.json" "data/$sym/" 2>/dev/null
  cp "$DATA_SRC/$sym/prev_row.json" "data/$sym/" 2>/dev/null
done

# Regenerate symbols.json
python3 -c "
import json, os
symbols = ['river','btc','eth','sol','siren','lit','rave','pippin','beat','power']
result = []
for sym in symbols:
    info = {'symbol': sym, 'label': sym.upper()+'/USDT'}
    pf = f'$DATA_SRC/{sym}/prev_row.json'
    if os.path.exists(pf):
        with open(pf) as f:
            d = json.load(f)
            info['price'] = d.get('price')
            info['change_pct'] = d.get('price_change_pct')
            info['has_data'] = True
    else:
        info['has_data'] = False
    result.append(info)
with open('data/symbols.json','w') as f:
    json.dump(result, f)
"

# Git push (squash to single commit to prevent .git bloat)
git add -A
git diff --cached --quiet && exit 0  # nothing changed
git commit -m "data update $(date -u +%Y-%m-%dT%H:%M:%SZ)" --quiet

# Keep only last 10 commits to prevent .git growth
COUNT=$(git rev-list --count HEAD 2>/dev/null || echo 0)
if [ "$COUNT" -gt 20 ]; then
  git checkout --orphan temp_branch 2>/dev/null
  git add -A 2>/dev/null
  git commit -m "data update $(date -u +%Y-%m-%dT%H:%M:%SZ)" --quiet 2>/dev/null
  git branch -D main 2>/dev/null
  git branch -m main 2>/dev/null
  git push --force --set-upstream origin main 2>&1 || { sleep 5; git push --force --set-upstream origin main 2>&1; } || true
else
  git push --set-upstream origin main --quiet 2>&1 || { sleep 5; git push --set-upstream origin main --quiet 2>&1; } || true
fi
