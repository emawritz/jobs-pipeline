import type { Page } from "playwright";
import { callJSON, DRAFT_MODEL } from "./claude.ts";
import type { Answers } from "./auto-apply.ts";

// ---------------------------------------------------------------------------
// 1. Form introspection — read what's on the page as structured JSON.
// ---------------------------------------------------------------------------

export type FieldOption = { value: string; label: string };

export type FormField = {
  selector: string; // unique enough to query: id|name|nth-input style
  type:
    | "text"
    | "email"
    | "tel"
    | "url"
    | "number"
    | "password"
    | "textarea"
    | "select"
    | "radio"
    | "checkbox"
    | "file"
    | "date";
  label: string; // best-effort label/question
  placeholder?: string;
  required: boolean;
  options?: FieldOption[]; // for select/radio groups
  accept?: string; // for file inputs (e.g., ".pdf,.docx")
  maxLength?: number;
  groupName?: string; // for radio groups
};

export type FormSnapshot = {
  url: string;
  fields: FormField[];
  hasSubmitButton: boolean;
  hasCaptcha: boolean;
  hasLoginGate: boolean;
};

const INTROSPECT_FN = `(() => {
  const out = [];
  const seenRadioGroups = new Set();

  function getLabel(el) {
    if (el.id) {
      const lbl = document.querySelector('label[for="' + el.id + '"]');
      if (lbl && lbl.textContent) return lbl.textContent.trim();
    }
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel;
    const ariaLabelledBy = el.getAttribute('aria-labelledby');
    if (ariaLabelledBy) {
      const target = document.getElementById(ariaLabelledBy);
      if (target && target.textContent) return target.textContent.trim();
    }
    let parent = el.parentElement;
    for (let i = 0; i < 5 && parent; i++) {
      const lbl = parent.querySelector('label, h3, h4, legend, .application-question-label');
      if (lbl && lbl.textContent && lbl !== el) {
        const t = lbl.textContent.trim();
        if (t.length > 1 && t.length < 500) return t;
      }
      parent = parent.parentElement;
    }
    const placeholder = el.getAttribute('placeholder');
    if (placeholder) return placeholder;
    return el.getAttribute('name') || el.getAttribute('id') || '(no label)';
  }

  function uniqueSelector(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    const name = el.getAttribute('name');
    if (name) {
      const matches = document.querySelectorAll('[name="' + name + '"]');
      if (matches.length === 1) return '[name="' + CSS.escape(name) + '"]';
      const value = el.getAttribute('value');
      if (value) return '[name="' + CSS.escape(name) + '"][value="' + CSS.escape(value) + '"]';
      return '[name="' + CSS.escape(name) + '"]';
    }
    const tag = el.tagName.toLowerCase();
    const all = Array.from(document.querySelectorAll(tag));
    const idx = all.indexOf(el);
    return idx >= 0 ? tag + ':nth-of-type(' + (idx + 1) + ')' : tag;
  }

  function isVisible(el) {
    if (!el) return false;
    // File inputs are often hidden behind a styled button. Treat them as visible
    // if they exist at all — we set files programmatically anyway.
    if (el.tagName === 'INPUT' && el.type === 'file') return true;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    return true;
  }

  document.querySelectorAll('input, select, textarea').forEach((el) => {
    if (!isVisible(el)) return;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || tag).toLowerCase();
    const required = el.required || el.getAttribute('aria-required') === 'true';
    const label = getLabel(el);
    const selector = uniqueSelector(el);

    if (tag === 'select') {
      const options = Array.from(el.options || []).map((o) => ({ value: o.value, label: o.textContent ? o.textContent.trim() : '' }));
      out.push({ selector, type: 'select', label, required, options });
    } else if (tag === 'textarea') {
      out.push({ selector, type: 'textarea', label, required, placeholder: el.placeholder, maxLength: el.maxLength > 0 ? el.maxLength : undefined });
    } else if (type === 'radio') {
      const groupName = el.getAttribute('name') || '';
      if (groupName && seenRadioGroups.has(groupName)) return;
      seenRadioGroups.add(groupName);
      const group = document.querySelectorAll('input[type="radio"][name="' + groupName + '"]');
      const options = Array.from(group).map((r) => ({ value: r.value || '', label: getLabel(r) || r.value || '' }));
      out.push({ selector: '[name="' + groupName + '"]', type: 'radio', label, required, options, groupName });
    } else if (type === 'checkbox') {
      out.push({ selector, type: 'checkbox', label, required });
    } else if (type === 'file') {
      out.push({ selector, type: 'file', label, required, accept: el.getAttribute('accept') || undefined });
    } else if (['text','email','tel','url','number','password','date'].includes(type)) {
      out.push({ selector, type, label, required, placeholder: el.placeholder, maxLength: el.maxLength > 0 ? el.maxLength : undefined });
    }
  });

  return out;
})()`;

const DIAG_FN = `(() => {
  const hasSubmitButton = !!document.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
  const hasCaptcha = !!document.querySelector('[class*="captcha"], iframe[src*="captcha"], iframe[src*="hcaptcha"], iframe[src*="recaptcha"], .g-recaptcha, .h-captcha');
  const passwords = document.querySelectorAll('input[type="password"]').length;
  const url = location.href;
  const hasLoginGate = passwords > 0 || /\\/(login|signin|sign-in|auth)\\b/i.test(url);
  return { url, hasSubmitButton, hasCaptcha, hasLoginGate };
})()`;

export async function introspect(page: Page): Promise<FormSnapshot> {
  const [fields, diag] = await Promise.all([
    page.evaluate(INTROSPECT_FN) as Promise<FormField[]>,
    page.evaluate(DIAG_FN) as Promise<{ url: string; hasSubmitButton: boolean; hasCaptcha: boolean; hasLoginGate: boolean }>,
  ]);
  return { url: diag.url, fields, hasSubmitButton: diag.hasSubmitButton, hasCaptcha: diag.hasCaptcha, hasLoginGate: diag.hasLoginGate };
}

// Heuristic gate: is this snapshot actually a job application form, or did we
// land on a careers-index/blog/newsletter page that happens to have fields?
//
// Real apply forms reliably have at least:
//   - one file input (resume upload), AND
//   - one email field
// OR field labels that strongly suggest application context.
export function isApplyForm(snapshot: FormSnapshot): { ok: boolean; reason: string } {
  if (snapshot.fields.length === 0) return { ok: false, reason: "no form fields detected" };

  const hasFile = snapshot.fields.some((f) => f.type === "file");
  const hasEmail = snapshot.fields.some((f) => f.type === "email" || /e-?mail|correo/i.test(f.label));
  const labels = snapshot.fields.map((f) => f.label.toLowerCase()).join(" | ");
  const applyKeywords = /(resume|cv|cover letter|portfolio|linkedin|github|years.*experience|why.*us|apply|application|first name|last name)/i;
  const hasApplyKeyword = applyKeywords.test(labels);

  // Newsletter/search/contact pages: 1-3 fields, no file input, no apply keywords.
  if (snapshot.fields.length <= 3 && !hasFile && !hasApplyKeyword) {
    return { ok: false, reason: `looks like a non-apply form (${snapshot.fields.length} fields, no file/keywords)` };
  }

  // Real apply forms: file upload + email is the strongest signal.
  if (hasFile && hasEmail) return { ok: true, reason: "file + email present" };

  // Apply forms without file (rare — email-only or in-house): need apply keywords.
  if (hasEmail && hasApplyKeyword) return { ok: true, reason: "email + apply keywords present" };

  // No email at all: almost certainly not an apply form.
  if (!hasEmail) return { ok: false, reason: "no email field" };

  return { ok: false, reason: "no file input and weak apply signal" };
}

// ---------------------------------------------------------------------------
// 2. LLM planner — Claude returns the list of actions to execute.
// ---------------------------------------------------------------------------

export type Action =
  | { kind: "fill"; selector: string; value: string; label?: string }
  | { kind: "select"; selector: string; value: string; label?: string }
  | { kind: "click"; selector: string; label?: string }
  | { kind: "upload"; selector: string; path: string; label?: string }
  | { kind: "skip"; selector: string; reason: string; label?: string };

- Use projects + metrics from the MASTER.md profile. Do NOT invent any.

Your job: receive a structured snapshot of a form + the company/role/posting text + the candidate's answers bank, then return a list of actions (one per field) that fills the form intelligently and honestly.

CORE RULES:
- For dropdowns / selects: pick the option whose label best matches the candidate (e.g., for "Years of experience" pick "5-7" or "7-10" since he has 7+; for "Authorized to work in US?" pick "No" or "I require sponsorship" honestly).
- For radio groups: pick the value whose label best matches. Be honest about visa/auth.
- For checkboxes: only check if required (terms, consent). Leave optional ones unchecked unless they apply.
- For textareas (long answers like Why us, Why now, Cover letter): write a specific, substantive answer that references the company by name and at least one specific detail from the posting. NO generic templates. Length: match the maxLength if set, else 80-200 words.
- For salary fields: USD 90,000-140,000 FT or 80-100/hr contract.
- For "Where did you hear about us?": prefer "Online research" or "Job board" — not specific platforms unless asked.
- For demographic questions (gender, ethnicity, veteran, disability): pick "Decline to state" / "Prefer not to say" unless required, then pick "Other".
- For phone: use the phone in answers.identity.phone. If it contains "XXXX" placeholder, write "Will provide on request" in any text fallback.
- For LinkedIn / GitHub / Portfolio fields: use answers.identity values.
- For file inputs (resume / CV): emit an "upload" action with path = answers.resumeFile.
- For cover letter file inputs (optional): emit "skip" with reason "no cover letter file".
- For fields with options where NONE clearly match (e.g., asking for a state in the US while candidate is in Argentina): pick the closest option or "Other" and explain in any nearby textarea.
- For required fields you cannot answer well: still emit an action with the best-effort value rather than skip.
- Skip only when: the field is clearly inappropriate for the candidate (e.g., a "Specific US state of residence" with no Other option), OR a duplicate, OR a hidden honeypot.

BANNED phrases in any text answer: "passionate", "I am writing to express", "rockstar", "ninja", "exciting opportunity", "perfect fit", "synergy", "leverage", "I believe".

OUTPUT: strict JSON, no commentary, no markdown fences:
{
  "actions": [
    {"kind":"fill","selector":"...","value":"...","label":"..."},
    {"kind":"select","selector":"...","value":"...","label":"..."},
    {"kind":"click","selector":"...","label":"..."},
    {"kind":"upload","selector":"...","path":"...","label":"..."},
    {"kind":"skip","selector":"...","reason":"...","label":"..."}
  ]
}

For "select" actions the value MUST be one of the provided option values exactly.
For "click" actions on a radio group, the selector should target the specific option, e.g. [name="auth"][value="no"].
Return one action per field in the snapshot (no extras, no missing).`;

export async function plan(
  snapshot: FormSnapshot,
  context: {
    company: string;
    role: string;
    jobText: string;
    candidateCtx: string;
    answers: Answers;
  },
): Promise<Action[]> {
  // Trim huge fields list to top 40 to control prompt size.
  const fields = snapshot.fields.slice(0, 40);
  const user = `CANDIDATE CONTEXT (high-level identity + voice):
${context.candidateCtx.slice(0, 4000)}

CANDIDATE ANSWERS BANK (use these literal values when applicable):
${JSON.stringify(context.answers, null, 2)}

JOB:
Company: ${context.company}
Role: ${context.role}
Posting text (use specifics from here in "Why us" or similar answers):
${context.jobText.slice(0, 5000)}

FORM SNAPSHOT (URL: ${snapshot.url}):
${JSON.stringify(fields, null, 2)}

Produce the JSON actions now. One per field, exact selector + value.`;

  type Out = { actions: Action[] };
  const out = await callJSON<Out>(user, { system: PLANNER_SYSTEM, model: DRAFT_MODEL, timeoutMs: 120000 });
  return validateActions(out.actions ?? [], snapshot);
}

// Drop any action whose selector isn't in the snapshot.
// For radio clicks we accept a selector that EXTENDS a snapshot selector
// (e.g., snapshot `[name="auth"]` + Claude's `[name="auth"][value="No"]`).
function validateActions(actions: Action[], snapshot: FormSnapshot): Action[] {
  const validSelectors = new Set(snapshot.fields.map((f) => f.selector));
  const radioSelectors = snapshot.fields.filter((f) => f.type === "radio").map((f) => f.selector);
  const valid: Action[] = [];
  for (const a of actions) {
    if (a.kind === "skip") {
      valid.push(a);
      continue;
    }
    if (validSelectors.has(a.selector)) {
      valid.push(a);
      continue;
    }
    // Radio click extension: starts with a known radio selector + has [value=...]
    if (a.kind === "click") {
      const matchesRadio = radioSelectors.some((rs) => a.selector.startsWith(rs) && /\[value=/.test(a.selector));
      if (matchesRadio) {
        valid.push(a);
        continue;
      }
    }
    console.error(`  ⚠️  rejected hallucinated action: ${a.kind} ${a.selector} (${a.label ?? "no label"})`);
  }
  return valid;
}

// ---------------------------------------------------------------------------
// 3. Action executor — run each action with realistic timing.
// ---------------------------------------------------------------------------

async function safeClick(page: Page, selector: string): Promise<boolean> {
  const el = await page.$(selector);
  if (!el) return false;
  try {
    await el.scrollIntoViewIfNeeded();
    await page.waitForTimeout(120 + Math.random() * 180);
    await el.click({ delay: 60 });
    return true;
  } catch {
    return false;
  }
}

async function safeFill(page: Page, selector: string, value: string): Promise<boolean> {
  const el = await page.$(selector);
  if (!el) return false;
  try {
    await el.scrollIntoViewIfNeeded();
    await page.waitForTimeout(120 + Math.random() * 200);
    await el.click({ delay: 80 });
    await el.fill("");
    await page.keyboard.type(value, { delay: 30 + Math.random() * 50 });
    await page.waitForTimeout(80 + Math.random() * 100);
    return true;
  } catch {
    return false;
  }
}

async function safeSelect(page: Page, selector: string, value: string): Promise<boolean> {
  const el = await page.$(selector);
  if (!el) return false;
  try {
    await el.scrollIntoViewIfNeeded();
    await page.waitForTimeout(120 + Math.random() * 180);
    // Try select by value, then by label.
    const result = await el.selectOption(value).catch(() => null);
    if (result && result.length) return true;
    const byLabel = await el.selectOption({ label: value }).catch(() => null);
    return !!(byLabel && byLabel.length);
  } catch {
    return false;
  }
}

async function safeUpload(page: Page, selector: string, path: string): Promise<boolean> {
  const el = await page.$(selector);
  if (!el) return false;
  try {
    await el.setInputFiles(path);
    await page.waitForTimeout(600 + Math.random() * 400);
    return true;
  } catch {
    return false;
  }
}

export type ExecutionResult = {
  succeeded: Array<{ action: Action }>;
  failed: Array<{ action: Action; reason: string }>;
};

export async function execute(page: Page, actions: Action[]): Promise<ExecutionResult> {
  const result: ExecutionResult = { succeeded: [], failed: [] };
  for (const a of actions) {
    let ok = false;
    try {
      if (a.kind === "fill") ok = await safeFill(page, a.selector, a.value);
      else if (a.kind === "select") ok = await safeSelect(page, a.selector, a.value);
      else if (a.kind === "click") ok = await safeClick(page, a.selector);
      else if (a.kind === "upload") ok = await safeUpload(page, a.selector, a.path);
      else ok = true; // skip
    } catch (e) {
      result.failed.push({ action: a, reason: (e as Error).message });
      continue;
    }
    if (ok || a.kind === "skip") result.succeeded.push({ action: a });
    else result.failed.push({ action: a, reason: "selector not found / action no-op" });
    await page.waitForTimeout(150 + Math.random() * 250);
  }
  return result;
}
