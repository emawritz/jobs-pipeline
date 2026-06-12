import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { callJSON, DRAFT_MODEL } from "./claude.ts";
import { loadAnswers } from "./auto-apply.ts";
import { isBounced } from "./bounce-tracker.ts";

// Profile source resolution: MASTER.md in repo root (gitignored, candidate's
// personal dossier) → fall back to CLAUDE.md if present.
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MASTER_PROFILE_PATH = join(PROJECT_ROOT, "MASTER.md");
const CLAUDE_FALLBACK_PATH = join(PROJECT_ROOT, "CLAUDE.md");

export function loadProfile(): string {
  if (existsSync(MASTER_PROFILE_PATH)) {
    return readFileSync(MASTER_PROFILE_PATH, "utf8");
  }
  if (existsSync(CLAUDE_FALLBACK_PATH)) {
    return readFileSync(CLAUDE_FALLBACK_PATH, "utf8");
  }
  return "";
}

export type EmailDraft = {
  subject: string;
  body: string;
};

const SYSTEM_EN = `You draft a complete job-application email for the candidate described in the MASTER profile below.

NON-NEGOTIABLE RULES:
- Subject line: short, specific, no "Application:" / "Re:" prefix. Reference one concrete proof from the MASTER (project + metric).
- Body: ~150 words, 3-4 short paragraphs.
  - Para 1: 1-2 sentences referencing ONE specific detail from the posting text (a product fact, a tech choice, a phrase from their post).
  - Para 2: 1 specific project of the candidate's that maps to the role + 1 concrete outcome with a number. Pull projects + numbers from the MASTER — DO NOT invent.
  - Para 3: 1-2 sentences offering what the candidate ships in the first 2-4 weeks.
  - Para 4 (sign-off): 1 line CTA — suggest a 20-min call OR ask for next steps. Mention candidate timezone + overlap with target market.
- Plain text only (no markdown, no HTML). Line breaks between paragraphs.
- BANNED phrases: "passionate", "I am writing to express", "rockstar", "ninja", "synergy", "leverage", "perfect fit", "I believe", "amazing opportunity", "warm regards".
- Sign with the candidate's name + contact details FROM THE MASTER. Do not invent contacts.

OUTPUT: strict JSON only:
{"subject":"<short subject>","body":"<plain text email body with newlines>"}`;

const SYSTEM_ES = `Drafteás un email completo de aplicación de trabajo para el candidato descrito en el perfil MASTER de abajo.

REGLAS NO NEGOCIABLES:
- Asunto: corto, específico, SIN prefijos "Aplicación:" / "Re:". Referenciá una prueba concreta del MASTER (proyecto + métrica).
- Body: ~150 palabras, 3-4 párrafos cortos. Español natural según el país del target (vos / tú).
  - Párrafo 1: 1-2 oraciones referenciando UN detalle específico del posting/empresa.
  - Párrafo 2: 1 proyecto específico del MASTER que mapea al rol + 1 outcome concreto con número del MASTER. NO inventes proyectos ni métricas.
  - Párrafo 3: 1-2 oraciones ofreciendo qué puede shippear el candidato en las primeras 2-4 semanas.
  - Párrafo 4 (cierre): 1 línea CTA — sugerir 20 min de llamada O preguntar próximos pasos. Mencionar timezone + overlap con target.
- Texto plano (sin markdown ni HTML). Saltos de línea entre párrafos.
- PROHIBIDAS: "apasionado", "amazing", "rockstar", "ninja", "sinergia", "perfect fit", "yo creo que", "increíble oportunidad", "saludos cordiales", "estimado/a", "señor/a".
- Firma con el nombre del candidato + datos de contacto DEL MASTER. No inventes contactos.
- Para Argentina/Uruguay: vos. Para España: tú. Para México/Colombia/Chile: tú. NO mezclar registros.

OUTPUT: solo JSON estricto:
{"subject":"<asunto corto>","body":"<email plain text con saltos de línea>"}`;

const SYSTEM_SPRINT_ES = `Drafteás un email de outreach SPRINT FREELANCE para el candidato descrito en el perfil MASTER de abajo.

⚠️ ESTO NO ES UN PEDIDO DE TRABAJO FULL-TIME. Es un pitch para CONTRATAR al candidato por una modalidad SPRINT (burst de 2 semanas con entregable fijo) o RETAINER (mensual). El target es un FOUNDER/CTO de una startup que probablemente NO tiene una vacante publicada — el candidato le está vendiendo un servicio concreto.

REGLAS NO NEGOCIABLES:
- Idioma: español natural del país objetivo (España = tú / "vale"; LATAM = vos o tú según país). NUNCA mezclar registros.
- Asunto: corto, específico, vendedor. Ej: "SPRINT 2 semanas — [entregable concreto basado en el contexto]".
- Body: ~150-180 palabras, 4 párrafos cortos.
  - Párrafo 1: 1-2 frases referenciando UN dato real y específico de la empresa o el founder. Esto demuestra que NO es spam.
  - Párrafo 2: 1 proyecto del MASTER que MAPEA al stack/dominio del target + 1 número concreto del MASTER. NO inventes proyectos ni métricas — solo usá lo que está en el MASTER.
  - Párrafo 3: la oferta concreta. "Modalidad SPRINT: 2 semanas, [entregable específico], fixed-price USD [X]" o "RETAINER: 1 sprint/mes, USD [Y]/mes". Proponé el deal, no pidas reunión vaga.
  - Párrafo 4 (CTA): "¿20 min de call esta semana para validar si el SPRINT te resuelve [problema específico]?" + mencionar timezone del candidato.
- Texto plano (sin markdown, sin emojis, sin bullets).
- PROHIBIDAS: "estimado", "atentamente", "saludos cordiales", "amplia experiencia", "apasionado", "perfect fit", "encantado", "me pongo en contacto", "espero su respuesta", "señor", "señora", "le escribo para".
- Firma: usá los datos de contacto del MASTER. NO inventes.

OUTPUT: solo JSON estricto:
{"subject":"<asunto corto y vendedor>","body":"<email plain text con saltos de línea>"}`;

const SYSTEM = SYSTEM_EN; // default for backward-compat

export async function draftEmail(context: {
  company: string;
  role: string;
  jobText: string;
  candidateCtx: string;
  toEmail: string;
  language?: "en" | "es";
  pitch?: "hire" | "sprint";
}): Promise<EmailDraft> {
  let sysPrompt = SYSTEM_EN;
  if (context.pitch === "sprint" && context.language === "es") sysPrompt = SYSTEM_SPRINT_ES;
  else if (context.language === "es") sysPrompt = SYSTEM_ES;
  const answers = loadAnswers();
  const user = `CANDIDATE CONTEXT (from MASTER.md profile — 11 shipped projects, pricing tiers, 6 producto/proceso rules):
${context.candidateCtx.slice(0, 8000)}

CANDIDATE ANSWERS BANK (use these literal values):
${JSON.stringify(answers, null, 2)}

JOB:
Company: ${context.company}
Role: ${context.role}
Email to: ${context.toEmail}
Posting (full text — use specifics):
${context.jobText.slice(0, 4500)}

Write the email JSON now. Subject + plain-text body.`;

  type Out = { subject: string; body: string };
  try {
    return await callJSON<Out>(user, { system: sysPrompt, model: DRAFT_MODEL, timeoutMs: 180000 });
  } catch (e) {
    const msg = (e as Error).message;
    if (!/timeout|EPIPE|aborted/i.test(msg)) throw e;
    console.error(`  draftEmail timed out, retrying once...`);
    return await callJSON<Out>(user, { system: sysPrompt, model: DRAFT_MODEL, timeoutMs: 240000 });
  }
}

// Send via Mail.app using AppleScript. Requires Mail.app to be configured with
// at least one account. First run may trigger a macOS automation permission prompt.
export function sendViaMailApp(opts: {
  to: string;
  subject: string;
  body: string;
  attachments?: string[];
}): { ok: boolean; reason: string } {
  const scriptPath = join(tmpdir(), `jobs-pipeline-mail-${Date.now()}.scpt`);
  const attachmentLines = (opts.attachments ?? [])
    .filter((p) => existsSync(p))
    .map((p) => {
      const abs = p.startsWith("/") ? p : process.cwd() + "/" + p;
      return `make new attachment with properties {file name:(POSIX file "${abs}")} at after last paragraph`;
    })
    .join("\n      ");

  // Escape double quotes and backslashes in subject/body for AppleScript literals.
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const subject = esc(opts.subject);
  const body = esc(opts.body);
  const to = esc(opts.to);

  const script = `
tell application "Mail"
  activate
  set newMsg to make new outgoing message with properties {subject:"${subject}", content:"${body}", visible:false}
  tell newMsg
    make new to recipient at end of to recipients with properties {address:"${to}"}
    ${attachmentLines}
  end tell
  delay 1
  send newMsg
end tell
`;
  writeFileSync(scriptPath, script);
  const res = spawnSync("osascript", [scriptPath], { encoding: "utf8", timeout: 30000 });
  if (res.status === 0) return { ok: true, reason: "sent via Mail.app" };
  return { ok: false, reason: `osascript failed (${res.status}): ${res.stderr?.slice(0, 200) ?? "?"}` };
}

// Accept multi-part TLDs like .com.mx, .com.br, .co.uk
const EMAIL_VALID = /^[a-zA-Z][\w.+-]*@[\w-]+(?:\.[a-z]{2,8}){1,3}$/i;

export async function emailApply(opts: {
  to: string;
  company: string;
  role: string;
  jobText: string;
  candidateCtx: string;
  resumePath: string;
  dryRun?: boolean;
  language?: "en" | "es";
  pitch?: "hire" | "sprint";
}): Promise<{ ok: boolean; subject: string; body: string; reason: string }> {
  if (!EMAIL_VALID.test(opts.to)) {
    return { ok: false, subject: "", body: "", reason: `invalid email address: ${opts.to}` };
  }
  // Cheap guard: bail before Claude draft if address is a known bounce.
  if (isBounced(opts.to)) {
    return { ok: false, subject: "", body: "", reason: `bounced-known-bad: ${opts.to}` };
  }
  const draft = await draftEmail({
    company: opts.company,
    role: opts.role,
    jobText: opts.jobText,
    candidateCtx: opts.candidateCtx,
    toEmail: opts.to,
    language: opts.language,
    pitch: opts.pitch,
  });
  if (opts.dryRun) {
    return { ok: true, subject: draft.subject, body: draft.body, reason: "[dry-run] would send" };
  }
  const send = sendViaMailApp({
    to: opts.to,
    subject: draft.subject,
    body: draft.body,
    attachments: [opts.resumePath],
  });
  return { ok: send.ok, subject: draft.subject, body: draft.body, reason: send.reason };
}
