import type { RawJob } from "../lib/score.ts";

// Arbeitnow — European job board with public unauthenticated JSON API.
// Skewed toward DE/EU companies but includes remote-globally postings.
// https://www.arbeitnow.com/blog/job-board-api
// No auth. No rate limit documented. Pages are 25-100 jobs each.
// `remote` boolean filter is supported. No seniority filter — we apply our own.
const BASE = "https://www.arbeitnow.com/api/job-board-api";
const MAX_PAGES = 8; // generous ceiling; stop early when no remote jobs found

type ArbeitnowJob = {
  slug: string;
  company_name: string;
  title: string;
  description: string;
  remote: boolean;
  url: string;
  tags: string[];
  job_types: string[];
  location: string;
  created_at: number;
};

type ArbeitnowResponse = {
  data: ArbeitnowJob[];
  links?: unknown;
};

const UA = "Mozilla/5.0 jobs-pipeline";
const SENIOR_HINTS = /\b(senior|sr\.?|staff|principal|lead|founding|head of|tech lead)\b/i;
const ENG_TITLE =
  /\b(engineer|developer|architect|programmer|sde|swe|fullstack|full-stack|backend|frontend|devops|platform|infrastructure|software)\b/i;
const EXCLUDE = /\b(web3|crypto|blockchain|nft|defi|casino|gambling)\b/i;
// Skip EU-only hard restrictions (German text jobs are acceptable, but skip
// roles explicitly requiring residence in DE/AT/CH with no remote option)
const EU_ONLY_RESTR = /\b(nur.*deutschland|only.*germany|wohnsitz.*deutschland|must.*reside.*germany)\b/i;

function unhtml(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim();
}

function extractApplyEmail(text: string): string | undefined {
  const m = text.match(/[\w.+-]+@[\w-]+\.[a-z]{2,8}(?![a-zA-Z])/i);
  if (!m) return undefined;
  if (/noreply|donotreply|sentry|arbeitnow/i.test(m[0])) return undefined;
  return m[0];
}

async function fetchPage(page: number): Promise<ArbeitnowJob[]> {
  const params = new URLSearchParams({ remote: "true", page: String(page) });
  const res = await fetch(`${BASE}?${params}`, {
    headers: { "user-agent": UA, accept: "application/json" },
  });
  if (!res.ok) {
    console.error(`[arbeitnow] HTTP ${res.status} page=${page}`);
    return [];
  }
  const data = (await res.json()) as ArbeitnowResponse;
  return data.data ?? [];
}

export async function scrape(): Promise<RawJob[]> {
  const seen = new Set<string>();
  const out: RawJob[] = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const jobs = await fetchPage(page);
    if (jobs.length === 0) break;

    let remoteCount = 0;
    for (const j of jobs) {
      if (!j.slug || !j.url || !j.title) continue;
      if (seen.has(j.slug)) continue;
      seen.add(j.slug);

      // API has `remote` filter but may still mix in on-site
      if (!j.remote) continue;
      remoteCount++;

      const desc = unhtml(j.description ?? "");
      const blob = `${j.title} ${desc} ${(j.tags ?? []).join(" ")}`;

      if (EXCLUDE.test(blob)) continue;
      if (EU_ONLY_RESTR.test(desc.toLowerCase())) continue;
      if (!ENG_TITLE.test(j.title)) continue;
      if (!SENIOR_HINTS.test(blob)) continue;

      const postedAt = j.created_at
        ? new Date(j.created_at * 1000).toISOString()
        : undefined;

      out.push({
        source: "Arbeitnow",
        url: j.url,
        company: j.company_name,
        title: j.title,
        text: [
          `${j.title} @ ${j.company_name ?? "?"} (${j.location || "remote"})`,
          `Tags: ${(j.tags ?? []).join(", ")}`,
          `Type: ${(j.job_types ?? []).join(", ")}`,
          "",
          desc,
        ]
          .filter(Boolean)
          .join("\n"),
        postedAt,
        applyEmail: extractApplyEmail(desc),
        applyUrl: j.url,
      });
    }

    // Arbeitnow does not expose pagination metadata. If the page had very
    // few remote jobs, it's likely near the end of the remote-filtered set.
    if (remoteCount < 3) break;
  }

  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  scrape().then((jobs) => {
    console.log(`Arbeitnow: ${jobs.length} senior remote dev jobs`);
    for (const j of jobs.slice(0, 5)) {
      console.log(`\n--- ${j.company} — ${j.title}`);
      if (j.applyEmail) console.log(`    email: ${j.applyEmail}`);
    }
  });
}
