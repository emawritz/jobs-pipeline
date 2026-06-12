#!/bin/bash
# Composite: Sweep diario completo (manual).
# Equivalente al cron de 8am pero sin esperar.
# 1. Digest fresco con cap 100
# 2. Workana drafts (no envía)
# 3. Email auto-apply scan
# 4. Reporte final

set -u
export PATH="${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
cd "$(dirname "$0")/.."

echo "════════════════════════════════════════════════════════"
echo "  SWEEP COMPLETO  $(date)"
echo "════════════════════════════════════════════════════════"

echo
echo "── PASO 1/3 · Digest fresco (limit=100)"
rm -f data/jobs-seen.json
npx tsx bin/digest.ts --limit=100 2>&1 | tail -15

echo
echo "── PASO 2/3 · Workana drafts (no envía nada)"
if [ -d ".playwright-data" ]; then
  npx tsx bin/workana-bid.ts --draft-only 2>&1 | tail -20 || echo "(Workana skipped: profile en revisión o sin login)"
else
  echo "(skipped — no hay sesión Playwright. Corré npm run workana-login)"
fi

echo
echo "── PASO 3/3 · Auto-apply email scan (max=10)"
npx tsx bin/auto-apply-all.ts --min-score=55 --max=10 --email-only --scan-for-email 2>&1 | tail -40

echo
echo "── DONE  $(date)"
