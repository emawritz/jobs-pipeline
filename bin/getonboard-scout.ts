// Scout the GetOnBoard apply flow step by step using Playwright.
//
// Walks through a real job application from start to (just before) final submit.
// At every screen: screenshot + dump of relevant DOM state (URL, visible
// buttons/links matching apply/next/submit, form fields, breadcrumb step).
//
// Output: data/getonboard-flow/
//   00_job_page.png + 00_job_page.json
//   01_after_postular.png + 01_after_postular.json
//   02_after_next.png + 02_after_next.json
//   ...
//   NN_preview.png + NN_preview.json   ← LAST. Does NOT click final submit.
//
// Use this output to write/fix the production bot's selectors precisely.
//
// Usage:
//   npx tsx bin/getonboard-scout.ts <jobUrl>
//   npx tsx bin/getonboard-scout.ts        # picks first scraped job

import { chromium, type Page } from "playwright";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { scrape } from "../scrapers/getonboard.ts";

const USER_DATA_DIR = ".playwright-data";
const FLOW_DIR = "data/getonboard-flow";
const SLOW_MS = 1500; // pause between actions so screenshots are stable

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

async function dumpState(page: Page, label: string, idx: number): Promise<void> {
  mkdirSync(FLOW_DIR, { recursive: true });
  const base = join(FLOW_DIR, `${pad(idx)}_${label}`);

  // Screenshot (full page so we see what's below the fold too).
  try {
    await page.screenshot({ path: `${base}.png`, fullPage: true });
  } catch (e) {
    console.log(`  [warn] screenshot failed: ${(e as Error).message}`);
  }

  // DOM dump — find any element relevant to the apply flow.
  const dump = await page.evaluate(`
    (function () {
      function visible(el) {
        var s = window.getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden') return false;
        var r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }
      function clean(s) { return String(s || '').replace(/\\s+/g, ' ').trim(); }

      var url = location.href;

      var breadcrumb = '';
      var bcEl = document.querySelector('[class*="step"], [class*="breadcrumb"], nav ol, nav ul');
      if (bcEl) breadcrumb = clean(bcEl.textContent).slice(0, 200);

      var ctas = [];
      var allClickable = Array.prototype.slice.call(document.querySelectorAll('a, button, input[type="submit"]'));
      for (var i = 0; i < allClickable.length; i++) {
        var el = allClickable[i];
        if (!visible(el)) continue;
        var txt = clean(el.innerText || el.value || '');
        if (!/postul|enviar|siguiente|continuar|next|submit|aplicar|apply|revisar/i.test(txt)) continue;
        ctas.push({
          tag: el.tagName,
          type: el.type || '',
          text: txt.slice(0, 80),
          href: el.href || '',
          classes: clean(el.className).slice(0, 100),
          dataAttrs: Object.keys(el.dataset || {}).map(function (k) { return k + '=' + el.dataset[k]; }).join(','),
          inDialog: !!el.closest('[role="dialog"], [class*="modal"]')
        });
      }

      var fields = [];
      var inputs = Array.prototype.slice.call(document.querySelectorAll('input, select, textarea, trix-editor'));
      for (var j = 0; j < inputs.length; j++) {
        var f = inputs[j];
        if (!visible(f)) continue;
        var type = f.type || f.tagName.toLowerCase();
        if (type === 'hidden' || type === 'submit' || type === 'button') continue;
        var name = f.getAttribute('name') || f.id || '';
        if (/authenticity_token|utf8|_method|^q$/.test(name)) continue;
        var label = '';
        if (f.id) {
          var lbl = document.querySelector('label[for="' + f.id + '"]');
          if (lbl) label = clean(lbl.textContent).slice(0, 120);
        }
        if (!label) {
          var pLbl = f.closest('label');
          if (pLbl) label = clean(pLbl.textContent).slice(0, 120);
        }
        fields.push({
          tag: f.tagName,
          type: type,
          name: name,
          id: f.id || '',
          required: f.hasAttribute('required'),
          value: clean(f.value || '').slice(0, 60),
          label: label,
          placeholder: f.placeholder || '',
          minlength: f.getAttribute('minlength') || '',
          maxlength: f.getAttribute('maxlength') || ''
        });
      }

      var banner = clean(document.body.innerText).match(/Tu pa[ií]s no coincide[^\\n]{0,80}|Aún no puedes[^\\n]{0,80}|requires.*English|requiere.*Ingl[eé]s|Ésta es una vista previa[^\\n]{0,120}|Tienes una postulaci[oó]n por enviar/);

      return {
        url: url,
        title: document.title,
        breadcrumb: breadcrumb,
        cta_buttons: ctas,
        form_fields: fields,
        notable_banner: banner ? banner[0] : null
      };
    })()
  `);

  writeFileSync(`${base}.json`, JSON.stringify(dump, null, 2));
  console.log(`  · ${base}.png + .json  (url: ${(dump as { url: string }).url})`);
  return dump as unknown as Promise<void>;
}

async function clickByText(page: Page, regex: RegExp): Promise<boolean> {
  const handle = await page.evaluateHandle(
    `(function () {
      var els = Array.prototype.slice.call(document.querySelectorAll('a, button, input[type="submit"]'));
      var re = ${regex.toString()};
      for (var i = 0; i < els.length; i++) {
        var t = (els[i].innerText || els[i].value || '').trim();
        if (re.test(t)) {
          var s = window.getComputedStyle(els[i]);
          if (s.display !== 'none' && s.visibility !== 'hidden') return els[i];
        }
      }
      return null;
    })()`,
  );
  const el = handle.asElement();
  if (!el) return false;
  try {
    await el.scrollIntoViewIfNeeded();
    await el.click({ delay: 80 });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const explicitUrl = process.argv[2];
  let jobUrl = explicitUrl;

  if (!jobUrl) {
    console.log("[scout] no URL provided; scraping first match…");
    const jobs = await scrape();
    if (jobs.length === 0) {
      console.error("no jobs scraped");
      process.exit(1);
    }
    jobUrl = jobs[0].url;
    console.log(`[scout] using: ${jobUrl}`);
  }

  if (!existsSync(USER_DATA_DIR)) {
    console.error(`missing ${USER_DATA_DIR} — log in first or import cookies`);
    process.exit(1);
  }

  mkdirSync(FLOW_DIR, { recursive: true });

  const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
    channel: "chrome",
    headless: false,
    viewport: { width: 1400, height: 900 },
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());

  let stepIdx = 0;
  try {
    // ───── STEP 0: Job page ─────
    console.log(`\n══ STEP ${pad(stepIdx)}: load job page ══`);
    await page.goto(jobUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(SLOW_MS);
    await dumpState(page, "job_page", stepIdx++);

    // ───── STEP 1: click Postular (or resume draft) ─────
    console.log(`\n══ STEP ${pad(stepIdx)}: click Postular ══`);
    const postularClicked = await clickByText(page, /^postular$|tienes una postulaci[oó]n por enviar/i);
    if (!postularClicked) {
      console.log("  [warn] Postular link not found — stopping here");
      await dumpState(page, "no_postular", stepIdx++);
      return;
    }
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => null);
    await page.waitForTimeout(SLOW_MS);
    await dumpState(page, "after_postular", stepIdx++);

    // ───── STEPS 2-N: walk through Siguiente steps until preview/submit ─────
    const MAX_NEXT_STEPS = 5;
    for (let s = 0; s < MAX_NEXT_STEPS; s++) {
      // Stop BEFORE submitting on preview — we just want to inspect what it looks like.
      const currentUrl = page.url();
      const isPreview =
        /job_application_preview=true/.test(currentUrl) ||
        /Ésta es una vista previa de tu postulaci[oó]n/.test(await page.content());
      if (isPreview) {
        console.log(`\n══ STEP ${pad(stepIdx)}: REACHED PREVIEW (stopping before submit) ══`);
        await dumpState(page, "preview_BEFORE_SUBMIT", stepIdx++);

        // Also: try opening the modal if it's the list page, so we capture the submit button.
        const modalOpen = await page.$("button:has-text('Enviar postulación')");
        if (!modalOpen) {
          const opened = await clickByText(page, /por enviar/i);
          if (opened) {
            await page.waitForTimeout(SLOW_MS);
            await dumpState(page, "preview_modal_open", stepIdx++);
          }
        }
        return;
      }

      console.log(`\n══ STEP ${pad(stepIdx)}: trying Siguiente ══`);
      // Try the regular Siguiente OR the "Siguiente: Revisar y enviar"
      const advanced = await clickByText(page, /^siguiente(:|$)|^next$/i);
      if (!advanced) {
        console.log(`  [warn] no Siguiente button found at step ${stepIdx} — stopping`);
        await dumpState(page, "no_next", stepIdx++);
        return;
      }
      await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => null);
      await page.waitForTimeout(SLOW_MS);
      await dumpState(page, `after_next_${s + 1}`, stepIdx++);
    }
  } finally {
    console.log(`\nscout done. saved ${stepIdx} steps to ${FLOW_DIR}/`);
    console.log("review:  open " + FLOW_DIR);
    await page.waitForTimeout(2000);
    await ctx.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
