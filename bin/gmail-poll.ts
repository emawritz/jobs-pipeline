// Gmail poller — fetch inbox since last cursor, match to sent apps,
// auto-update applications.json. Idempotent (skips already-seen gmail ids).
//
// Flags:
//   --limit=N       max messages to fetch (default 50)
//   --window=14d    seed query if no cursor exists yet (default 14d)
//   --reset         delete cursor → re-scan last 14 days
//   --debug         show every message fetched

import { listInbox, loadCursor, saveCursor } from "../lib/gmail-reader.ts";
import { matchReplies } from "../lib/reply-matcher.ts";

function arg(flag: string, def?: string): string | undefined {
  const m = process.argv.find((a) => a.startsWith(`${flag}=`));
  return m ? m.split("=")[1] : def;
}
function has(flag: string): boolean { return process.argv.includes(flag); }

async function main() {
  const limit = parseInt(arg("--limit", "50")!, 10);
  const window = arg("--window", "14d")!;
  const debug = has("--debug");

  if (has("--reset")) {
    saveCursor({ lastInternalDate: null });
    console.log("[gmail-poll] cursor reset → re-scan");
  }

  const cursor = loadCursor();
  const query = cursor.lastInternalDate
    ? `after:${Math.floor(parseInt(cursor.lastInternalDate, 10) / 1000)} in:inbox -from:me`
    : `newer_than:${window} in:inbox -from:me`;

  console.log(`[gmail-poll] query: ${query}`);
  const messages = await listInbox({ maxResults: limit, query });
  console.log(`[gmail-poll] fetched ${messages.length} messages`);

  if (debug) {
    for (const m of messages) {
      console.log(`  · ${m.fromEmail.padEnd(40)} | ${m.subject.slice(0, 70)}`);
    }
  }

  const result = matchReplies(messages);
  console.log(`[gmail-poll] matched ${result.matched} new replies (${result.alreadySeen} already seen)`);

  for (const r of result.newReplies) {
    console.log(`  ✓ ${r.fromEmail} → app ${r.appId} — "${r.subject.slice(0, 60)}"`);
    console.log(`    snippet: ${r.snippet.slice(0, 140)}`);
  }
}

main().catch((e) => {
  console.error("[gmail-poll]", e.message ?? e);
  process.exit(1);
});
