import type { RawJob } from "../lib/score.ts";
import { load } from "cheerio";

// GetOnBoard — LATAM tech jobs board. Public listings (no auth).
// We pull the remote-programming + remote-sysadmin categories and senior+ filter.
// "Postular" requires login, so for auto-apply we rely on emails extracted from
// the job description body — common in LATAM listings ("envía tu CV a x@y.com").

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const LISTING_URLS = [
  "https://www.getonbrd.com/jobs?category_id=programming&remote=true",
  "https://www.getonbrd.com/jobs?category_id=sysadmin-devops-qa&remote=true",
  "https://www.getonbrd.com/jobs?category_id=data-science-analytics&remote=true",
];

const SENIOR_HINTS = /\b(senior|sr\.?|staff|principal|lead|founding|head of|líder|lider)\b/i;
const ENG_TITLE =
  /\b(engineer|developer|architect|programmer|sde|swe|fullstack|full-stack|backend|frontend|devops|ingeniero|desarrollador|programador)\b/i;
const EXCLUDE = /\b(web3|crypto|blockchain|nft|defi|casino|gambling)\b/i;

function extractEmail(text: string): string | undefined {
  const m = text.match(/[\w.+-]+@[\w-]+\.[a-z]{2,8}(?![a-zA-Z])/i);
  if (!m) return undefined;
  if (/noreply|donotreply|sentry|getonbrd|wordpress|@example\./i.test(m[0])) return undefined;
  return m[0].replace(/[.,;)\]]+$/, "");
}

async function fetchListing(url: string): Promise<string[]> {
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "text/html" } });
  if (!res.ok) return [];
  const html = await res.text();
  const $ = load(html);
  const out: string[] = [];
  $('a[href*="/jobs/"][href*="getonbrd"], a[href^="/jobs/"]').each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const abs = href.startsWith("http") ? href : `https://www.getonbrd.com${href}`;
    // Only specific job pages (with category in path), skip search/listing URLs
    if (!/\/jobs\/[a-z-]+\/[a-z0-9-]+\b/.test(abs)) return;
    if (/applications\/new/.test(abs)) return;
    if (!out.includes(abs)) out.push(abs);
  });
  return out;
}

type JobDetail = {
  url: string;
  title?: string;
  company?: string;
  salary?: string;
  text: string;
  applyEmail?: string;
};

async function fetchJobDetail(url: string): Promise<JobDetail | null> {
  try {
    const res = await fetch(url, { headers: { "user-agent": UA, accept: "text/html" } });
    if (!res.ok) return null;
    const html = await res.text();
    const $ = load(html);
    // Title + company. Two sources, fallback order:
    //   1. <title> tag: "Full-Stack Developer en EasyAudit AI, Inc. - Remoto | Get on Board"
    //   2. <h1>: often "Job Title\n\nin\nCompany Name"
    const fullTitle = ($("title").first().text() || "").trim();
    const titleMatch = fullTitle.match(/^(.+?)\s+en\s+(.+?)\s*-\s*.*\|\s*Get on Board/i);
    let title = titleMatch?.[1]?.trim();
    let company = titleMatch?.[2]?.trim();
    if (!title || !company) {
      const h1Raw = $("h1").first().text();
      const h1Match = h1Raw.match(/^([\s\S]+?)\n\s*in\s*\n([\s\S]+?)$/i);
      if (h1Match) {
        if (!title) title = h1Match[1].trim().replace(/\s+/g, " ");
        if (!company) company = h1Match[2].trim().replace(/\s+/g, " ");
      } else if (!title) {
        title = h1Raw.trim().replace(/\s+/g, " ");
      }
    }
    // Strip nav/UI noise before extracting body text
    $("script, style, nav, footer, header, svg, iframe, noscript").remove();
    $("[class*='cookie'], [class*='banner'], [class*='navbar'], [class*='header']").remove();
    // Prefer the job-description container
    const descEl = $("[class*='job-description'], [class*='description'], main, article").first();
    const text = (descEl.text() || $("body").text()).replace(/\s+/g, " ").trim();
    const salaryMatch = text.match(/(?:Sueldo|salary|sueldo bruto)[^$]{0,20}\$\s*([0-9,. ]+)\s*-\s*([0-9,. ]+)\s*USD/i);
    const salary = salaryMatch ? `$${salaryMatch[1].trim()} - ${salaryMatch[2].trim()} USD` : undefined;
    return {
      url,
      title,
      company,
      salary,
      text: text.slice(0, 8000),
      applyEmail: extractEmail(text),
    };
  } catch {
    return null;
  }
}

export async function scrape(): Promise<RawJob[]> {
  const urlSets = await Promise.allSettled(LISTING_URLS.map(fetchListing));
  const allUrls = Array.from(
    new Set(urlSets.flatMap((r) => (r.status === "fulfilled" ? r.value : []))),
  ).slice(0, 60);

  const details = await Promise.allSettled(allUrls.map(fetchJobDetail));
  const out: RawJob[] = [];
  for (const r of details) {
    if (r.status !== "fulfilled" || !r.value) continue;
    const d = r.value;
    const blob = `${d.title ?? ""} ${d.text}`;
    if (EXCLUDE.test(blob)) continue;
    if (!d.title || !ENG_TITLE.test(d.title)) continue;
    if (!SENIOR_HINTS.test(blob)) continue;
    out.push({
      source: "GetOnBoard (LATAM)",
      url: d.url,
      company: d.company,
      title: d.title,
      text: d.text,
      salary: d.salary,
      applyEmail: d.applyEmail,
      applyUrl: d.applyEmail ? undefined : d.url,
    });
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  scrape().then((jobs) => {
    console.log(`GetOnBoard: ${jobs.length} senior LATAM remote dev jobs`);
    for (const j of jobs.slice(0, 8)) {
      console.log(`\n--- ${j.company ?? "?"} — ${j.title}`);
      console.log(`  ${j.salary ?? ""} · email: ${j.applyEmail ?? "—"} · ${j.url}`);
    }
  });
}
