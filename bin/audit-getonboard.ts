import { scrape } from "../scrapers/getonboard.ts";

async function main() {
  const jobs = await scrape();
  console.log(`Total: ${jobs.length}\n`);
  for (const j of jobs.slice(0, 12)) {
    console.log(`company:${j.company ? `"${j.company}"` : "(none)"} | title:${j.title ? `"${j.title}"` : "(none)"} | salary:${j.salary ?? "—"}`);
    console.log(`  ${j.url}`);
  }
}
main().catch(console.error);
