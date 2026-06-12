#!/bin/bash
# Daily autonomous run — wire to launchd / cron.
# - Fresh digest (resets seen so we re-evaluate the latest HN)
# - Email batch with --scan-for-email to promote URL→email when possible
# - Skip captcha by default; if TWO_CAPTCHA_API_KEY is set, also run a web pass

set -u
# launchd starts with a minimal PATH. Make sure:
#   - /opt/homebrew/bin   (Apple Silicon Homebrew: node, npx, python3)
#   - ${HOME}/.local/bin   (Claude Code CLI lives here)
#   - /usr/local/bin, /usr/bin, /bin (standard)
export PATH="${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
cd "$(dirname "$0")/.."

# Sanity: refuse to run if the claude CLI is missing — otherwise all scoring
# calls silently 404 and the digest writes 0 jobs.
if ! command -v claude >/dev/null 2>&1; then
  echo "ERROR: 'claude' CLI not on PATH. Aborting daily run." >&2
  exit 1
fi

LOG_DIR="data/daily-logs"
mkdir -p "$LOG_DIR"
STAMP=$(date +%Y-%m-%d)
LOG="$LOG_DIR/$STAMP.log"

{
  echo "════════════════════════════════════════════════════════"
  echo "  daily run $STAMP at $(date)"
  echo "════════════════════════════════════════════════════════"

  echo
  echo "── 1. fresh digest (--limit=200)"
  rm -f data/jobs-seen.json
  npx tsx bin/digest.ts --limit=200 2>&1 | tail -20

  echo
  echo "── 2. autonomous email batch (--scan-for-email)"
  npx tsx bin/auto-apply-all.ts --min-score=55 --max=20 --email-only --scan-for-email 2>&1 | tail -40

  if [ -f .env ] && grep -q '^TWO_CAPTCHA_API_KEY=.\+' .env; then
    echo
    echo "── 3. autonomous web batch (2captcha key present)"
    npx tsx bin/auto-apply-all.ts --min-score=60 --max=10 --no-pause --web-only 2>&1 | tail -50
  else
    echo
    echo "── 3. skipped web batch (no TWO_CAPTCHA_API_KEY in .env)"
  fi

  echo
  echo "  done $(date)"
  echo
} >> "$LOG" 2>&1

osascript -e "display notification \"daily batch done. log: $LOG\" with title \"jobs-pipeline\" sound name \"Glass\""
