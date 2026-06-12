import type { Page } from "playwright";

// 2captcha solver. Opt-in via TWO_CAPTCHA_API_KEY env var.
// Supports hCaptcha + reCaptcha v2 (the two most common on Lever/Greenhouse/Ashby).
// Pricing as of writing: hCaptcha ~$0.003, reCaptcha v2 ~$0.003. $5 ≈ 1500 solves.

const API = "https://2captcha.com";
const POLL_INTERVAL_MS = 5000;
const MAX_WAIT_MS = 180_000; // 3 min — 2captcha workers usually solve in 30-90s

type CaptchaInfo =
  | { kind: "hcaptcha"; sitekey: string }
  | { kind: "recaptcha-v2"; sitekey: string }
  | { kind: "none" };

// Read sitekeys directly from the DOM via Playwright.
export async function detectCaptcha(page: Page): Promise<CaptchaInfo> {
  return await page.evaluate(() => {
    const h = document.querySelector("[class*='h-captcha'][data-sitekey], .h-captcha, iframe[src*='hcaptcha']");
    if (h) {
      const key = h.getAttribute("data-sitekey") ?? null;
      if (key) return { kind: "hcaptcha" as const, sitekey: key };
      const iframe = document.querySelector("iframe[src*='hcaptcha']") as HTMLIFrameElement | null;
      if (iframe) {
        const m = iframe.src.match(/sitekey=([a-zA-Z0-9-]+)/);
        if (m) return { kind: "hcaptcha" as const, sitekey: m[1] };
      }
    }
    const g = document.querySelector(".g-recaptcha[data-sitekey], [data-sitekey]");
    if (g) {
      const key = g.getAttribute("data-sitekey");
      if (key) return { kind: "recaptcha-v2" as const, sitekey: key };
    }
    return { kind: "none" as const };
  });
}

async function http<T>(url: string): Promise<T> {
  const res = await fetch(url);
  return (await res.json()) as T;
}

async function submit2captcha(info: { kind: "hcaptcha" | "recaptcha-v2"; sitekey: string }, pageUrl: string): Promise<string> {
  const key = process.env.TWO_CAPTCHA_API_KEY;
  if (!key) throw new Error("TWO_CAPTCHA_API_KEY not set");
  const method = info.kind === "hcaptcha" ? "hcaptcha" : "userrecaptcha";
  const url = `${API}/in.php?key=${key}&method=${method}&sitekey=${encodeURIComponent(info.sitekey)}&pageurl=${encodeURIComponent(pageUrl)}&json=1`;
  type In = { status: number; request: string };
  const r = await http<In>(url);
  if (r.status !== 1) throw new Error(`2captcha submit failed: ${r.request}`);
  return r.request; // request id
}

async function poll2captcha(id: string): Promise<string> {
  const key = process.env.TWO_CAPTCHA_API_KEY!;
  const start = Date.now();
  while (Date.now() - start < MAX_WAIT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    type Res = { status: number; request: string };
    const r = await http<Res>(`${API}/res.php?key=${key}&action=get&id=${id}&json=1`);
    if (r.status === 1) return r.request;
    if (r.request !== "CAPCHA_NOT_READY") throw new Error(`2captcha poll error: ${r.request}`);
  }
  throw new Error("2captcha timeout");
}

// Inject the solved token into the page so the form treats it as solved.
async function injectToken(page: Page, info: { kind: "hcaptcha" | "recaptcha-v2" }, token: string): Promise<void> {
  if (info.kind === "hcaptcha") {
    await page.evaluate((t) => {
      const fields = document.querySelectorAll("textarea[name='h-captcha-response'], textarea[name='g-recaptcha-response']");
      fields.forEach((f) => {
        (f as HTMLTextAreaElement).value = t;
      });
      // hCaptcha widget: trigger the callback if defined.
      const w = (window as unknown as { hcaptcha?: { execute?: (k?: string) => void } }).hcaptcha;
      if (w && typeof w.execute === "function") {
        try { w.execute(); } catch {}
      }
    }, token);
  } else {
    await page.evaluate((t) => {
      const fields = document.querySelectorAll("textarea[name='g-recaptcha-response'], #g-recaptcha-response");
      fields.forEach((f) => {
        (f as HTMLTextAreaElement).value = t;
        f.setAttribute("style", "display: block;");
      });
      // Try to call the page's recaptcha callback.
      const w = window as unknown as { ___grecaptcha_cfg?: { clients?: Record<string, unknown> } };
      const cfg = w.___grecaptcha_cfg;
      if (cfg && cfg.clients) {
        const findCallback = (obj: unknown): ((token: string) => void) | null => {
          if (!obj || typeof obj !== "object") return null;
          for (const v of Object.values(obj as Record<string, unknown>)) {
            if (typeof v === "function" && (v as Function).length === 1) return v as (t: string) => void;
            const nested = findCallback(v);
            if (nested) return nested;
          }
          return null;
        };
        const cb = findCallback(cfg.clients);
        if (cb) {
          try { cb(t); } catch {}
        }
      }
    }, token);
  }
}

export async function solveCaptcha(page: Page): Promise<{ solved: boolean; reason: string }> {
  if (!process.env.TWO_CAPTCHA_API_KEY) return { solved: false, reason: "TWO_CAPTCHA_API_KEY not set" };
  const info = await detectCaptcha(page);
  if (info.kind === "none") return { solved: false, reason: "no captcha detected" };
  console.log(`  solving ${info.kind} (sitekey ${info.sitekey.slice(0, 10)}...)`);
  try {
    const id = await submit2captcha(info, page.url());
    console.log(`  2captcha request ${id} submitted, polling...`);
    const token = await poll2captcha(id);
    console.log(`  token received (${token.length} chars), injecting...`);
    await injectToken(page, info, token);
    await page.waitForTimeout(1000);
    return { solved: true, reason: `${info.kind} solved` };
  } catch (e) {
    return { solved: false, reason: (e as Error).message };
  }
}
