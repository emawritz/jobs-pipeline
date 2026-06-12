import type { RawJob } from "../lib/score.ts";

// Working Nomads exposes a JSON feed of all-remote jobs by category.
const FEED = "https://www.workingnomads.com/api/exposed_jobs/?category=development";

type WNJob = {
  url: string;
  title: string;
  description: string;
  company_name?: string;
  category_name?: string;
  tags?: string;
  location?: string;
  pub_date?: string;
};

const UA = "Mozilla/5.0 jobs-pipeline";
const SENIOR_HINTS = /\b(senior|sr\.?|staff|principal|lead|founding|head of)\b/i;
const ENG_TITLE = /\b(engineer|developer|architect|programmer|sde|swe|fullstack|full-stack|backend|frontend|devops)\b/i;
const EXCLUDE = /\b(web3|crypto|blockchain|nft|defi|casino|gambling)\b/i;

function unhtml(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function extractApplyEmail(text: string): string | undefined {
  const m = text.match(/[\w.+-]+@[\w-]+\.[a-z]{2,8}(?![a-zA-Z])/i);
  if (!m) return undefined;
  if (/noreply|donotreply|sentry/i.test(m[0])) return undefined;
  return m[0];
}

export async function scrape(): Promise<RawJob[]> {
  const res = await fetch(FEED, { headers: { "user-agent": UA, accept: "application/json" } });
  if (!res.ok) {
    console.error(`[workingnomads] HTTP ${res.status}`);
    return [];
  }
  const data = (await res.json()) as WNJob[];
  const out: RawJob[] = [];
  for (const j of data) {
    if (!j.title || !j.url) continue;
    const desc = unhtml(j.description ?? "");
    const blob = `${j.title} ${desc} ${j.tags ?? ""}`;
    if (EXCLUDE.test(blob)) continue;
    if (!ENG_TITLE.test(j.title)) continue;
    if (!SENIOR_HINTS.test(blob)) continue;
    out.push({
      source: "WorkingNomads",
      url: j.url,
      company: j.company_name,
      title: j.title,
      text: `${j.title} @ ${j.company_name ?? "?"} (${j.location ?? "remote"})\nTags: ${j.tags ?? ""}\n\n${desc}`,
      postedAt: j.pub_date,
      applyEmail: extractApplyEmail(desc),
      applyUrl: j.url,
    });
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  scrape().then((jobs) => {
    console.log(`WorkingNomads: ${jobs.length} senior dev jobs`);
    for (const j of jobs.slice(0, 5)) console.log("\n---", j.company, "—", j.title);
  });
}
