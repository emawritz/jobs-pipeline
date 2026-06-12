import type { RawJob } from "../lib/score.ts";
import { load } from "cheerio";

// YC Work at a Startup (workatastartup.com) requires login.
// PUBLIC alternative: ycombinator.com/jobs lists a curated subset without auth.
// We scrape that instead. If it stops working, fall back to manual export.

const LIST_URL = "https://www.ycombinator.com/jobs";

export async function scrape(): Promise<RawJob[]> {
  try {
    const res = await fetch(LIST_URL, {
      headers: { "user-agent": "Mozilla/5.0 jobs-pipeline" },
    });
    if (!res.ok) {
      console.error(`yc: HTTP ${res.status}`);
      return [];
    }
    const html = await res.text();
    const $ = load(html);
    const out: RawJob[] = [];
    $("a[href*='/companies/'][href*='/jobs/']").each((_, el) => {
      const href = $(el).attr("href");
      if (!href) return;
      const url = href.startsWith("http") ? href : `https://www.ycombinator.com${href}`;
      const text = $(el).text().replace(/\s+/g, " ").trim();
      if (!text) return;
      out.push({
        source: "YC Jobs (public)",
        url,
        title: text,
        text: `${text}\n(YC-backed company, fetch URL for full description)`,
      });
    });
    return out;
  } catch (e) {
    console.error("yc:", (e as Error).message);
    return [];
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  scrape().then((jobs) => {
    console.log(`YC public: ${jobs.length} listings`);
    for (const j of jobs.slice(0, 3)) console.log("\n---", j.title, "—", j.url);
  });
}
