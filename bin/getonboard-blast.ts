// GetOnBoard LATAM blast: scrape job board → guess company email via DNS
// MX verification → send SPRINT-pitch email referencing the actual posting.
//
// Strategy: GetOnBoard doesn't expose emails (apply goes through their
// platform). We bypass by:
//   1. Use GetOnBoard as a SOURCE of currently-hiring LATAM companies.
//   2. Guess email via lib/email-guesser (hola@/contacto@/careers@/jobs@).
//   3. Send via existing email-apply infra with Spanish SPRINT pitch.
//
// Flags:
//   --max=N         max jobs to email (default 10)
//   --dry-run       generate emails but don't send
//   --pattern=hola  which guess pattern to use (default hola, options: hola|contacto|careers|jobs)
//   --no-dedup      send even if we already emailed this domain

import { scrape } from "../scrapers/getonboard.ts";
import { guessEmails } from "../lib/email-guesser.ts";
import { emailApply, loadProfile } from "../lib/email-apply.ts";
import { loadAnswers } from "../lib/auto-apply.ts";
import { readJSON, writeJSON, today } from "../lib/storage.ts";

type Application = {
  id: string; url: string; platform: string; company?: string; title?: string;
  status: string; appliedAt: string; lastUpdate: string; notes: string[];
};

function genId() { return Math.random().toString(36).slice(2, 8); }

function arg(flag: string, def?: string): string | undefined {
  const m = process.argv.find((a) => a.startsWith(`${flag}=`));
  return m ? m.split("=")[1] : def;
}
function has(flag: string): boolean { return process.argv.includes(flag); }

async function main() {
  const max = parseInt(arg("--max", "10")!, 10);
  const dryRun = has("--dry-run");
  const pattern = arg("--pattern", "hola")!;
  const noDedup = has("--no-dedup");

  console.log(`[getonboard-blast] mode: ${dryRun ? "DRY-RUN" : "LIVE"} · max=${max} · pattern=${pattern}`);

  // 1. Scrape
  console.log(`\n→ scraping GetOnBoard…`);
  const jobs = await scrape();
  console.log(`  ${jobs.length} jobs senior LATAM remote`);

  // 2. Dedup against already-emailed addresses/domains
  const apps = readJSON<Application[]>("data/applications.json", []);
  const sentDomains = new Set(
    apps
      .filter((a) => a.url.startsWith("mailto:"))
      .map((a) => a.url.slice(7).split("@")[1]?.toLowerCase())
      .filter(Boolean),
  );

  // 3. Resolve email per job
  const ctx = loadProfile();
  const answers = loadAnswers();
  const tasks: Array<{ job: typeof jobs[0]; email: string; domain: string }> = [];

  for (const job of jobs.slice(0, max * 3)) { // overscan because some companies won't have MX
    if (!job.company) continue;
    const guesses = await guessEmails({ company: job.company });
    if (guesses.length === 0) {
      console.log(`  [no-mx] ${job.company}`);
      continue;
    }
    // Use the requested pattern (or first available).
    const pick = guesses.find((g) => g.pattern === pattern) ?? guesses[0];
    if (!noDedup && sentDomains.has(pick.domain)) {
      console.log(`  [skip-dom] ${job.company} → ${pick.email} (dominio ya contactado)`);
      continue;
    }
    tasks.push({ job, email: pick.email, domain: pick.domain });
    sentDomains.add(pick.domain);
    if (tasks.length >= max) break;
  }

  console.log(`\n→ ${tasks.length} emails to send\n`);
  let okCount = 0, errCount = 0;

  for (const { job, email } of tasks) {
    console.log(`\n────── ${job.company} (${job.title?.slice(0, 50)}) → ${email} ──────`);
    try {
      const r = await emailApply({
        to: email,
        company: job.company ?? "?",
        role: job.title ?? "Senior Engineer",
        jobText: `POSTING EN GETONBOARD:\n${job.text.slice(0, 3500)}\n\nURL: ${job.url}\n${job.salary ? "Salario: " + job.salary : ""}`,
        candidateCtx: ctx,
        resumePath: answers.resumeFile,
        language: "es",
        pitch: "sprint",
        dryRun,
      });
      if (r.ok) {
        console.log(`  ✓ "${r.subject}"`);
        if (dryRun) {
          console.log(`\n${r.body}\n`);
        } else {
          const fresh = readJSON<Application[]>("data/applications.json", []);
          fresh.push({
            id: genId(),
            url: `mailto:${email.toLowerCase()}`,
            platform: "auto:email:getonboard",
            company: job.company,
            title: job.title,
            status: "applied",
            appliedAt: today(),
            lastUpdate: today(),
            notes: [`${today()}: GetOnBoard blast (pattern ${pattern}) — ${job.url} · ${r.subject}`],
          });
          writeJSON("data/applications.json", fresh);
        }
        okCount++;
      } else {
        console.log(`  ✗ ${r.reason}`);
        errCount++;
      }
    } catch (e) {
      console.log(`  ✗ ${(e as Error).message}`);
      errCount++;
    }
    if (!dryRun) await new Promise((res) => setTimeout(res, 60000 + Math.floor(Math.random() * 60000)));
    else await new Promise((res) => setTimeout(res, 1000));
  }

  console.log(`\n══════ DONE ══════`);
  console.log(`  ${okCount} sent · ${errCount} errors`);
  if (!dryRun && okCount > 0) {
    console.log(`  → próximamente: gmail-poll detectará respuestas y bounces`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
