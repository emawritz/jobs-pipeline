// Match incoming Gmail messages to apps we sent. Updates data/applications.json
// by setting status=replied for matched apps and appending a note with the
// reply snippet.
//
// Matching strategy (in order of confidence):
//   1. fromEmail of incoming === recipient email of any sent app
//   2. subject (stripped of Re:/Fwd:) matches the subject we used (if we know it)
//
// Since we send via Mail.app (AppleScript), we DON'T have outgoing Message-IDs
// to use for In-Reply-To matching. So we rely on (1) which is very reliable
// for cold outreach where each prospect is a unique address.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { GmailMessage } from "./gmail-reader.ts";
import { isMailerDaemon, extractBouncedAddress, classifyBounce, recordBounce } from "./bounce-tracker.ts";

// Resolve paths relative to project root, not process cwd, so module works
// whether invoked from root (CLI scripts) or from web/ (Vite dev server).
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APPS_PATH = join(PROJECT_ROOT, "data/applications.json");
const REPLIES_PATH = join(PROJECT_ROOT, "data/gmail/replies.json");
const SENT_INDEX_PATH = join(PROJECT_ROOT, "data/gmail/sent-thread-index.json");

export type Application = {
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

export type StoredReply = {
  id: string;                 // gmail message id
  threadId: string;
  appId: string;              // matched app id
  matchedBy: "email" | "subject" | "thread";
  fromEmail: string;
  fromDisplay: string;
  subject: string;
  date: string;
  snippet: string;
  body: string;
  detectedAt: string;
};

function loadApps(): Application[] {
  if (!existsSync(APPS_PATH)) return [];
  try { return JSON.parse(readFileSync(APPS_PATH, "utf8")) as Application[]; } catch { return []; }
}

function saveApps(apps: Application[]) {
  writeFileSync(APPS_PATH, JSON.stringify(apps, null, 2));
}

export function loadReplies(): StoredReply[] {
  if (!existsSync(REPLIES_PATH)) return [];
  try { return JSON.parse(readFileSync(REPLIES_PATH, "utf8")) as StoredReply[]; } catch { return []; }
}

// Map of threadId → appId, built by indexSentThreads() when we scan Sent mail.
// Used so a reply from lucie@threatmark.com in the same thread as our outbound
// to career@threatmark.com still resolves to the right app.
type SentIndex = Record<string, string>; // threadId → appId
function loadSentIndex(): SentIndex {
  if (!existsSync(SENT_INDEX_PATH)) return {};
  try { return JSON.parse(readFileSync(SENT_INDEX_PATH, "utf8")) as SentIndex; } catch { return {}; }
}
function saveSentIndex(idx: SentIndex) {
  writeFileSync(SENT_INDEX_PATH, JSON.stringify(idx, null, 2));
}

// Build the threadId → appId map by scanning our Sent mail and matching each
// sent message's `to` against app emails. Call once at startup, then again
// whenever you send new mail.
export function indexSentThreads(sentMessages: GmailMessage[]): { indexed: number; total: number } {
  const apps = loadApps();
  const appsByEmail = new Map<string, Application[]>();
  for (const a of apps) {
    const e = appEmail(a);
    if (!e) continue;
    if (!appsByEmail.has(e)) appsByEmail.set(e, []);
    appsByEmail.get(e)!.push(a);
  }
  const idx: SentIndex = loadSentIndex();
  let added = 0;
  for (const m of sentMessages) {
    // `to` header may contain multiple addresses; check each
    const toAddrs = (m.to || "").split(",")
      .map((s) => emailFromAddr(s.trim()))
      .filter(Boolean);
    for (const to of toAddrs) {
      const candidates = appsByEmail.get(to);
      if (!candidates || candidates.length === 0) continue;
      candidates.sort((a, b) => b.appliedAt.localeCompare(a.appliedAt));
      if (!idx[m.threadId]) {
        idx[m.threadId] = candidates[0].id;
        added++;
      }
      break;
    }
  }
  saveSentIndex(idx);
  return { indexed: added, total: Object.keys(idx).length };
}

function emailFromAddr(addr: string): string {
  const m = addr.match(/<([^>]+)>/);
  if (m) return m[1].trim().toLowerCase();
  return addr.trim().toLowerCase();
}

function saveReplies(arr: StoredReply[]) {
  writeFileSync(REPLIES_PATH, JSON.stringify(arr, null, 2));
}

function appEmail(a: Application): string | null {
  // Apps from the email pipeline store url as "mailto:user@example.com".
  if (a.url.startsWith("mailto:")) return a.url.slice(7).toLowerCase();
  return null;
}

function stripSubjectPrefix(s: string): string {
  return s.replace(/^\s*(?:re|fwd|fw|rv|resp|respuesta)\s*:\s*/gi, "").trim().toLowerCase();
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function matchReplies(messages: GmailMessage[]): {
  matched: number;
  alreadySeen: number;
  newReplies: StoredReply[];
} {
  const apps = loadApps();
  const replies = loadReplies();
  const seenIds = new Set(replies.map((r) => r.id));

  // Index apps by recipient email for O(1) lookup.
  const appsByEmail = new Map<string, Application[]>();
  for (const a of apps) {
    const e = appEmail(a);
    if (!e) continue;
    if (!appsByEmail.has(e)) appsByEmail.set(e, []);
    appsByEmail.get(e)!.push(a);
  }

  // Index app subject prefixes (from last note line — we store subject there).
  // Notes pattern: "2026-05-26: ... · subject text"
  // Less reliable; skip subject-only matches for now to avoid false positives.

  const sentIndex = loadSentIndex();
  const newReplies: StoredReply[] = [];
  let alreadySeen = 0;

  for (const m of messages) {
    if (seenIds.has(m.id)) { alreadySeen++; continue; }

    // 0. Bounce detection runs BEFORE app-matching. mailer-daemon messages
    //    can't be matched by fromEmail (the daemon address is never one of ours),
    //    but the body contains the address that bounced — use that to:
    //      a) add the address to bounced-emails.json (so we skip future sends)
    //      b) find the app we sent there + mark it status=bounced (not replied)
    if (isMailerDaemon(m.fromEmail)) {
      const bouncedAddr = extractBouncedAddress({ subject: m.subject, body: m.body, snippet: m.snippet });
      if (bouncedAddr) {
        const reason = classifyBounce(m.body ?? m.snippet ?? "");
        recordBounce(bouncedAddr, reason, m.id);
        const candidates = appsByEmail.get(bouncedAddr);
        const matchedApp = candidates && candidates.length > 0
          ? candidates.sort((a, b) => b.appliedAt.localeCompare(a.appliedAt))[0]
          : undefined;
        if (matchedApp && reason !== "delivery-delay") {
          matchedApp.status = "bounced";
          matchedApp.lastUpdate = today();
          matchedApp.notes.push(`${today()}: bounce auto-detectado (${reason}) — ${bouncedAddr}`);
        }
      }
      // Still store the daemon message so we don't reprocess it.
      newReplies.push({
        id: m.id,
        threadId: m.threadId,
        appId: "",
        matchedBy: "email",
        fromEmail: m.fromEmail,
        fromDisplay: m.from,
        subject: m.subject,
        date: m.date,
        snippet: m.snippet,
        body: m.body,
        detectedAt: new Date().toISOString(),
      });
      continue;
    }

    // 1. Strongest match: threadId is one of our outbound threads.
    let app: Application | undefined;
    let matchedBy: StoredReply["matchedBy"] = "email";
    if (sentIndex[m.threadId]) {
      app = apps.find((a) => a.id === sentIndex[m.threadId]);
      if (app) matchedBy = "thread";
    }

    // 2. Fallback: fromEmail matches an app's recipient address.
    if (!app) {
      const candidates = appsByEmail.get(m.fromEmail);
      if (!candidates || candidates.length === 0) continue;
      candidates.sort((a, b) => b.appliedAt.localeCompare(a.appliedAt));
      app = candidates[0];
      matchedBy = "email";
    }
    if (!app) continue;

    const rep: StoredReply = {
      id: m.id,
      threadId: m.threadId,
      appId: app.id,
      matchedBy,
      fromEmail: m.fromEmail,
      fromDisplay: m.from,
      subject: m.subject,
      date: m.date,
      snippet: m.snippet,
      body: m.body,
      detectedAt: new Date().toISOString(),
    };
    newReplies.push(rep);

    // Mark app as replied if not already in a more advanced state.
    if (app.status === "applied" || app.status === "ghosted") {
      app.status = "replied";
      app.lastUpdate = today();
      app.notes.push(`${today()}: Gmail reply auto-detectado de ${m.fromEmail} — "${m.subject}" — ${m.snippet.slice(0, 200)}`);
    } else {
      // Already past 'applied' — just append a note.
      app.notes.push(`${today()}: nueva mensaje de ${m.fromEmail} — "${m.subject}"`);
      app.lastUpdate = today();
    }
  }

  if (newReplies.length > 0) {
    saveApps(apps);
    saveReplies([...replies, ...newReplies]);
  }

  return { matched: newReplies.length, alreadySeen, newReplies };
}
