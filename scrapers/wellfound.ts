import type { RawJob } from "../lib/score.ts";

// TODO Wellfound (formerly AngelList Talent) is auth-walled and aggressively bot-detected.
// Strategy: manual flow. The user logs in, applies their filters, exports the matching
// listings to a JSON file, and we read it. Or we skip this source entirely.
//
// Until that flow exists, this scraper returns an empty array so digest.ts does not break.

export async function scrape(): Promise<RawJob[]> {
  console.error("[wellfound] skipped — auth-walled, manual export pending");
  return [];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  scrape().then((jobs) => console.log(`Wellfound: ${jobs.length}`));
}
