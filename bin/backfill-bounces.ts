// Walks data/gmail/replies.json, extracts bounced addresses from mailer-daemon
// messages, populates data/bounced-emails.json. One-shot; idempotent.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extractBouncedAddress, classifyBounce, isMailerDaemon, recordBounce, loadBounced } from "../lib/bounce-tracker.ts";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPLIES_PATH = join(PROJECT_ROOT, "data/gmail/replies.json");

type StoredReply = {
  id: string;
  fromEmail: string;
  subject: string;
  snippet: string;
  body?: string;
};

function main() {
  if (!existsSync(REPLIES_PATH)) {
    console.error(`missing ${REPLIES_PATH}`);
    process.exit(1);
  }
  const replies = JSON.parse(readFileSync(REPLIES_PATH, "utf8")) as StoredReply[];
  console.log(`scanning ${replies.length} replies for bounces…\n`);

  let added = 0;
  let alreadyKnown = 0;
  let notBounce = 0;

  for (const r of replies) {
    if (!isMailerDaemon(r.fromEmail)) {
      notBounce++;
      continue;
    }
    const email = extractBouncedAddress({
      subject: r.subject ?? "",
      body: r.body ?? "",
      snippet: r.snippet ?? "",
    });
    if (!email) {
      console.log(`  [?] could not extract address from ${r.id} — ${r.subject?.slice(0, 60)}`);
      continue;
    }
    const reason = classifyBounce(r.body ?? r.snippet ?? "");
    const newlyAdded = recordBounce(email, reason, r.id);
    if (newlyAdded) {
      added++;
      console.log(`  ✓ ${email.padEnd(40)} ${reason}`);
    } else {
      alreadyKnown++;
    }
  }

  const total = loadBounced().size;
  console.log(`\n══════ DONE ══════`);
  console.log(`  added:        ${added}`);
  console.log(`  already known: ${alreadyKnown}`);
  console.log(`  non-bounce:   ${notBounce}`);
  console.log(`  total tracked: ${total}`);
}

main();
