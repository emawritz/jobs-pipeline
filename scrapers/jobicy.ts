import type { RawJob } from "../lib/score.ts";

// Jobicy public JSON API — no auth, up to 50 results per call.
// JSON API preferred over RSS: includes structured salary, jobLevel, jobGeo.
const API = "https://jobicy.com/api/v2/remote-jobs";

type JobicyJob = {
  id: number;
  url: string;
  jobSlug: string;
  jobTitle: string;
  companyName: string;
  companyLogo?: string;
  jobIndustry: string[];
  jobType: string[];
  jobGeo: string;
  jobLevel: string;
  jobExcerpt: string;
  jobDescription: string;
  pubDate: string;
  salaryMin?: number;
  salaryMax?: number;
  salaryCurrency?: string;
  salaryPeriod?: string;
};

const UA = "Mozilla/5.0 jobs-pipeline";
const SENIOR_HINTS = /\b(senior|sr\.?|staff|principal|lead|founding|head of)\b/i;
const ENG_TITLE =
  /\b(engineer|developer|architect|programmer|sde|swe|fullstack|full-stack|backend|frontend|devops|platform|infrastructure)\b/i;
const EXCLUDE = /\b(web3|crypto|blockchain|nft|defi|casino|gambling)\b/i;
// Jobicy often includes security/clearance roles with restricted geography
const GEO_EXCLUDE = /\b(US-W2|clearance|secret|top secret)\b/i;

function unhtml(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function extractApplyEmail(text: string): string | undefined {
  const m = text.match(/[\w.+-]+@[\w-]+\.[a-z]{2,8}(?![a-zA-Z])/i);
  if (!m) return undefined;
  if (/noreply|donotreply|sentry/i.test(m[0])) return undefined;
  return m[0];
}

function formatSalary(j: JobicyJob): string | undefined {
  if (!j.salaryMin && !j.salaryMax) return undefined;
  const cur = j.salaryCurrency ?? "USD";
  const period = j.salaryPeriod === "yearly" ? "/yr" : `/${j.salaryPeriod ?? "yr"}`;
  if (j.salaryMin && j.salaryMax) {
    return `${cur} ${j.salaryMin.toLocaleString()}–${j.salaryMax.toLocaleString()}${period}`;
  }
  return `${cur} ${(j.salaryMin ?? j.salaryMax)!.toLocaleString()}${period}`;
}

async function fetchJobs(tag: string): Promise<JobicyJob[]> {
  const params = new URLSearchParams({
    count: "50",
    industry: "dev",
    tag,
  });
  const res = await fetch(`${API}?${params}`, {
    headers: { "user-agent": UA, accept: "application/json" },
  });
  if (!res.ok) {
    console.error(`[jobicy] HTTP ${res.status} for tag=${tag}`);
    return [];
  }
  const data = await res.json() as { jobs?: JobicyJob[] };
  return data.jobs ?? [];
}

export async function scrape(): Promise<RawJob[]> {
  // Use multiple search tags to widen senior coverage
  const tags = ["senior", "staff engineer", "principal", "lead engineer"];
  const fetched = await Promise.all(tags.map(fetchJobs));
  const all = fetched.flat();

  const seen = new Set<number>();
  const out: RawJob[] = [];

  for (const j of all) {
    if (!j.id || !j.url || !j.jobTitle) continue;
    if (seen.has(j.id)) continue;
    seen.add(j.id);

    const desc = unhtml(j.jobDescription ?? j.jobExcerpt ?? "");
    const blob = `${j.jobTitle} ${desc} ${j.jobGeo ?? ""}`;

    if (EXCLUDE.test(blob)) continue;
    if (GEO_EXCLUDE.test(blob)) continue;
    if (!ENG_TITLE.test(j.jobTitle)) continue;
    // jobLevel field is pre-filtered by Jobicy, but also check description for misses
    if (!SENIOR_HINTS.test(blob) && !/senior/i.test(j.jobLevel ?? "")) continue;

    const salary = formatSalary(j);

    out.push({
      source: "Jobicy",
      url: j.url,
      company: j.companyName,
      title: j.jobTitle,
      text: [
        `${j.jobTitle} @ ${j.companyName ?? "?"} (${j.jobGeo || "remote"})`,
        salary ? `Salary: ${salary}` : "",
        `Level: ${j.jobLevel || "not specified"}`,
        "",
        desc,
      ]
        .filter(Boolean)
        .join("\n"),
      salary,
      postedAt: j.pubDate,
      applyEmail: extractApplyEmail(desc),
      applyUrl: j.url,
    });
  }

  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  scrape().then((jobs) => {
    console.log(`Jobicy: ${jobs.length} senior dev jobs`);
    for (const j of jobs.slice(0, 5)) {
      console.log(`\n--- ${j.company} — ${j.title}`);
      if (j.salary) console.log(`    salary: ${j.salary}`);
      if (j.applyEmail) console.log(`    email: ${j.applyEmail}`);
    }
  });
}
