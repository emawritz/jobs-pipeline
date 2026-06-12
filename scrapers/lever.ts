import type { RawJob } from "../lib/score.ts";

// Lever ATS public postings API — no auth required for GET.
// Each company has its own slug endpoint. There is no cross-company search.
// Maintain SLUGS list: add companies known to hire LATAM/remote engineers.
// Scraper silently skips 404s (company migrated ATS) and 429s (rate limited).

const BASE = "https://api.lever.co/v0/postings";

// Curated list of remote-first companies with known LATAM-friendly hiring.
// Validate periodically — companies migrate ATS. 404 = remove slug.
const SLUGS = [
  "canonical",
  "sourcegraph",
  "descript",
  "linear",
  "mercury",
  "brex",
  "miro",
  "deel",
  "remote",          // Remote.com, the EOR company
  "oyster",
  "loom",
  "retool",
  "vercel",
  "replit",
  "leverdemo",       // Lever's own demo company — good for testing
];

type LeverCategories = {
  commitment?: string;
  department?: string;
  location?: string;
  team?: string;
  allLocations?: string[];
};

type LeverSalaryRange = {
  currency?: string;
  interval?: string;
  min?: number;
  max?: number;
};

type LeverPosting = {
  id: string;
  text: string;
  categories: LeverCategories;
  country?: string;
  workplaceType?: "remote" | "hybrid" | "on-site" | "unspecified";
  hostedUrl: string;
  applyUrl: string;
  description?: string;
  descriptionPlain?: string;
  additional?: string;
  additionalPlain?: string;
  createdAt?: number; // Unix ms
  salaryRange?: LeverSalaryRange;
};

const UA = "Mozilla/5.0 jobs-pipeline";
const SENIOR_HINTS = /\b(senior|sr\.?|staff|principal|lead|founding|head of)\b/i;
const ENG_TITLE =
  /\b(engineer|developer|architect|programmer|sde|swe|fullstack|full-stack|backend|frontend|devops|platform|infrastructure|site reliability)\b/i;
const EXCLUDE = /\b(web3|crypto|blockchain|nft|defi|casino|gambling)\b/i;
// Skip on-site-only roles
const ONSITE_HINT = /\bon.?site\b|in.?office|must.*relocate/i;

function unhtml(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function extractApplyEmail(text: string): string | undefined {
  const m = text.match(/[\w.+-]+@[\w-]+\.[a-z]{2,8}(?![a-zA-Z])/i);
  if (!m) return undefined;
  if (/noreply|donotreply|sentry/i.test(m[0])) return undefined;
  return m[0];
}

function formatSalary(s?: LeverSalaryRange): string | undefined {
  if (!s?.min && !s?.max) return undefined;
  const cur = s.currency ?? "USD";
  const period = s.interval ? `/${s.interval.replace("per-", "")}` : "/yr";
  if (s.min && s.max) {
    return `${cur} ${s.min.toLocaleString()}–${s.max.toLocaleString()}${period}`;
  }
  return `${cur} ${(s.min ?? s.max)!.toLocaleString()}${period}`;
}

async function fetchSlug(slug: string): Promise<RawJob[]> {
  const url = `${BASE}/${slug}?mode=json&limit=250`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "user-agent": UA, accept: "application/json" },
    });
  } catch (err) {
    console.error(`[lever] network error for ${slug}:`, err);
    return [];
  }

  if (res.status === 404) return []; // Company moved ATS, skip silently
  if (res.status === 429) {
    console.warn(`[lever] rate limited on ${slug}, skipping`);
    return [];
  }
  if (!res.ok) {
    console.error(`[lever] HTTP ${res.status} for slug=${slug}`);
    return [];
  }

  const postings = (await res.json()) as LeverPosting[];
  const out: RawJob[] = [];

  // Company display name: capitalize slug (best we can do without extra fetch)
  const company = slug.charAt(0).toUpperCase() + slug.slice(1);

  for (const p of postings) {
    if (!p.id || !p.text || !p.hostedUrl) continue;

    // Filter: remote only
    if (p.workplaceType && p.workplaceType !== "remote" && p.workplaceType !== "unspecified") {
      continue;
    }

    const plainDesc = p.descriptionPlain ?? unhtml(p.description ?? "");
    const plainAdditional = p.additionalPlain ?? unhtml(p.additional ?? "");
    const fullText = `${plainDesc}\n${plainAdditional}`.trim();
    const blob = `${p.text} ${fullText} ${p.categories.location ?? ""}`;

    if (EXCLUDE.test(blob)) continue;
    if (ONSITE_HINT.test(p.categories.location ?? "")) continue;
    if (!ENG_TITLE.test(p.text)) continue;
    if (!SENIOR_HINTS.test(blob)) continue;

    const location = p.categories.location ?? p.categories.allLocations?.join(", ") ?? "remote";
    const salary = formatSalary(p.salaryRange);
    const postedAt = p.createdAt ? new Date(p.createdAt).toISOString().slice(0, 10) : undefined;

    out.push({
      source: "Lever",
      url: p.hostedUrl,
      company,
      title: p.text,
      text: [
        `${p.text} @ ${company} (${location})`,
        salary ? `Salary: ${salary}` : "",
        p.categories.team ? `Team: ${p.categories.team}` : "",
        "",
        fullText,
      ]
        .filter(Boolean)
        .join("\n"),
      salary,
      postedAt,
      applyEmail: extractApplyEmail(fullText),
      applyUrl: p.applyUrl,
    });
  }

  return out;
}

export async function scrape(): Promise<RawJob[]> {
  // Fetch all slugs with limited concurrency (3 at a time) to avoid rate limits
  const CONCURRENCY = 3;
  const all: RawJob[] = [];

  for (let i = 0; i < SLUGS.length; i += CONCURRENCY) {
    const batch = SLUGS.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(fetchSlug));
    all.push(...results.flat());
  }

  // Deduplicate by hostedUrl in case a slug appears twice
  const seen = new Set<string>();
  return all.filter((j) => {
    if (seen.has(j.url)) return false;
    seen.add(j.url);
    return true;
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  scrape().then((jobs) => {
    console.log(`Lever: ${jobs.length} senior dev jobs across ${SLUGS.length} companies`);
    for (const j of jobs.slice(0, 5)) {
      console.log(`\n--- ${j.company} — ${j.title}`);
      if (j.salary) console.log(`    salary: ${j.salary}`);
      if (j.applyEmail) console.log(`    email: ${j.applyEmail}`);
    }
  });
}
