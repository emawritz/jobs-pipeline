// Import cookies from a Netscape cookie file (exported from Chrome via
// EditThisCookie / Cookies.txt extension) into Playwright's persistent
// context. Bypasses the interactive login flow entirely.
//
// Usage:
//   npx tsx bin/getonboard-import-cookies.ts /path/to/cookies.txt
//
// Filters to getonbrd.com / getonboard.com cookies only.

import { chromium, type Cookie } from "playwright";
import { readFileSync, existsSync } from "node:fs";

const USER_DATA_DIR = ".playwright-data";
const DOMAIN_FILTER = /getonbrd|getonboard/i;

type ParsedCookie = {
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  expires: number;
  name: string;
  value: string;
};

function parseNetscape(text: string): ParsedCookie[] {
  const out: ParsedCookie[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    // Some entries use #HttpOnly_<domain>
    const httpOnlyPrefix = line.startsWith("#HttpOnly_");
    const data = httpOnlyPrefix ? line.replace(/^#HttpOnly_/, "") : line;
    const parts = data.split("\t");
    if (parts.length < 7) continue;
    const [domain, flag, path, secure, expires, name, value] = parts;
    out.push({
      domain: domain.trim(),
      hostOnly: flag.toUpperCase() !== "TRUE",
      path: path || "/",
      secure: secure.toUpperCase() === "TRUE",
      expires: parseInt(expires, 10) || -1,
      name: name.trim(),
      value: value.trim(),
    });
  }
  return out;
}

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("uso: npx tsx bin/getonboard-import-cookies.ts <cookies.txt>");
    process.exit(1);
  }
  if (!existsSync(file)) {
    console.error(`no existe: ${file}`);
    process.exit(1);
  }

  const all = parseNetscape(readFileSync(file, "utf8"));
  const filtered = all.filter((c) => DOMAIN_FILTER.test(c.domain));
  console.log(`[import] total cookies parsed: ${all.length}, getonboard matched: ${filtered.length}`);

  if (filtered.length === 0) {
    console.error("no se encontraron cookies de getonbrd. abortando.");
    process.exit(1);
  }

  // Convert to Playwright cookie shape.
  const pwCookies: Cookie[] = filtered.map((c) => {
    // Playwright requires either url OR (domain + path).
    // For hostOnly cookies the domain should NOT start with a dot.
    let dom = c.domain;
    if (c.hostOnly && dom.startsWith(".")) dom = dom.slice(1);
    if (!c.hostOnly && !dom.startsWith(".")) dom = "." + dom;
    return {
      name: c.name,
      value: c.value,
      domain: dom,
      path: c.path,
      // 0 → session cookie; treat as Date.now()+30d so it sticks for a bit.
      expires: c.expires > 0 ? c.expires : Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30,
      httpOnly: c.name === "_getonboard_session", // session cookie is HttpOnly in production
      secure: c.secure,
      sameSite: "Lax",
    };
  });

  console.log("[import] cookies preview:");
  for (const c of pwCookies) {
    console.log(`  ${c.name}@${c.domain}${c.path} secure=${c.secure} httpOnly=${c.httpOnly}`);
  }

  const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
    channel: "chrome",
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  try {
    await ctx.addCookies(pwCookies);
    console.log(`✓ injected ${pwCookies.length} cookies into Playwright profile`);

    // Verify by visiting /misempleos (which redirects to /login when not authed).
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto("https://www.getonbrd.com/misempleos", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    const url = page.url();
    const html = await page.content();
    const loggedIn =
      !/Iniciar sesi[oó]n|Sign in to apply/i.test(html.slice(0, 5000)) ||
      /misempleos|webpros/.test(url);
    console.log(`\nverification: url=${url}`);
    console.log(`logged-in heuristic: ${loggedIn ? "✓ yes" : "✗ no"}`);
    if (!loggedIn) {
      console.log("(if it says NO but cookies look right, the session cookie may have expired — re-export from your logged-in Chrome.)");
    }
  } finally {
    await ctx.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
