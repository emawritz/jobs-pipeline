// Targets viewer — lists data + outreach files with metadata, and returns
// content on demand. READ-ONLY. Bounded to a hardcoded allow-list of paths.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ALLOWED = [
  "data/spain-targets.json",
  "data/workana-drafts.md",
  "data/hn-comment.txt",
  "outreach/targets.md",
  "outreach/targets-v2.md",
  "outreach/targets-v3.md",
];

// User profile — MASTER.md lives in the repo root (gitignored). The viewer
// surfaces it (and any custom outreach files you drop in `outreach/`) so you
// can inspect what the agent reads as your candidate context.
const EXTERNAL_ALLOWED: Array<{ path: string; label: string }> = [
  { path: "MASTER.md", label: "MASTER — your candidate profile" },
];

export type TargetFile = {
  path: string;       // relative path
  label: string;      // friendly Spanish name
  kind: "json-array" | "markdown-numbered" | "markdown-plain" | "text";
  exists: boolean;
  mtime: string | null;
  sizeKb: number;
  count: number | null;     // # of items if structured
  preview: string;          // first ~600 chars
};

function safeRead(p: string): string {
  try { return readFileSync(p, "utf8"); } catch { return ""; }
}

function detect(path: string): TargetFile["kind"] {
  if (path.endsWith(".json")) return "json-array";
  if (path.endsWith(".md") && /targets-?v?\d?\.md$/.test(path)) return "markdown-numbered";
  if (path.endsWith(".md")) return "markdown-plain";
  return "text";
}

function labelFor(path: string): string {
  if (path === "data/spain-targets.json") return "Fundadores España (SPRINT)";
  if (path === "data/workana-drafts.md") return "Propuestas Workana drafteadas";
  if (path === "data/hn-comment.txt") return "Comentario HN \"Who wants to be hired\"";
  if (path === "outreach/targets.md") return "Outreach LinkedIn — batch 1";
  if (path === "outreach/targets-v2.md") return "Outreach LinkedIn — batch 2";
  if (path === "outreach/targets-v3.md") return "Outreach LinkedIn — batch 3";
  return path;
}

export function listTargetsFiles(root: string): TargetFile[] {
  const inRepo: TargetFile[] = ALLOWED.map((rel) => {
    const full = join(root, rel);
    const exists = existsSync(full);
    if (!exists) {
      return {
        path: rel,
        label: labelFor(rel),
        kind: detect(rel),
        exists: false,
        mtime: null,
        sizeKb: 0,
        count: null,
        preview: "",
      };
    }
    const st = statSync(full);
    const text = safeRead(full);
    const kind = detect(rel);
    let count: number | null = null;
    if (kind === "json-array") {
      try { count = Array.isArray(JSON.parse(text)) ? JSON.parse(text).length : null; } catch {}
    } else if (kind === "markdown-numbered") {
      count = (text.match(/^##\s+\d+\.\s+/gm) ?? []).length;
    } else if (kind === "markdown-plain") {
      count = (text.match(/^##\s+/gm) ?? []).length;
    }
    return {
      path: rel,
      label: labelFor(rel),
      kind,
      exists: true,
      mtime: new Date(st.mtimeMs).toISOString(),
      sizeKb: Math.round(st.size / 1024 * 10) / 10,
      count,
      preview: text.slice(0, 600),
    };
  });

  const external: TargetFile[] = EXTERNAL_ALLOWED.map(({ path: full, label }) => {
    const exists = existsSync(full);
    if (!exists) {
      return { path: full, label, kind: detect(full), exists: false, mtime: null, sizeKb: 0, count: null, preview: "" };
    }
    const st = statSync(full);
    const text = safeRead(full);
    const kind = detect(full);
    let count: number | null = null;
    if (kind === "json-array") {
      try { count = Array.isArray(JSON.parse(text)) ? JSON.parse(text).length : null; } catch {}
    } else if (kind === "markdown-numbered" || kind === "markdown-plain") {
      count = (text.match(/^##\s+/gm) ?? []).length;
    }
    return {
      path: full,
      label,
      kind,
      exists: true,
      mtime: new Date(st.mtimeMs).toISOString(),
      sizeKb: Math.round(st.size / 1024 * 10) / 10,
      count,
      preview: text.slice(0, 600),
    };
  });

  return [...inRepo, ...external];
}

export function readTargetFile(rel: string, root: string): { ok: boolean; content?: string; reason?: string } {
  // External absolute path (already in EXTERNAL_ALLOWED list)?
  const externalMatch = EXTERNAL_ALLOWED.find((e) => e.path === rel);
  const full = externalMatch ? rel : (ALLOWED.includes(rel) ? join(root, rel) : null);
  if (!full) return { ok: false, reason: "ruta no permitida" };
  if (!existsSync(full)) return { ok: false, reason: "no existe" };
  const content = safeRead(full);
  if (content.length > 200 * 1024) {
    return { ok: true, content: content.slice(0, 200 * 1024) + "\n\n(... truncado a 200kb)" };
  }
  return { ok: true, content };
}
