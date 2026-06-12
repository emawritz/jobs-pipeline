// bin/prompt-iterate.ts
//
// The self-iteration loop. Pulls the last N applications + their outcomes
// (replied / bounced / ghosted), pairs them with the cover letter that was
// drafted for each, and asks Claude (via Code CLI) to critique the active
// system prompt and propose a v2.
//
// HARD RULES:
//   - Never overwrites an existing prompt version file.
//   - Never auto-activates the new version. The output is a *suggestion*
//     written to data/prompt-iterations/<timestamp>.md for human review.
//   - Promotion to active happens via the panel (or `npm run prompt-activate`).
//
// Usage:
//   npx tsx bin/prompt-iterate.ts                         # cover-letter-en, default sample
//   npx tsx bin/prompt-iterate.ts --key=cover-letter-es
//   npx tsx bin/prompt-iterate.ts --sample=50
//   npx tsx bin/prompt-iterate.ts --dry-run               # don't write file, just print

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { callText, DRAFT_MODEL } from "../lib/claude.ts";
import { listCoverLetters, type CoverLetterRecord } from "../lib/cover-letter-store.ts";
import { getActivePrompt, listVersions } from "../lib/prompts/registry.ts";
import type { PromptKey } from "../lib/prompts/types.ts";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APPS_PATH = join(PROJECT_ROOT, "data", "applications.json");
const ITER_DIR = join(PROJECT_ROOT, "data", "prompt-iterations");
const PROMPTS_DIR = join(PROJECT_ROOT, "lib", "prompts");

type Application = {
  id: string;
  url: string;
  platform: string;
  company?: string;
  title?: string;
  status: string;     // applied / replied / bounced / ghosted / send-error
  appliedAt: string;
  lastUpdate: string;
  notes: string[];
};

function arg(flag: string, def?: string): string | undefined {
  const m = process.argv.find((a) => a.startsWith(`${flag}=`));
  return m ? m.split("=")[1] : def;
}
function has(flag: string): boolean {
  return process.argv.includes(flag);
}

function loadApps(): Application[] {
  if (!existsSync(APPS_PATH)) return [];
  try { return JSON.parse(readFileSync(APPS_PATH, "utf8")) as Application[]; } catch { return []; }
}

type PairedSample = {
  appId: string;
  company: string;
  title: string;
  outcome: "replied" | "bounced" | "ghosted";
  coverLetter: CoverLetterRecord;
  jobUrl: string;
  daysSinceApplied: number;
};

function pair(apps: Application[], coverLetters: CoverLetterRecord[], promptKey: PromptKey): PairedSample[] {
  const clByApp = new Map<string, CoverLetterRecord>();
  for (const cl of coverLetters) {
    if (cl.promptKey === promptKey) clByApp.set(cl.appId, cl);
  }
  const out: PairedSample[] = [];
  for (const a of apps) {
    const cl = clByApp.get(a.id);
    if (!cl) continue;
    let outcome: PairedSample["outcome"] | null = null;
    if (a.status === "replied") outcome = "replied";
    else if (a.status === "bounced") outcome = "bounced";
    else if (a.status === "applied") outcome = "ghosted"; // proxy: applied + no reply yet
    if (!outcome) continue;
    const days = Math.floor((Date.now() - new Date(a.appliedAt).getTime()) / 86400000);
    // Only count "ghosted" if > 7 days without reply — otherwise too early to judge.
    if (outcome === "ghosted" && days < 7) continue;
    out.push({
      appId: a.id,
      company: a.company ?? "?",
      title: a.title ?? "?",
      outcome,
      coverLetter: cl,
      jobUrl: a.url,
      daysSinceApplied: days,
    });
  }
  // Sort newest first.
  out.sort((a, b) => (a.coverLetter.generatedAt < b.coverLetter.generatedAt ? 1 : -1));
  return out;
}

const CRITIC_SYSTEM = `You are a prompt engineer reviewing a job application agent's cover-letter system prompt and the actual results it produced.

You will be given:
- The CURRENT active system prompt.
- A sample of cover letters the agent drafted, each labeled with the outcome (replied / bounced / ghosted).

Your job: analyze patterns. Identify the traits that correlate with REPLIED vs GHOSTED outcomes. Then propose a REVISED system prompt that should improve the reply rate.

GUARDRAILS (non-negotiable):
- Do not weaken the truthfulness rules. Do not allow the agent to invent projects or metrics.
- Do not weaken the BANNED phrases list.
- Keep the same output format constraints (plain text only, length bounds, no markdown, etc).
- Changes must be small, specific, and justified by patterns in the sample. Do not rewrite the whole prompt.
- If the sample is too small (< 10 with outcomes) or shows no clear pattern, say so honestly and return the prompt unchanged.

OUTPUT a JSON object with this shape — strictly. No prose outside the JSON.

{
  "sampleSize": <int>,
  "repliedCount": <int>,
  "bouncedCount": <int>,
  "ghostedCount": <int>,
  "findings": [
    "specific pattern observed (1-2 sentences). cite outcomes."
  ],
  "verdict": "iterate" | "keep" | "insufficient-data",
  "proposedPromptDiff": "human-readable summary of what changed in the prompt and why",
  "proposedSystemPrompt": "<the full revised system prompt as a single string>"
}`;

function formatSampleForCritic(prompt: string, samples: PairedSample[]): string {
  const lines: string[] = [];
  lines.push("=== CURRENT ACTIVE SYSTEM PROMPT ===");
  lines.push(prompt);
  lines.push("");
  lines.push("=== SAMPLE OF DRAFTED COVER LETTERS WITH OUTCOMES ===");
  for (const s of samples) {
    lines.push("");
    lines.push(`--- [${s.outcome.toUpperCase()}] ${s.company} — ${s.title} (${s.daysSinceApplied}d) ---`);
    lines.push(`Job snippet: ${s.coverLetter.jobTextSnippet.slice(0, 300)}`);
    lines.push(`Cover letter (${s.coverLetter.body.length} chars):`);
    lines.push(s.coverLetter.body);
  }
  lines.push("");
  lines.push("=== TASK ===");
  lines.push("Analyze the patterns and produce the JSON output as specified.");
  return lines.join("\n");
}

function bumpMinor(version: string): string {
  const parts = version.split(".").map((n) => parseInt(n, 10) || 0);
  while (parts.length < 3) parts.push(0);
  parts[1] += 1;
  parts[2] = 0;
  return parts.join(".");
}

type CritiqueOut = {
  sampleSize: number;
  repliedCount: number;
  bouncedCount: number;
  ghostedCount: number;
  findings: string[];
  verdict: "iterate" | "keep" | "insufficient-data";
  proposedPromptDiff: string;
  proposedSystemPrompt: string;
};

async function main() {
  const key = (arg("--key", "cover-letter-en") as PromptKey);
  const sampleCap = parseInt(arg("--sample", "30") ?? "30", 10);
  const dryRun = has("--dry-run");

  console.log(`[prompt-iterate] key=${key} sample=${sampleCap} dryRun=${dryRun}`);

  const active = await getActivePrompt(key);
  console.log(`  active version: ${active.version}`);

  const apps = loadApps();
  const allLetters = listCoverLetters();
  console.log(`  total apps: ${apps.length} · total cover letters: ${allLetters.length}`);

  const paired = pair(apps, allLetters, key).slice(0, sampleCap);
  const replied = paired.filter((p) => p.outcome === "replied").length;
  const bounced = paired.filter((p) => p.outcome === "bounced").length;
  const ghosted = paired.filter((p) => p.outcome === "ghosted").length;
  console.log(`  sample: ${paired.length} (replied=${replied} bounced=${bounced} ghosted=${ghosted})`);

  if (paired.length < 10) {
    console.log(`  ✗ not enough sample data yet (${paired.length} < 10). Apply to more jobs first.`);
    process.exit(1);
  }

  const userPrompt = formatSampleForCritic(active.systemPrompt, paired);

  console.log(`  → calling Claude (model=${DRAFT_MODEL})...`);
  let raw = await callText(userPrompt, { system: CRITIC_SYSTEM, model: DRAFT_MODEL, timeoutMs: 300000 });
  // Strip code fences if Claude wrapped the JSON.
  raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  let parsed: CritiqueOut;
  try {
    parsed = JSON.parse(raw) as CritiqueOut;
  } catch (e) {
    console.error(`  ✗ failed to parse Claude JSON: ${(e as Error).message}`);
    console.error(`  raw output (first 800 chars):\n${raw.slice(0, 800)}`);
    process.exit(2);
  }

  const iterationId = `${key}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
  const newVersion = bumpMinor(active.version);

  mkdirSync(ITER_DIR, { recursive: true });
  const reportPath = join(ITER_DIR, `${iterationId}.md`);
  const report = [
    `# Prompt iteration: ${key}`,
    "",
    `- Iteration ID: \`${iterationId}\``,
    `- Active version: \`${active.version}\``,
    `- Proposed version: \`${newVersion}\``,
    `- Verdict: **${parsed.verdict}**`,
    `- Sample: ${paired.length} (replied=${replied}, bounced=${bounced}, ghosted=${ghosted})`,
    `- Generated at: ${new Date().toISOString()}`,
    "",
    "## Findings",
    "",
    ...parsed.findings.map((f) => `- ${f}`),
    "",
    "## Proposed diff (human-readable)",
    "",
    parsed.proposedPromptDiff,
    "",
    "## Proposed system prompt (full)",
    "",
    "```",
    parsed.proposedSystemPrompt,
    "```",
    "",
    "## How to promote",
    "",
    "Review the prompt above. If you want to ship it, run:",
    "",
    "```bash",
    `npm run prompt-activate -- --key=${key} --version=${newVersion}`,
    "```",
    "",
    "Or use the **Prompts** tab in the panel to approve with one click.",
  ].join("\n");

  if (dryRun) {
    console.log(`\n${report}\n`);
    console.log(`  (dry-run, nothing written)`);
    return;
  }

  writeFileSync(reportPath, report);
  console.log(`  ✓ wrote ${reportPath}`);

  // Also write the candidate prompt as a versioned .json file (NOT activated).
  // JSON (not .ts) so the registry can read it under Vite plugin host where
  // dynamic import doesn't pick up runtime-written files.
  if (parsed.verdict === "iterate") {
    const promptFile = join(PROMPTS_DIR, `${key}.v${newVersion}.json`);
    if (existsSync(promptFile)) {
      console.log(`  ✗ ${promptFile} already exists, refusing to overwrite`);
    } else {
      const candidate = {
        key,
        version: newVersion,
        createdAt: new Date().toISOString(),
        parentVersion: active.version,
        notes: parsed.proposedPromptDiff,
        derivedFrom: {
          iterationId,
          sampleSize: paired.length,
          replyRate: replied / Math.max(1, replied + ghosted),
        },
        systemPrompt: parsed.proposedSystemPrompt,
      };
      writeFileSync(promptFile, JSON.stringify(candidate, null, 2));
      console.log(`  ✓ wrote ${promptFile} (not activated yet)`);
    }
  }

  console.log(`\n──────────────`);
  console.log(`  Verdict: ${parsed.verdict.toUpperCase()}`);
  console.log(`  Read the full report: ${reportPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
