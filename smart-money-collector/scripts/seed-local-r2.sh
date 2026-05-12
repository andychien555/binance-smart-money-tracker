#!/usr/bin/env bash
set -euo pipefail

# Seed local R2 emulation with a one-shot snapshot of production R2 data.
# After running, `npm run dev:local` works offline with full historical data.

BUCKET=smart-money-data
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

cd "$(dirname "$0")/.."

echo "📥 fetching symbols.json from remote R2…"
npx wrangler r2 object get "$BUCKET/symbols.json" --pipe --remote > "$TMPDIR/symbols.json"
npx wrangler r2 object put "$BUCKET/symbols.json" --file="$TMPDIR/symbols.json" --local

node -e "const d=require('$TMPDIR/symbols.json'); process.stdout.write(d.map(s=>s.symbol).join('\n'))" > "$TMPDIR/symbols.txt"

while IFS= read -r sym; do
  [ -z "${sym}" ] && continue
  echo "📥 ${sym} ..."
  for key in history_full prev_row; do
    if npx wrangler r2 object get "${BUCKET}/${sym}/${key}.json" --pipe --remote > "${TMPDIR}/${sym}-${key}.json" 2>/dev/null; then
      npx wrangler r2 object put "${BUCKET}/${sym}/${key}.json" --file="${TMPDIR}/${sym}-${key}.json" --local > /dev/null
    else
      echo "  skip ${key}.json (not in remote)"
    fi
  done
done < "${TMPDIR}/symbols.txt"

echo "✅ done — local R2 seeded. run 'npm run dev:local' to use."
