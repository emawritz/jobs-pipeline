// HN "Ask HN: Freelancer? Seeking freelancer?" monthly thread.
// Comments tagged "SEEKING FREELANCER" are clients posting projects.
// Comments tagged "SEEKING WORK" are other freelancers (skip those).
import type { RawJob } from "../lib/score.ts";

const ALGOLIA = "https://hn.algolia.com/api/v1";

type AlgoliaHit = { objectID: string; title?: string; created_at?: string };
type AlgoliaSearch = { hits: AlgoliaHit[] };
type HNItem = { id: number; text?: string; author?: string; children?: HNItem[] };

async function findLatestThread(): Promise<{ id: number; title: string } | null> {
  const url = `${ALGOLIA}/search_by_date?query=Freelancer+Seeking&tags=story&hitsPerPage=10`;
  const res = await fetch(url);
  const data = (await res.json()) as AlgoliaSearch;
  const hit = data.hits.find((h) => /freelancer\?\s*seeking freelancer\?/i.test(h.title ?? ""));
  return hit ? { id: Number(hit.objectID), title: hit.title ?? "" } : null;
}

async function fetchThread(id: number): Promise<HNItem> {
  const res = await fetch(`${ALGOLIA}/items/${id}`);
  return (await res.json()) as HNItem;
}

function htmlToText(html: string): string {
  return html
    .replace(/<p>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    // Preserve href URLs (HN truncates display)
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

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[a-z]{2,8}(?![a-zA-Z])/i;
const URL_RE = /https?:\/\/[^\s)<>"']+/;

function extractEmail(text: string): string | undefined {
  const m = text.match(EMAIL_RE);
  if (!m) return undefined;
  if (/noreply|donotreply|sentry/i.test(m[0])) return undefined;
  return m[0].replace(/[.,;)\]]+$/, "");
}

function extractFirstUrl(text: string): string | undefined {
  const m = text.match(URL_RE);
  return m?.[0]?.replace(/[.,;)\]]+$/, "");
}

function isSeekingFreelancer(text: string): boolean {
  // Clients posting projects mark themselves SEEKING FREELANCER. SEEKING WORK
  // is other freelancers we should ignore (they're competitors, not clients).
  return /SEEKING FREELANCER/i.test(text);
}

function extractCompany(text: string): string | undefined {
  // First non-tag line is usually company / project name
  const firstLine = text.split("\n").map((l) => l.trim()).find((l) => l && !/^seeking\s+(freelancer|work)/i.test(l));
  if (!firstLine) return undefined;
  const m = firstLine.match(/^([A-Z][A-Za-z0-9&. ]{1,40})\s*[|\-—–\(]/);
  return m?.[1]?.trim();
}

export async function scrape(): Promise<RawJob[]> {
  const thread = await findLatestThread();
  if (!thread) return [];
  const root = await fetchThread(thread.id);
  const out: RawJob[] = [];
  for (const c of root.children ?? []) {
    if (!c.text) continue;
    const text = htmlToText(c.text);
    if (!isSeekingFreelancer(text)) continue;
    out.push({
      source: `HN Freelance — ${thread.title}`,
      url: `https://news.ycombinator.com/item?id=${c.id}`,
      company: extractCompany(text),
      title: "Freelance contract opportunity",
      text,
      applyEmail: extractEmail(text),
      applyUrl: extractFirstUrl(text),
    });
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  scrape().then((jobs) => {
    console.log(`HN Freelance: ${jobs.length} 'SEEKING FREELANCER' posts`);
    for (const j of jobs.slice(0, 5)) {
      console.log(`\n--- ${j.company ?? "?"} ---`);
      console.log(`  email: ${j.applyEmail ?? "-"} · url: ${j.applyUrl ?? "-"}`);
      console.log(`  ${j.text.slice(0, 200).replace(/\n/g, " ")}...`);
    }
  });
}
