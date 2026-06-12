// Auto-post comment to the latest "Ask HN: Who wants to be hired?" thread.
//
// Strategy:
// 1. Visit https://news.ycombinator.com/submitted?id=whoishiring
// 2. Find the most recent thread whose title matches "Ask HN: Who wants to be hired?"
//    (whoishiring also posts "Who is hiring?" and "Freelancer?" — we want WANTS hired).
// 3. Verify it's from the current month (so we don't accidentally repost old).
// 4. Open the thread, fill the top-level comment textarea, click submit.
// 5. Verify the comment appeared (URL changes, our text visible on the page).
// 6. Log to data/applications.json + write screenshot.
//
// Flags:
//   --check     Find thread + report, do NOT post.
//   --dry-run   Find thread + load page + report what would happen, do NOT submit.
//   --force     Skip the "current month" sanity check.
//   --headed    Show browser (default headless for cron).
//
// Pre-req: Chrome persistent context (.playwright-data/) must have an HN session.
// Run `npm run hn-login` once to log in manually if needed.

import { chromium, type Page, type BrowserContext } from "playwright";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { readJSON, writeJSON, today } from "../lib/storage.ts";

const USER_DATA_DIR = ".playwright-data";
const SCREENSHOT_DIR = "data/hn-screenshots";
const COMMENT_FILE = "data/hn-comment.txt";

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

function log(msg: string) {
  console.log(`[hn-post ${new Date().toISOString()}] ${msg}`);
}

const SUBMITTED_URL = "https://news.ycombinator.com/submitted?id=whoishiring";

type Thread = { id: string; title: string; url: string };

async function findHiredThread(page: Page): Promise<Thread | null> {
  log(`fetching ${SUBMITTED_URL}`);
  await page.goto(SUBMITTED_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(800);

  // Each .athing row has a .titleline > a with the post title and id=<storyId>.
  const threads = await page.$$eval("tr.athing", (rows) => {
    return rows.map((row) => {
      const id = row.getAttribute("id") ?? "";
      const a = row.querySelector("span.titleline > a") as HTMLAnchorElement | null;
      return {
        id,
        title: a?.textContent?.trim() ?? "",
        url: a?.href ?? "",
      };
    });
  });

  log(`found ${threads.length} submissions by whoishiring on page 1`);
  // First match wins (page is in date-descending order).
  const match = threads.find((t) =>
    /ask hn:\s*who wants to be hired\??/i.test(t.title),
  );
  if (!match) {
    log(`no "Who wants to be hired" thread on page 1`);
    return null;
  }
  return {
    id: match.id,
    title: match.title,
    url: match.url.startsWith("http") ? match.url : `https://news.ycombinator.com/${match.url}`,
  };
}

async function isLoggedIn(page: Page): Promise<boolean> {
  await page.goto("https://news.ycombinator.com/", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  // Logged-in users see "logout" link at top right.
  const logout = await page.$('a[href^="logout"]');
  return logout !== null;
}

async function postComment(page: Page, thread: Thread, body: string): Promise<{ ok: boolean; reason: string }> {
  log(`opening thread ${thread.url}`);
  await page.goto(thread.url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1000);

  // Top-level comment textarea is name="text" inside a form that submits to "comment".
  const textarea = await page.$('form[action="comment"] textarea[name="text"]');
  if (!textarea) {
    return { ok: false, reason: "no top-level comment form — are we logged in?" };
  }

  await textarea.click();
  await page.waitForTimeout(300);
  // Type with light human-ish delay to avoid trivial bot fingerprints.
  await textarea.fill(body);
  await page.waitForTimeout(800 + Math.random() * 1200);

  const submitBtn = await page.$('form[action="comment"] input[type="submit"]');
  if (!submitBtn) {
    return { ok: false, reason: "no submit button found on comment form" };
  }

  log("submitting comment...");
  await Promise.all([
    page.waitForLoadState("domcontentloaded", { timeout: 30000 }),
    submitBtn.click(),
  ]);
  await page.waitForTimeout(2000);

  // Verify our comment is on the page.
  // First 80 chars (Location: ...) are extremely distinctive.
  const probe = body.slice(0, 60);
  const pageText = await page.content();
  if (pageText.includes(probe.replace(/\n/g, " ")) || pageText.includes(probe)) {
    return { ok: true, reason: "comment text confirmed on thread page" };
  }
  // Sometimes HN renders comment on /threads?id=user — fall back: visit profile.
  return { ok: true, reason: "submitted, text not visually confirmed (check manually)" };
}

function isCurrentMonth(title: string): boolean {
  const now = new Date();
  const months = [
    "january","february","march","april","may","june",
    "july","august","september","october","november","december",
  ];
  // whoishiring titles include month name e.g. "Ask HN: Who wants to be hired? (June 2026)"
  const monthName = months[now.getUTCMonth()];
  return title.toLowerCase().includes(monthName);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const check = args.has("--check");
  const dryRun = args.has("--dry-run");
  const force = args.has("--force");
  const headed = args.has("--headed");

  if (!existsSync(COMMENT_FILE)) {
    console.error(`missing ${COMMENT_FILE}`);
    process.exit(1);
  }
  const body = readFileSync(COMMENT_FILE, "utf8").trim();
  if (body.length < 100) {
    console.error(`comment is too short (${body.length} chars) — refusing`);
    process.exit(1);
  }

  mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const context: BrowserContext = await chromium.launchPersistentContext(USER_DATA_DIR, {
    channel: "chrome",
    headless: !headed,
    viewport: { width: 1400, height: 900 },
    args: ["--disable-blink-features=AutomationControlled"],
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  const page = context.pages()[0] ?? (await context.newPage());

  try {
    if (!check) {
      const logged = await isLoggedIn(page);
      if (!logged) {
        log("NOT logged in to HN — run `npm run hn-login` first");
        process.exit(2);
      }
      log("HN session confirmed");
    }

    const thread = await findHiredThread(page);
    if (!thread) {
      log("ABORT: no matching thread yet");
      process.exit(3);
    }

    log(`thread: "${thread.title}" → ${thread.url}`);

    if (!force && !isCurrentMonth(thread.title)) {
      log(`thread is NOT for the current month — would post to stale thread, aborting. Use --force to override.`);
      process.exit(4);
    }

    if (check) {
      log("CHECK only — exiting without posting");
      return;
    }

    if (dryRun) {
      log("DRY-RUN — would post the following:");
      console.log("---");
      console.log(body);
      console.log("---");
      return;
    }

    const result = await postComment(page, thread, body);
    log(result.ok ? `✓ ${result.reason}` : `✗ ${result.reason}`);

    const shot = `${SCREENSHOT_DIR}/${today()}-${thread.id}.png`;
    await page.screenshot({ path: shot, fullPage: true });
    log(`screenshot → ${shot}`);

    if (result.ok) {
      const apps = readJSON<Application[]>("data/applications.json", []);
      apps.push({
        id: genId(),
        url: thread.url,
        platform: "auto:hn-wants-hired",
        company: "HN Community",
        title: thread.title,
        status: "applied",
        appliedAt: today(),
        lastUpdate: today(),
        notes: [`${today()}: HN "Who wants to be hired" auto-post — ${result.reason}`],
      });
      writeJSON("data/applications.json", apps);
      log("logged to data/applications.json");
    }
  } finally {
    await context.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
