import { readFileSync, existsSync } from "node:fs";
import { load } from "cheerio";
import { callText, DRAFT_MODEL } from "../lib/claude.ts";
import { writeText } from "../lib/storage.ts";

const SYSTEM = `You draft personalized job application proposals for a senior product engineer.

NON-NEGOTIABLE RULES:
- Max 200 words. Hard cap.
- BANNED words/phrases: "passionate", "I am writing to express", "rockstar", "ninja", "excited to apply", "perfect fit", "I believe", "synergy", "leverage".
- MUST mention at least ONE specific detail from the job posting (not just the company name — a stack choice, a product feature, a recent shipping, a phrase from the post).
- Structure:
    1. Hook (1-2 sentences): the specific detail from the post + why it lands with the candidate's experience.
    2. Body (2-3 sentences): 1-2 of the candidate's projects that map directly to the role, with concrete outcomes/metrics.
    3. Concrete proposal (1-2 sentences): something specific the candidate can ship in the first 2-4 weeks if hired.
    4. CTA (1 sentence): suggest a 20-min call, name a specific timeslot range.

If the draft could plausibly be sent to ANY OTHER company without edits, you have failed. Regenerate mentally before finalizing.

Output: the proposal body only. No subject line, no signature, no markdown headers.`;

async function fetchPosting(input: string): Promise<{ text: string; source: string }> {
  if (existsSync(input)) {
    return { text: readFileSync(input, "utf8"), source: input };
  }
  const res = await fetch(input, { headers: { "user-agent": "Mozilla/5.0 jobs-pipeline" } });
  if (!res.ok) throw new Error(`fetch ${input}: HTTP ${res.status}`);
  const html = await res.text();
  const $ = load(html);
  $("script, style, nav, footer, header, svg").remove();
  const text = $("main, article, [class*='job'], [class*='posting'], body").first().text().replace(/\s+/g, " ").trim();
  return { text: text.slice(0, 12000), source: input };
}

function loadContext(): string {
  const parts: string[] = [];
  for (const p of ["CLAUDE.md", "portfolio/README.md"]) {
    if (existsSync(p)) parts.push(`=== ${p} ===\n${readFileSync(p, "utf8")}`);
  }
  if (parts.length === 0) {
    console.error("WARN: no CLAUDE.md or portfolio/README.md found — proposal will be generic.");
  }
  return parts.join("\n\n");
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/https?:\/\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

async function main() {
  const input = process.argv[2];
  if (!input) {
    console.error("usage: tsx bin/propose.ts <url|file>");
    process.exit(1);
  }
  const ctx = loadContext();
  const posting = await fetchPosting(input);

  const user = `CANDIDATE CONTEXT:
${ctx}

JOB POSTING (source: ${posting.source}):
${posting.text}

Draft the proposal now. Remember the rules.`;

  const proposal = await callText(user, { system: SYSTEM, model: DRAFT_MODEL });
  console.log("\n" + proposal + "\n");

  const path = `data/drafts/${slugify(input)}.md`;
  writeText(path, `<!-- source: ${posting.source} -->\n\n${proposal}\n`);
  console.log(`saved -> ${path}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
