# Daily cron via launchd

Schedules `bin/daily.sh` to run every day at **08:00 local time**.

## Install (one-time)

```bash
# 1. Copy plist into your LaunchAgents folder
cp launchd/dev.jobs-pipeline.daily.plist ~/Library/LaunchAgents/

# 2. Load it
launchctl load -w ~/Library/LaunchAgents/dev.jobs-pipeline.daily.plist

# 3. (Optional) Trigger an immediate test run to make sure it works
launchctl start dev.jobs-pipeline.daily
```

## Verify

```bash
# See it scheduled
launchctl list | grep jobs-pipeline

# Watch today's log live
tail -f data/daily-logs/$(date +%Y-%m-%d).log
```

## Pause / Remove

```bash
# Pause (no longer fires daily)
launchctl unload ~/Library/LaunchAgents/dev.jobs-pipeline.daily.plist

# Re-enable later
launchctl load -w ~/Library/LaunchAgents/dev.jobs-pipeline.daily.plist

# Remove entirely
launchctl unload ~/Library/LaunchAgents/dev.jobs-pipeline.daily.plist
rm ~/Library/LaunchAgents/dev.jobs-pipeline.daily.plist
```

## What it does

1. Fresh digest (`--limit=200`) — re-scrapes HN, RemoteOK, YC, scores via Claude Haiku CLI
2. Email batch (`--email-only --scan-for-email`) — promotes URL→email when text contains it, sends via Mail.app
3. (Conditional) Web batch — only runs if `.env` has `TWO_CAPTCHA_API_KEY=<key>`

All output goes to `data/daily-logs/YYYY-MM-DD.log`. macOS notification fires at the end.

## Sleep / Wake behaviour

`launchd` does **not** wake the Mac to run a job. If the computer is asleep at 8:00, the job runs at the next wake. For guaranteed runs use `pmset schedule wake` separately, or leave the Mac on overnight.

## Expected daily output

- 3-8 email applications (depending on HN refresh + scan-for-email hits)
- 0-7 web applications (only if 2captcha funded)
- Native macOS notification when done
- Detailed log in `data/daily-logs/`
- All applications auto-tracked in `data/applications.json` (visible in dashboard)
