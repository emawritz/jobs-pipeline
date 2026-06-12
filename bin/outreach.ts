import { readFileSync, existsSync } from "node:fs";
import { load } from "cheerio";
import { callText, DRAFT_MODEL } from "../lib/claude.ts";
import { writeText } from "../lib/storage.ts";

const SYSTEM = `You draft cold LinkedIn outreach messages from a senior product engineer to a founder/CTO.

NON-NEGOTIABLE RULES:
- Max 80 words. Hard cap. Shorter is better.
- BANNED: "passionate", "I came across your profile", "I noticed", "love what you're doing", "would love to connect", "perfect fit", "synergy", "leverage", "rockstar".
- MUST reference ONE specific thing about the target: a tweet, a blog post, a shipping, a podcast appearance, an OSS commit — something they personally did. Generic "your company is interesting" = fail.
- Structure:
    1. Specific hook (1-2 sentences): what they did + a 1-sentence signal of the sender's relevance.
    2. Concrete value (1-2 sentences): one thing the sender could help with, grounded in evidence.
    3. Soft CTA (1 sentence): ask for 15 min OR offer to send something useful, no pressure.

Tone: casual professional. Peer-to-peer, not supplicant. No emojis.

Output: the message body only. No greeting line (just start). No signature.`;

async function fetchLinkedIn(url: string): Promise<string> {
  try {
    const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 jobs-pipeline" } });
    if (!res.ok) return "";
    const html = await res.text();
    const $ = load(html);
    $("script, style").remove();
    return $("body").text().replace(/\s+/g, " ").trim().slice(0, 4000);
  } catch {
    return "";
  }
}

function loadContext(): string {
  const parts: string[] = [];
  for (const p of ["CLAUDE.md", "portfolio/README.md"]) {
    if (existsSync(p)) parts.push(`=== ${p} ===\n${readFileSync(p, "utf8")}`);
  }
  return parts.join("\n\n");
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/https?:\/\//, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

async function main() {
  const url = process.argv[2];
  const context = process.argv.slice(3).join(" ");
  if (!url) {
    console.error("usage: tsx bin/outreach.ts <linkedin-url> [context about why we're reaching out]");
    process.exit(1);
  }
  const ctx = loadContext();
  const liText = await fetchLinkedIn(url);

  const user = `CANDIDATE CONTEXT:
${ctx}

TARGET PROFILE (raw scrape, may be empty if LinkedIn auth-walled):
${liText || "(empty — use the context below to anchor the hook)"}

EXTRA CONTEXT FROM USER (use this if present — it usually has the specific hook):
${context || "(none provided — DO NOT invent; ask user to rerun with context)"}

Draft the outreach message now.`;

  const msg = await callText(user, { system: SYSTEM, model: DRAFT_MODEL });
  console.log("\n" + msg + "\n");

  writeText(`data/drafts/outreach-${slugify(url)}.md`, `<!-- target: ${url} -->\n<!-- context: ${context} -->\n\n${msg}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
