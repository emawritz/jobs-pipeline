// One-shot: scan our Sent mail and build a threadId → appId index, so
// replies from different addresses within the same thread still resolve to
// the right application. Run this once after gmail-auth, and again any time
// you send a large new batch.

import { listInbox } from "../lib/gmail-reader.ts";
import { indexSentThreads } from "../lib/reply-matcher.ts";

async function main() {
  // Pull recent SENT messages.
  const messages = await listInbox({
    query: "in:sent newer_than:14d",
    maxResults: 200,
  });
  console.log(`[gmail-index-sent] fetched ${messages.length} sent messages`);
  const result = indexSentThreads(messages);
  console.log(`[gmail-index-sent] +${result.indexed} threads · ${result.total} total in index`);
}

main().catch((e) => {
  console.error("[gmail-index-sent]", e.message ?? e);
  process.exit(1);
});
