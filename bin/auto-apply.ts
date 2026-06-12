import { chromium, type Page } from "playwright";
import { existsSync, readFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readJSON, writeJSON, today } from "../lib/storage.ts";
import { detectATS, loadAnswers, navigateToForm, submitSelector, type ATS } from "../lib/auto-apply.ts";
import { introspect, plan, execute, isApplyForm, type FormSnapshot, type Action } from "../lib/form-agent.ts";
import { findApplyLink } from "../lib/discover.ts";
import { solveCaptcha } from "../lib/captcha.ts";

const USER_DATA_DIR = ".playwright-data";
const SCREENSHOT_DIR = "data/auto-apply-screenshots";
const LOG_PATH = "data/auto-apply.log";
const APPS_PATH = "data/applications.json";

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

function logEvent(payload: object) {
  mkdirSync("data", { recursive: true });
  appendFileSync(LOG_PATH, JSON.stringify({ ts: new Date().toISOString(), ...payload }) + "\n");
}

function notify(title: string, body = "") {
  const t = title.replace(/"/g, "'");
  const b = body.replace(/"/g, "'");
  spawnSync("osascript", ["-e", `display notification "${b}" with title "${t}" sound name "Glass"`]);
}

function findJobInLatestDigest(idOrUrl: string): { url: string; company?: string; title?: string; text: string } | null {
  const digestPath = `data/digests/${today()}.json`;
  if (!existsSync(digestPath)) return null;
  const d = JSON.parse(readFileSync(digestPath, "utf8"));
  for (const it of d.items ?? []) {
    if (it.job.url === idOrUrl || it.job.applyUrl === idOrUrl) {
      return {
        url: it.job.applyUrl ?? it.job.url,
        company: it.job.company,
        title: it.job.title,
        text: it.job.text,
      };
    }
  }
  return null;
}

async function countdownThen(page: Page, seconds: number): Promise<"submit" | "cancel"> {
  console.log(`\n⏳ Form filled. ${seconds}s before auto-submit.`);
  console.log(`   Press Ctrl+C OR close the browser window to CANCEL.`);
  console.log(`   Do nothing to submit.\n`);
  let aborted = false;
  page.on("close", () => {
    aborted = true;
  });
  const sig = () => {
    aborted = true;
    console.log("\n[cancel] SIGINT");
  };
  process.on("SIGINT", sig);
  for (let i = seconds; i > 0; i--) {
    if (aborted) {
      process.off("SIGINT", sig);
      return "cancel";
    }
    process.stdout.write(`\r⏳ ${i}s...   `);
    await page.waitForTimeout(1000);
  }
  process.off("SIGINT", sig);
  console.log("\r⏰ submitting...   ");
  return aborted ? "cancel" : "submit";
}

async function processForm(
  page: Page,
  ats: ATS,
  ctx: { company: string; role: string; jobText: string; candidateCtx: string; appId: string },
  options: { dryRun?: boolean; skipCaptcha?: boolean; gateCheck?: boolean } = {},
): Promise<{ snapshot: FormSnapshot; actions: Action[]; filledCount: number; failedCount: number }> {
  console.log(`introspecting form...`);
  const snapshot = await introspect(page);
  console.log(`  found ${snapshot.fields.length} fields, captcha=${snapshot.hasCaptcha}, login=${snapshot.hasLoginGate}`);

  if (snapshot.hasLoginGate) {
    throw new Error("login-gate-detected");
  }
  if (snapshot.fields.length === 0) {
    throw new Error("no-fields-found");
  }

  if (options.gateCheck) {
    const gate = isApplyForm(snapshot);
    if (!gate.ok) {
      throw new Error(`not-an-apply-form: ${gate.reason}`);
    }
    console.log(`  apply-form gate: OK (${gate.reason})`);
  }

  if (snapshot.hasCaptcha) {
    if (process.env.TWO_CAPTCHA_API_KEY) {
      console.log(`  CAPTCHA detected — attempting 2captcha solve...`);
      const result = await solveCaptcha(page);
      if (result.solved) {
        console.log(`  ✓ captcha solved: ${result.reason}`);
        logEvent({ event: "captcha-solved", appId: ctx.appId, reason: result.reason });
      } else {
        console.log(`  ✗ captcha solve failed: ${result.reason}`);
        logEvent({ event: "captcha-solve-failed", appId: ctx.appId, reason: result.reason });
        if (options.skipCaptcha) throw new Error("captcha-detected-skipped");
      }
    } else if (options.skipCaptcha) {
      throw new Error("captcha-detected-skipped");
    }
  }

  const answers = loadAnswers();
  console.log(`planning ${snapshot.fields.length} actions with Claude...`);
  const actions = await plan(snapshot, { ...ctx, answers });
  console.log(`  Claude returned ${actions.length} actions`);

  for (const a of actions) {
    if (a.kind === "upload" && (!a.path || a.path === "<resume>")) a.path = answers.resumeFile;
  }

  if (options.dryRun) {
    console.log(`[--dry-run] skipping execution.`);
    return { snapshot, actions, filledCount: 0, failedCount: 0 };
  }

  console.log(`executing actions...`);
  const result = await execute(page, actions);
  console.log(`  ✓ ${result.succeeded.length} succeeded · ✗ ${result.failed.length} failed`);
  for (const f of result.failed) {
    console.log(`    fail: ${f.action.kind} ${f.action.label ?? f.action.selector} — ${f.reason}`);
  }
  logEvent({ event: "filled", appId: ctx.appId, succeeded: result.succeeded.length, failed: result.failed.length, fields: snapshot.fields.length });
  return { snapshot, actions, filledCount: result.succeeded.length, failedCount: result.failed.length };
}

async function isMultiStep(page: Page): Promise<boolean> {
  // After clicking submit on a single-page form we navigate away or see success text.
  // On a multi-step form we get a fresh batch of fields without leaving.
  const after = await introspect(page);
  return after.fields.length > 3 && after.hasSubmitButton && !/(thank|success|received|confirm)/i.test(await page.content());
}

async function detectSuccess(page: Page): Promise<boolean> {
  const url = page.url();
  if (/(thank|success|confirm|complete|received)/i.test(url)) return true;
  const body = await page.content();
  if (/(thank you|application received|application submitted|we will get back|we'll be in touch|successfully applied)/i.test(body)) return true;
  return false;
}

async function main() {
  const args = process.argv.slice(2);
  const review = args.includes("--review");
  const noPause = args.includes("--no-pause");
  const dryRun = args.includes("--dry-run");
  const skipCaptcha = args.includes("--skip-captcha");
  const target = args.find((a) => !a.startsWith("--"));

  if (!target) {
    console.error(`usage: tsx bin/auto-apply.ts <url-or-source-url> [--review|--no-pause|--dry-run|--skip-captcha]
  --review        fill but never submit (browser stays open)
  --no-pause      submit immediately after filling (skip 30s countdown)
  --dry-run       plan but do not execute any browser actions (prints actions JSON)
  --skip-captcha  abort with exit 5 if the form has a CAPTCHA (for autonomous batch)`);
    process.exit(1);
  }

  const jobInfo = findJobInLatestDigest(target) ?? { url: target, text: "", company: undefined, title: undefined };
  const url = jobInfo.url;
  const ats = detectATS(url);
  const candidateCtx = existsSync("CLAUDE.md") ? readFileSync("CLAUDE.md", "utf8") : "";
  const appId = genId();

  console.log(`\n→ auto-apply\n  target: ${url}\n  ATS: ${ats}\n  company: ${jobInfo.company ?? "?"}\n  role: ${jobInfo.title ?? "?"}\n  appId: ${appId}\n`);
  logEvent({ event: "start", appId, url, ats, company: jobInfo.company, title: jobInfo.title });

  if (dryRun) {
    console.log("[--dry-run] launching browser, introspecting, planning, exiting without execution.");
  }

  mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    channel: "chrome",
    headless: false,
    viewport: null,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en", "es-AR", "es"] });
  });

  const page = context.pages()[0] ?? (await context.newPage());

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1500 + Math.random() * 800);

    console.log(`navigating to form (clicking 'Apply' if needed)...`);
    let onForm = await navigateToForm(page, ats);

    // If no form on the current page, try the discover-agent: pick a specific
    // job link from the careers index and retry there.
    if (!onForm) {
      console.log(`no form here — asking discover-agent to find a specific job link...`);
      const found = await findApplyLink(page, {
        company: jobInfo.company ?? "",
        role: jobInfo.title ?? "",
        jobText: jobInfo.text,
      });
      logEvent({ event: "discover", appId, picked: found.href, reason: found.reason });
      if (found.href) {
        console.log(`  picked: ${found.href}`);
        console.log(`  reason: ${found.reason}`);
        try {
          await page.goto(found.href, { waitUntil: "domcontentloaded", timeout: 30000 });
          await page.waitForTimeout(1500);
          onForm = await navigateToForm(page, detectATS(found.href));
        } catch (e) {
          console.error(`  navigate to picked URL failed: ${(e as Error).message}`);
        }
      } else {
        console.log(`  no candidate link found: ${found.reason}`);
      }
    }

    if (!onForm) {
      console.error(`✗ could not reach apply form on ${page.url()}`);
      logEvent({ event: "form-not-found", appId, finalUrl: page.url() });
      notify(`Auto-apply: form not found`, jobInfo.company ?? url);
      if (!noPause) {
        console.log(`browser stays open — press Enter to close.`);
        await new Promise((r) => process.stdin.once("data", r));
      }
      await context.close();
      process.exit(4);
    }
    console.log(`form URL: ${page.url()}`);

    // Step 1: introspect + plan + execute
    let stepNum = 1;
    let totalFilled = 0;
    while (stepNum <= 5) {
      console.log(`\n=== step ${stepNum} ===`);
      const { snapshot, actions, filledCount, failedCount } = await processForm(page, ats, {
        company: jobInfo.company ?? "the company",
        role: jobInfo.title ?? "this role",
        jobText: jobInfo.text,
        candidateCtx,
        appId,
      }, { dryRun, skipCaptcha, gateCheck: stepNum === 1 });
      totalFilled += filledCount;

      if (snapshot.hasCaptcha) {
        console.log(`\n⚠️  CAPTCHA detected. Pausing for you to solve it manually.`);
        notify(`CAPTCHA — solve it manually`, jobInfo.company ?? "");
        if (!dryRun) await new Promise((r) => setTimeout(r, 60000)); // 60s for human to solve
      }

      if (dryRun) {
        console.log("\n[--dry-run] actions planned (NOT executed, NOT submitted, tracker NOT updated):");
        console.log(JSON.stringify(actions, null, 2));
        await context.close();
        return; // bail before submit + tracker side-effects
      }

      const ss = join(SCREENSHOT_DIR, `${appId}-step-${stepNum}.png`);
      await page.screenshot({ path: ss, fullPage: true });
      logEvent({ event: `step-${stepNum}`, appId, screenshot: ss, filled: filledCount, failed: failedCount });

      if (review) {
        console.log(`\n[--review] step ${stepNum} filled. NOT submitting. Press Enter to close.`);
        await new Promise((r) => process.stdin.once("data", r));
        await context.close();
        return;
      }

      // Submit / Next
      const submitBtn = await page.$(submitSelector(ats));
      const nextBtn = await page.$("button:has-text('Next'), button:has-text('Continue'), button:has-text('Next step')");
      const btn = nextBtn ?? submitBtn;
      if (!btn) {
        console.log(`no submit/next button found — assuming form complete.`);
        break;
      }
      const label = nextBtn ? "next" : "submit";
      const action = noPause ? "submit" : await countdownThen(page, label === "next" ? 5 : 30);
      if (action === "cancel") {
        console.log(`[cancel] aborted at step ${stepNum}.`);
        logEvent({ event: "cancelled", appId, step: stepNum });
        await context.close();
        process.exit(2);
      }
      await btn.scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
      await btn.click({ delay: 100 });
      console.log(`clicked ${label} on step ${stepNum}`);

      await Promise.race([
        page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => null),
        page.waitForTimeout(5000),
      ]);

      if (await detectSuccess(page)) {
        console.log(`\n✓ success detected on landing ${page.url()}`);
        break;
      }
      if (!(await isMultiStep(page))) break;
      console.log(`detected multi-step — continuing to step ${stepNum + 1}`);
      stepNum++;
    }

    const ssFinal = join(SCREENSHOT_DIR, `${appId}-final.png`);
    await page.screenshot({ path: ssFinal, fullPage: true });
    const finalUrl = page.url();
    const success = await detectSuccess(page);
    logEvent({ event: "submit-result", appId, success, finalUrl, screenshot: ssFinal });

    if (success) {
      notify(`✓ Submitted: ${jobInfo.company ?? "?"}`, finalUrl);
      console.log(`\n✓ APPLIED to ${jobInfo.company ?? "?"} (${finalUrl})`);
    } else {
      notify(`? Unclear: ${jobInfo.company ?? "?"}`, "Check the screenshot to verify");
      console.log(`\n? Unclear if submitted — check ${ssFinal}`);
    }

    // Tracker update
    const apps = readJSON<Application[]>(APPS_PATH, []);
    apps.push({
      id: appId,
      url,
      platform: `auto:${ats}`,
      company: jobInfo.company,
      title: jobInfo.title,
      status: success ? "applied" : "applied-unverified",
      appliedAt: today(),
      lastUpdate: today(),
      notes: [`${today()}: auto-applied via ${ats} · ${totalFilled} fields filled · success=${success}`],
    });
    writeJSON(APPS_PATH, apps);
    console.log(`tracker: ${appId} added`);

    await page.waitForTimeout(2000);
    await context.close();
  } catch (e) {
    const msg = (e as Error).message;
    console.error(`\n✗ error: ${msg}`);
    logEvent({ event: "error", appId, error: msg });
    const ssErr = join(SCREENSHOT_DIR, `${appId}-error.png`);
    try { await page.screenshot({ path: ssErr, fullPage: true }); } catch {}

    // Distinct exit codes so callers (auto-apply-all) can react.
    let exitCode = 1;
    if (msg === "not-an-apply-form" || msg.startsWith("not-an-apply-form")) {
      notify(`Skipped: not an apply form`, jobInfo.company ?? "?");
      exitCode = 6;
    } else if (msg === "captcha-detected-skipped") {
      notify(`Skipped: CAPTCHA on form`, jobInfo.company ?? "?");
      exitCode = 5;
    } else if (msg === "login-gate-detected") {
      notify(`Login required — manual intervention needed`, jobInfo.company ?? "?");
      exitCode = 7;
      if (!noPause) {
        console.log(`browser stays open — log in manually then press Enter to close.`);
        await new Promise((r) => process.stdin.once("data", r));
      }
    } else {
      notify(`Auto-apply failed`, `${jobInfo.company ?? "?"}: ${msg}`);
    }
    await context.close();
    process.exit(exitCode);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
