// Autonomous batch: from today's digest, auto-apply to every job with applyUrl
// OR applyEmail and score >= MIN. Throttled to avoid bot-pattern detection.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readJSON, writeJSON, today } from "../lib/storage.ts";
import { emailApply } from "../lib/email-apply.ts";
import { loadAnswers } from "../lib/auto-apply.ts";

const MIN_SCORE_DEFAULT = 70;
const MAX_APPLY_DEFAULT = 10;
const DELAY_MIN_SEC = 90; // minimum between applies — looks human
const DELAY_MAX_SEC = 180; // randomised upper bound

type Item = {
  job: {
    url: string;
    applyUrl?: string;
    applyEmail?: string;
    company?: string;
    title?: string;
    text: string;
  };
  score: { total: number };
};

type Application = {
  id: string;
  url: string;
  platform: string;
  company?: string;
  title?: string;
  status: string;
  appliedAt: string;
  lastUpdate: string;
  notes: string[];
};

function genId() {
  return Math.random().toString(36).slice(2, 8);
}

function loadDigest(): Item[] {
  const path = `data/digests/${today()}.json`;
  if (!existsSync(path)) {
    console.error(`no digest at ${path} — run 'npm run digest' first.`);
    process.exit(1);
  }
  const d = JSON.parse(readFileSync(path, "utf8"));
  return d.items ?? [];
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const args = process.argv.slice(2);
  const minScoreArg = args.find((a) => a.startsWith("--min-score="));
  const maxArg = args.find((a) => a.startsWith("--max="));
  const noPauseFlag = args.includes("--no-pause");
  const dryRun = args.includes("--dry-run");
  const skipCaptcha = args.includes("--skip-captcha");
  const emailOnly = args.includes("--email-only");
  const webOnly = args.includes("--web-only");
  const scanForEmail = args.includes("--scan-for-email");
  const minScore = minScoreArg ? Number(minScoreArg.split("=")[1]) : MIN_SCORE_DEFAULT;
  const maxApply = maxArg ? Number(maxArg.split("=")[1]) : MAX_APPLY_DEFAULT;

  // Helper: pull a job-application email from the enriched text if one exists.
  const extractEmailFromText = (text: string): string | null => {
    // Require non-letter (or end-of-string) after the TLD so we don't gobble
    // adjacent words ("support@x.aiConnect..." → no match).
    const re = /[\w.+-]+@[\w-]+\.[a-z]{2,8}(?![a-zA-Z])/gi;
    const matches = text.match(re) ?? [];
    const denylist = /(noreply|do-?not-?reply|donotreply|sentry|notifications|example\.com|github\.com|@anthropic\.com|wordpress\.com|gravatar)/i;
    const allowlist = /(jobs|careers|hiring|hr|team|talent|work|recruit|founder|hello|contact|join|apply)/i;
    const valid = /^[a-zA-Z][\w.+-]*@[\w-]+\.[a-z]{2,8}$/i; // basic sanity
    const good = matches
      .map((e) => e.replace(/[.,;)\]]+$/, ""))
      .filter((e) => valid.test(e))
      .filter((e) => !denylist.test(e))
      .filter((e, i, a) => a.indexOf(e) === i);
    const preferred = good.find((e) => allowlist.test(e));
    return preferred ?? good[0] ?? null;
  };

  const items = loadDigest();
  const previousApps = readJSON<Application[]>("data/applications.json", []);
  const alreadySent = new Set<string>(
    previousApps.flatMap((a) => [a.url.toLowerCase(), `mailto:${(a.company ?? "").toLowerCase()}`]),
  );

  // Optional promotion: if a candidate has only URL but its text contains an email,
  // promote to email channel (much higher autonomy success rate).
  if (scanForEmail) {
    for (const it of items) {
      if (it.job.applyEmail) continue;
      const found = extractEmailFromText(it.job.text);
      if (found) {
        console.log(`  [promote] ${it.job.company ?? "?"} → email ${found}`);
        it.job.applyEmail = found;
      }
    }
  }

  const candidates = items
    .filter((it) => {
      if (it.score.total < minScore) return false;
      if (emailOnly) return !!it.job.applyEmail; // promoted candidates count too
      if (webOnly) return !!it.job.applyUrl && !it.job.applyEmail; // explicit web only
      return !!(it.job.applyUrl || it.job.applyEmail);
    })
    .filter((it) => {
      // Skip if we already applied to this URL/email
      const urlKey = (it.job.applyUrl ?? "").toLowerCase();
      const emailKey = it.job.applyEmail ? `mailto:${it.job.applyEmail.toLowerCase()}` : "";
      if (urlKey && alreadySent.has(urlKey)) {
        console.log(`  [skip] ${it.job.company ?? "?"} — already applied to ${urlKey}`);
        return false;
      }
      if (emailKey && alreadySent.has(emailKey)) {
        console.log(`  [skip] ${it.job.company ?? "?"} — already applied to ${emailKey}`);
        return false;
      }
      return true;
    })
    .slice(0, maxApply);

  const urlOnes = candidates.filter((c) => c.job.applyUrl).length;
  const emailOnes = candidates.filter((c) => !c.job.applyUrl && c.job.applyEmail).length;

  console.log(`\n→ auto-apply-all`);
  console.log(`  digest: ${items.length} items · ${candidates.length} qualify (score>=${minScore}, max=${maxApply})`);
  console.log(`  · ${urlOnes} via web form · ${emailOnes} via email\n`);

  if (candidates.length === 0) {
    console.log("nothing to apply to today.");
    return;
  }

  const summary: Array<{ company: string; code: number | null; label: string }> = [];
  const codeLabel = (c: number | null) => {
    if (c === 0) return "submitted";
    if (c === 5) return "skipped:captcha";
    if (c === 6) return "skipped:not-apply-form";
    if (c === 7) return "skipped:login-required";
    if (c === 2) return "cancelled";
    return `error:${c}`;
  };

  const candidateCtx = existsSync("CLAUDE.md") ? readFileSync("CLAUDE.md", "utf8") : "";
  const answers = loadAnswers();

  for (const [i, it] of candidates.entries()) {
    // Prefer email channel — higher success rate than web (no CAPTCHA, no anti-bot)
    const channel = (emailOnly || it.job.applyEmail) ? "email" : "web";
    console.log(`\n────── ${i + 1}/${candidates.length}: ${it.job.company ?? "?"} (score ${it.score.total}, ${channel}) ──────`);

    if (channel === "email") {
      const toEmail = it.job.applyEmail!;
      console.log(`  → email apply to ${toEmail}`);
      if (dryRun) {
        const r = await emailApply({
          to: toEmail, company: it.job.company ?? "?", role: it.job.title ?? "Senior Engineer",
          jobText: it.job.text, candidateCtx, resumePath: answers.resumeFile, dryRun: true,
        });
        console.log(`  [dry-run] subject: ${r.subject}`);
        console.log(`  [dry-run] body:\n${r.body}`);
        summary.push({ company: it.job.company ?? "?", code: 0, label: "dry-run:email" });
      } else {
        const r = await emailApply({
          to: toEmail, company: it.job.company ?? "?", role: it.job.title ?? "Senior Engineer",
          jobText: it.job.text, candidateCtx, resumePath: answers.resumeFile,
        });
        if (r.ok) {
          console.log(`  ✓ sent: "${r.subject}"`);
          const apps = readJSON<Application[]>("data/applications.json", []);
          const appUrl = `mailto:${toEmail.toLowerCase()}`;
          apps.push({
            id: genId(), url: appUrl, platform: "auto:email",
            company: it.job.company, title: it.job.title, status: "applied",
            appliedAt: today(), lastUpdate: today(),
            notes: [`${today()}: email sent via Mail.app — subject: ${r.subject}`],
          });
          writeJSON("data/applications.json", apps);
          alreadySent.add(appUrl); // prevent intra-batch dups too
          summary.push({ company: it.job.company ?? "?", code: 0, label: "submitted:email" });
        } else {
          console.log(`  ✗ failed: ${r.reason}`);
          summary.push({ company: it.job.company ?? "?", code: 1, label: `error:email:${r.reason.slice(0, 30)}` });
        }
      }
    } else {
      const flags = ["bin/auto-apply.ts", it.job.applyUrl!];
      if (noPauseFlag) flags.push("--no-pause");
      if (dryRun) flags.push("--dry-run");
      if (skipCaptcha) flags.push("--skip-captcha");
      const r = spawnSync("npx", ["tsx", ...flags], { stdio: "inherit", timeout: 600000 });
      summary.push({ company: it.job.company ?? "?", code: r.status, label: codeLabel(r.status) });
      console.log(`→ ${codeLabel(r.status)} (exit ${r.status})`);
    }

    if (i < candidates.length - 1) {
      const delaySec = DELAY_MIN_SEC + Math.floor(Math.random() * (DELAY_MAX_SEC - DELAY_MIN_SEC));
      console.log(`\nthrottling ${delaySec}s before next apply...`);
      await sleep(delaySec * 1000);
    }
  }

  console.log(`\n══════════════ BATCH SUMMARY ══════════════`);
  for (const s of summary) console.log(`  ${s.label.padEnd(24)}  ${s.company}`);
  const submitted = summary.filter((s) => s.code === 0).length;
  console.log(`──────────────`);
  console.log(`  ${submitted}/${summary.length} submitted`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
