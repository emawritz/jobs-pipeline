// Active prompt registry. Each PromptKey resolves to one PromptVersion
// (the "active" one). The self-iteration loop produces new vN.ts files and
// updates ACTIVE_VERSIONS after human approval — never mutates v1 files.

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { PromptKey, PromptVersion } from "./types.ts";

import { COVER_LETTER_EN_V1 } from "./cover-letter-en.v1.ts";
import { COVER_LETTER_ES_V1 } from "./cover-letter-es.v1.ts";
import { EMAIL_APPLICATION_EN_V1 } from "./email-application-en.v1.ts";
import { EMAIL_APPLICATION_ES_V1 } from "./email-application-es.v1.ts";
import { EMAIL_SPRINT_ES_V1 } from "./email-sprint-es.v1.ts";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ACTIVE_FILE = join(PROJECT_ROOT, "data", "prompt-active.json");
const PROMPTS_DIR = join(PROJECT_ROOT, "lib", "prompts");

// All built-in v1 versions. Newer versions are written by the iterate script
// to `lib/prompts/<key>.vN.ts` and discovered at runtime via the filesystem.
const BUILTINS: Record<PromptKey, PromptVersion> = {
  "cover-letter-en": COVER_LETTER_EN_V1,
  "cover-letter-es": COVER_LETTER_ES_V1,
  "email-application-en": EMAIL_APPLICATION_EN_V1,
  "email-application-es": EMAIL_APPLICATION_ES_V1,
  "email-sprint-es": EMAIL_SPRINT_ES_V1,
  // short-answer-en/es are inlined in getonboard-apply for now; we'll move
  // them in a follow-up iteration.
  "short-answer-en": null as unknown as PromptVersion,
  "short-answer-es": null as unknown as PromptVersion,
};

type ActiveMap = Partial<Record<PromptKey, string>>; // key → version string

function loadActiveMap(): ActiveMap {
  if (!existsSync(ACTIVE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(ACTIVE_FILE, "utf8")) as ActiveMap;
  } catch {
    return {};
  }
}

function saveActiveMap(m: ActiveMap): void {
  mkdirSync(dirname(ACTIVE_FILE), { recursive: true });
  writeFileSync(ACTIVE_FILE, JSON.stringify(m, null, 2));
}

// Discover all versions on disk for a prompt key.
// Looks for files matching `lib/prompts/<key>.v*.ts`. Each must default-export
// or named-export a PromptVersion-shaped object.
async function discoverVersions(key: PromptKey): Promise<Map<string, PromptVersion>> {
  const out = new Map<string, PromptVersion>();
  // Always seed with built-in v1.
  if (BUILTINS[key]) out.set(BUILTINS[key].version, BUILTINS[key]);
  if (!existsSync(PROMPTS_DIR)) return out;
  for (const name of readdirSync(PROMPTS_DIR)) {
    if (!name.startsWith(`${key}.v`) || !name.endsWith(".ts")) continue;
    try {
      const mod = await import(join(PROMPTS_DIR, name));
      for (const exp of Object.values(mod)) {
        const candidate = exp as Partial<PromptVersion>;
        if (candidate && candidate.key === key && typeof candidate.version === "string" && typeof candidate.systemPrompt === "string") {
          out.set(candidate.version, candidate as PromptVersion);
        }
      }
    } catch {
      // skip broken files
    }
  }
  return out;
}

export async function getActivePrompt(key: PromptKey): Promise<PromptVersion> {
  const map = loadActiveMap();
  const versions = await discoverVersions(key);
  if (versions.size === 0) {
    throw new Error(`no prompt versions found for key ${key}`);
  }
  // If user has pinned an active version that exists, use it.
  const pinned = map[key];
  if (pinned && versions.has(pinned)) {
    return versions.get(pinned)!;
  }
  // Default: highest version string by lexical sort (works for "1.0.0" < "1.1.0" < "2.0.0").
  const sorted = Array.from(versions.values()).sort((a, b) => (a.version < b.version ? 1 : -1));
  return sorted[0];
}

// Cheap sync fallback for code paths that can't await. Returns built-in v1.
export function getBuiltinPrompt(key: PromptKey): PromptVersion {
  const p = BUILTINS[key];
  if (!p) throw new Error(`no built-in prompt for key ${key}`);
  return p;
}

export async function listVersions(key: PromptKey): Promise<PromptVersion[]> {
  const versions = await discoverVersions(key);
  return Array.from(versions.values()).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}

export function setActiveVersion(key: PromptKey, version: string): void {
  const map = loadActiveMap();
  map[key] = version;
  saveActiveMap(map);
}

export async function getAllActive(): Promise<Array<{ key: PromptKey; active: PromptVersion; available: number }>> {
  const keys: PromptKey[] = [
    "cover-letter-en",
    "cover-letter-es",
    "email-application-en",
    "email-application-es",
    "email-sprint-es",
  ];
  return Promise.all(keys.map(async (k) => {
    const versions = await discoverVersions(k);
    const active = await getActivePrompt(k);
    return { key: k, active, available: versions.size };
  }));
}
