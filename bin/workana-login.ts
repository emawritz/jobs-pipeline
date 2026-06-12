// One-time helper: opens Workana login in a visible browser.
// Log in manually, close the window — session saved in .playwright-data/.

import { chromium } from "playwright";

const USER_DATA_DIR = ".playwright-data";

async function main() {
  const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
    channel: "chrome",
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto("https://www.workana.com/login", { waitUntil: "domcontentloaded" });
  console.log(`
══════════════════════════════════════════════════════════════════
  Login manualmente en la ventana de Chrome.
  Cuando veas tu nombre arriba a la derecha, cerrá la pestaña.
══════════════════════════════════════════════════════════════════
`);
  while (true) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      await page.goto("https://www.workana.com/jobs", {
        waitUntil: "domcontentloaded",
        timeout: 10000,
      });
      const login = await page.$('a[href*="/login"]');
      if (!login) {
        console.log("✓ logueado. Session saved at .playwright-data/. Cerrando.");
        break;
      }
    } catch {
      console.log("ventana cerrada antes de loguear.");
      break;
    }
  }
  await ctx.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
