import type { Plugin } from "vite";
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startJob, stopJob, getJob, listJobs, subscribe, type Job } from "../lib/orchestrator.ts";
import { getStatus } from "../lib/status.ts";
import { getFunnel } from "../lib/funnel.ts";
import { listCron, toggleCron, readLogTail } from "../lib/cron-mgr.ts";
import { listTargetsFiles, readTargetFile } from "../lib/targets-viewer.ts";
import { loadReplies, type StoredReply, type Application as MatcherApp } from "../lib/reply-matcher.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Whitelist of allowed commands to prevent arbitrary shell exec via /api/run.
// Each key is a playbook id; value is the actual command+args invocation.
type Playbook = {
  label: string;        // short Spanish title for the button
  description: string;  // 1-line explanation of what happens when clicked
  danger?: boolean;     // visual warning — actually sends/spends
  command: string;
  args: string[];
};

const PLAYBOOKS: Record<string, Playbook> = {
  // ── EMAIL ──
  "email-spain-sprint-dry": {
    label: "Probar emails España (sin enviar)",
    description: "Genera 3 borradores de email a fundadores españoles para que veas cómo quedan. NO envía nada.",
    command: "npx",
    args: ["tsx", "bin/email-spain-sprint.ts", "--dry-run", "--max=3"],
  },
  "email-spain-sprint": {
    label: "Enviar emails España (25 fundadores)",
    description: "Envía emails reales a 25 fundadores españoles con pitch SPRINT freelance. 1-2 min entre emails para no parecer spam.",
    danger: true,
    command: "npx",
    args: ["tsx", "bin/email-spain-sprint.ts"],
  },

  // ── WORKANA ──
  "workana-scan": {
    label: "Escanear proyectos Workana",
    description: "Lista los proyectos nuevos en Workana que matchean tu stack (sin generar propuestas todavía). Requiere login en Workana.",
    command: "npx",
    args: ["tsx", "scrapers/workana.ts"],
  },
  "workana-drafts": {
    label: "Generar propuestas Workana (sin enviar)",
    description: "Escanea proyectos + genera propuestas en español argentino. Las escribe a data/workana-drafts.md para que las revises. NO envía nada.",
    command: "npx",
    args: ["tsx", "bin/workana-bid.ts", "--draft-only"],
  },

  // ── WEB AUTO ──
  "auto-apply-email": {
    label: "Auto-aplicar por email a empleos",
    description: "Toma los empleos top del último digest, scrapea sus posts buscando emails, y manda aplicación con CV adjunto. Max 10.",
    danger: true,
    command: "npx",
    args: ["tsx", "bin/auto-apply-all.ts", "--email-only", "--scan-for-email", "--max=10", "--min-score=55"],
  },

  // ── DIGEST ──
  "digest-50": {
    label: "Buscar empleos nuevos (rápido — 50)",
    description: "Scrapea las 16 fuentes (HN, RemoteOK, Wellfound, WWR, etc.) y trae los 50 mejores empleos scorados por Claude Haiku. ~2-3 min.",
    command: "npx",
    args: ["tsx", "bin/digest.ts", "--limit=50"],
  },
  "digest-200": {
    label: "Buscar empleos completo (200)",
    description: "Igual al de 50 pero trae 200 empleos. Tarda 5-8 min. Lo mismo que corre el cron diario a las 8am.",
    command: "npx",
    args: ["tsx", "bin/digest.ts", "--limit=200"],
  },

  // ── HN POSTER ──
  "hn-check": {
    label: "Ver thread HN actual (sin postear)",
    description: "Va a Hacker News y reporta si ya salió el thread \"Who wants to be hired?\" del mes. No postea nada.",
    command: "npx",
    args: ["tsx", "bin/hn-post.ts", "--check"],
  },

  // ── MANTENIMIENTO ──
  "daily-run": {
    label: "Correr ciclo diario completo",
    description: "Lo mismo que corre el cron a las 8am: digest + auto-apply por email + (si está) auto-apply web. Tarda 8-12 min.",
    danger: true,
    command: "/bin/bash",
    args: ["bin/daily.sh"],
  },
  "followup": {
    label: "Mandar followups a apps sin respuesta",
    description: "Para apps con >7 días sin respuesta, draftea y manda un nudge corto. Skipea las ya marcadas como rechazadas/respondidas.",
    danger: true,
    command: "npx",
    args: ["tsx", "bin/followup.ts"],
  },
  "register-freelance": {
    label: "Abrir páginas de registro freelance",
    description: "Abre Codementor, Workana, Lemon, Revelo, Arc, South, Pangea, Hubstaff Talent en pestañas distintas + copia tu perfil al clipboard.",
    command: "npx",
    args: ["tsx", "bin/register-freelance.ts"],
  },

  // ── PLAYBOOKS COMPUESTOS (chainean varios scripts) ──
  "sweep-complete": {
    label: "Sweep completo (digest + workana + auto-apply)",
    description: "Workflow completo en un solo click: digest fresco (100 jobs) → workana drafts → auto-apply por email. Tarda 8-12 min. Lo mismo que corre el cron a las 8am.",
    danger: true,
    command: "/bin/bash",
    args: ["bin/sweep-complete.sh"],
  },

  // ── GMAIL ──
  "gmail-poll": {
    label: "Revisar respuestas en Gmail",
    description: "Lee tu inbox de Gmail desde la última vez, matchea con los emails que enviamos, y marca las apps como respondidas. Requiere setup OAuth previo (ver data/gmail/SETUP.md).",
    command: "npx",
    args: ["tsx", "bin/gmail-poll.ts", "--limit=100"],
  },

  // ── GETONBOARD (LATAM Spanish-speaking blast) ──
  "getonboard-dry": {
    label: "Probar GetOnBoard blast (sin enviar, 3 drafts)",
    description: "Scrapea jobs senior LATAM remote de GetOnBoard, adivina email del founder (hola@/contacto@/careers@ con verificación DNS MX), draftea 3 emails SPRINT en español. NO envía.",
    command: "npx",
    args: ["tsx", "bin/getonboard-blast.ts", "--dry-run", "--max=3"],
  },
  "getonboard-blast": {
    label: "Enviar GetOnBoard blast (max 10 empresas)",
    description: "Mismo flujo pero ENVÍA emails reales a empresas LATAM que tienen jobs senior abiertos en GetOnBoard. 1-2 min entre sends para no parecer spam. Pattern hola@.",
    danger: true,
    command: "npx",
    args: ["tsx", "bin/getonboard-blast.ts", "--max=10"],
  },
  "getonboard-apply-dry": {
    label: "Probar GetOnBoard apply (sin enviar, 5 drafts)",
    description: "Scrapea GetOnBoard, filtra jobs senior, draftea 5 cover letters (ES/EN según el posting) y los escribe a data/getonboard-drafts.md. NO abre el navegador, NO envía.",
    command: "npx",
    args: ["tsx", "bin/getonboard-apply.ts", "--dry-run", "--max=5"],
  },
  "getonboard-apply": {
    label: "Aplicar a GetOnBoard (max 5 jobs)",
    description: "Auto-postular en la plataforma de GetOnBoard usando la sesión logueada de Chrome. Draftea cover letter por job, llena el Trix editor, pasa los 3 pasos, envía. 60-120s entre apps.",
    danger: true,
    command: "npx",
    args: ["tsx", "bin/getonboard-apply.ts", "--max=5"],
  },

  // ── PROMPTS (v0.2 self-iteration) ──
  "prompt-iterate-cover-en": {
    label: "Iterar prompt: cover-letter (EN)",
    description: "Analiza últimas 30 cover letters EN con sus outcomes (replied/bounced/ghosted), pide a Claude que critique el prompt activo y proponga v2. Escribe la propuesta a data/prompt-iterations/, NO la activa.",
    command: "npx",
    args: ["tsx", "bin/prompt-iterate.ts", "--key=cover-letter-en", "--sample=30"],
  },
  "prompt-iterate-cover-es": {
    label: "Iterar prompt: cover-letter (ES)",
    description: "Igual que el de EN pero para cover letters en español.",
    command: "npx",
    args: ["tsx", "bin/prompt-iterate.ts", "--key=cover-letter-es", "--sample=30"],
  },
  "prompt-iterate-email-en": {
    label: "Iterar prompt: email apply (EN)",
    description: "Analiza emails EN enviados a recruiters/founders, propone una nueva versión del SYSTEM.",
    command: "npx",
    args: ["tsx", "bin/prompt-iterate.ts", "--key=email-application-en", "--sample=30"],
  },
};

function readJSON<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return fallback; }
}

function writeJSON(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function getLatestDigest() {
  const dir = join(ROOT, "data/digests");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort().reverse();
  if (files.length === 0) return null;
  return readJSON(join(dir, files[0]), null);
}

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

function getApplications(): Application[] {
  return readJSON(join(ROOT, "data/applications.json"), []);
}

function saveApplications(apps: Application[]) {
  writeJSON(join(ROOT, "data/applications.json"), apps);
}

function genId() { return Math.random().toString(36).slice(2, 8); }

function parseOneFile(path: string, numberOffset = 0): Array<{ num: number; name: string; body: string }> {
  if (!existsSync(path)) return [];
  const md = readFileSync(path, "utf8");
  const lines = md.split("\n");
  const out: Array<{ num: number; name: string; body: string }> = [];
  let cur: { num: number; name: string; body: string } | null = null;
  for (const line of lines) {
    const m = line.match(/^##\s+(\d+)\.\s+(.+)$/);
    if (m) {
      const name = m[2].trim();
      // Skip cross-reference notes the agent wrote (e.g. "Turso (see Category A #3) — replaced by Svix")
      if (/already #|see above|swap|see (?:category|existing|the existing)|replaced by/i.test(name)) continue;
      if (cur) out.push(cur);
      cur = { num: Number(m[1]) + numberOffset, name: name.replace(/\s*[-—–]\s*.*$/, "").trim(), body: "" };
      continue;
    }
    if (cur) {
      if (/^#\s+/.test(line) || /^## (?!\d)/.test(line)) {
        out.push(cur);
        cur = null;
        continue;
      }
      cur.body += line + "\n";
    }
  }
  if (cur) out.push(cur);
  return out;
}

function parseTargets() {
  const v1 = parseOneFile(join(ROOT, "outreach/targets.md"), 0);
  const v2 = parseOneFile(join(ROOT, "outreach/targets-v2.md"), 100); // numbers 101-120
  const v3 = parseOneFile(join(ROOT, "outreach/targets-v3.md"), 200); // numbers 201-220
  const all = [...v1, ...v2, ...v3];
  // Dedupe by name AND by number to defend against any remaining collisions.
  const seenName = new Set<string>();
  const seenNum = new Set<number>();
  return all.filter((t) => {
    const k = t.name.toLowerCase();
    if (seenName.has(k) || seenNum.has(t.num)) return false;
    seenName.add(k);
    seenNum.add(t.num);
    return true;
  });
}

function getOutreach() {
  const targets = parseTargets();
  const dir = join(ROOT, "outreach");
  const apps = getApplications();
  const sentByCompany = new Set(
    apps
      .filter((a) => a.platform === "outreach-linkedin")
      .map((a) => (a.company ?? "").toLowerCase().trim())
      .filter(Boolean),
  );
  const out = targets.map((t) => {
    const padded = String(t.num).padStart(2, "0");
    const matching = readdirSync(dir).find((f) => f.startsWith(`${padded}-`));
    let message = "";
    if (matching) {
      const raw = readFileSync(join(dir, matching), "utf8");
      message = raw.replace(/<!--[\s\S]*?-->\s*/g, "").trim();
    }
    const li = t.body.match(/https:\/\/(?:www\.)?linkedin\.com\/in\/[^\s|)]+/);
    const site = t.body.match(/\*\*Site:\*\*\s*(https?:\/\/\S+)/);
    // Pull founder NAME from research body. The agent wrote lines like:
    //   "CTO/Founder: Dan Farrelly — https://www.linkedin.com/in/djfarrelly/"
    // or "**CTO/Founder/Eng-lead:** Name (Role) — ..."
    const founderLine = t.body.match(/\*\*\s*(?:CTO|Founder|Eng[- ]lead|CEO|Co-Founder|Engineering Lead)[^*]*?\*\*\s*([^\n—|—]+?)(?:\s*[—–-]|\s*\(|\n)/i);
    let founderName = founderLine?.[1]?.trim().replace(/\*+$/, "") ?? null;
    if (founderName && /^https?:/.test(founderName)) founderName = null;
    const sent = sentByCompany.has(t.name.toLowerCase().trim());
    const matchedApp = apps
      .filter((a) => a.platform === "outreach-linkedin" && (a.company ?? "").toLowerCase().trim() === t.name.toLowerCase().trim())
      .sort((a, b) => b.lastUpdate.localeCompare(a.lastUpdate))[0];

    // Build a LinkedIn search fallback so a stale URL doesn't dead-end the user.
    const searchQuery = founderName ? `${founderName} ${t.name}` : `${t.name} founder CEO CTO`;
    const linkedinSearch = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(searchQuery)}`;

    return {
      num: t.num,
      name: t.name,
      message,
      linkedin: li?.[0] ?? null,
      linkedinSearch,
      founderName,
      site: site?.[1] ?? null,
      summary: t.body.slice(0, 600),
      sent,
      sentAt: matchedApp?.appliedAt ?? null,
      appId: matchedApp?.id ?? null,
    };
  });
  return out;
}

function getDrafts() {
  const dir = join(ROOT, "data/drafts");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => ({ file: f, content: readFileSync(join(dir, f), "utf8") }));
}

async function readBody(req: any): Promise<any> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c: any) => (data += c));
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
  });
}

function sendJSON(res: any, status: number, data: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(data));
}

function pbcopy(text: string) {
  spawnSync("pbcopy", [], { input: text });
}

function openUrl(url: string) {
  spawnSync("open", [url]);
}

function spawnAutoApply(url: string, mode: "auto" | "review" | "no-pause") {
  const args = ["tsx", "bin/auto-apply.ts", url];
  if (mode === "review") args.push("--review");
  else if (mode === "no-pause") args.push("--no-pause");
  // Detached so the dashboard doesn't block waiting for the browser session.
  const proc = spawnSync("npx", args, { cwd: ROOT, env: process.env, stdio: "inherit", timeout: 600000 });
  return { code: proc.status, error: proc.error?.message };
}

export function apiPlugin(): Plugin {
  return {
    name: "jobs-api",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? "";
        if (!url.startsWith("/api/")) return next();

        try {
          if (req.method === "GET" && url === "/api/digest") {
            return sendJSON(res, 200, getLatestDigest());
          }
          if (req.method === "GET" && url === "/api/applications") {
            return sendJSON(res, 200, getApplications());
          }
          if (req.method === "GET" && url === "/api/outreach") {
            return sendJSON(res, 200, getOutreach());
          }
          if (req.method === "GET" && url === "/api/drafts") {
            return sendJSON(res, 200, getDrafts());
          }
          if (req.method === "POST" && url === "/api/applications") {
            const body = await readBody(req);
            const apps = getApplications();
            const app: Application = {
              id: genId(),
              url: body.url ?? "",
              platform: body.platform ?? "unknown",
              company: body.company,
              title: body.title,
              status: "applied",
              appliedAt: today(),
              lastUpdate: today(),
              notes: body.note ? [`${today()}: ${body.note}`] : [],
            };
            apps.push(app);
            saveApplications(apps);
            return sendJSON(res, 201, app);
          }
          if (req.method === "PATCH" && url.startsWith("/api/applications/")) {
            const id = url.split("/").pop();
            const body = await readBody(req);
            const apps = getApplications();
            const app = apps.find((a) => a.id === id);
            if (!app) return sendJSON(res, 404, { error: "not found" });
            if (body.status) app.status = body.status;
            if (body.note) app.notes.push(`${today()}: ${body.note}`);
            app.lastUpdate = today();
            saveApplications(apps);
            return sendJSON(res, 200, app);
          }
          if (req.method === "POST" && url === "/api/clipboard") {
            const body = await readBody(req);
            pbcopy(body.text ?? "");
            return sendJSON(res, 200, { ok: true });
          }
          if (req.method === "POST" && url === "/api/open") {
            const body = await readBody(req);
            if (body.url) openUrl(body.url);
            return sendJSON(res, 200, { ok: true });
          }
          if (req.method === "POST" && url === "/api/auto-apply") {
            const body = await readBody(req);
            if (!body.url) return sendJSON(res, 400, { error: "url required" });
            const mode: "auto" | "review" | "no-pause" = body.mode ?? "auto";
            // Run synchronously so the response carries the exit code.
            const result = spawnAutoApply(body.url, mode);
            return sendJSON(res, 200, result);
          }
          // ── orchestrator routes ──
          if (req.method === "GET" && url === "/api/playbooks") {
            const out = Object.entries(PLAYBOOKS).map(([id, def]) => ({
              id,
              label: def.label,
              description: def.description,
              danger: !!def.danger,
              command: `${def.command} ${def.args.join(" ")}`,
            }));
            return sendJSON(res, 200, out);
          }
          if (req.method === "POST" && url === "/api/run") {
            const body = await readBody(req);
            const playbook = PLAYBOOKS[body.playbook];
            if (!playbook) return sendJSON(res, 400, { error: `unknown playbook: ${body.playbook}` });
            const job = startJob({
              label: playbook.label,
              command: playbook.command,
              args: playbook.args,
              cwd: ROOT,
            });
            return sendJSON(res, 201, job);
          }
          if (req.method === "GET" && url === "/api/jobs") {
            return sendJSON(res, 200, listJobs());
          }
          if (req.method === "GET" && url.startsWith("/api/jobs/") && url.endsWith("/stream")) {
            const id = url.split("/")[3];
            const job = getJob(id);
            if (!job) return sendJSON(res, 404, { error: "no such job" });
            res.statusCode = 200;
            res.setHeader("content-type", "text/event-stream");
            res.setHeader("cache-control", "no-cache");
            res.setHeader("connection", "keep-alive");
            res.setHeader("x-accel-buffering", "no");
            // Replay buffered output first.
            for (const line of job.output) {
              res.write(`data: ${JSON.stringify(line)}\n\n`);
            }
            // If job already ended, emit end + close.
            if (job.status !== "running") {
              res.write(`event: end\ndata: ${JSON.stringify({ status: job.status, exitCode: job.exitCode })}\n\n`);
              res.end();
              return;
            }
            // Live stream remaining output.
            const unsub = subscribe(id,
              (line) => res.write(`data: ${JSON.stringify(line)}\n\n`),
              () => {
                const finalJob = getJob(id);
                res.write(`event: end\ndata: ${JSON.stringify({ status: finalJob?.status, exitCode: finalJob?.exitCode })}\n\n`);
                res.end();
              },
            );
            req.on("close", () => unsub());
            return;
          }
          if (req.method === "POST" && url.startsWith("/api/jobs/") && url.endsWith("/stop")) {
            const id = url.split("/")[3];
            const r = stopJob(id);
            return sendJSON(res, r.ok ? 200 : 400, r);
          }
          if (req.method === "GET" && url.startsWith("/api/jobs/")) {
            const id = url.split("/")[3];
            const job = getJob(id);
            if (!job) return sendJSON(res, 404, { error: "no such job" });
            return sendJSON(res, 200, job);
          }
          if (req.method === "GET" && url === "/api/status") {
            return sendJSON(res, 200, getStatus(ROOT));
          }
          // ── pipeline / funnel ──
          if (req.method === "GET" && url === "/api/funnel") {
            return sendJSON(res, 200, getFunnel(ROOT));
          }
          // ── cron manager ──
          if (req.method === "GET" && url === "/api/cron") {
            return sendJSON(res, 200, listCron(ROOT));
          }
          if (req.method === "POST" && url.startsWith("/api/cron/") && url.endsWith("/toggle")) {
            const filename = decodeURIComponent(url.split("/")[3]);
            const r = toggleCron(filename, ROOT);
            return sendJSON(res, r.ok ? 200 : 400, r);
          }
          if (req.method === "POST" && url === "/api/cron/log") {
            const body = await readBody(req);
            if (!body.path) return sendJSON(res, 400, { error: "path required" });
            return sendJSON(res, 200, { content: readLogTail(body.path, body.lines ?? 60) });
          }
          // ── targets viewer ──
          if (req.method === "GET" && url === "/api/targets/files") {
            return sendJSON(res, 200, listTargetsFiles(ROOT));
          }
          if (req.method === "POST" && url === "/api/targets/read") {
            const body = await readBody(req);
            if (!body.path) return sendJSON(res, 400, { error: "path required" });
            const r = readTargetFile(body.path, ROOT);
            return sendJSON(res, r.ok ? 200 : 400, r);
          }
          // ── replies (Gmail-matched) ──
          if (req.method === "GET" && url === "/api/replies") {
            const replies = loadReplies();
            const apps = getApplications();
            const appsById = new Map(apps.map((a) => [a.id, a]));
            // Newest first.
            const enriched = replies
              .sort((a, b) => b.detectedAt.localeCompare(a.detectedAt))
              .map((r) => ({
                ...r,
                app: appsById.get(r.appId) ?? null,
              }));
            return sendJSON(res, 200, enriched);
          }
          // Gmail status — is OAuth configured? Has poll ever run?
          if (req.method === "GET" && url === "/api/gmail-status") {
            const credsExist = existsSync(join(ROOT, "data/gmail/credentials.json"));
            const tokenExist = existsSync(join(ROOT, "data/gmail/token.json"));
            const cursorExist = existsSync(join(ROOT, "data/gmail/cursor.json"));
            let cursor: { lastInternalDate: string | null } = { lastInternalDate: null };
            if (cursorExist) {
              try { cursor = JSON.parse(readFileSync(join(ROOT, "data/gmail/cursor.json"), "utf8")); } catch {}
            }
            const lastPollMs = cursor.lastInternalDate ? parseInt(cursor.lastInternalDate, 10) : null;
            return sendJSON(res, 200, {
              credentialsConfigured: credsExist,
              tokenConfigured: tokenExist,
              lastPollAt: lastPollMs ? new Date(lastPollMs).toISOString() : null,
              repliesDetected: loadReplies().length,
            });
          }

          // ── PROMPTS REGISTRY (v0.2 self-iteration) ──
          if (req.method === "GET" && url === "/api/prompts") {
            const { getAllActive, listVersions } = await import("../lib/prompts/registry.ts");
            const active = await getAllActive();
            const detailed = await Promise.all(active.map(async (a) => ({
              key: a.key,
              activeVersion: a.active.version,
              activeNotes: a.active.notes,
              availableVersions: (await listVersions(a.key)).map((v) => ({
                version: v.version,
                createdAt: v.createdAt,
                parentVersion: v.parentVersion,
                notes: v.notes,
                sampleSize: v.derivedFrom?.sampleSize ?? null,
                replyRate: v.derivedFrom?.replyRate ?? null,
              })),
            })));
            return sendJSON(res, 200, { prompts: detailed });
          }

          // List recent iteration suggestions (data/prompt-iterations/*.md).
          if (req.method === "GET" && url === "/api/prompt-iterations") {
            const dir = join(ROOT, "data/prompt-iterations");
            if (!existsSync(dir)) return sendJSON(res, 200, { iterations: [] });
            const files = require("node:fs").readdirSync(dir)
              .filter((f: string) => f.endsWith(".md"))
              .sort()
              .reverse();
            const iterations = files.slice(0, 20).map((f: string) => {
              const full = join(dir, f);
              const stat = require("node:fs").statSync(full);
              return {
                id: f.replace(/\.md$/, ""),
                filename: f,
                createdAt: stat.mtime.toISOString(),
                sizeBytes: stat.size,
              };
            });
            return sendJSON(res, 200, { iterations });
          }

          // Get a single iteration report (markdown body).
          if (req.method === "GET" && url.startsWith("/api/prompt-iterations/")) {
            const id = url.slice("/api/prompt-iterations/".length);
            const safe = id.replace(/[^a-z0-9._-]/gi, "");
            const full = join(ROOT, "data/prompt-iterations", `${safe}.md`);
            if (!existsSync(full)) return sendJSON(res, 404, { error: "not found" });
            return sendJSON(res, 200, {
              id: safe,
              body: readFileSync(full, "utf8"),
            });
          }

          // Activate a prompt version. POST { key, version }.
          if (req.method === "POST" && url === "/api/prompt-activate") {
            const body = await readBody(req);
            const { setActiveVersion, listVersions } = await import("../lib/prompts/registry.ts");
            const versions = await listVersions(body.key);
            if (!versions.find((v) => v.version === body.version)) {
              return sendJSON(res, 404, { error: `version ${body.version} not found for ${body.key}` });
            }
            setActiveVersion(body.key, body.version);
            return sendJSON(res, 200, { ok: true, key: body.key, activeVersion: body.version });
          }

          return sendJSON(res, 404, { error: "no route" });
        } catch (e) {
          return sendJSON(res, 500, { error: (e as Error).message });
        }
      });
    },
  };
}
