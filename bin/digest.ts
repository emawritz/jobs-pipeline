import { spawnSync } from "node:child_process";
import { scoreJob, type RawJob, type Score } from "../lib/score.ts";
import { readJSON, writeJSON, writeText, today, hash } from "../lib/storage.ts";
import { fetchPostingFull } from "../lib/fetch-posting.ts";
import * as hn from "../scrapers/hn-hiring.ts";
import * as hnfreelance from "../scrapers/hn-freelance.ts";
import * as remoteok from "../scrapers/remoteok.ts";
import * as hiringcafe from "../scrapers/hiringcafe.ts";
import * as yc from "../scrapers/ycombinator.ts";
import * as wellfound from "../scrapers/wellfound.ts";
import * as wwr from "../scrapers/weworkremotely.ts";
import * as workingnomads from "../scrapers/workingnomads.ts";
import * as himalayas from "../scrapers/himalayas.ts";
import * as remotive from "../scrapers/remotive.ts";
import * as jobicy from "../scrapers/jobicy.ts";
import * as leverpostings from "../scrapers/lever.ts";
import * as remotefirst from "../scrapers/remotefirstjobs.ts";
import * as arbeitnow from "../scrapers/arbeitnow.ts";
import * as ashbymulti from "../scrapers/ashby.ts";
import * as getonboard from "../scrapers/getonboard.ts";

const ALERT_THRESHOLD = 85;

function alertHighScore(job: RawJob, score: Score) {
  const title = `🔥 ${score.total} · ${job.company ?? "?"}`;
  const body = (job.title ?? job.text.slice(0, 80)).replace(/"/g, "'");
  spawnSync("osascript", [
    "-e",
    `display notification "${body}" with title "${title}" sound name "Glass"`,
  ]);
}

type SeenMap = Record<string, true>;

const SEEN_PATH = "data/jobs-seen.json";
const DIGEST_DIR = "data/digests";
const MIN_SCORE = 50;
const TOP_N = 15;

// Optional --limit N caps how many jobs we score per run.
// Useful for fast demos. Omit for full nightly run.
const LIMIT_ARG = process.argv.find((a) => a.startsWith("--limit="));
const LIMIT = LIMIT_ARG ? Number(LIMIT_ARG.split("=")[1]) : Infinity;

function dedupeKey(j: RawJob): string {
  // RemoteOK duplicates the same posting across multiple IDs.
  // Dedupe by company+title first; fall back to URL.
  const ct = `${(j.company ?? "").toLowerCase().trim()}|${(j.title ?? "").toLowerCase().trim()}`;
  if (ct.length > 4) return hash(ct);
  return hash(j.url);
}

async function gather(): Promise<RawJob[]> {
  const sources = [
    { name: "hn", fn: hn.scrape },
    { name: "hnfreelance", fn: hnfreelance.scrape },
    { name: "remoteok", fn: remoteok.scrape },
    { name: "hiringcafe", fn: hiringcafe.scrape },
    { name: "yc", fn: yc.scrape },
    { name: "wellfound", fn: wellfound.scrape },
    { name: "wwr", fn: wwr.scrape },
    { name: "workingnomads", fn: workingnomads.scrape },
    { name: "himalayas", fn: himalayas.scrape },
    { name: "remotive", fn: remotive.scrape },
    { name: "jobicy", fn: jobicy.scrape },
    { name: "leverpostings", fn: leverpostings.scrape },
    { name: "remotefirst", fn: remotefirst.scrape },
    { name: "arbeitnow", fn: arbeitnow.scrape },
    { name: "ashbymulti", fn: ashbymulti.scrape },
    { name: "getonboard", fn: getonboard.scrape },
  ];
  const settled = await Promise.allSettled(sources.map((s) => s.fn()));
  const out: RawJob[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") {
      console.log(`[${sources[i].name}] ${r.value.length} jobs`);
      out.push(...r.value);
    } else {
      console.error(`[${sources[i].name}] FAIL:`, r.reason);
    }
  });
  return out;
}

async function enrich(jobs: RawJob[]): Promise<RawJob[]> {
  // For jobs with an applyUrl, fetch the page and merge into text — gives the LLM
  // the full posting instead of an HN snippet. Also VALIDATES the URL: drops
  // applyUrl when it returns 4xx/5xx so the dashboard doesn't show dead links.
  const limit = 6;
  let fetched = 0;
  let dropped = 0;
  for (let i = 0; i < jobs.length; i += limit) {
    const batch = jobs.slice(i, i + limit);
    await Promise.allSettled(
      batch.map(async (j) => {
        if (!j.applyUrl) return;
        const r = await fetchPostingFull(j.applyUrl);
        if (r.status >= 400 || r.status === 0) {
          // Network error, timeout, or 4xx/5xx — drop the URL so it doesn't
          // show in the dashboard. Job remains in digest via its HN source URL.
          console.log(`\n  ✗ drop ${j.company ?? "?"} applyUrl: status ${r.status} ${j.applyUrl}`);
          j.applyUrl = undefined;
          dropped++;
          return;
        }
        // If we followed a redirect that landed on a different host or path,
        // use the FINAL url (the one the user will actually see).
        if (r.finalUrl && r.finalUrl !== j.applyUrl) {
          j.applyUrl = r.finalUrl;
        }
        if (r.text) {
          j.text = `${j.text}\n\n--- FULL POSTING (from ${j.applyUrl}) ---\n${r.text}`;
          fetched++;
        }
      }),
    );
    process.stdout.write(`enriched ${Math.min(i + limit, jobs.length)}/${jobs.length}\r`);
  }
  console.log(`\nenriched ${fetched} jobs with full posting · dropped ${dropped} broken URLs`);
  return jobs;
}

async function scoreAll(jobs: RawJob[]): Promise<Array<{ job: RawJob; score: Score }>> {
  const scored: Array<{ job: RawJob; score: Score }> = [];
  const limit = 8;
  for (let i = 0; i < jobs.length; i += limit) {
    const batch = jobs.slice(i, i + limit);
    const results = await Promise.allSettled(batch.map((j) => scoreJob(j)));
    results.forEach((r, k) => {
      if (r.status === "fulfilled") {
        scored.push({ job: batch[k], score: r.value });
        if (r.value.total >= ALERT_THRESHOLD) {
          alertHighScore(batch[k], r.value);
          console.log(`\n🔥 ALERT score=${r.value.total} ${batch[k].company} ${batch[k].url}`);
        }
      } else {
        console.error("score fail:", r.reason);
      }
    });
    process.stdout.write(`scored ${Math.min(i + limit, jobs.length)}/${jobs.length}\r`);
  }
  console.log();
  return scored;
}

function renderDigest(items: Array<{ job: RawJob; score: Score }>): string {
  const date = today();
  let md = `# Job digest — ${date}\n\nTop ${items.length} jobs (score >= ${MIN_SCORE}).\n\n`;
  items.forEach((it, idx) => {
    const { job, score } = it;
    md += `## ${idx + 1}. ${job.title ?? "(no title)"} @ ${job.company ?? "(unknown)"}\n`;
    md += `**Score: ${score.total}**  ·  stack ${score.stackFit}  ·  seniority ${score.seniorityFit}  ·  comp ${score.compensation}  ·  stage ${score.companyStage}  ·  flags ${score.redFlags}\n\n`;
    md += `**Why:** ${score.oneLiner}\n\n`;
    md += `**Flags:** ${score.flags.map((f) => `[${f}]`).join(" ")}\n\n`;
    md += `**Salary:** ${job.salary ?? "not stated"}  ·  **Source:** ${job.source}\n\n`;
    md += `**URL:** ${job.url}\n\n`;
    md += `---\n\n`;
  });
  return md;
}

async function main() {
  const seen = readJSON<SeenMap>(SEEN_PATH, {});
  const all = await gather();
  console.log(`gathered ${all.length} jobs total`);
  const fresh = all.filter((j) => !seen[dedupeKey(j)]);
  console.log(`${fresh.length} new after dedupe`);
  if (fresh.length === 0) {
    console.log("nothing new today.");
    return;
  }
  const sampled = isFinite(LIMIT) ? fresh.slice(0, LIMIT) : fresh;
  if (sampled.length < fresh.length) console.log(`[--limit] scoring ${sampled.length} of ${fresh.length}`);
  const enriched = await enrich(sampled);
  const scored = await scoreAll(enriched);
  for (const j of fresh) seen[dedupeKey(j)] = true;
  writeJSON(SEEN_PATH, seen);

  const kept = scored
    .filter((s) => s.score.total >= MIN_SCORE)
    .sort((a, b) => b.score.total - a.score.total)
    .slice(0, TOP_N);

  const md = renderDigest(kept);
  const outMd = `${DIGEST_DIR}/${today()}.md`;
  writeText(outMd, md);
  const outJson = `${DIGEST_DIR}/${today()}.json`;
  writeJSON(outJson, { date: today(), generatedAt: new Date().toISOString(), items: kept });
  console.log(`\nwrote ${outMd} + ${outJson} — ${kept.length} jobs >= ${MIN_SCORE}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
