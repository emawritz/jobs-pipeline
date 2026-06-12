import type { RawJob } from "../lib/score.ts";

// RemoteFirstJobs (formerly JobsCollider) — free public JSON API, no auth.
// https://remotefirstjobs.com/remote-jobs-api
// Up to 5 pages x 100 jobs each per query; 24-hour posting delay.
// seniority field is structured: "senior", "middle", "junior", etc.
const BASE = "https://remotefirstjobs.com/api/search-jobs";

type RFJJob = {
  id: string;
  url: string;
  company_name: string;
  company_logo?: string | null;
  title: string;
  category: string;
  seniority: string;
  description: string;
  salary_min?: number | null;
  salary_max?: number | null;
  locations?: string[];
  published_at: string;
};

type RFJResponse = {
  page: number;
  jobs_count: number;
  jobs: RFJJob[];
};

const UA = "Mozilla/5.0 jobs-pipeline";
const EXCLUDE = /\b(web3|crypto|blockchain|nft|defi|casino|gambling)\b/i;
const ENG_TITLE =
  /\b(engineer|developer|architect|programmer|sde|swe|fullstack|full-stack|backend|frontend|devops|platform|infrastructure)\b/i;
// Locations that are definitely not LATAM-compatible
const GEO_EXCLUDE = /^(India|China|Japan|South Korea|Singapore|Hong Kong|Philippines)$/i;

function unhtml(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function extractApplyEmail(text: string): string | undefined {
  const m = text.match(/[\w.+-]+@[\w-]+\.[a-z]{2,8}(?![a-zA-Z])/i);
  if (!m) return undefined;
  if (/noreply|donotreply|sentry|remotefirstjobs/i.test(m[0])) return undefined;
  return m[0];
}

function formatSalary(j: RFJJob): string | undefined {
  const mn = j.salary_min ?? 0;
  const mx = j.salary_max ?? 0;
  if (!mn && !mx) return undefined;
  if (mn && mx && mn !== mx) return `$${mn.toLocaleString()}–$${mx.toLocaleString()}`;
  return `$${(mx || mn).toLocaleString()}`;
}

async function fetchPage(query: string, page: number): Promise<RFJJob[]> {
  const params = new URLSearchParams({
    category: "software-development",
    query,
    page: String(page),
  });
  const res = await fetch(`${BASE}?${params}`, {
    headers: { "user-agent": UA, accept: "application/json" },
  });
  if (!res.ok) {
    console.error(`[remotefirstjobs] HTTP ${res.status} query=${query} page=${page}`);
    return [];
  }
  const data = (await res.json()) as RFJResponse;
  return data.jobs ?? [];
}

export async function scrape(): Promise<RawJob[]> {
  // Two queries: "senior engineer" and "staff engineer"
  const queries = ["senior engineer", "staff engineer"];
  // Fetch pages 0-1 per query (up to 200 jobs each) in parallel
  const fetches = queries.flatMap((q) => [fetchPage(q, 0), fetchPage(q, 1)]);
  const results = await Promise.all(fetches);
  const all = results.flat();

  const seen = new Set<string>();
  const out: RawJob[] = [];

  for (const j of all) {
    if (!j.id || !j.url || !j.title) continue;
    if (seen.has(j.id)) continue;
    seen.add(j.id);

    // Only senior/staff seniority
    if (!/^(senior|staff|principal|lead)/i.test(j.seniority ?? "")) continue;

    const desc = unhtml(j.description ?? "");
    const blob = `${j.title} ${desc}`;

    if (EXCLUDE.test(blob)) continue;
    if (!ENG_TITLE.test(j.title)) continue;

    // Skip if ALL locations are geo-excluded
    const locations = j.locations ?? [];
    if (locations.length > 0 && locations.every((l) => GEO_EXCLUDE.test(l))) continue;

    const salary = formatSalary(j);
    const locationStr = locations.length > 0 ? locations.join(", ") : "remote";

    out.push({
      source: "RemoteFirstJobs",
      url: j.url,
      company: j.company_name,
      title: j.title,
      text: [
        `${j.title} @ ${j.company_name ?? "?"} (${locationStr})`,
        `Seniority: ${j.seniority}`,
        salary ? `Salary: ${salary}` : "",
        "",
        desc,
      ]
        .filter(Boolean)
        .join("\n"),
      salary,
      postedAt: j.published_at,
      applyEmail: extractApplyEmail(desc),
      applyUrl: j.url,
    });
  }

  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  scrape().then((jobs) => {
    console.log(`RemoteFirstJobs: ${jobs.length} senior dev jobs`);
    for (const j of jobs.slice(0, 5)) {
      console.log(`\n--- ${j.company} — ${j.title}`);
      if (j.salary) console.log(`    salary: ${j.salary}`);
      if (j.applyEmail) console.log(`    email: ${j.applyEmail}`);
    }
  });
}
