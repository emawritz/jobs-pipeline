import type { RawJob } from "../lib/score.ts";
import { load } from "cheerio";

// RemoteOK's JSON API now returns a schema stub for bots. Their RSS feed still
// returns real items. We use the dev-jobs RSS as our source.
const FEED = "https://remoteok.com/remote-dev-jobs.rss";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const SENIOR_HINTS = /\b(senior|sr\.?|staff|principal|lead|founding|head of)\b/i;
const ENG_TITLE = /\b(engineer|developer|architect|programmer|sde|swe|dev\b|fullstack|full-stack|backend|frontend)\b/i;
const STACK_HINTS =
  /\b(typescript|node\.?js|nestjs|svelte|angular|postgres|rust|tauri|claude|llm|anthropic|openai|next\.?js|sveltekit)\b/i;
const EXCLUDE =
  /\b(react-native|web3|crypto|blockchain|defi|nft|casino|gambling|marketing manager|videographer|sales|recruiter|content creator)\b/i;

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

export async function scrape(): Promise<RawJob[]> {
  const res = await fetch(FEED, { headers: { "user-agent": UA, accept: "application/rss+xml" } });
  if (!res.ok) {
    console.error(`[remoteok] HTTP ${res.status}`);
    return [];
  }
  const xml = await res.text();
  const $ = load(xml, { xmlMode: true });
  const out: RawJob[] = [];
  $("item").each((_, el) => {
    const $el = $(el);
    const title = unhtml($el.find("title").first().text());
    const company = unhtml($el.find("company").first().text() || "");
    const description = unhtml($el.find("description").first().text());
    const link = $el.find("link").first().text().trim() || $el.find("guid").first().text().trim();
    const pubDate = $el.find("pubDate").first().text().trim();
    if (!title || !link) return;
    const blob = `${title} ${description}`;
    if (EXCLUDE.test(blob)) return;
    if (!ENG_TITLE.test(title)) return;
    if (!SENIOR_HINTS.test(blob) && !STACK_HINTS.test(blob)) return;
    out.push({
      source: "RemoteOK",
      url: link,
      company: company || undefined,
      title,
      text: `${title} @ ${company}\n${description}`,
      postedAt: pubDate,
    });
  });
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  scrape().then((jobs) => {
    console.log(`RemoteOK: ${jobs.length} matching jobs`);
    for (const j of jobs.slice(0, 5)) console.log("\n---", j.company, "—", j.title, "—", j.url);
  });
}
