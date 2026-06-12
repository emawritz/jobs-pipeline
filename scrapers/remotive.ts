import type { RawJob } from "../lib/score.ts";

// Remotive public JSON API — no auth, max 4 requests/day or risk ban.
// 24-hour data delay is intentional (API ToS).
const BASE = "https://remotive.com/api/remote-jobs";
const CATEGORIES = ["software-dev", "devops-sysadmin"];

type RemotiveJob = {
  id: number;
  url: string;
  title: string;
  company_name: string;
  category: string;
  tags: string[];
  job_type: string;
  publication_date: string;
  candidate_required_location: string;
  salary: string;
  description: string;
};

const UA = "Mozilla/5.0 jobs-pipeline";
const SENIOR_HINTS = /\b(senior|sr\.?|staff|principal|lead|founding|head of)\b/i;
const ENG_TITLE = /\b(engineer|developer|architect|programmer|sde|swe|fullstack|full-stack|backend|frontend|devops|platform|infrastructure)\b/i;
const EXCLUDE = /\b(web3|crypto|blockchain|nft|defi|casino|gambling)\b/i;

// Remotive obfuscates some emails as "word(at)domain(dot)com"
function deobfuscate(s: string): string {
  return s.replace(/\(at\)/gi, "@").replace(/\(dot\)/gi, ".");
}

function unhtml(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function extractApplyEmail(text: string): string | undefined {
  const clean = deobfuscate(text);
  const m = clean.match(/[\w.+-]+@[\w-]+\.[a-z]{2,8}(?![a-zA-Z])/i);
  if (!m) return undefined;
  if (/noreply|donotreply|sentry|remotive/i.test(m[0])) return undefined;
  return m[0];
}

async function fetchCategory(category: string): Promise<RemotiveJob[]> {
  const url = `${BASE}?category=${encodeURIComponent(category)}&limit=100`;
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "application/json" },
  });
  if (!res.ok) {
    console.error(`[remotive] HTTP ${res.status} for category=${category}`);
    return [];
  }
  const data = await res.json() as { jobs?: RemotiveJob[] };
  return data.jobs ?? [];
}

export async function scrape(): Promise<RawJob[]> {
  const fetched = await Promise.all(CATEGORIES.map(fetchCategory));
  const all = fetched.flat();

  // Deduplicate by id across categories
  const seen = new Set<number>();
  const out: RawJob[] = [];

  for (const j of all) {
    if (!j.id || !j.url || !j.title) continue;
    if (seen.has(j.id)) continue;
    seen.add(j.id);

    const desc = unhtml(j.description ?? "");
    const blob = `${j.title} ${desc} ${(j.tags ?? []).join(" ")}`;

    if (EXCLUDE.test(blob)) continue;
    if (!ENG_TITLE.test(j.title)) continue;
    if (!SENIOR_HINTS.test(blob)) continue;

    const location = j.candidate_required_location ?? "";
    const salary = j.salary?.trim() || undefined;

    out.push({
      source: "Remotive",
      url: j.url,
      company: j.company_name,
      title: j.title,
      text: [
        `${j.title} @ ${j.company_name ?? "?"} (${location || "remote"})`,
        `Tags: ${(j.tags ?? []).join(", ")}`,
        salary ? `Salary: ${salary}` : "",
        "",
        desc,
      ]
        .filter(Boolean)
        .join("\n"),
      salary,
      postedAt: j.publication_date,
      applyEmail: extractApplyEmail(desc),
      applyUrl: j.url,
    });
  }

  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  scrape().then((jobs) => {
    console.log(`Remotive: ${jobs.length} senior dev jobs`);
    for (const j of jobs.slice(0, 5)) {
      console.log(`\n--- ${j.company} — ${j.title}`);
      if (j.applyEmail) console.log(`    email: ${j.applyEmail}`);
    }
  });
}
