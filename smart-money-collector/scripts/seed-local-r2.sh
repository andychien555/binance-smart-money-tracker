#!/usr/bin/env bash
set -euo pipefail

# Seed local R2 emulation with a one-shot snapshot of production data.
# After running, `npm run dev:local` works offline with full historical data.
#
# Source: production worker URL (wrangler r2 object get has a bug with
# slash-containing keys in 4.x, so we use the public worker endpoint).

BUCKET=smart-money-data
WORKER_URL="https://smart-money-collector.andychien-design.workers.dev"
TMPDIR=$(mktemp -d)
trap 'rm -rf "${TMPDIR}"' EXIT

cd "$(dirname "$0")/.."

echo "📥 fetching symbols.json from ${WORKER_URL}"
curl -fsSL "${WORKER_URL}/data/symbols.json" -o "${TMPDIR}/symbols.json"
npx wrangler r2 object put "${BUCKET}/symbols.json" \
  --file="${TMPDIR}/symbols.json" --local > /dev/null
echo "  ✓ symbols.json"

node -e "const d=require('${TMPDIR}/symbols.json'); process.stdout.write(d.map(s=>s.symbol).join('\n')+'\n')" \
  > "${TMPDIR}/symbols.txt"

while IFS= read -r sym || [ -n "${sym}" ]; do
  [ -z "${sym}" ] && continue
  echo "📥 ${sym}"
  for key in history_full prev_row; do
    url="${WORKER_URL}/data/${sym}/${key}.json"
    out="${TMPDIR}/${sym}-${key}.json"
    if curl -fsSL "${url}" -o "${out}"; then
      npx wrangler r2 object put "${BUCKET}/${sym}/${key}.json" \
        --file="${out}" --local > /dev/null
      size=$(wc -c < "${out}" | tr -d ' ')
      echo "  ✓ ${key}.json (${size} bytes)"
    else
      echo "  ✗ ${key}.json (fetch failed)"
    fi
  done
done < "${TMPDIR}/symbols.txt"

echo ""
echo "✅ done — local R2 seeded. Run 'npm run dev:local' to use the snapshot."
