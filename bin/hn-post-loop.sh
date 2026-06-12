#!/bin/bash
# Wrapper: polls for the "Who wants to be hired?" thread up to 2h, posts on first hit.
# Called by launchd at 12:00 GMT-3 on the 1st of each month (11am ET).

set -u
export PATH="${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
cd "$(dirname "$0")/.."

LOG_DIR="data/hn-logs"
mkdir -p "$LOG_DIR"
STAMP=$(date +%Y-%m-%d)
LOG="$LOG_DIR/$STAMP.log"

MAX_ATTEMPTS=60   # 60 * 120s = 2h max
SLEEP_SEC=120

{
  echo "════════════════════════════════════════════════════════"
  echo "  hn-post-loop $STAMP $(date)"
  echo "════════════════════════════════════════════════════════"

  for i in $(seq 1 $MAX_ATTEMPTS); do
    echo
    echo "── attempt $i / $MAX_ATTEMPTS"

    # First do a --check to see if a thread for the current month exists.
    if npx tsx bin/hn-post.ts --check 2>&1 | tee /tmp/hn-check.out; then
      if grep -q 'thread: "' /tmp/hn-check.out && ! grep -q 'NOT for the current month' /tmp/hn-check.out; then
        echo "── thread found and matches current month — posting"
        if npx tsx bin/hn-post.ts 2>&1; then
          echo "── ✓ posted successfully on attempt $i"
          osascript -e "display notification \"HN auto-post fired — check the thread\" with title \"jobs-pipeline\" sound name \"Glass\""
          exit 0
        else
          echo "── ✗ post failed; will retry"
        fi
      else
        echo "── thread exists but not current month yet — waiting"
      fi
    else
      echo "── --check failed; will retry"
    fi

    sleep $SLEEP_SEC
  done

  echo "── giving up after $MAX_ATTEMPTS attempts"
  osascript -e "display notification \"HN auto-post FAILED after 2h — run manually\" with title \"jobs-pipeline\" sound name \"Basso\""
  exit 1
} >> "$LOG" 2>&1
