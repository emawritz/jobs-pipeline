// Persist every generated cover letter / email body to disk so the
// self-iteration loop has training data: (cover letter + posting + outcome).
//
// Storage: data/cover-letters/<appId>.json with structure:
//   {
//     appId: string,
//     promptKey: PromptKey,
//     promptVersion: string,
//     language: "en" | "es",
//     company: string,
//     title: string,
//     jobUrl: string,
//     jobTextSnippet: string,  // first ~500 chars of the JD (for context)
//     subject: string | null,  // if email, otherwise null
//     body: string,
//     generatedAt: string,     // ISO
//   }

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { PromptKey } from "./prompts/types.ts";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COVER_LETTERS_DIR = join(PROJECT_ROOT, "data", "cover-letters");

export type CoverLetterRecord = {
  appId: string;
  promptKey: PromptKey;
  promptVersion: string;
  language: "en" | "es";
  company: string;
  title: string;
  jobUrl: string;
  jobTextSnippet: string;
  subject: string | null;
  body: string;
  generatedAt: string;
};

export function saveCoverLetter(record: CoverLetterRecord): void {
  mkdirSync(COVER_LETTERS_DIR, { recursive: true });
  const path = join(COVER_LETTERS_DIR, `${record.appId}.json`);
  writeFileSync(path, JSON.stringify(record, null, 2));
}

export function loadCoverLetter(appId: string): CoverLetterRecord | null {
  const path = join(COVER_LETTERS_DIR, `${appId}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as CoverLetterRecord;
  } catch {
    return null;
  }
}

export function listCoverLetters(): CoverLetterRecord[] {
  if (!existsSync(COVER_LETTERS_DIR)) return [];
  const out: CoverLetterRecord[] = [];
  for (const name of readdirSync(COVER_LETTERS_DIR)) {
    if (!name.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(readFileSync(join(COVER_LETTERS_DIR, name), "utf8")));
    } catch {
      // skip
    }
  }
  return out.sort((a, b) => (a.generatedAt < b.generatedAt ? 1 : -1));
}
