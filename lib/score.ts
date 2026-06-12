import { callJSON, SCORE_MODEL } from "./claude.ts";

export type RawJob = {
  source: string;
  url: string;
  company?: string;
  title?: string;
  text: string;
  salary?: string;
  postedAt?: string;
  // For aggregators like HN: the actual application URL or email,
  // extracted from the post body. Lets the dashboard open the real page.
  applyUrl?: string;
  applyEmail?: string;
};

export type Score = {
  total: number;
  stackFit: number;
  seniorityFit: number;
  compensation: number;
  companyStage: number;
  redFlags: number;
  oneLiner: string;
  flags: string[];
};

// CUSTOMIZE: adjust the rubric stack/preferences to match your MASTER profile.
// The default below is a senior full-stack / AI engineer preset — change the
// stack keywords + salary band + timezone to fit your situation.
const RUBRIC = `You score job postings for a senior product engineer / builder
(see MASTER profile for full context: stack, location, comp band, async preference, target market).

Default stack profile: TypeScript / Node / NestJS / Postgres / AI orchestration with Claude. Replace these with YOUR stack.

SCORING RUBRIC (return strict JSON):

stackFit (-15 to 40):
  +15 TypeScript, +10 Svelte or Angular, +10 Node/NestJS, +5 Postgres, +5 Rust/Tauri, +5 if AI/LLM agentic
  -10 React-only role, -15 Java/.NET shop, -5 PHP shop

seniorityFit (-20 to 25):
  +25 Senior/Staff/Lead/Founding/Principal, +10 Mid, -20 Junior, 0 if unclear

compensation (-10 to 15):
  +15 USD explicit (range or floor), +5 "competitive"/"market-rate", 0 no info, -10 local-currency-only or "we discuss"

companyStage (-5 to 10):
  +10 Seed/Series A/Series B, +5 Series C, 0 unknown, -5 agency/consultancy/dev-shop

redFlags (-15 to 0, negative):
  -3 each: "rockstar"/"ninja", unpaid trial, equity-only, >5 interview rounds, PST-only schedule, US-W2-only, on-site required

ALSO produce:
- flags array: short tags like "USD", "LATAM-OK", "REMOTE", "VISA-REQUIRED", "REACT-ONLY", "BIG-CORP", "DEV-TOOL", "AI-STARTUP"
- oneLiner: 1 sentence (max 25 words) why this scored as it did

Total = stackFit + seniorityFit + compensation + companyStage + redFlags. Clamp 0-100.

Output ONLY this JSON:
{"total":N,"stackFit":N,"seniorityFit":N,"compensation":N,"companyStage":N,"redFlags":N,"flags":["..."],"oneLiner":"..."}`;

export async function scoreJob(job: RawJob): Promise<Score> {
  const user = `Job source: ${job.source}
Company: ${job.company ?? "unknown"}
Title: ${job.title ?? "unknown"}
URL: ${job.url}
Salary: ${job.salary ?? "not stated"}

POSTING:
${job.text.slice(0, 4000)}`;

  const out = await callJSON<Score>(user, { system: RUBRIC, model: SCORE_MODEL });
  out.total = Math.max(0, Math.min(100, Math.round(out.total)));
  return out;
}
