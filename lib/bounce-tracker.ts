// Tracks bounced email addresses extracted from mailer-daemon replies.
// Read by email-spain-sprint and other senders to skip known-bad addresses
// BEFORE wasting a send + getting flagged by Gmail as spam-prone.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BOUNCED_PATH = join(PROJECT_ROOT, "data/bounced-emails.json");

export type BounceRecord = {
  email: string;
  firstSeenAt: string;
  reason: string; // e.g. "address-not-found", "mailbox-full", "delivery-delay"
  sourceReplyId?: string;
};

// Pull the target email out of a mailer-daemon bounce body. Looks at a few
// well-known phrases (English + Spanish + Portuguese) and falls back to first
// email-like token in the body.
export function extractBouncedAddress(opts: { subject: string; body: string; snippet: string }): string | null {
  const all = `${opts.subject}\n${opts.snippet}\n${opts.body}`;
  // High-confidence phrases first.
  const phrases = [
    /no\s+se\s+ha\s+entregado\s+a\s+([^\s,;:<>"']+@[^\s,;:<>"')]+)/i,           // ES
    /not\s+delivered\s+to\s+([^\s,;:<>"']+@[^\s,;:<>"')]+)/i,                    // EN
    /to\s+([^\s,;:<>"']+@[^\s,;:<>"')]+)\s+(failed|because)/i,                   // EN variant
    /entrega\s+[ae]l?\s+mensaje\s+a\s+([^\s,;:<>"']+@[^\s,;:<>"')]+)/i,          // ES variant
    /Final-Recipient:\s+[^;]+;\s*([^\s,;:<>"']+@[^\s,;:<>"')]+)/i,               // DSN header
  ];
  for (const re of phrases) {
    const m = all.match(re);
    if (m) return m[1].toLowerCase().trim();
  }
  // Fallback: first email-like token that isn't the sender / mailer-daemon.
  const tokens = all.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) ?? [];
  for (const t of tokens) {
    const lower = t.toLowerCase();
    if (lower.includes("mailer-daemon") || lower.endsWith("@googlemail.com") || lower.includes("postmaster")) continue;
    return lower;
  }
  return null;
}

// Classify the bounce reason from the body.
export function classifyBounce(body: string): string {
  const b = body.toLowerCase();
  if (/no\s+se\s+ha\s+encontrado\s+la\s+direcci|address\s+not\s+found|550\s+5\.1\.1|user unknown|recipient address rejected|mailbox\s+unavailable|no such user/i.test(b)) {
    return "address-not-found";
  }
  if (/mailbox\s+full|over\s+quota|quota\s+exceeded/i.test(b)) {
    return "mailbox-full";
  }
  if (/temporary|delay|deferred|try again/i.test(b)) {
    return "delivery-delay";
  }
  if (/blocked|spam|denied|rejected/i.test(b)) {
    return "blocked";
  }
  return "unknown";
}

export function isMailerDaemon(fromEmail: string): boolean {
  const f = (fromEmail || "").toLowerCase();
  return f.includes("mailer-daemon") || f.includes("postmaster@") || f.endsWith("@googlemail.com");
}

export function loadBounced(): Map<string, BounceRecord> {
  if (!existsSync(BOUNCED_PATH)) return new Map();
  try {
    const arr = JSON.parse(readFileSync(BOUNCED_PATH, "utf8")) as BounceRecord[];
    return new Map(arr.map((r) => [r.email.toLowerCase(), r]));
  } catch {
    return new Map();
  }
}

export function saveBounced(map: Map<string, BounceRecord>): void {
  mkdirSync(dirname(BOUNCED_PATH), { recursive: true });
  const arr = Array.from(map.values()).sort((a, b) => a.email.localeCompare(b.email));
  writeFileSync(BOUNCED_PATH, JSON.stringify(arr, null, 2));
}

// Add an email to the bounce list. Returns true if newly added, false if existed.
export function recordBounce(email: string, reason: string, sourceReplyId?: string): boolean {
  if (!email) return false;
  const key = email.toLowerCase().trim();
  const map = loadBounced();
  if (map.has(key) && map.get(key)!.reason !== "delivery-delay") {
    return false; // already permanently marked
  }
  map.set(key, {
    email: key,
    firstSeenAt: map.get(key)?.firstSeenAt ?? new Date().toISOString(),
    reason,
    sourceReplyId,
  });
  saveBounced(map);
  return true;
}

export function isBounced(email: string): boolean {
  if (!email) return false;
  const map = loadBounced();
  const rec = map.get(email.toLowerCase().trim());
  if (!rec) return false;
  // delivery-delay isn't permanent; treat as still-deliverable after 48h.
  if (rec.reason === "delivery-delay") {
    const ageH = (Date.now() - new Date(rec.firstSeenAt).getTime()) / 3600000;
    return ageH < 48;
  }
  return true;
}
