#!/bin/bash
# Gmail auto-poll: re-index sent threads + poll inbox + notify if matched.
# Fires every 10 min via launchd (dev.jobs-pipeline.gmail-poll).
#
# Notifications:
#   - Glass sound + native banner when N new replies detected (N > 0)
#   - Silent when 0 new (we don't spam you)

set -u
export PATH="${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
cd "$(dirname "$0")/.."

LOG_DIR="data/gmail/cron-logs"
mkdir -p "$LOG_DIR"
STAMP=$(date +%Y-%m-%d)
LOG="$LOG_DIR/$STAMP.log"

# Sanity: if no credentials/token, exit cleanly.
if [ ! -f data/gmail/credentials.json ] || [ ! -f data/gmail/token.json ]; then
  echo "[$(date '+%H:%M:%S')] skipping: gmail OAuth not configured yet (run setup first)" >> "$LOG"
  exit 0
fi

{
  echo
  echo "════════ $(date '+%Y-%m-%d %H:%M:%S') ════════"

  # Re-index sent threads (cheap, keeps map current as you send new mail).
  npx tsx bin/gmail-index-sent.ts 2>&1 | tail -3

  # Poll inbox with default cursor (only new since last run).
  OUTPUT=$(npx tsx bin/gmail-poll.ts --limit=50 2>&1)
  echo "$OUTPUT"

  # Parse "matched N new replies" to decide whether to notify.
  MATCHED=$(echo "$OUTPUT" | grep -oE 'matched [0-9]+ new replies' | grep -oE '[0-9]+' | head -1)
  MATCHED=${MATCHED:-0}

  if [ "$MATCHED" -gt 0 ]; then
    # Pull the first reply line for the notification body.
    FIRST=$(echo "$OUTPUT" | grep -E '^  ✓' | head -1 | sed 's/^  ✓ //' | cut -c1-80)
    osascript -e "display notification \"$MATCHED nueva(s) — $FIRST\" with title \"jobs-pipeline · respuesta Gmail\" sound name \"Glass\""
    echo "→ notified: $MATCHED nueva(s)"
  fi
} >> "$LOG" 2>&1
