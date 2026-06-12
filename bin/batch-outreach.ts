import { readFileSync, existsSync } from "node:fs";
import { callText, DRAFT_MODEL } from "../lib/claude.ts";
import { writeText } from "../lib/storage.ts";

const TARGETS_PATHS = ["outreach/targets.md", "outreach/targets-v2.md", "outreach/targets-v3.md"];
const OUTPUT_DIR = "outreach";
const BATCH_SIZE = 4;

const SYSTEM = `You draft cold LinkedIn outreach messages from the candidate (senior product engineer) to a founder/CTO.

NON-NEGOTIABLE RULES:
- Max 80 words. Hard cap. Shorter is better.
- BANNED words/phrases: "passionate", "I came across", "I noticed", "love what you're doing", "would love to connect", "perfect fit", "synergy", "leverage", "rockstar", "ninja", "exciting opportunity", "reach out", "huge fan".
- MUST reference ONE specific thing about the target company taken from the context provided — not "your company is interesting." Use the stack signal, the outreach angle, or the hiring signal.
- Structure (no labels, just flowing prose):
    1. Specific hook (1-2 sentences): cite the specific thing about THEIR product/post/role + a 1-sentence signal of the candidate's relevance grounded in evidence.
    2. Concrete value (1-2 sentences): one specific thing he could ship or help with in the first 2-4 weeks.
    3. Soft CTA (1 sentence): suggest 15-20 min call OR offer to send a short Loom, no pressure.

Tone: casual professional. Peer-to-peer, not supplicant. No emojis. No greeting line. No signature.
Output: the message body only. Start directly with the hook.`;

type Target = {
  num: number;
  name: string;
  body: string;
};

function loadContext(): string {
  const parts: string[] = [];
  for (const p of ["CLAUDE.md", "portfolio/README.md"]) {
    if (existsSync(p)) parts.push(`=== ${p} ===\n${readFileSync(p, "utf8")}`);
  }
  return parts.join("\n\n");
}

function parseTargets(md: string): Target[] {
  const out: Target[] = [];
  const lines = md.split("\n");
  let current: Target | null = null;
  for (const line of lines) {
    const m = line.match(/^##\s+(\d+)\.\s+(.+)$/);
    if (m) {
      const num = Number(m[1]);
      const name = m[2].trim();
      // Skip cross-references like "## 4. Windmill (already #1) — see above"
      if (/already #|see above|swap/i.test(name)) continue;
      if (current) out.push(current);
      current = { num, name: name.replace(/\s*[-—–]\s*.*$/, "").trim(), body: "" };
      continue;
    }
    // Stop adding body when we hit the next "##" section or a "---" divider followed by big blocks
    if (current) {
      if (/^#\s+/.test(line) || /^## (?!\d)/.test(line)) {
        out.push(current);
        current = null;
        continue;
      }
      current.body += line + "\n";
    }
  }
  if (current) out.push(current);
  // Dedupe by name (some agent-generated dupes), keep first
  const seen = new Set<string>();
  return out.filter((t) => {
    const key = t.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
}

async function generateOne(t: Target, ctx: string): Promise<string> {
  const user = `CANDIDATE CONTEXT (this is who is sending the message — full MASTER profile):
${ctx}

TARGET COMPANY (use the specifics from here in the hook):
Company: ${t.name}

Details from research:
${t.body.trim()}

Draft the 80-word cold outreach message now. Start directly with the hook — no greeting line.`;

  return await callText(user, { system: SYSTEM, model: DRAFT_MODEL });
}

async function main() {
  const ctx = loadContext();
  if (!ctx || ctx.length < 100) {
    console.error("CLAUDE.md missing or incomplete — refusing to draft generic messages");
    process.exit(1);
  }
  let targets: Target[] = [];
  let offset = 0;
  for (const path of TARGETS_PATHS) {
    if (!existsSync(path)) continue;
    const parsed = parseTargets(readFileSync(path, "utf8")).map((t) => ({ ...t, num: t.num + offset }));
    console.log(`  ${path}: ${parsed.length} targets (offset +${offset})`);
    targets.push(...parsed);
    offset += 100; // v2 → 101+, v3 → 201+, etc.
  }
  // Dedupe by company name
  const seen = new Set<string>();
  targets = targets.filter((t) => {
    const k = t.name.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  console.log(`total: ${targets.length} unique targets`);
  // Only generate for targets that don't already have a message file
  const padded = (n: number) => String(n).padStart(2, "0");
  const dir = OUTPUT_DIR;
  const fs = await import("node:fs");
  targets = targets.filter((t) => {
    const existing = fs.readdirSync(dir).some((f) => f.startsWith(`${padded(t.num)}-`));
    return !existing;
  });
  console.log(`to draft: ${targets.length} (skipping ones that already have a message)`);
  if (targets.length === 0) {
    console.log("nothing to draft.");
    return;
  }

  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const batch = targets.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(batch.map((t) => generateOne(t, ctx)));
    results.forEach((r, k) => {
      const t = batch[k];
      const fname = `${OUTPUT_DIR}/${padded(t.num)}-${slugify(t.name)}.md`;
      if (r.status === "fulfilled") {
        const header = `<!-- target: ${t.name} -->\n<!-- generated: ${new Date().toISOString()} -->\n\n`;
        writeText(fname, header + r.value + "\n");
        console.log(`✓ ${fname}`);
      } else {
        console.error(`✗ ${t.name}:`, (r.reason as Error).message);
      }
    });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
