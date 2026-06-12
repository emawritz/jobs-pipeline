import type { RawJob } from "../lib/score.ts";

// Himalayas — global remote job board with structured JSON API.
// Pulls software development jobs with seniority filter (Senior / Staff / Principal).
const ENDPOINT = "https://himalayas.app/jobs/api?category=software-development&limit=100&seniority=Senior&seniority=Staff&seniority=Principal&seniority=Lead";

type HJob = {
  title: string;
  excerpt?: string;
  description?: string;
  companyName?: string;
  companySlug?: string;
  employmentType?: string;
  minSalary?: number | null;
  maxSalary?: number | null;
  currency?: string;
  seniority?: string[];
  locationRestrictions?: string[];
  timezoneRestrictions?: number[];
  categories?: string[];
  pubDate?: string;
  applicationLink?: string;
  guid?: string;
};

const UA = "Mozilla/5.0 jobs-pipeline";
const EXCLUDE = /\b(web3|crypto|blockchain|nft|defi|casino|gambling)\b/i;

function unhtml(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim();
}

function extractApplyEmail(text: string): string | undefined {
  const m = text.match(/[\w.+-]+@[\w-]+\.[a-z]{2,8}(?![a-zA-Z])/i);
  if (!m) return undefined;
  if (/noreply|donotreply|sentry/i.test(m[0])) return undefined;
  return m[0];
}

export async function scrape(): Promise<RawJob[]> {
  const res = await fetch(ENDPOINT, { headers: { "user-agent": UA, accept: "application/json" } });
  if (!res.ok) {
    console.error(`[himalayas] HTTP ${res.status}`);
    return [];
  }
  const data = (await res.json()) as { jobs?: HJob[] };
  const jobs = data.jobs ?? [];
  const out: RawJob[] = [];
  for (const j of jobs) {
    if (!j.title) continue;
    const desc = unhtml(j.description ?? j.excerpt ?? "");
    const blob = `${j.title} ${desc}`;
    if (EXCLUDE.test(blob)) continue;

    // Skip jobs that restrict to a single country far from LATAM-friendly.
    const restr = (j.locationRestrictions ?? []).join(" | ").toLowerCase();
    if (restr && /(india only|japan only|china only|korea only|singapore only|hong kong only|^uk$|^ireland$)/.test(restr)) continue;

    const salary =
      j.minSalary && j.maxSalary
        ? `$${j.minSalary.toLocaleString()}-${j.maxSalary.toLocaleString()} ${j.currency ?? ""}`
        : undefined;

    const url = j.applicationLink ?? (j.companySlug ? `https://himalayas.app/companies/${j.companySlug}/jobs/${j.guid ?? ""}` : "");
    if (!url) continue;

    out.push({
      source: "Himalayas",
      url,
      company: j.companyName,
      title: j.title,
      text: `${j.title} @ ${j.companyName ?? "?"}\nSeniority: ${(j.seniority ?? []).join(", ")}\nLocation: ${restr || "remote-anywhere"}\nSalary: ${salary ?? "n/a"}\n\n${desc}`,
      salary,
      postedAt: j.pubDate,
      applyEmail: extractApplyEmail(desc),
      applyUrl: url,
    });
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  scrape().then((jobs) => {
    console.log(`Himalayas: ${jobs.length} senior+ dev jobs`);
    for (const j of jobs.slice(0, 5)) console.log("\n---", j.company, "—", j.title, "—", j.salary);
  });
}
