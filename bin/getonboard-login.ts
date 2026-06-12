// One-time helper: opens GetOnBoard login in a visible Playwright Chrome
// using the project's persistent context. Log in (Google OAuth works since
// you're already logged in to Google in this profile), close the window —
// the session sticks around in .playwright-data/ for bin/getonboard-apply.ts.
//
// Run: npm run getonboard-login

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
  await page.goto("https://www.getonbrd.com/webpros/login", { waitUntil: "domcontentloaded" });

  console.log(`
══════════════════════════════════════════════════════════════════
  Logueate en la ventana de Chrome (recomendado: "Ingresa con Google").
  Cuando veas tu nombre arriba a la derecha, cerrá la pestaña/ventana.
  La sesión queda guardada en .playwright-data/ para el bot.
══════════════════════════════════════════════════════════════════
`);

  // Poll: logged-in landing redirects to /misempleos and shows our name.
  while (true) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      await page.goto("https://www.getonbrd.com/misempleos", {
        waitUntil: "domcontentloaded",
        timeout: 10000,
      });
      const loginLink = await page.$('a[href*="/login"], a[href*="/signup"]');
      if (!loginLink) {
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

main().catch((e) => { console.error(e); process.exit(1); });
