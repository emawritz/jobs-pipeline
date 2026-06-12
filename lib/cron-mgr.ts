// Lightweight launchd manager — read-only state inspection + load/unload.
// Looks specifically at plists named dev.jobs-pipeline.* in
// ~/Library/LaunchAgents/.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

const LAUNCH_AGENTS = join(homedir(), "Library/LaunchAgents");
const LABEL_PREFIX = "dev.jobs-pipeline.";

export type CronEntry = {
  label: string;
  filename: string;
  installed: boolean;
  loaded: boolean;
  lastExitCode: number | null;
  pid: number | null;
  schedule: string;          // human-friendly summary
  scriptPath: string | null; // first arg in ProgramArguments
  logFile: string | null;
  logTailKb: number;
};

function parsePlistText(text: string) {
  // Very lightweight extraction — no real XML parser. Pull what we need.
  const out: {
    label?: string;
    program?: string[];
    calendar?: { hour?: number; minute?: number; day?: number };
    intervalSec?: number;
    out?: string;
  } = {};

  const labelMatch = text.match(/<key>Label<\/key>\s*<string>([^<]+)<\/string>/);
  if (labelMatch) out.label = labelMatch[1];

  const progBlock = text.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if (progBlock) {
    out.program = Array.from(progBlock[1].matchAll(/<string>([^<]*)<\/string>/g)).map((m) => m[1]);
  }

  const calBlock = text.match(/<key>StartCalendarInterval<\/key>\s*<dict>([\s\S]*?)<\/dict>/);
  if (calBlock) {
    const cal: { hour?: number; minute?: number; day?: number } = {};
    const h = calBlock[1].match(/<key>Hour<\/key>\s*<integer>(\d+)<\/integer>/);
    const m = calBlock[1].match(/<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/);
    const d = calBlock[1].match(/<key>Day<\/key>\s*<integer>(\d+)<\/integer>/);
    if (h) cal.hour = parseInt(h[1], 10);
    if (m) cal.minute = parseInt(m[1], 10);
    if (d) cal.day = parseInt(d[1], 10);
    out.calendar = cal;
  }

  const interval = text.match(/<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/);
  if (interval) out.intervalSec = parseInt(interval[1], 10);

  const stdOut = text.match(/<key>StandardOutPath<\/key>\s*<string>([^<]+)<\/string>/);
  if (stdOut) out.out = stdOut[1];

  return out;
}

function fmtSchedule(parsed: { calendar?: { hour?: number; minute?: number; day?: number }; intervalSec?: number }): string {
  if (parsed.calendar) {
    const c = parsed.calendar;
    const hh = String(c.hour ?? 0).padStart(2, "0");
    const mm = String(c.minute ?? 0).padStart(2, "0");
    if (c.day != null) return `día ${c.day} de cada mes a las ${hh}:${mm}`;
    return `todos los días a las ${hh}:${mm}`;
  }
  if (parsed.intervalSec) {
    const s = parsed.intervalSec;
    if (s < 60) return `cada ${s} seg`;
    if (s < 3600) return `cada ${Math.round(s / 60)} min`;
    if (s < 86400) return `cada ${(s / 3600).toFixed(1)} h`;
    return `cada ${(s / 86400).toFixed(1)} días`;
  }
  return "sin schedule";
}

function getLaunchctlState(): Map<string, { pid: number | null; lastExit: number | null }> {
  // `launchctl list` → "PID  Status  Label" lines.
  const res = spawnSync("launchctl", ["list"], { encoding: "utf8" });
  if (res.status !== 0) return new Map();
  const out = new Map<string, { pid: number | null; lastExit: number | null }>();
  for (const line of res.stdout.split("\n")) {
    const m = line.match(/^(-|\d+)\s+(-|\d+)\s+(\S+)$/);
    if (!m) continue;
    const pid = m[1] === "-" ? null : parseInt(m[1], 10);
    const lastExit = m[2] === "-" ? null : parseInt(m[2], 10);
    out.set(m[3], { pid, lastExit });
  }
  return out;
}

export function listCron(root: string): CronEntry[] {
  // 1. Find candidate plists in BOTH ~/Library/LaunchAgents (installed) and
  //    in the repo's launchd/ folder (available but maybe not installed).
  const installed = existsSync(LAUNCH_AGENTS)
    ? readdirSync(LAUNCH_AGENTS).filter((f) => f.startsWith(LABEL_PREFIX) && f.endsWith(".plist"))
    : [];
  const repoDir = join(root, "launchd");
  const available = existsSync(repoDir)
    ? readdirSync(repoDir).filter((f) => f.endsWith(".plist"))
    : [];

  const all = new Set<string>([...installed, ...available]);
  const state = getLaunchctlState();
  const entries: CronEntry[] = [];

  for (const filename of all) {
    const installedPath = join(LAUNCH_AGENTS, filename);
    const repoPath = join(repoDir, filename);
    const path = existsSync(installedPath) ? installedPath : repoPath;
    let text = "";
    try { text = readFileSync(path, "utf8"); } catch { continue; }
    const parsed = parsePlistText(text);
    const label = parsed.label ?? filename.replace(/\.plist$/, "");
    const isInstalled = existsSync(installedPath);
    const lc = state.get(label) ?? { pid: null, lastExit: null };
    const logFile = parsed.out ?? null;
    let logTailKb = 0;
    if (logFile && existsSync(logFile)) {
      try { logTailKb = Math.round(statSync(logFile).size / 1024); } catch {}
    }
    entries.push({
      label,
      filename,
      installed: isInstalled,
      loaded: isInstalled && state.has(label),
      lastExitCode: lc.lastExit,
      pid: lc.pid,
      schedule: fmtSchedule(parsed),
      scriptPath: parsed.program?.slice(-1)[0] ?? null,
      logFile,
      logTailKb,
    });
  }
  entries.sort((a, b) => a.label.localeCompare(b.label));
  return entries;
}

export function toggleCron(filename: string, root: string): { ok: boolean; reason: string } {
  // Allow only our own plists.
  if (!filename.startsWith(LABEL_PREFIX) || !filename.endsWith(".plist")) {
    return { ok: false, reason: "filename not allowed" };
  }
  const installedPath = join(LAUNCH_AGENTS, filename);
  const repoPath = join(root, "launchd", filename);
  const isInstalled = existsSync(installedPath);

  if (isInstalled) {
    // Unload + remove.
    const r = spawnSync("launchctl", ["unload", "-w", installedPath], { encoding: "utf8" });
    if (r.status !== 0) return { ok: false, reason: r.stderr || "unload failed" };
    try {
      spawnSync("rm", ["-f", installedPath]);
    } catch {}
    return { ok: true, reason: "descargado y eliminado" };
  } else {
    // Install + load.
    if (!existsSync(repoPath)) return { ok: false, reason: `no existe ${repoPath}` };
    const cp = spawnSync("cp", [repoPath, installedPath], { encoding: "utf8" });
    if (cp.status !== 0) return { ok: false, reason: cp.stderr || "cp failed" };
    const ld = spawnSync("launchctl", ["load", "-w", installedPath], { encoding: "utf8" });
    if (ld.status !== 0) return { ok: false, reason: ld.stderr || "load failed" };
    return { ok: true, reason: "instalado y cargado" };
  }
}

export function readLogTail(filename: string, lines = 50): string {
  // Allow only files under data/daily-logs, data/hn-logs, or the configured log paths.
  const safe = /^\/Users\/ema\/jobs-pipeline\/data\/(daily-logs|hn-logs|orchestrator)\/[A-Za-z0-9._-]+$/;
  if (!safe.test(filename)) return "ruta de log no permitida";
  if (!existsSync(filename)) return "(sin log todavía)";
  const text = readFileSync(filename, "utf8");
  const all = text.split("\n");
  return all.slice(-lines).join("\n");
}
