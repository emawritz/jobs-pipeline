import type { RawJob } from "../lib/score.ts";

// Ashby ATS — per-company public JSON API, no auth.
// Each Ashby-hosted company exposes:
//   GET https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true
// Returns all published jobs for that company. No cross-company search API exists;
// we maintain a curated list of remote-friendly engineering companies.
// XML feed also available at:
//   https://app.ashbyhq.com/api/xml-feed/job-postings/organization/{slug}
// We use the JSON API for structured compensation data.
const BASE = "https://api.ashbyhq.com/posting-api/job-board";

// Curated list of Ashby-hosted companies known to be remote-friendly engineering shops.
// Add more slugs as needed — find slugs from jobs.ashbyhq.com/{slug}
const COMPANY_SLUGS = [
  "zapier",
  "notion",
  "linear",
  "posthog",
  "retool",
  "replit",
  "cursor",
  "clay",
  "harvey",
  "mercury",
  "ramp",
  "vanta",
  "confluent",
  "gorgias",
  "coder",
  "hackerone",
  "fullstory",
  "oyster",
  "deel",
  "kong",
  // LATAM-focused or explicitly LATAM-friendly companies (verified Ashby slugs)
  "truelogic",     // Nearshore LATAM staff aug, hires Argentina/Brazil/Colombia engineers
  "openai",        // Global remote, strong AI fit
  "anthropic",     // Global remote, direct stack fit (Claude)
  "perplexity",    // AI-native, remote-friendly
  "modal",         // AI infra, remote-global
  "supabase",      // Open source, distributed team
  "neon",          // Postgres-native, distributed team
  "turso",         // DB startup, distributed
  "runway",        // AI/creative tech, remote
  "baseten",       // AI infra / model serving
];

type AshbyCompensation = {
  minValue?: number | null;
  maxValue?: number | null;
  currency?: string;
  interval?: string;
};

type AshbyJob = {
  id: string;
  title: string;
  isRemote?: boolean;
  workplaceType?: string;
  department?: string;
  team?: string;
  location?: string;
  publishedAt?: string;
  jobUrl?: string;
  applyUrl?: string;
  descriptionPlain?: string;
  descriptionHtml?: string;
  compensation?: {
    compensationTiers?: Array<{
      minValue?: number;
      maxValue?: number;
      currency?: string;
      interval?: string;
    }>;
  };
  company?: string; // injected by us
};

type AshbyResponse = {
  jobs: AshbyJob[];
};

const UA = "Mozilla/5.0 jobs-pipeline";
const SENIOR_HINTS = /\b(senior|sr\.?|staff|principal|lead|founding|head of|tech lead)\b/i;
const ENG_TITLE =
  /\b(engineer|developer|architect|programmer|sde|swe|fullstack|full-stack|backend|frontend|devops|platform|infrastructure|software)\b/i;
const EXCLUDE = /\b(web3|crypto|blockchain|nft|defi|casino|gambling)\b/i;

function unhtml(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim();
}

function extractApplyEmail(text: string): string | undefined {
  const m = text.match(/[\w.+-]+@[\w-]+\.[a-z]{2,8}(?![a-zA-Z])/i);
  if (!m) return undefined;
  if (/noreply|donotreply|sentry|ashby/i.test(m[0])) return undefined;
  return m[0];
}

function formatCompensation(j: AshbyJob): string | undefined {
  const tiers = j.compensation?.compensationTiers ?? [];
  if (tiers.length === 0) return undefined;
  const t = tiers[0];
  if (!t.minValue && !t.maxValue) return undefined;
  const cur = t.currency ?? "USD";
  const period = t.interval === "Year" ? "/yr" : t.interval ? `/${t.interval}` : "/yr";
  if (t.minValue && t.maxValue) {
    return `${cur} ${t.minValue.toLocaleString()}–${t.maxValue.toLocaleString()}${period}`;
  }
  return `${cur} ${(t.minValue ?? t.maxValue)!.toLocaleString()}${period}`;
}

async function fetchCompany(slug: string): Promise<Array<AshbyJob & { _company: string }>> {
  const url = `${BASE}/${slug}?includeCompensation=true`;
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "application/json" },
  });
  if (!res.ok) {
    if (res.status !== 404) {
      console.error(`[ashby] HTTP ${res.status} for slug=${slug}`);
    }
    return [];
  }
  const data = (await res.json()) as AshbyResponse;
  return (data.jobs ?? []).map((j) => ({ ...j, _company: slug }));
}

export async function scrape(): Promise<RawJob[]> {
  const fetched = await Promise.all(COMPANY_SLUGS.map(fetchCompany));
  const all = fetched.flat();

  const seen = new Set<string>();
  const out: RawJob[] = [];

  for (const j of all) {
    if (!j.id || !j.title) continue;
    if (seen.has(j.id)) continue;
    seen.add(j.id);

    // Only remote postings
    if (!j.isRemote && !/remote/i.test(j.workplaceType ?? "")) continue;

    const desc = unhtml(j.descriptionPlain ?? unhtml(j.descriptionHtml ?? ""));
    const blob = `${j.title} ${desc}`;

    if (EXCLUDE.test(blob)) continue;
    if (!ENG_TITLE.test(j.title)) continue;
    if (!SENIOR_HINTS.test(blob)) continue;

    const salary = formatCompensation(j);
    const url = j.jobUrl ?? j.applyUrl ?? `https://jobs.ashbyhq.com/${j._company}/${j.id}`;

    out.push({
      source: "Ashby",
      url,
      company: j._company,
      title: j.title,
      text: [
        `${j.title} @ ${j._company} (${j.location ?? "remote"})`,
        j.department ? `Dept: ${j.department}` : "",
        salary ? `Salary: ${salary}` : "",
        "",
        desc,
      ]
        .filter(Boolean)
        .join("\n"),
      salary,
      postedAt: j.publishedAt,
      applyEmail: extractApplyEmail(desc),
      applyUrl: j.applyUrl ?? url,
    });
  }

  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  scrape().then((jobs) => {
    console.log(`Ashby: ${jobs.length} senior remote dev jobs`);
    for (const j of jobs.slice(0, 5)) {
      console.log(`\n--- ${j.company} — ${j.title}`);
      if (j.salary) console.log(`    salary: ${j.salary}`);
      if (j.applyEmail) console.log(`    email: ${j.applyEmail}`);
    }
  });
}
