// Job orchestration core — shared by the dashboard's api-plugin.ts.
//
// Lifecycle:
//   startJob(cmd, args) → spawns a child, tracks output in memory, persists
//   start/end state to data/orchestrator/jobs.json.
//
// SSE clients subscribe via `subscribe(jobId, fn)` — they get all buffered
// output first, then live updates until the process exits.
//
// History: last 50 jobs (including ended ones, with their full output).

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const HISTORY_PATH = "data/orchestrator/jobs.json";
const MAX_OUTPUT_LINES = 800;
const MAX_HISTORY = 50;

export type JobStatus = "running" | "completed" | "failed" | "killed";

export type Job = {
  id: string;
  label: string;         // human-friendly: "Spain SPRINT batch"
  command: string;       // e.g., "npx"
  args: string[];        // e.g., ["tsx", "bin/email-spain-sprint.ts"]
  status: JobStatus;
  pid?: number;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  output: string[];      // capped to MAX_OUTPUT_LINES
};

// In-memory state. Recovers nothing across server restarts except persisted
// history (live PIDs die with the parent vite process anyway).
const jobs = new Map<string, Job>();
const procs = new Map<string, ChildProcess>();
const emitters = new Map<string, EventEmitter>();

function genId() { return Math.random().toString(36).slice(2, 10); }

function nowIso() { return new Date().toISOString(); }

function loadHistory(): Job[] {
  if (!existsSync(HISTORY_PATH)) return [];
  try { return JSON.parse(readFileSync(HISTORY_PATH, "utf8")) as Job[]; } catch { return []; }
}

function persist() {
  mkdirSync("data/orchestrator", { recursive: true });
  // Merge in-memory jobs over disk history, dedup by id, keep latest MAX_HISTORY.
  const fromDisk = loadHistory();
  const seen = new Set<string>();
  const merged: Job[] = [];
  // memory first (latest wins)
  for (const j of jobs.values()) {
    if (seen.has(j.id)) continue;
    seen.add(j.id);
    merged.push(j);
  }
  for (const j of fromDisk) {
    if (seen.has(j.id)) continue;
    seen.add(j.id);
    merged.push(j);
  }
  merged.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  writeFileSync(HISTORY_PATH, JSON.stringify(merged.slice(0, MAX_HISTORY), null, 2));
}

// Hydrate in-memory jobs map from disk on first import, so listJobs() returns
// past runs even after the vite server restarts.
let hydrated = false;
function hydrateOnce() {
  if (hydrated) return;
  hydrated = true;
  for (const j of loadHistory()) {
    // Anything we find on disk as "running" died with the previous process.
    if (j.status === "running") {
      j.status = "killed";
      j.endedAt = j.endedAt ?? nowIso();
    }
    jobs.set(j.id, j);
  }
}

function pushLine(job: Job, line: string, isErr = false) {
  const prefix = isErr ? "stderr: " : "";
  const text = (prefix + line).slice(0, 2000);
  job.output.push(text);
  if (job.output.length > MAX_OUTPUT_LINES) job.output.splice(0, job.output.length - MAX_OUTPUT_LINES);
  const em = emitters.get(job.id);
  em?.emit("line", text);
}

export function startJob(opts: {
  label: string;
  command: string;
  args: string[];
  cwd?: string;
}): Job {
  hydrateOnce();
  const id = genId();
  const job: Job = {
    id,
    label: opts.label,
    command: opts.command,
    args: opts.args,
    status: "running",
    startedAt: nowIso(),
    output: [`▶ ${opts.command} ${opts.args.join(" ")}  (cwd: ${opts.cwd ?? process.cwd()})`],
  };

  const emitter = new EventEmitter();
  emitters.set(id, emitter);

  const proc = spawn(opts.command, opts.args, {
    cwd: opts.cwd ?? process.cwd(),
    env: { ...process.env, FORCE_COLOR: "0", CLAUDE_CODE_NO_HOOKS: "1", PATH: `${process.env.HOME ?? ""}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH ?? ""}` },
    detached: false,
  });
  job.pid = proc.pid;
  procs.set(id, proc);

  let stdoutBuf = "";
  let stderrBuf = "";
  proc.stdout?.on("data", (chunk: Buffer) => {
    stdoutBuf += chunk.toString();
    const lines = stdoutBuf.split("\n");
    stdoutBuf = lines.pop() ?? "";
    for (const l of lines) if (l.length > 0) pushLine(job, l, false);
  });
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString();
    const lines = stderrBuf.split("\n");
    stderrBuf = lines.pop() ?? "";
    for (const l of lines) if (l.length > 0) pushLine(job, l, true);
  });

  proc.on("error", (err) => {
    pushLine(job, `process error: ${err.message}`, true);
  });

  proc.on("close", (code) => {
    if (stdoutBuf) pushLine(job, stdoutBuf, false);
    if (stderrBuf) pushLine(job, stderrBuf, true);
    job.endedAt = nowIso();
    job.exitCode = code;
    if (job.status === "killed") {
      // already marked by stopJob
    } else {
      job.status = code === 0 ? "completed" : "failed";
    }
    pushLine(job, `◼ exit ${code} (${job.status})`, false);
    procs.delete(id);
    const em = emitters.get(id);
    em?.emit("end");
    emitters.delete(id);
    persist();
  });

  jobs.set(id, job);
  persist();
  return job;
}

export function stopJob(id: string): { ok: boolean; reason: string } {
  const job = jobs.get(id);
  if (!job) return { ok: false, reason: "no such job" };
  if (job.status !== "running") return { ok: false, reason: `job already ${job.status}` };
  const proc = procs.get(id);
  if (!proc) return { ok: false, reason: "no live process" };
  try {
    proc.kill("SIGTERM");
    job.status = "killed";
    persist();
    return { ok: true, reason: "SIGTERM sent" };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

export function getJob(id: string): Job | undefined {
  hydrateOnce();
  return jobs.get(id);
}

export function listJobs(limit = MAX_HISTORY): Job[] {
  hydrateOnce();
  return Array.from(jobs.values())
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, limit);
}

export function subscribe(id: string, onLine: (line: string) => void, onEnd: () => void): () => void {
  let em = emitters.get(id);
  if (!em) {
    // Job already ended — still allow replay then end immediately.
    em = new EventEmitter();
  }
  const lineHandler = (l: string) => onLine(l);
  const endHandler = () => onEnd();
  em.on("line", lineHandler);
  em.once("end", endHandler);
  return () => {
    em?.off("line", lineHandler);
    em?.off("end", endHandler);
  };
}

export function isRunning(id: string): boolean {
  const j = jobs.get(id);
  return !!j && j.status === "running";
}
