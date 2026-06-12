import { readFileSync, existsSync } from "node:fs";
import type { Page, ElementHandle } from "playwright";
import { callText, DRAFT_MODEL } from "./claude.ts";

export type Answers = {
  identity: Record<string, string>;
  logistics: Record<string, string>;
  resumeFile: string;
  coverLetterFile: string;
  shortAnswers: Record<string, string>;
  demographic: Record<string, string>;
};

export type ATS = "lever" | "greenhouse" | "ashby" | "workable" | "generic";

export function detectATS(url: string): ATS {
  if (/jobs\.lever\.co/i.test(url)) return "lever";
  if (/greenhouse\.io|boards\.greenhouse/i.test(url)) return "greenhouse";
  if (/jobs\.ashbyhq\.com|ashby/i.test(url)) return "ashby";
  if (/apply\.workable\.com|workable\.com/i.test(url)) return "workable";
  return "generic";
}

// Most ATS land you on the job DESCRIPTION page first. The actual form is
// behind an "Apply for this job" button. We click it and wait for form fields
// to appear before proceeding. Returns true if we ended up on a form, false
// if no form was reachable.
export async function navigateToForm(page: Page, ats: ATS): Promise<boolean> {
  // If URL already points at the apply form, just confirm a field exists.
  const url = page.url();
  if (/\/apply(\?|$|\/)/i.test(url) || ats === "ashby") {
    return waitForFormField(page);
  }

  // Try ATS-specific apply-button selectors, then generic fallbacks.
  const selectorsByAts: Record<ATS, string[]> = {
    lever: [
      "a.postings-btn:has-text('Apply')",
      "a[href*='/apply']:has-text('Apply')",
      "a:has-text('Apply for this job')",
    ],
    greenhouse: [
      "a:has-text('Apply for this Job')",
      "a:has-text('Apply')",
      "a[href*='#app']",
    ],
    ashby: [
      "button:has-text('Apply')",
      "a:has-text('Apply')",
    ],
    workable: [
      "a:has-text('Apply for this job')",
      "button:has-text('Apply now')",
    ],
    generic: [
      "a:has-text('Apply for this job')",
      "a:has-text('Apply now')",
      "button:has-text('Apply now')",
      "a:has-text('Apply for this position')",
      "a.apply-button",
      "[class*='apply-button']:not([disabled])",
      "a:has-text('Apply')",
    ],
  };

  const candidates = selectorsByAts[ats];
  for (const sel of candidates) {
    const btn = await page.$(sel);
    if (!btn) continue;
    try {
      await btn.scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
      await btn.click({ delay: 80 });
      // Either navigation happens or the form scrolls into view in-place.
      await Promise.race([
        page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => null),
        page.waitForTimeout(1500),
      ]);
      if (await waitForFormField(page)) return true;
    } catch {
      continue;
    }
  }

  // Last resort: maybe the form is already on the page (some Greenhouse boards inline it).
  return waitForFormField(page, 2000);
}

async function waitForFormField(page: Page, timeout = 6000): Promise<boolean> {
  try {
    await page.waitForSelector(
      "input[type='email'], input[name='email'], input[name='name'], input[id='first_name'], input[name='firstname'], input[type='file']",
      { timeout, state: "visible" },
    );
    return true;
  } catch {
    return false;
  }
}

export function loadAnswers(path = "profiles/answers.json"): Answers {
  return JSON.parse(readFileSync(path, "utf8"));
}

// Humanise typing speed so we don't look like a 200ms-burst bot.
async function typeLike(page: Page, selector: string, value: string) {
  const el = await page.$(selector);
  if (!el) return false;
  await el.click({ delay: 80 });
  await page.waitForTimeout(120 + Math.random() * 200);
  await el.fill(""); // clear in case of pre-fill
  await page.keyboard.type(value, { delay: 50 + Math.random() * 60 });
  await page.waitForTimeout(80 + Math.random() * 120);
  return true;
}

async function uploadResume(page: Page, selector: string, file: string) {
  const el = await page.$(selector);
  if (!el) return false;
  await el.setInputFiles(file);
  await page.waitForTimeout(800 + Math.random() * 400);
  return true;
}

// Try a list of selectors in order, return on first match.
async function tryFill(page: Page, selectors: string[], value: string): Promise<boolean> {
  for (const sel of selectors) {
    if (await typeLike(page, sel, value)) return true;
  }
  return false;
}

async function tryUpload(page: Page, selectors: string[], file: string): Promise<boolean> {
  for (const sel of selectors) {
    if (await uploadResume(page, sel, file)) return true;
  }
  return false;
}

async function clickIfExists(page: Page, selector: string) {
  const el = await page.$(selector);
  if (!el) return false;
  await el.click({ delay: 60 });
  return true;
}

export type FillResult = {
  filled: string[];
  skipped: string[];
  questions: string[]; // long custom questions we left for the LLM
};

export async function fillLever(page: Page, a: Answers): Promise<FillResult> {
  const result: FillResult = { filled: [], skipped: [], questions: [] };
  const log = (label: string, ok: boolean) => (ok ? result.filled.push(label) : result.skipped.push(label));

  log("name", await tryFill(page, ["input[name='name']"], a.identity.fullName));
  log("email", await tryFill(page, ["input[name='email']"], a.identity.email));
  log("phone", await tryFill(page, ["input[name='phone']"], a.identity.phone));
  log("location", await tryFill(page, ["input[name='location']", "input[name='currentLocation']"], a.identity.currentLocation));
  log("linkedin", await tryFill(page, ["input[name='urls[LinkedIn]']", "input[name='linkedinUrl']"], a.identity.linkedin));
  log("github", await tryFill(page, ["input[name='urls[GitHub]']", "input[name='githubUrl']"], a.identity.github));
  log("portfolio", await tryFill(page, ["input[name='urls[Portfolio]']", "input[name='urls[Other]']"], a.identity.portfolio));

  log("resume", await tryUpload(page, ["input[type='file'][name='resume']", "input[type='file']"], a.resumeFile));

  // Lever's "Additional information" textarea
  const additionalSelectors = ["textarea[name='comments']", "textarea[name='additionalInfo']"];
  log(
    "additionalInfo",
    await tryFill(page, additionalSelectors, a.shortAnswers.tellMeAboutYourself),
  );

  await collectCustomQuestions(page, "ul[class*='application-question'] textarea, .application-question textarea", result);
  return result;
}

export async function fillGreenhouse(page: Page, a: Answers): Promise<FillResult> {
  const result: FillResult = { filled: [], skipped: [], questions: [] };
  const log = (label: string, ok: boolean) => (ok ? result.filled.push(label) : result.skipped.push(label));

  log("first_name", await tryFill(page, ["input#first_name", "input[name='first_name']"], a.identity.firstName));
  log("last_name", await tryFill(page, ["input#last_name", "input[name='last_name']"], a.identity.lastName));
  log("email", await tryFill(page, ["input#email", "input[name='email']"], a.identity.email));
  log("phone", await tryFill(page, ["input#phone", "input[name='phone']"], a.identity.phone));
  log("resume", await tryUpload(page, ["input#resume", "input[type='file']"], a.resumeFile));

  // Greenhouse custom field URL inputs
  log("linkedin", await tryFill(page, ["input[id*='linkedin' i]", "input[name*='linkedin' i]"], a.identity.linkedin));
  log("github", await tryFill(page, ["input[id*='github' i]", "input[name*='github' i]"], a.identity.github));
  log("portfolio", await tryFill(page, ["input[id*='portfolio' i]", "input[id*='website' i]"], a.identity.portfolio));

  await collectCustomQuestions(page, ".custom-question textarea, #custom_fields textarea", result);
  return result;
}

export async function fillAshby(page: Page, a: Answers): Promise<FillResult> {
  const result: FillResult = { filled: [], skipped: [], questions: [] };
  const log = (label: string, ok: boolean) => (ok ? result.filled.push(label) : result.skipped.push(label));

  // Ashby uses aria-label / placeholder; queryByLabelText style.
  log("name", await tryFill(page, ["input[aria-label*='Name' i]", "input[name='_systemfield_name']"], a.identity.fullName));
  log("email", await tryFill(page, ["input[aria-label*='Email' i]", "input[name='_systemfield_email']", "input[type='email']"], a.identity.email));
  log("resume", await tryUpload(page, ["input[type='file']"], a.resumeFile));
  log("linkedin", await tryFill(page, ["input[aria-label*='LinkedIn' i]", "input[name*='linkedin' i]"], a.identity.linkedin));
  log("github", await tryFill(page, ["input[aria-label*='GitHub' i]", "input[name*='github' i]"], a.identity.github));

  await collectCustomQuestions(page, "textarea", result);
  return result;
}

export async function fillWorkable(page: Page, a: Answers): Promise<FillResult> {
  const result: FillResult = { filled: [], skipped: [], questions: [] };
  const log = (label: string, ok: boolean) => (ok ? result.filled.push(label) : result.skipped.push(label));

  log("first_name", await tryFill(page, ["input[name='firstname']", "input#firstname"], a.identity.firstName));
  log("last_name", await tryFill(page, ["input[name='lastname']", "input#lastname"], a.identity.lastName));
  log("email", await tryFill(page, ["input[name='email']", "input#email"], a.identity.email));
  log("phone", await tryFill(page, ["input[name='phone']", "input#phone"], a.identity.phone));
  log("resume", await tryUpload(page, ["input[type='file']"], a.resumeFile));
  log("linkedin", await tryFill(page, ["input[name*='linkedin' i]"], a.identity.linkedin));

  await collectCustomQuestions(page, ".question textarea", result);
  return result;
}

export async function fillGeneric(page: Page, a: Answers): Promise<FillResult> {
  const result: FillResult = { filled: [], skipped: [], questions: [] };
  const log = (label: string, ok: boolean) => (ok ? result.filled.push(label) : result.skipped.push(label));

  // Best-effort: try common patterns broadly.
  log("name", await tryFill(page, ["input[name*='name' i]:not([name*='last' i]):not([name*='first' i])", "input[id*='fullname' i]"], a.identity.fullName));
  log("first_name", await tryFill(page, ["input[name*='first' i]", "input[id*='first' i]"], a.identity.firstName));
  log("last_name", await tryFill(page, ["input[name*='last' i]", "input[id*='last' i]"], a.identity.lastName));
  log("email", await tryFill(page, ["input[type='email']", "input[name*='email' i]"], a.identity.email));
  log("phone", await tryFill(page, ["input[type='tel']", "input[name*='phone' i]"], a.identity.phone));
  log("linkedin", await tryFill(page, ["input[name*='linkedin' i]", "input[id*='linkedin' i]"], a.identity.linkedin));
  log("github", await tryFill(page, ["input[name*='github' i]", "input[id*='github' i]"], a.identity.github));
  log("resume", await tryUpload(page, ["input[type='file']"], a.resumeFile));

  await collectCustomQuestions(page, "textarea", result);
  return result;
}

async function collectCustomQuestions(page: Page, selector: string, result: FillResult) {
  const textareas = await page.$$(selector);
  for (const ta of textareas) {
    // Find the question label by walking up the DOM
    const label = await ta.evaluate((el) => {
      let parent: Element | null = el.parentElement;
      for (let i = 0; i < 5 && parent; i++) {
        const lbl = parent.querySelector("label, h3, h4, .application-question-label, [class*='label']");
        if (lbl && lbl.textContent && lbl.textContent.trim().length > 3 && lbl.textContent.trim().length < 400) {
          return lbl.textContent.trim();
        }
        parent = parent.parentElement;
      }
      return el.getAttribute("placeholder") ?? el.getAttribute("aria-label") ?? "";
    });
    if (label) result.questions.push(label);
  }
}

// Generate one answer per collected custom question via Claude, then fill them.
export async function answerCustomQuestions(
  page: Page,
  selector: string,
  questions: string[],
  context: { company: string; role: string; jobText: string; candidateCtx: string },
): Promise<Array<{ question: string; answer: string }>> {
  if (questions.length === 0) return [];

  const system = `You write short, specific answers for job application custom questions.
- Use projects + metrics from the MASTER.md profile. Do NOT invent any.
RULES:
- Match the question type: short text → 1-2 sentences; long text → 3-6 sentences.
- BANNED: "passionate", "I am writing to express", "rockstar", "exciting opportunity".
- For "Why us" questions: reference one specific thing about THIS company (from the job text below).
- For "Why now/why looking" questions: be honest — solo founder looking for team velocity, USD cash flow.
- For "Salary" questions: state target USD 90-140k FT or 80-100/hr contract.
- For "Notice period" questions: "Available immediately."
- For "Visa/Work auth": "Argentine independent contractor, no US work authorization needed; will work via international contract."
- For yes/no questions: answer directly + 1 sentence why.
- Output strict JSON: {"answers":[{"q":"<question text>","a":"<answer>"}]}`;

  const user = `CANDIDATE CONTEXT:
${context.candidateCtx.slice(0, 4000)}

COMPANY: ${context.company}
ROLE: ${context.role}
JOB POSTING TEXT (use specifics from here for any "Why us" question):
${context.jobText.slice(0, 3000)}

QUESTIONS TO ANSWER (return them in the same order):
${questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}

Return the JSON now.`;

  try {
    const raw = await callText(user, { system, model: DRAFT_MODEL, timeoutMs: 120000 });
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return [];
    const parsed = JSON.parse(m[0]) as { answers: Array<{ q: string; a: string }> };
    const answered: Array<{ question: string; answer: string }> = [];

    // Find each textarea again and fill with the matching answer.
    const textareas = await page.$$(selector);
    for (let i = 0; i < Math.min(textareas.length, parsed.answers.length); i++) {
      const ta = textareas[i];
      const ans = parsed.answers[i]?.a ?? "";
      if (!ans) continue;
      await ta.scrollIntoViewIfNeeded();
      await ta.click({ delay: 60 });
      await page.waitForTimeout(150 + Math.random() * 200);
      await ta.fill("");
      await page.keyboard.type(ans, { delay: 40 + Math.random() * 50 });
      await page.waitForTimeout(150);
      answered.push({ question: parsed.answers[i]?.q ?? questions[i], answer: ans });
    }
    return answered;
  } catch (e) {
    console.error("custom-questions FAIL:", (e as Error).message);
    return [];
  }
}

// Top-level dispatcher
export async function fill(page: Page, ats: ATS, a: Answers): Promise<FillResult> {
  switch (ats) {
    case "lever": return fillLever(page, a);
    case "greenhouse": return fillGreenhouse(page, a);
    case "ashby": return fillAshby(page, a);
    case "workable": return fillWorkable(page, a);
    default: return fillGeneric(page, a);
  }
}

export function customQuestionSelector(ats: ATS): string {
  switch (ats) {
    case "lever": return "ul[class*='application-question'] textarea, .application-question textarea";
    case "greenhouse": return ".custom-question textarea, #custom_fields textarea";
    case "ashby": return "textarea";
    case "workable": return ".question textarea";
    default: return "textarea";
  }
}

export function submitSelector(ats: ATS): string {
  switch (ats) {
    case "lever": return "button[type='submit'], button:has-text('Submit')";
    case "greenhouse": return "input[type='submit'], button[type='submit']";
    case "ashby": return "button[type='submit']:has-text('Submit'), button:has-text('Submit application')";
    case "workable": return "button[type='submit']:has-text('Submit'), button:has-text('Apply')";
    default: return "button[type='submit'], input[type='submit']";
  }
}
