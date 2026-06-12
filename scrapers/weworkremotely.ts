import type { RawJob } from "../lib/score.ts";
import { load } from "cheerio";

// WeWorkRemotely RSS feeds — global remote jobs, dev-heavy. Multiple categories
// to cast a wide net.
const FEEDS = [
  "https://weworkremotely.com/categories/remote-programming-jobs.rss",
  "https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss",
  "https://weworkremotely.com/categories/remote-back-end-programming-jobs.rss",
  "https://weworkremotely.com/categories/remote-front-end-programming-jobs.rss",
  "https://weworkremotely.com/categories/remote-devops-sysadmin-jobs.rss",
];

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const SENIOR_HINTS = /\b(senior|sr\.?|staff|principal|lead|founding|head of)\b/i;
const ENG_TITLE = /\b(engineer|developer|architect|programmer|sde|swe|fullstack|full-stack|backend|frontend|devops)\b/i;
const EXCLUDE = /\b(web3|crypto|blockchain|nft|defi|casino|gambling)\b/i;

function unhtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function extractApplyEmail(text: string): string | undefined {
  const m = text.match(/[\w.+-]+@[\w-]+\.[a-z]{2,8}(?![a-zA-Z])/i);
  if (!m) return undefined;
  if (/noreply|donotreply|sentry/i.test(m[0])) return undefined;
  return m[0];
}

async function scrapeFeed(url: string): Promise<RawJob[]> {
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/rss+xml" } });
  if (!res.ok) return [];
  const xml = await res.text();
  const $ = load(xml, { xmlMode: true });
  const out: RawJob[] = [];
  $("item").each((_, el) => {
    const $el = $(el);
    const titleRaw = unhtml($el.find("title").first().text());
    const link = $el.find("link").first().text().trim() || $el.find("guid").first().text().trim();
    const description = unhtml($el.find("description").first().text());
    const region = $el.find("region").first().text().trim();
    const pubDate = $el.find("pubDate").first().text().trim();
    if (!titleRaw || !link) return;

    // Title format: "Company Name: Role - fully remote"
    const m = titleRaw.match(/^([^:]+):\s*(.+?)(?:\s*[-–—]\s*.*)?$/);
    const company = m?.[1]?.trim();
    const title = m?.[2]?.trim() ?? titleRaw;
    const blob = `${title} ${description}`;

    if (EXCLUDE.test(blob)) return;
    if (!ENG_TITLE.test(title)) return;
    if (!SENIOR_HINTS.test(blob)) return; // require senior-ish

    out.push({
      source: "WeWorkRemotely",
      url: link,
      company,
      title,
      text: `${title} @ ${company ?? "?"} (${region || "remote"})\n${description}`,
      postedAt: pubDate,
      applyEmail: extractApplyEmail(description),
      applyUrl: link, // WWR posts have their own application URL on weworkremotely.com
    });
  });
  return out;
}

export async function scrape(): Promise<RawJob[]> {
  const settled = await Promise.allSettled(FEEDS.map(scrapeFeed));
  const all: RawJob[] = [];
  for (const r of settled) if (r.status === "fulfilled") all.push(...r.value);
  // Dedupe by URL
  const seen = new Set<string>();
  return all.filter((j) => {
    if (seen.has(j.url)) return false;
    seen.add(j.url);
    return true;
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  scrape().then((jobs) => {
    console.log(`WeWorkRemotely: ${jobs.length} senior+ dev jobs`);
    for (const j of jobs.slice(0, 5)) console.log("\n---", j.company, "—", j.title, "—", j.url, "\n  email:", j.applyEmail);
  });
}
