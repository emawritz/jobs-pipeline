// SPRAY MODE — bypass scoring, scan all sources, send emails to anyone with
// extractable email we haven't already applied to. No waiting. NOW.
import { existsSync, readFileSync } from "node:fs";
import * as hn from "../scrapers/hn-hiring.ts";
import * as remoteok from "../scrapers/remoteok.ts";
import * as yc from "../scrapers/ycombinator.ts";
import * as wwr from "../scrapers/weworkremotely.ts";
import * as wn from "../scrapers/workingnomads.ts";
import * as him from "../scrapers/himalayas.ts";
import * as remotive from "../scrapers/remotive.ts";
import * as jobicy from "../scrapers/jobicy.ts";
import * as lever from "../scrapers/lever.ts";
import * as rfj from "../scrapers/remotefirstjobs.ts";
import * as arbeit from "../scrapers/arbeitnow.ts";
import * as ashby from "../scrapers/ashby.ts";
import { emailApply, loadProfile } from "../lib/email-apply.ts";
import { loadAnswers } from "../lib/auto-apply.ts";
import { readJSON, writeJSON, today } from "../lib/storage.ts";
import { classifyStartup } from "../lib/startup-filter.ts";

type Application = {
  id: string; url: string; platform: string; company?: string; title?: string;
  status: string; appliedAt: string; lastUpdate: string; notes: string[];
};

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[a-z]{2,8}(?![a-zA-Z])/i;
const DENY = /(noreply|donotreply|sentry|notifications|example\.com|github\.com|@anthropic|wordpress|gravatar|sentry|analytics)/i;
const PREFER = /(jobs|careers|hiring|hr|team|talent|recruit|founder|hello|contact|apply)/i;

function extractEmail(text: string): string | null {
  const all = (text.match(/[\w.+-]+@[\w-]+\.[a-z]{2,8}(?![a-zA-Z])/gi) ?? [])
    .map((e) => e.replace(/[.,;)\]]+$/, ""))
    .filter((e) => !DENY.test(e));
  return all.find((e) => PREFER.test(e)) ?? all[0] ?? null;
}

function genId() { return Math.random().toString(36).slice(2, 8); }

async function main() {
  console.log("→ scanning ALL 12 sources in parallel...");
  const t0 = Date.now();
  const sources = [hn.scrape(), remoteok.scrape(), yc.scrape(), wwr.scrape(), wn.scrape(),
    him.scrape(), remotive.scrape(), jobicy.scrape(), lever.scrape(),
    rfj.scrape(), arbeit.scrape(), ashby.scrape()];
  const results = await Promise.allSettled(sources);
  const allJobs = results.flatMap((r) => r.status === "fulfilled" ? r.value : []);
  console.log(`  ${allJobs.length} jobs scraped in ${((Date.now()-t0)/1000).toFixed(1)}s`);

  const apps = readJSON<Application[]>("data/applications.json", []);
  const sent = new Set(apps.map((a) => a.url.toLowerCase()));

  // For each job, promote to email if possible
  const withEmail = allJobs.map((j) => {
    const email = j.applyEmail ?? extractEmail(j.text);
    return { job: j, email };
  })
    .filter((c) => c.email && !sent.has(`mailto:${c.email.toLowerCase()}`))
    .filter((c, i, arr) => arr.findIndex((x) => x.email === c.email) === i);

  console.log(`  ${withEmail.length} NEW email candidates (before startup filter)`);

  // Classify each as startup vs BigCorp + skip non-startups
  const classified = withEmail.map((c) => ({
    ...c,
    classification: classifyStartup(c.job, c.email!),
  }));

  const rejected = classified.filter((c) => !c.classification.isStartup);
  const candidates = classified
    .filter((c) => c.classification.isStartup)
    .sort((a, b) => b.classification.score - a.classification.score); // highest-startup-signal first

  console.log(`\n  → REJECTED ${rejected.length} as BigCorp / black-hole:`);
  for (const r of rejected.slice(0, 8)) {
    console.log(`     ✗ ${r.job.company ?? "?"} (${r.email}) score=${r.classification.score}: ${r.classification.reasons.join(", ")}`);
  }
  if (rejected.length > 8) console.log(`     ... +${rejected.length - 8} more rejected`);

  console.log(`\n  → ACCEPTED ${candidates.length} as startup (sorted by signal strength):`);
  for (const c of candidates.slice(0, 15)) {
    console.log(`     ✓ ${c.job.company ?? "?"} (${c.email}) +${c.classification.score}: ${c.classification.reasons.slice(0,3).join(", ")}`);
  }

  if (candidates.length === 0) { console.log("\nnothing startup-flavored to send."); return; }

  const ctx = loadProfile();
  const answers = loadAnswers();

  // Send first 15 (throttled 60-120s between to avoid spam-flagging)
  const MAX = Math.min(15, candidates.length);
  console.log(`\n→ sending ${MAX} emails (throttled 60-120s between)...\n`);

  for (let i = 0; i < MAX; i++) {
    const { job, email } = candidates[i];
    console.log(`────── ${i+1}/${MAX}: ${job.company ?? "?"} → ${email} ──────`);
    try {
      const r = await emailApply({
        to: email!,
        company: job.company ?? "?",
        role: job.title ?? "Senior Engineer",
        jobText: job.text,
        candidateCtx: ctx,
        resumePath: answers.resumeFile,
      });
      if (r.ok) {
        console.log(`  ✓ "${r.subject}"`);
        const fresh = readJSON<Application[]>("data/applications.json", []);
        fresh.push({
          id: genId(),
          url: `mailto:${email!.toLowerCase()}`,
          platform: "auto:email:spray",
          company: job.company,
          title: job.title,
          status: "applied",
          appliedAt: today(),
          lastUpdate: today(),
          notes: [`${today()}: spray send — ${job.source} — ${r.subject}`],
        });
        writeJSON("data/applications.json", fresh);
      } else {
        console.log(`  ✗ ${r.reason}`);
      }
    } catch (e) {
      console.log(`  ✗ ${(e as Error).message}`);
    }
    if (i < MAX - 1) {
      const delay = 60 + Math.floor(Math.random() * 60);
      console.log(`  ...waiting ${delay}s\n`);
      await new Promise((res) => setTimeout(res, delay * 1000));
    }
  }
  console.log(`\n✓ DONE. ${MAX} sends attempted.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
