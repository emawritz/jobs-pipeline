// Spain SPRINT freelance batch — pitch a Founder/CTO español
// modality: SPRINT 2 semanas fixed-price (NO full-time hire).
//
// Loads verified targets from data/spain-targets.json — populated by the
// research agent. Format expected (array):
//   {
//     email, company, founder, stage, context,
//     pitch_angle, source, role?
//   }

import { existsSync, readFileSync } from "node:fs";
import { emailApply, loadProfile } from "../lib/email-apply.ts";
import { loadAnswers } from "../lib/auto-apply.ts";
import { readJSON, writeJSON, today } from "../lib/storage.ts";
import { isBounced } from "../lib/bounce-tracker.ts";

type Application = {
  id: string; url: string; platform: string; company?: string; title?: string;
  status: string; appliedAt: string; lastUpdate: string; notes: string[];
};

type SpainTarget = {
  email: string;
  company: string;
  founder: string;
  stage: string;
  context: string;
  pitch_angle: string;
  source?: string;
  role?: string;
};

function genId() { return Math.random().toString(36).slice(2, 8); }

function arg(flag: string, def?: string): string | undefined {
  const m = process.argv.find((a) => a.startsWith(`${flag}=`));
  return m ? m.split("=")[1] : def;
}
function has(flag: string): boolean { return process.argv.includes(flag); }

async function main() {
  const TARGETS_PATH = "data/spain-targets.json";
  if (!existsSync(TARGETS_PATH)) {
    console.error(`missing ${TARGETS_PATH} — research agent hasn't written it yet`);
    process.exit(1);
  }

  const targets = readJSON<SpainTarget[]>(TARGETS_PATH, []);
  if (targets.length === 0) {
    console.error("spain-targets.json is empty");
    process.exit(1);
  }

  const max = parseInt(arg("--max", "30")!, 10);
  const dryRun = has("--dry-run");

  const ctx = loadProfile();
  const answers = loadAnswers();
  const apps = readJSON<Application[]>("data/applications.json", []);
  const sent = new Set(apps.map((a) => a.url.toLowerCase()));

  console.log(`\n→ email-spain-sprint: ${targets.length} targets (cap=${max}, dry=${dryRun})\n`);
  let okCount = 0, skipCount = 0, errCount = 0;

  for (const t of targets.slice(0, max)) {
    const url = `mailto:${t.email.toLowerCase()}`;
    // CRITICAL: refresh dedup set every iteration. Otherwise, if a previous run
    // was killed between send + write, the in-memory `sent` is stale and we
    // re-send. Read applications.json fresh to see what's truly recorded.
    const live = readJSON<Application[]>("data/applications.json", []);
    const liveSent = new Set(live.map((a) => a.url.toLowerCase()));
    if (liveSent.has(url)) { console.log(`[skip] ${t.company} (already in db)`); skipCount++; continue; }
    if (isBounced(t.email)) {
      console.log(`[bounced] ${t.company} — ${t.email} known-bad, skipping`);
      skipCount++;
      continue;
    }

    console.log(`\n────── ${t.company} (${t.stage}) → ${t.email} ──────`);
    console.log(`  hook: ${t.pitch_angle}`);

    // CRITICAL: write a 'pending' entry BEFORE sending so a kill mid-flight
    // doesn't cause re-send on resume. The optimistic record is updated to
    // 'applied' on success, or 'send-error' on failure.
    const appId = genId();
    if (!dryRun) {
      const fresh = readJSON<Application[]>("data/applications.json", []);
      fresh.push({
        id: appId, url, platform: "auto:email:spain-sprint",
        company: t.company, title: t.role || "SPRINT 2 semanas",
        status: "sending",
        appliedAt: today(), lastUpdate: today(),
        notes: [`${today()}: Spain SPRINT intent (${t.stage}) → ${t.founder} — pending send`],
      });
      writeJSON("data/applications.json", fresh);
    }

    try {
      const r = await emailApply({
        to: t.email,
        company: t.company,
        role: t.role || "SPRINT freelance — entregable concreto en 2 semanas",
        jobText: `EMPRESA: ${t.company} (${t.stage})\nFOUNDER: ${t.founder}\n\nCONTEXTO:\n${t.context}\n\nÁNGULO PARA SPRINT:\n${t.pitch_angle}`,
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
          // Promote 'sending' → 'applied' on the entry we just wrote.
          const fresh = readJSON<Application[]>("data/applications.json", []);
          const entry = fresh.find((a) => a.id === appId);
          if (entry) {
            entry.status = "applied";
            entry.lastUpdate = today();
            entry.notes = [`${today()}: Spain SPRINT pitch (${t.stage}) → ${t.founder} · ${r.subject}`];
            writeJSON("data/applications.json", fresh);
          }
        }
        okCount++;
      } else {
        console.log(`  ✗ ${r.reason}`);
        if (!dryRun) {
          const fresh = readJSON<Application[]>("data/applications.json", []);
          const entry = fresh.find((a) => a.id === appId);
          if (entry) {
            entry.status = "send-error";
            entry.lastUpdate = today();
            entry.notes.push(`${today()}: error: ${r.reason}`);
            writeJSON("data/applications.json", fresh);
          }
        }
        errCount++;
      }
    } catch (e) {
      const msg = (e as Error).message;
      console.log(`  ✗ ${msg}`);
      if (!dryRun) {
        const fresh = readJSON<Application[]>("data/applications.json", []);
        const entry = fresh.find((a) => a.id === appId);
        if (entry) {
          entry.status = "send-error";
          entry.lastUpdate = today();
          entry.notes.push(`${today()}: exception: ${msg}`);
          writeJSON("data/applications.json", fresh);
        }
      }
      errCount++;
    }
    // throttle 60-120s between sends (avoid spam pattern flag)
    if (!dryRun) {
      await new Promise((res) => setTimeout(res, 60000 + Math.floor(Math.random() * 60000)));
    } else {
      await new Promise((res) => setTimeout(res, 1000));
    }
  }

  console.log(`\n══════ DONE ══════`);
  console.log(`  ${okCount} sent · ${skipCount} skipped · ${errCount} errors`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
