// GetOnBoard auto-postular — fills the platform's native application form
// (Trix-editor cover letter on step 1, "Siguiente" through steps 2-3, then
// "Enviar postulación"). Re-uses the persistent Chrome session at
// .playwright-data/ which must already be logged in via Google OAuth.
//
// Flags:
//   --dry-run    scrape + draft cover letters → data/getonboard-drafts.md, no browser submits
//   --review     for each job: open + fill + readline "submit? [y/N/skip-all]"
//   --auto       (default) fully autonomous, throttled
//   --max=N      cap (default 5)
//   --headed     show browser (auto-true in review mode)

import { chromium, type Page, type BrowserContext } from "playwright";
import { createInterface } from "node:readline/promises";
import { mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scrape } from "../scrapers/getonboard.ts";
import { callText, DRAFT_MODEL } from "../lib/claude.ts";
import { loadProfile } from "../lib/email-apply.ts";
import { getActivePrompt } from "../lib/prompts/registry.ts";
import { saveCoverLetter } from "../lib/cover-letter-store.ts";
import { readJSON, writeJSON, today } from "../lib/storage.ts";
import type { RawJob } from "../lib/score.ts";

const USER_DATA_DIR = ".playwright-data";
const SCREENSHOT_DIR = "data/auto-apply-screenshots";
const LOG_PATH = "data/auto-apply.log";
const APPS_PATH = "data/applications.json";
const DRAFTS_PATH = "data/getonboard-drafts.md";

const SENIOR_HINTS = /\b(senior|sr\.?|staff|principal|lead|founding|head|líder|lider)\b/i;

// MUST match the candidate's profile (full-stack / product engineer / AI engineer / backend with web).
// Title must include at least one of these keywords to be considered.
const PROFILE_MATCH = /\b(full[-\s]?stack|fullstack|product\s?engineer|software\s?engineer|software\s?developer|backend|back[-\s]?end|nest(?:js)?|node(?:js|\.js)?|founding\s?engineer|ai\s?engineer|ml\s?engineer|llm\s?engineer|typescript|javascript|angular|react|svelte|next\.?js|web\s?developer|developer)\b/i;

// Roles outside the candidate's profile (Senior Product Engineer / Full-Stack / AI / SaaS).
// Reject by TITLE: QA, designer, data analyst, devops/sre-only, marketing, PM, mobile-native, game dev,
// data engineer puro (ETL/pipeline-focused, not the candidate's strength).
const TITLE_EXCLUDE = /\b(qa|quality\s?assurance|tester|sdet|automation\s?engineer|designer|ux|ui\s?engineer|figma|graphic|illustrator|data\s?engineer|data\s?analyst|business\s?analyst|bi\s?analyst|sql\s?analyst|devops\s?engineer|sre|site\s?reliability|sysadmin|system\s?admin|network|cybersecurity|pentester|marketing|growth|seo|sem|copywriter|content|community|sales|account\s?(executive|manager)|customer\s?(success|support)|product\s?(manager|owner)|project\s?manager|scrum\s?master|recruit|talent|hr\b|human\s?resources|ios\s?developer|android\s?developer|kotlin\s?developer|swift\s?developer|flutter\s?developer|game\s?(dev|developer|engineer)|unity|unreal|salesforce|sap|odoo|dynamics|sharepoint|drupal|magento|shopify\s?dev|liferay|finance|accountant|controller|legal|paralegal)\b/i;

// Body-text exclusions (the candidate's anti-objectives list).
const EXCLUDE = /\b(wordpress|elementor|crypto|web3|blockchain|nft|defi|casino|gambling|unpaid|stipend\s?only|equity\s?only)\b/i;

const DELAY_MIN_SEC = 60;
const DELAY_MAX_SEC = 120;

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

function arg(flag: string, def?: string): string | undefined {
  const m = process.argv.find((a) => a.startsWith(`${flag}=`));
  return m ? m.split("=")[1] : def;
}
function has(flag: string): boolean {
  return process.argv.includes(flag);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// SYSTEM prompts are intentionally GENERIC. All candidate-specific context
// (name, projects, metrics, anti-objectives) comes from MASTER.md via
// `candidateCtx` in the user message. Keep these prompts portable.
const SYSTEM_EN = `You write a job application cover letter for the candidate described in the MASTER profile below.

NON-NEGOTIABLE RULES:
- Plain text. NO markdown. NO emojis. NO greeting/sign-off lines (the form is contextual — no "Dear Hiring Manager" / "Best regards").
- 600-1500 characters TOTAL.
- Exactly 3 short paragraphs separated by a blank line:
  · Para 1: hook referencing ONE specific detail from this posting (tech choice, product fact, phrase from the post). 1-2 sentences.
  · Para 2: ONE project of the candidate's mapping to the role + ONE concrete metric. Pull projects + metrics from the MASTER profile — DO NOT invent.
  · Para 3: what the candidate ships in week 1-2 + timezone overlap line. End with a soft CTA.
- BANNED words: passionate, rockstar, ninja, synergy, leverage, perfect fit, I believe, amazing opportunity, I am writing to express.
- NEVER invent projects, metrics, or credentials not present in MASTER. If MASTER lacks evidence for a claim, omit the claim.

OUTPUT: plain text body ONLY. No JSON, no quotes wrapping, no preamble.`;

const SYSTEM_ES = `Escribís una carta de presentación para una postulación de trabajo para el candidato descrito en el perfil MASTER de abajo.

REGLAS NO NEGOCIABLES:
- Texto plano. SIN markdown. SIN emojis. SIN saludo ni despedida ("Hola equipo", "Saludos", etc.) — el formulario ya es contextual.
- 600-1500 caracteres TOTAL.
- Exactamente 3 párrafos cortos separados por línea en blanco:
  · Párrafo 1: hook referenciando UN detalle específico del posting (elección técnica, fact del producto, frase del aviso). 1-2 oraciones.
  · Párrafo 2: UN proyecto del candidato que mapea al rol + UNA métrica concreta. Tomá proyectos + métricas del perfil MASTER — NO inventes.
  · Párrafo 3: qué entrega el candidato en la semana 1-2 + línea de overlap timezone. Cerrá con un CTA suave.
- PROHIBIDAS: apasionado, rockstar, ninja, sinergia, perfect fit, yo creo que, increíble oportunidad, "me dirijo a ustedes para".
- Español natural (vos / tú según país del candidato — inferí del MASTER).
- NUNCA inventes proyectos, métricas o credenciales que no estén en el MASTER. Si el MASTER no tiene evidencia para un claim, omití el claim.

OUTPUT: SOLO el texto del cuerpo. Sin JSON, sin comillas, sin preámbulo.`;

async function draftCover(
  job: { company: string; title: string; text: string; url?: string },
  language: "en" | "es",
  candidateCtx: string,
  appId?: string,
): Promise<string> {
  // Pull the ACTIVE prompt version from the registry. Falls back to built-in
  // constants only if the registry is broken (paranoia guard).
  const promptKey = language === "en" ? "cover-letter-en" : "cover-letter-es";
  let sys: string;
  let promptVersion: string;
  try {
    const active = await getActivePrompt(promptKey);
    sys = active.systemPrompt;
    promptVersion = active.version;
  } catch {
    sys = language === "en" ? SYSTEM_EN : SYSTEM_ES;
    promptVersion = "1.0.0-builtin";
  }

  const user = `CANDIDATE CONTEXT (MASTER profile):
${candidateCtx.slice(0, 7000)}

JOB:
Company: ${job.company}
Role: ${job.title}
Posting (full text — reference specifics):
${job.text.slice(0, 4000)}

Write the cover letter body now. Plain text only.`;
  const out = await callText(user, { system: sys, model: DRAFT_MODEL, timeoutMs: 180000 });
  const body = out.replace(/^```[a-z]*\s*/i, "").replace(/```$/, "").replace(/^["']|["']$/g, "").trim();

  // Persist for the self-iteration loop.
  if (appId) {
    try {
      saveCoverLetter({
        appId,
        promptKey,
        promptVersion,
        language,
        company: job.company,
        title: job.title,
        jobUrl: job.url ?? "",
        jobTextSnippet: job.text.slice(0, 500),
        subject: null,
        body,
        generatedAt: new Date().toISOString(),
      });
    } catch (e) {
      console.error(`  (warn) saveCoverLetter failed: ${(e as Error).message}`);
    }
  }
  return body;
}

// Convert plain text cover letter into the Trix-compatible HTML (paragraph divs).
function coverToHtml(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.split("\n").map((l) => l.trim()).filter(Boolean).join("<br>"))
    .filter(Boolean)
    .map((p) => `<div>${p}</div>`)
    .join("");
}

async function dismissCookieBanner(page: Page): Promise<void> {
  try {
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button, a"));
      for (const b of buttons) {
        const t = (b.textContent ?? "").trim().toLowerCase();
        if (/^(aceptar|accept|aceptar cookies|accept all|got it|entendido)/.test(t)) {
          (b as HTMLElement).click();
          return;
        }
      }
      // Common selector heuristics
      const sels = ["#cookie-banner button", ".cookie-banner button", "[class*='cookie'] button"];
      for (const s of sels) {
        const el = document.querySelector(s) as HTMLElement | null;
        if (el) el.click();
      }
    });
  } catch {}
}

async function detectLoggedIn(page: Page): Promise<boolean> {
  const html = await page.content();
  // "Iniciar sesión" or "Sign in" present → not logged in.
  if (/Iniciar sesión|Iniciar Sesi[oó]n|Sign in to apply/i.test(html)) {
    // Could be a sign-in link in the footer. Check for the apply CTA instead.
    const hasApplyBtn = await page.$("a[href*='/applications/new'], button:has-text('Postular')");
    return !!hasApplyBtn;
  }
  return true;
}

// Language detection: explicit indicators first, then stopword count fallback.
async function detectLanguage(page: Page, jobText: string): Promise<"en" | "es"> {
  const pageTxt = await page.locator("body").innerText().catch(() => "");
  if (/requiere que tu postulaci[oó]n sea enviada en Ingl[eé]s|application.*in English|must be (submitted|written)?\s*in English|raz[oó]n para postular debe estar escrita en ingl[eé]s/i.test(pageTxt)) {
    return "en";
  }
  // Stopword-based detection on the job description itself (more reliable than page chrome).
  const text = " " + jobText.toLowerCase() + " ";
  const enWords = (text.match(/ (the|of|and|to|with|that|this|for|you|your|our|we|are|is|will|have|from|build|work)/g) || []).length;
  const esWords = (text.match(/ (el|la|los|las|de|en|que|y|para|con|por|una|son|es|del|al|nuestra|nuestro|trabajo|equipo)/g) || []).length;
  if (enWords > esWords * 1.5) return "en";
  return "es";
}

async function clickPostular(page: Page): Promise<boolean> {
  // Prefer NAVIGATE directly to the apply URL (more reliable than .click() —
  // Stimulus/Turbo handlers on the page can intercept the click).
  // Cases handled:
  //   a) New apply       → a[href*='/applications/new']    with text "Postular"
  //   b) Resume a draft  → a[href*='/applications/<id>']    with text "Tienes una postulación por enviar"
  // Use innerHTML-walking inside page context to avoid esbuild's __name helper
  // (which is injected for named arrow expressions and is not available in
  // the page's window context).
  const href = await page.evaluate(`
    (function () {
      var all = Array.prototype.slice.call(document.querySelectorAll("a[href*='/applications/']"));
      var visible = [];
      for (var i = 0; i < all.length; i++) {
        var a = all[i];
        var s = window.getComputedStyle(a);
        if (s.display !== 'none' && s.visibility !== 'hidden') visible.push(a);
      }
      var postular = null, resume = null, fallback = null;
      for (var j = 0; j < visible.length; j++) {
        var el = visible[j];
        var cls = String(el.className || '');
        var txtLow = String(el.textContent || '').toLowerCase().replace(/[\\s\\u00a0]+/g, ' ').trim();
        var h = String(el.href || '');
        var hasNew = h.indexOf('/applications/new') !== -1;
        var isBtn = cls.indexOf('gb-btn') !== -1;
        if (!postular && isBtn && txtLow === 'postular' && hasNew) postular = h;
        // When resuming, prefer the EDIT URL over the preview URL so we walk all steps.
        if (!resume && isBtn && (txtLow.indexOf('postulación por enviar') !== -1 || txtLow.indexOf('postulacion por enviar') !== -1 || txtLow.indexOf('continuar postulación') !== -1 || txtLow.indexOf('continuar postulacion') !== -1)) {
          // The href on this link goes to preview; we want /edit instead.
          // Extract the applicationId from the href and build the edit URL.
          var m = h.match(/\\/applications\\/([a-f0-9]{20,})/);
          if (m) {
            var jobMatch = h.match(/\\/jobs\\/([^\\/]+)\\/applications\\//);
            // Build /jobs/<jobSlugOrId>/applications/<appId>/edit
            resume = h.replace(/(\\/applications\\/[a-f0-9]{20,}).*$/, '$1/edit');
          } else {
            resume = h;
          }
        }
        if (!fallback && hasNew) fallback = h;
      }
      return postular || resume || fallback || null;
    })()
  `);

  if (href) {
    await page.goto(href, { waitUntil: "domcontentloaded", timeout: 30000 });
    return true;
  }

  // Last-ditch: text-based click (rare).
  const byText = await page.$("a:has-text('Postular'), a:has-text('Tienes una postulación')");
  if (byText) {
    await byText.scrollIntoViewIfNeeded();
    await byText.click({ delay: 80 });
    return true;
  }
  return false;
}

async function alreadyApplied(page: Page): Promise<boolean> {
  const txt = await page.locator("body").innerText().catch(() => "");
  return /ya (te )?postulaste|already applied|tu postulaci[oó]n fue enviada/i.test(txt);
}

async function countryMismatch(page: Page): Promise<boolean> {
  const txt = await page.locator("body").innerText().catch(() => "");
  return /tu pa[ií]s no coincide con la ubicaci[oó]n del empleo|country does not match/i.test(txt);
}

// Parse "$3000 - 3500 USD/mes" or "USD 3500" etc. Returns upper bound, or null.
function parseExpectedSalary(salary?: string): number | null {
  if (!salary) return null;
  const nums = (salary.match(/\d{1,3}(?:[.,]?\d{3})*/g) ?? [])
    .map((n) => parseInt(n.replace(/[.,]/g, ""), 10))
    .filter((n) => n >= 500 && n <= 50000); // sanity for monthly USD
  if (nums.length === 0) return null;
  return Math.max(...nums); // upper bound of the range
}

// Generic Claude-driven short-answer generator (for "Por qué LegalAtoms" / custom questions).
async function draftShortAnswer(opts: {
  question: string;
  language: "en" | "es";
  jobContext: string;
  candidateCtx: string;
  minChars?: number;
  maxChars?: number;
}): Promise<string> {
  const minC = opts.minChars ?? 300;
  const maxC = opts.maxChars ?? 900;
  const sys = opts.language === "en"
    ? `You answer ONE specific job application question from the candidate (see MASTER for timezone). Plain text, no markdown, no preamble. Length: ${minC}-${maxC} characters. Be concrete: reference a real the candidate project + a real metric, tie it to the question. Banned: "passionate", "rockstar", "synergy", "I believe", "great fit". Output ONLY the answer body.`
    : `Respondés UNA pregunta específica de aplicación a trabajo desde el candidato (ver MASTER para timezone). Texto plano, sin markdown, sin preámbulo. Largo: ${minC}-${maxC} caracteres. Concreto: referenciá un proyecto real + un número real, atado a la pregunta. Prohibidas: "apasionado", "rockstar", "sinergia", "yo creo que", "perfect fit". Output SOLO el cuerpo de la respuesta.`;
  const user = `CANDIDATE MASTER:
${opts.candidateCtx.slice(0, 6000)}

JOB CONTEXT:
${opts.jobContext.slice(0, 2500)}

QUESTION:
${opts.question}

Write the answer now.`;
  const out = await callText(user, { system: sys, model: DRAFT_MODEL, timeoutMs: 120000 });
  return out.replace(/^```[a-z]*\s*/i, "").replace(/```$/, "").replace(/^["']|["']$/g, "").trim();
}

// Detect and fill radio groups (Yes/No, skill-level, etc.) using heuristics.
// GetOnBoard renders short-answer questions on step=questions as radio groups
// keyed by an opaque name (e.g. "box-<hash>"). The question text lives in a
// nearby parent (usually 2-4 levels up).
async function autoFillRadios(page: Page): Promise<{ handled: string[]; unhandled: string[] }> {
  const groups = await page.evaluate(() => {
    const radios = Array.from(document.querySelectorAll('input[type="radio"]')) as HTMLInputElement[];
    const visible = radios.filter((r) => {
      const s = window.getComputedStyle(r);
      if (s.display === "none" || s.visibility === "hidden") return false;
      // Walk up checking for hidden ancestors (radios are often visually-hidden + label-styled)
      let n: HTMLElement | null = r.parentElement;
      for (let i = 0; i < 4 && n; i++) {
        const ps = window.getComputedStyle(n);
        if (ps.display === "none" || ps.visibility === "hidden") return false;
        n = n.parentElement;
      }
      return true;
    });
    const byName = new Map<string, HTMLInputElement[]>();
    for (const r of visible) {
      if (!r.name) continue;
      const list = byName.get(r.name) ?? [];
      list.push(r);
      byName.set(r.name, list);
    }
    const out: Array<{ name: string; question: string; options: Array<{ value: string; label: string }>; anyChecked: boolean }> = [];
    for (const [name, list] of byName.entries()) {
      const optionLabels = list.map((r) => (r.labels?.[0]?.textContent ?? "").trim());
      // Walk up parents to find the question context.
      let question = "";
      let node: HTMLElement | null = list[0];
      for (let i = 0; i < 6 && node; i++) {
        node = node.parentElement;
        if (!node) break;
        const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
        if (text.length > 20 && text.length < 500) { question = text; break; }
      }
      // Strip option labels from the question text to isolate the question.
      for (const lbl of optionLabels) {
        if (!lbl) continue;
        // Remove standalone occurrences
        question = question.split(new RegExp(`\\b${lbl.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\b`, "g")).join(" ");
      }
      question = question.replace(/\s+/g, " ").trim();
      out.push({
        name,
        question,
        options: list.map((r) => ({ value: r.value, label: (r.labels?.[0]?.textContent ?? "").trim() })),
        anyChecked: list.some((r) => r.checked),
      });
    }
    return out;
  });

  const handled: string[] = [];
  const unhandled: string[] = [];

  for (const g of groups) {
    if (g.anyChecked) continue;
    if (g.options.length === 0) continue;
    const optLabelsLower = g.options.map((o) => o.label.toLowerCase());
    let chosen: { value: string; label: string } | null = null;

    // 1) Skill levels: Beginner / Intermediate / Advanced → Advanced
    if (optLabelsLower.includes("advanced") || optLabelsLower.includes("avanzado")) {
      chosen = g.options.find((o) => /^(advanced|avanzado)$/i.test(o.label)) ?? null;
    } else if (optLabelsLower.includes("yes") || optLabelsLower.includes("sí") || optLabelsLower.includes("si")) {
      // 2) Yes/No: default Yes UNLESS the question is clearly negative-disqualifying.
      const negative = /\b(felony|crime|crimen|fired|despedido|sancionado|sanctioned|denied|denegado|investigation|investigaci[oó]n|impedimento|prevents you|impide|deuda|debt)\b/i.test(g.question);
      const yes = g.options.find((o) => /^(yes|s[ií])$/i.test(o.label)) ?? null;
      const no = g.options.find((o) => /^no$/i.test(o.label)) ?? null;
      chosen = negative ? (no ?? yes) : (yes ?? no);
    } else {
      // 3) Unknown → pick last option (often "best" for ratings).
      chosen = g.options[g.options.length - 1];
    }

    if (!chosen) {
      unhandled.push(`radio[${g.name}] q="${g.question.slice(0, 60)}"`);
      continue;
    }

    const ok = await page.evaluate(({ name, value }) => {
      const inputs = Array.from(document.querySelectorAll(`input[type="radio"][name="${name}"]`)) as HTMLInputElement[];
      const target = inputs.find((r) => r.value === value);
      if (!target) return false;
      target.click();
      target.dispatchEvent(new Event("change", { bubbles: true }));
      return target.checked;
    }, { name: g.name, value: chosen.value });

    if (ok) handled.push(`radio["${g.question.slice(0, 40)}"]→${chosen.label}`);
    else unhandled.push(`radio[${g.name}] click failed`);
  }

  return { handled, unhandled };
}

// Fill any visible, required, empty fields on the current step. Returns the
// list of fields it tried + which ones it couldn't handle.
async function autoFillStep(
  page: Page,
  opts: {
    job: { company: string; title: string; text: string; salary?: string };
    language: "en" | "es";
    candidateCtx: string;
  },
): Promise<{ handled: string[]; unhandled: string[] }> {
  // Discover all visible required-ish inputs/selects/textareas in the form area.
  const fields = await page.evaluate(() => {
    const out: Array<{ kind: "input" | "select" | "textarea"; name: string; type: string; required: boolean; value: string; labelText: string; placeholder: string; min: number; max: number }> = [];
    const all = Array.from(document.querySelectorAll("input, select, textarea")) as Array<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>;
    for (const el of all) {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const type = "type" in el ? (el as HTMLInputElement).type : el.tagName.toLowerCase();
      if (type === "hidden" || type === "submit" || type === "button" || type === "file") continue;
      const name = el.getAttribute("name") || el.id || "";
      if (!name) continue;
      // Skip framework / CSRF / search inputs.
      if (/authenticity_token|utf8|_method|^q$/.test(name)) continue;
      // Skip trix-related fields (the editor handles them).
      if (/application\[(experience|cover_letter|presentation)\]/i.test(name)) continue;
      // Skip Trix toolbar add-link / attach-link dialog inputs.
      if (el.closest("[data-trix-dialog], trix-toolbar, [data-trix-component]")) continue;
      if (name === "href" && el.tagName === "INPUT") continue; // Trix link dialog
      const required = el.hasAttribute("required") || el.getAttribute("aria-required") === "true";
      const value = (el as HTMLInputElement).value?.trim() ?? "";
      // Try to find a label for context (question text).
      let labelText = "";
      if (el.id) {
        const lbl = document.querySelector(`label[for="${el.id}"]`);
        if (lbl) labelText = (lbl.textContent ?? "").replace(/\s+/g, " ").trim();
      }
      if (!labelText) {
        const parentLbl = el.closest("label");
        if (parentLbl) labelText = (parentLbl.textContent ?? "").replace(/\s+/g, " ").trim();
      }
      if (!labelText) {
        // Look for a heading/strong text immediately preceding the field
        const prev = el.closest("div, fieldset")?.previousElementSibling
          ?? el.closest("div, fieldset")?.firstElementChild;
        labelText = (prev?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 250);
      }
      const placeholder = (el as HTMLInputElement).placeholder ?? "";
      const minA = parseInt(el.getAttribute("minlength") ?? "0", 10) || 0;
      const maxA = parseInt(el.getAttribute("maxlength") ?? "0", 10) || 0;
      out.push({
        kind: el.tagName.toLowerCase() as "input" | "select" | "textarea",
        name, type, required, value, labelText, placeholder, min: minA, max: maxA,
      });
    }
    return out;
  });

  const handled: string[] = [];
  const unhandled: string[] = [];

  for (const f of fields) {
    // Always overwrite the cover-letter-like textarea ("reason_to_apply") — drafts
    // from prior failed runs may have wrong-language content the server rejects.
    const isReasonField = /reason_to_apply|why_(do_you_)?apply/i.test(f.name);
    if (f.value && !isReasonField) continue;
    // Free-text questions on GetOnBoard's "questions" step are often NOT marked
    // required in HTML but ARE required server-side. So we fill textareas even
    // when required=false, and skip optional non-textarea inputs.
    if (!f.required && f.kind !== "textarea") continue;
    const labelLower = (f.labelText + " " + f.placeholder + " " + f.name).toLowerCase();

    // Salary field — heuristic: name contains "salary" / "sueldo", or it's a number input near "sueldo".
    if (/salary|sueldo|expected|expectativa/i.test(labelLower) || (f.type === "number" && /sueldo|salary/i.test(f.name))) {
      const parsed = parseExpectedSalary(opts.job.salary);
      // Floor at $3500/month (the candidate's contract floor for AI/senior roles).
      const target = parsed && parsed >= 3500 ? parsed : 3500;
      const ok = await page.evaluate(({ name, val }) => {
        const el = document.querySelector(`[name="${name}"]`) as HTMLInputElement | null;
        if (!el) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
        setter.call(el, String(val));
        // Dispatch all four events so Stimulus / Turbo controllers react and enable the submit button.
        for (const evt of ["input", "change", "keyup", "blur"]) {
          el.dispatchEvent(new Event(evt, { bubbles: true }));
        }
        return true;
      }, { name: f.name, val: target });
      if (ok) handled.push(`salary=${target}`);
      else unhandled.push(`salary (${f.name})`);
      continue;
    }

    // Custom textarea questions ("¿Por qué te interesa..." / "Describe a feature...").
    if (f.kind === "textarea") {
      const question = f.labelText || f.placeholder || f.name;
      // Generate an answer.
      try {
        const ans = await draftShortAnswer({
          question,
          language: opts.language,
          jobContext: `Company: ${opts.job.company}\nRole: ${opts.job.title}\n\n${opts.job.text}`,
          candidateCtx: opts.candidateCtx,
          minChars: Math.max(50, f.min || 50),
          maxChars: Math.min(1500, f.max || 900),
        });
        const ok = await page.evaluate(({ name, val }) => {
          const el = document.querySelector(`[name="${name}"]`) as HTMLTextAreaElement | null;
          if (!el) return false;
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
          setter.call(el, val);
          for (const evt of ["input", "change", "keyup", "blur"]) {
            el.dispatchEvent(new Event(evt, { bubbles: true }));
          }
          return true;
        }, { name: f.name, val: ans });
        if (ok) handled.push(`textarea[${f.name}] (${ans.length} chars)`);
        else unhandled.push(`textarea[${f.name}]`);
      } catch (e) {
        unhandled.push(`textarea[${f.name}] — draft failed: ${(e as Error).message}`);
      }
      continue;
    }

    // Otherwise we don't know how to fill it — flag.
    unhandled.push(`${f.kind}[${f.name}] type=${f.type} label="${f.labelText.slice(0, 80)}"`);
  }

  return { handled, unhandled };
}

async function fillTrixEditor(page: Page, html: string): Promise<boolean> {
  // Wait for a trix-editor to appear on the page.
  try {
    await page.waitForSelector("trix-editor", { timeout: 15000 });
  } catch {
    return false;
  }
  return await page.evaluate((bodyHtml) => {
    const editor = document.querySelector("trix-editor") as unknown as { editor?: { loadHTML: (h: string) => void } };
    if (!editor || !editor.editor) return false;
    editor.editor.loadHTML(bodyHtml);
    return true;
  }, html);
}

async function detectExtraRequiredFields(page: Page): Promise<string | null> {
  // Look for unfilled required inputs on the current step. Resume upload, custom
  // free-text questions, etc. Treat the trix-editor area itself as already handled.
  return await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll(
      "input[required], select[required], textarea[required]",
    )) as Array<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>;
    for (const el of inputs) {
      // Skip hidden helpers
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      if (el.type === "hidden") continue;
      if (el instanceof HTMLInputElement && el.type === "file" && !el.files?.length) {
        return `file-upload required: ${el.name || el.id || "?"}`;
      }
      const val = (el as HTMLInputElement).value?.trim() ?? "";
      if (!val) {
        const name = el.getAttribute("name") || el.id || el.tagName.toLowerCase();
        // Ignore the trix hidden input — we handle that via the editor.
        if (/application\[(experience|cover_letter|presentation)\]/i.test(name)) continue;
        return `empty required field: ${name}`;
      }
    }
    return null;
  });
}

async function clickNext(page: Page): Promise<boolean> {
  const btn = await page.$(
    "button:has-text('Siguiente'), input[type='submit'][value*='Siguiente'], input[type='button'][value*='Siguiente'], button:has-text('Next')",
  );
  if (!btn) return false;
  // Wait until enabled — Stimulus controllers may take a few ms to react to fills.
  // If still disabled after 3s, bail (signals a missing required field).
  const enabled = await page.waitForFunction(
    (el) => !(el as HTMLButtonElement).disabled && !(el as HTMLElement).classList.contains("btn-disabled"),
    btn,
    { timeout: 3000 },
  ).then(() => true).catch(() => false);
  if (!enabled) {
    return false;
  }
  await btn.scrollIntoViewIfNeeded();
  await btn.click({ delay: 80 });
  return true;
}

async function clickSubmit(page: Page): Promise<boolean> {
  // The preview lives in a MODAL. If we're on /applications?preview=true and
  // the modal isn't open yet, click the "POR ENVIAR" item first.
  const isOnApplicationsList = /\/applications\?job_application_preview=true/.test(page.url());
  if (isOnApplicationsList) {
    const modalAlreadyOpen = await page.$("input[type='button'][value*='Enviar postulación'], button:has-text('Enviar postulación')");
    if (!modalAlreadyOpen) {
      const item = await page.$("a:has-text('POR ENVIAR'), a:has-text('Por enviar')");
      if (item) {
        await item.scrollIntoViewIfNeeded();
        await item.click({ delay: 80 });
        await page.waitForTimeout(2000);
      }
    }
  }

  // Find the submit button. GetOnBoard uses <input type="button" value="Enviar postulación ahora">
  // — NOT a <button>, NOT input[type="submit"]. Critical to include input[type="button"].
  const selectors = [
    "input[type='button'][value*='Enviar postulación']",
    "input[type='button'][value*='Enviar Postulación']",
    "input[type='submit'][value*='Enviar']",
    "button:has-text('Enviar postulación ahora')",
    "button:has-text('Enviar postulación')",
  ];
  for (const sel of selectors) {
    const btn = await page.$(sel);
    if (!btn) continue;
    await btn.scrollIntoViewIfNeeded();
    // Use force: true because the cover-letter <p> in the dialog can intercept pointer events.
    try {
      await btn.click({ delay: 80, force: true });
      return true;
    } catch {
      // Fall through to next selector.
    }
  }
  return false;
}

async function detectSubmitSuccess(page: Page): Promise<boolean> {
  const url = page.url();
  if (/\/applications\/\d+/.test(url) && !url.endsWith("/new")) return true;
  if (/\/applications\/[a-z0-9-]+$/.test(url) && !/\/new$/.test(url)) return true;
  // GetOnBoard: after successful submit, the preview modal updates to show
  // "Enviada hace N minutos" / "Sent N minutes ago". Check page text and modals.
  const txt = await page.locator("body").innerText().catch(() => "");
  if (/Enviada\s+hace|Sent\s+\d+\s+(seconds?|minutes?|hours?)\s+ago|postulaci[oó]n (enviada|recibida|exitosa)|application (submitted|received|sent)|gracias por postular|Aplicaste hace/i.test(txt)) {
    return true;
  }
  return false;
}

function writeDraftsFile(items: Array<{ job: RawJob; language: "en" | "es"; cover: string }>) {
  mkdirSync("data", { recursive: true });
  const md = items
    .map((it, i) => {
      return `## ${i + 1}. ${it.job.company ?? "?"} — ${it.job.title}
- URL: ${it.job.url}
- Language: ${it.language}
- Salary: ${it.job.salary ?? "—"}

\`\`\`
${it.cover}
\`\`\`
`;
    })
    .join("\n---\n\n");
  writeFileSync(DRAFTS_PATH, `# GetOnBoard apply drafts — ${today()}\n\n${items.length} drafts\n\n---\n\n${md}`);
}

type ProcessResult =
  | { ok: true; submitted: boolean; coverPreview: string; reason: string }
  | { ok: false; reason: string; coverPreview?: string };

async function processJob(
  ctx: BrowserContext,
  job: RawJob,
  mode: "auto" | "review" | "dry-run",
  candidateCtx: string,
  rl: ReturnType<typeof createInterface> | null,
  appId: string,
): Promise<ProcessResult> {
  const page = ctx.pages()[0] ?? (await ctx.newPage());

  await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await sleep(1500 + Math.random() * 800);
  await dismissCookieBanner(page);

  const loggedIn = await detectLoggedIn(page);
  if (!loggedIn) {
    return { ok: false, reason: "not-logged-in" };
  }
  if (await countryMismatch(page)) {
    return { ok: false, reason: "country-mismatch-blocked" };
  }
  if (await alreadyApplied(page)) {
    return { ok: false, reason: "already-applied-per-platform" };
  }

  const language = await detectLanguage(page, job.text);
  console.log(`  language: ${language}`);

  console.log(`  drafting cover letter (${DRAFT_MODEL})...`);
  const cover = await draftCover(
    { company: job.company ?? "?", title: job.title ?? "?", text: job.text, url: job.url },
    language,
    candidateCtx,
    appId,
  );
  console.log(`  cover: ${cover.length} chars`);
  const coverPreview = cover.slice(0, 200).replace(/\s+/g, " ");

  if (mode === "dry-run") {
    return { ok: true, submitted: false, coverPreview, reason: "dry-run" };
  }

  // Click Postular (or resume existing draft).
  const clicked = await clickPostular(page);
  if (!clicked) {
    return { ok: false, reason: "no-postular-button", coverPreview };
  }
  await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => null);

  // Accept any apply-flow URL: fresh form (/applications/new), draft edit
  // (/applications/<id>/edit?step=...), or preview redirect
  // (/applications?job_application_preview=true).
  const u = page.url();
  const onApplyFlow =
    /\/applications\/new/.test(u) ||
    /\/applications\/[a-f0-9]{20,}/.test(u) ||
    /\/applications\?job_application_preview=true/.test(u);
  if (!onApplyFlow) {
    return { ok: false, reason: `did-not-reach-form (url=${u})`, coverPreview };
  }

  // Step-driven loop. Handles experience (fill trix), basic, questions,
  // and preview (submit). Works whether we landed on /applications/new
  // (fresh) or were redirected to preview (existing draft).
  const jobForFill = { company: job.company ?? "?", title: job.title ?? "?", text: job.text, salary: job.salary };
  const coverHtml = coverToHtml(cover);
  let advancedSteps = 0;
  let trixFilledOnce = false;
  const MAX_STEPS = 6;

  while (advancedSteps < MAX_STEPS) {
    advancedSteps++;
    await sleep(1200);
    const url = page.url();
    const stepMatch = url.match(/[?&]step=([a-z]+)/);
    const stepName = stepMatch?.[1] ?? (/job_application_preview=true/.test(url) ? "preview" : "experience");
    console.log(`  step ${advancedSteps}: ${stepName}`);

    const isPreview =
      stepName === "preview" ||
      /job_application_preview=true/.test(url) ||
      /Ésta es una vista previa de tu postulaci[oó]n/.test(await page.content());

    if (isPreview) {
      // Review-mode pause BEFORE the final submit.
      if (mode === "review" && rl) {
        console.log(`\n──── REVIEW · ${job.company ?? "?"} ────\n${cover}\n────`);
        const ans = (await rl.question("submit this application? [y/N/skip-all] ")).trim().toLowerCase();
        if (ans === "skip-all") throw new Error("skip-all");
        if (ans !== "y" && ans !== "yes") return { ok: false, reason: "user-skipped", coverPreview };
      }
      const submitted = await clickSubmit(page);
      if (!submitted) return { ok: false, reason: "no-submit-button-on-preview", coverPreview };
      await Promise.race([
        page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => null),
        page.waitForTimeout(5000),
      ]);
      break;
    }

    // Experience step → fill trix with cover letter (once).
    if (stepName === "experience" && !trixFilledOnce) {
      const filled = await fillTrixEditor(page, coverHtml);
      if (!filled) {
        // No trix here — maybe the draft already has it. Continue without erroring.
        console.log(`    (no trix-editor on experience step, draft already has cover)`);
      } else {
        trixFilledOnce = true;
        await sleep(800);
      }
    }

    // Radios first (Yes/No, skill levels) — these often appear on step=questions.
    const radioResult = await autoFillRadios(page);
    if (radioResult.handled.length > 0) console.log(`    radios: ${radioResult.handled.join(", ")}`);
    if (radioResult.unhandled.length > 0) {
      return { ok: false, reason: `radio-fill-failed-${stepName}: ${radioResult.unhandled.join("; ")}`, coverPreview };
    }

    // Auto-fill any required empty fields (salary, "why us", custom questions).
    const fillResult = await autoFillStep(page, { job: jobForFill, language, candidateCtx });
    if (fillResult.handled.length > 0) console.log(`    auto-filled: ${fillResult.handled.join(", ")}`);
    if (fillResult.unhandled.length > 0) {
      return { ok: false, reason: `needs-additional-fields-${stepName}: ${fillResult.unhandled.join("; ")}`, coverPreview };
    }

    const advanced = await clickNext(page);
    if (!advanced) {
      // No Siguiente — could be preview-style page we didn't match. Try submit.
      const submitted = await clickSubmit(page);
      if (submitted) {
        await Promise.race([
          page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => null),
          page.waitForTimeout(5000),
        ]);
        break;
      }
      return { ok: false, reason: `no-next-or-submit-button-${stepName}`, coverPreview };
    }
  }

  if (advancedSteps >= MAX_STEPS) {
    return { ok: false, reason: "too-many-steps (loop bail-out)", coverPreview };
  }

  const success = await detectSubmitSuccess(page);
  const ssPath = join(SCREENSHOT_DIR, `${appId}-final.png`);
  try {
    await page.screenshot({ path: ssPath, fullPage: true });
  } catch {}
  logEvent({ event: "getonboard-submit", appId, success, finalUrl: page.url(), screenshot: ssPath });

  return success
    ? { ok: true, submitted: true, coverPreview, reason: `success (${page.url()})` }
    : { ok: false, reason: `submit-unclear (${page.url()})`, coverPreview };
}

async function main() {
  const max = parseInt(arg("--max", "5")!, 10);
  const dryRun = has("--dry-run");
  const review = has("--review");
  const headed = has("--headed") || review;
  const mode: "auto" | "review" | "dry-run" = dryRun ? "dry-run" : review ? "review" : "auto";

  console.log(`[getonboard-apply] mode=${mode} max=${max} headed=${headed}`);

  mkdirSync(SCREENSHOT_DIR, { recursive: true });

  // 1. Scrape.
  console.log(`\n→ scraping GetOnBoard…`);
  const jobs = await scrape();
  console.log(`  ${jobs.length} jobs from scraper`);

  // 2. Filter.
  const apps = readJSON<Application[]>(APPS_PATH, []);
  const seenUrls = new Set(apps.map((a) => a.url.toLowerCase()));
  const candidates = jobs.filter((j) => {
    if (seenUrls.has(j.url.toLowerCase())) return false;
    if (!j.title) return false;
    // Hard reject roles outside the candidate's profile by title.
    if (TITLE_EXCLUDE.test(j.title)) return false;
    if (EXCLUDE.test(`${j.title} ${j.text}`)) return false;
    if (!SENIOR_HINTS.test(j.title)) return false;
    // Must positively match the candidate's stack (full-stack / product / AI / backend with web).
    if (!PROFILE_MATCH.test(j.title)) return false;
    return true;
  }).slice(0, max);

  console.log(`  ${candidates.length} candidates after filter+dedup\n`);
  if (candidates.length === 0) {
    console.log("nothing to apply to.");
    return;
  }

  const candidateCtx = loadProfile();
  if (!candidateCtx) {
    console.error("ERROR: empty profile (MASTER.md and CLAUDE.md both missing).");
    process.exit(1);
  }

  // 3. Dry-run path: just draft + write file.
  if (mode === "dry-run") {
    const drafts: Array<{ job: RawJob; language: "en" | "es"; cover: string }> = [];
    for (const job of candidates) {
      console.log(`\n──── ${job.company ?? "?"} — ${job.title}`);
      const language = /require.*English|requiere.*Ingl[eé]s|must be in English/i.test(job.text) ? "en" : "es";
      try {
        const cover = await draftCover(
          { company: job.company ?? "?", title: job.title ?? "?", text: job.text, url: job.url },
          language,
          candidateCtx,
          // dry-run mode: synthesize a temp appId for cover-letter persistence
          `dryrun-${genId()}`,
        );
        console.log(`  ✓ drafted (${language}, ${cover.length} chars)`);
        drafts.push({ job, language, cover });
      } catch (e) {
        console.log(`  ✗ draft failed: ${(e as Error).message}`);
      }
    }
    writeDraftsFile(drafts);
    console.log(`\n✓ wrote ${drafts.length} drafts → ${DRAFTS_PATH}`);
    return;
  }

  // 4. Browser path.
  const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
    channel: "chrome",
    headless: !headed,
    viewport: headed ? null : { width: 1400, height: 900 },
    args: ["--disable-blink-features=AutomationControlled"],
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  const rl = mode === "review"
    ? createInterface({ input: process.stdin, output: process.stdout })
    : null;

  const summary: Array<{ company: string; status: string; reason: string }> = [];

  try {
    for (const [i, job] of candidates.entries()) {
      const appId = genId();
      console.log(`\n────── ${i + 1}/${candidates.length}: ${job.company ?? "?"} — ${job.title?.slice(0, 60)} ──────`);
      console.log(`  url: ${job.url}`);
      logEvent({ event: "getonboard-start", appId, url: job.url, company: job.company, title: job.title });

      try {
        const result = await processJob(ctx, job, mode, candidateCtx, rl, appId);
        if (result.ok && result.submitted) {
          console.log(`  ✓ submitted: ${result.reason}`);
          const all = readJSON<Application[]>(APPS_PATH, []);
          all.push({
            id: appId,
            url: job.url,
            platform: "auto:getonboard",
            company: job.company,
            title: job.title,
            status: "applied",
            appliedAt: today(),
            lastUpdate: today(),
            notes: [`${today()}: GetOnBoard auto-postular — cover snippet: ${result.coverPreview ?? ""}`],
          });
          writeJSON(APPS_PATH, all);
          summary.push({ company: job.company ?? "?", status: "submitted", reason: result.reason });
        } else if (result.ok && !result.submitted) {
          summary.push({ company: job.company ?? "?", status: "drafted", reason: result.reason });
        } else {
          console.log(`  ✗ skipped: ${result.reason}`);
          summary.push({ company: job.company ?? "?", status: "skipped", reason: result.reason });
          logEvent({ event: "getonboard-skip", appId, reason: result.reason });
        }
      } catch (e) {
        const msg = (e as Error).message;
        if (msg === "skip-all") {
          console.log("\n[skip-all] aborting remaining items.");
          break;
        }
        console.log(`  ✗ error: ${msg}`);
        summary.push({ company: job.company ?? "?", status: "error", reason: msg });
        logEvent({ event: "getonboard-error", appId, error: msg });
      }

      // Throttle between submits.
      if (i < candidates.length - 1) {
        const delaySec = DELAY_MIN_SEC + Math.floor(Math.random() * (DELAY_MAX_SEC - DELAY_MIN_SEC));
        console.log(`\nthrottling ${delaySec}s before next...`);
        await sleep(delaySec * 1000);
      }
    }
  } finally {
    rl?.close();
    await ctx.close();
  }

  console.log(`\n══════ SUMMARY ══════`);
  for (const s of summary) {
    console.log(`  ${s.status.padEnd(10)} ${s.company.padEnd(30)} ${s.reason}`);
  }
  const submitted = summary.filter((s) => s.status === "submitted").length;
  console.log(`──────`);
  console.log(`  ${submitted}/${summary.length} submitted`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
