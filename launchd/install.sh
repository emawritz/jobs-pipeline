#!/usr/bin/env bash
# Install all jobs-pipeline launchd schedules.
# Replaces __PROJECT_PATH__ in each plist with the current repo path, then
# copies to ~/Library/LaunchAgents/ and loads them.

set -euo pipefail

PROJECT_PATH="$(cd "$(dirname "$0")/.." && pwd)"
LAUNCH_DIR="${HOME}/Library/LaunchAgents"

mkdir -p "$LAUNCH_DIR"

for src in "$(dirname "$0")"/dev.jobs-pipeline.*.plist; do
  name="$(basename "$src")"
  dst="$LAUNCH_DIR/$name"

  # Render template
  sed "s|__PROJECT_PATH__|${PROJECT_PATH}|g" "$src" > "$dst"

  # Reload (unload first to allow re-install)
  launchctl unload "$dst" 2>/dev/null || true
  launchctl load -w "$dst"

  echo "✓ loaded: $name"
done

echo
echo "Installed. Verify with: launchctl list | grep dev.jobs-pipeline"
