import type { RawJob } from "../lib/score.ts";

const ALGOLIA = "https://hn.algolia.com/api/v1";

type AlgoliaHit = {
  objectID: string;
  title?: string;
  author?: string;
  created_at?: string;
};

type AlgoliaSearch = { hits: AlgoliaHit[] };

type HNItem = {
  id: number;
  type?: string;
  text?: string;
  author?: string;
  url?: string;
  children?: HNItem[];
};

async function findLatestThread(): Promise<{ id: number; title: string }> {
  // search_by_date sorted desc by created_at — gives us the most recent thread.
  const url = `${ALGOLIA}/search_by_date?tags=story,author_whoishiring&hitsPerPage=10`;
  const res = await fetch(url);
  const data = (await res.json()) as AlgoliaSearch;
  const hit = data.hits.find((h) => /who is hiring/i.test(h.title ?? ""));
  if (!hit) throw new Error("No 'Who is hiring' thread found");
  return { id: Number(hit.objectID), title: hit.title ?? "" };
}

async function fetchThread(id: number): Promise<HNItem> {
  const res = await fetch(`${ALGOLIA}/items/${id}`);
  return (await res.json()) as HNItem;
}

function htmlToText(html: string): string {
  return html
    .replace(/<p>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    // Preserve full href URLs — HN truncates display text to "...". Without this,
    // long URLs (Lever UUIDs, Greenhouse slugs) come out broken.
    .replace(/<a\b[^>]*href="([^"]+)"[^>]*>[\s\S]*?<\/a>/gi, " $1 ")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x2F;/g, "/")
    .trim();
}

function looksRemote(text: string): boolean {
  return /\b(REMOTE|remote-?friendly|anywhere|latam|americas|worldwide|global)\b/i.test(text);
}

function extractCompany(text: string): string | undefined {
  const firstLine = text.split("\n")[0] ?? "";
  const m = firstLine.match(/^([A-Z][A-Za-z0-9&. ]{1,40})\s*[|\-—–\(]/);
  return m?.[1]?.trim();
}

const CAREER_HOSTS = /(lever\.co|greenhouse\.io|ashbyhq\.com|workable\.com|breezy\.hr|jobs\.gusto|smartrecruiters\.com|recruitee\.com|notion\.so|airtable\.com|tally\.so|forms\.gle|typeform\.com|workatastartup\.com|careers\.|\/careers|\/jobs|\/apply|\/join|\/hiring)/i;

// Hard-blocked URLs: aggregators, blogs, news sites that should NEVER be
// surfaced as "the apply URL" even when they appear in the HN text.
const URL_BLOCKLIST = /(whoishiringjobs|indeed\.com|glassdoor|linkedin\.com\/jobs|monster\.com|ziprecruiter|simplyhired|\/blog\/|\/news\/|\/about\/|\/team\/|wikipedia|twitter\.com|x\.com|facebook\.com|youtube\.com)/i;

// Companies/postings to skip entirely (generic placeholders, no signal).
const COMPANY_BLOCKLIST = /^(stealth (startup|mode)|early stage startup|undisclosed|tba|tbd|n\/a)$/i;

function isUsableUrl(u: string): boolean {
  if (URL_BLOCKLIST.test(u)) return false;
  // Reject URLs that are clearly NOT a specific job posting.
  if (/\.(pdf|jpg|png|mp4|mov)$/i.test(u)) return false;
  return true;
}

function extractApply(text: string): { applyUrl?: string; applyEmail?: string } {
  // 1. Look for explicit "Apply: ..." or "Apply at ..." patterns first.
  const labeled = text.match(/(?:^|\n)\s*(?:Apply|Application|To apply|How to apply)[:\s]+([^\s\n]+)/i);
  if (labeled) {
    const raw = labeled[1].replace(/[.,;)\]]+$/, "");
    if (/^https?:\/\//i.test(raw) && isUsableUrl(raw)) return { applyUrl: raw };
    if (raw.startsWith("mailto:")) return { applyEmail: raw.slice(7) };
    if (/^[\w.+-]+@[\w.-]+\.\w+$/.test(raw)) return { applyEmail: raw };
  }
  // 2. Look for any mailto: link.
  const mail = text.match(/mailto:([\w.+-]+@[\w.-]+\.\w+)/);
  if (mail) return { applyEmail: mail[1] };
  // 3. Look for any URL that looks like a careers/job page.
  const urls = (text.match(/https?:\/\/[^\s)<>"']+/g) ?? []).filter(isUsableUrl);
  for (const u of urls) {
    if (CAREER_HOSTS.test(u)) return { applyUrl: u.replace(/[.,;)\]]+$/, "") };
  }
  // 4. Fallback: a bare email anywhere in the text.
  const bareMail = text.match(/(?:contact|email|reach|send.*to)[^\n]*?([\w.+-]+@[\w.-]+\.\w+)/i);
  if (bareMail) return { applyEmail: bareMail[1] };
  // 5. Fallback: first URL of any kind.
  if (urls.length > 0) return { applyUrl: urls[0].replace(/[.,;)\]]+$/, "") };
  return {};
}

export async function scrape(): Promise<RawJob[]> {
  const { id, title } = await findLatestThread();
  const thread = await fetchThread(id);
  const out: RawJob[] = [];
  for (const c of thread.children ?? []) {
    if (!c.text) continue;
    const text = htmlToText(c.text);
    if (!looksRemote(text)) continue;
    const company = extractCompany(text);
    // Skip placeholder companies — they pollute the digest without giving signal.
    if (company && COMPANY_BLOCKLIST.test(company)) continue;
    const apply = extractApply(text);
    out.push({
      source: `HN ${title}`,
      url: `https://news.ycombinator.com/item?id=${c.id}`,
      company,
      title: undefined,
      text,
      salary: undefined,
      postedAt: undefined,
      applyUrl: apply.applyUrl,
      applyEmail: apply.applyEmail,
    });
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  scrape().then((jobs) => {
    console.log(`HN: ${jobs.length} remote-flagged jobs`);
    for (const j of jobs.slice(0, 3)) console.log("\n---", j.url, "\n", j.text.slice(0, 200));
  });
}
