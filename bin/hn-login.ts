// One-time helper: opens HN login in a visible browser using the persistent context.
// Log in manually, then close the window. Session cookie is then reused by bin/hn-post.ts.

import { chromium } from "playwright";

const USER_DATA_DIR = ".playwright-data";

async function main() {
  const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
    channel: "chrome",
    headless: false,
    viewport: { width: 1200, height: 800 },
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto("https://news.ycombinator.com/login", { waitUntil: "domcontentloaded" });

  console.log(`
══════════════════════════════════════════════════════════════════
  Log in manually in the Chrome window that just opened.
  After you see your username top-right, close the browser tab.
  This script will then exit and your session is saved.
══════════════════════════════════════════════════════════════════
`);

  // Poll for login (logout link present on /).
  while (true) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      await page.goto("https://news.ycombinator.com/", { waitUntil: "domcontentloaded", timeout: 10000 });
      const logout = await page.$('a[href^="logout"]');
      if (logout) {
        console.log("✓ logged in. session saved to .playwright-data/. Closing browser.");
        break;
      }
    } catch {
      // Browser closed manually? Exit.
      console.log("browser closed before login confirmed.");
      break;
    }
  }
  await ctx.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
