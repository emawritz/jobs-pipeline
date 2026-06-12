// Gmail integration via OAuth2. Reads inbox, parses messages, persists
// next-page cursor. Used by lib/reply-matcher.ts to auto-detect replies
// to apps we sent.

import { google } from "googleapis";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const GMAIL_DIR = "data/gmail";
const CREDS_PATH = join(GMAIL_DIR, "credentials.json");
const TOKEN_PATH = join(GMAIL_DIR, "token.json");
const CURSOR_PATH = join(GMAIL_DIR, "cursor.json");

export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify", // for optional mark-as-read in the future
];

export type GmailMessage = {
  id: string;
  threadId: string;
  date: string;       // ISO from Date header
  internalDate: string; // ms epoch from Gmail
  from: string;       // raw "Name <addr@domain>"
  fromEmail: string;  // just the addr@domain
  to: string;
  subject: string;
  inReplyTo: string;  // Message-ID being replied to
  references: string;
  snippet: string;
  body: string;       // first ~5000 chars of plain text body
};

export type GmailCreds = {
  installed?: { client_id: string; client_secret: string; redirect_uris: string[] };
  web?: { client_id: string; client_secret: string; redirect_uris: string[] };
};

export function loadCredentials(): GmailCreds | null {
  if (!existsSync(CREDS_PATH)) return null;
  try { return JSON.parse(readFileSync(CREDS_PATH, "utf8")) as GmailCreds; } catch { return null; }
}

export function loadToken(): unknown | null {
  if (!existsSync(TOKEN_PATH)) return null;
  try { return JSON.parse(readFileSync(TOKEN_PATH, "utf8")); } catch { return null; }
}

export function saveToken(token: unknown) {
  mkdirSync(GMAIL_DIR, { recursive: true });
  writeFileSync(TOKEN_PATH, JSON.stringify(token, null, 2));
}

export function loadCursor(): { lastInternalDate: string | null } {
  if (!existsSync(CURSOR_PATH)) return { lastInternalDate: null };
  try { return JSON.parse(readFileSync(CURSOR_PATH, "utf8")); } catch { return { lastInternalDate: null }; }
}

export function saveCursor(cursor: { lastInternalDate: string | null }) {
  mkdirSync(GMAIL_DIR, { recursive: true });
  writeFileSync(CURSOR_PATH, JSON.stringify(cursor, null, 2));
}

export function getOAuth2Client(creds: GmailCreds) {
  const c = creds.installed ?? creds.web;
  if (!c) throw new Error("invalid credentials.json — falta 'installed' o 'web'");
  const oauth = new google.auth.OAuth2(c.client_id, c.client_secret, c.redirect_uris[0]);
  const token = loadToken();
  if (token) oauth.setCredentials(token as Parameters<typeof oauth.setCredentials>[0]);
  return oauth;
}

function decodeBase64Url(s: string): string {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

type GmailPayload = {
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: GmailPayload[];
  headers?: { name: string; value: string }[];
};

function extractPlainText(payload: GmailPayload): string {
  if (!payload) return "";
  // Prefer text/plain part if any.
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  // Recurse multipart.
  if (payload.parts) {
    for (const p of payload.parts) {
      if (p.mimeType === "text/plain" && p.body?.data) return decodeBase64Url(p.body.data);
    }
    // Fall back to first html part stripped.
    for (const p of payload.parts) {
      if (p.mimeType === "text/html" && p.body?.data) {
        return decodeBase64Url(p.body.data).replace(/<[^>]+>/g, " ");
      }
    }
    // Recurse deeper.
    for (const p of payload.parts) {
      const inner = extractPlainText(p);
      if (inner) return inner;
    }
  }
  if (payload.body?.data) return decodeBase64Url(payload.body.data);
  return "";
}

function header(headers: { name: string; value: string }[] | undefined, name: string): string {
  if (!headers) return "";
  const h = headers.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value ?? "";
}

function emailOf(addr: string): string {
  const m = addr.match(/<([^>]+)>/);
  if (m) return m[1].trim().toLowerCase();
  return addr.trim().toLowerCase();
}

export async function listInbox(opts: {
  maxResults?: number;
  query?: string;         // gmail-style query, e.g. "after:2026/05/01 in:inbox"
} = {}): Promise<GmailMessage[]> {
  const creds = loadCredentials();
  if (!creds) throw new Error("missing data/gmail/credentials.json — see SETUP.md");
  const auth = getOAuth2Client(creds);
  const token = loadToken();
  if (!token) throw new Error("missing data/gmail/token.json — run `npm run gmail-auth`");

  const gmail = google.gmail({ version: "v1", auth });
  const cursor = loadCursor();
  // Default query: anything newer than our cursor, in inbox, excluding our own sent.
  let q = opts.query;
  if (!q) {
    if (cursor.lastInternalDate) {
      // Gmail query uses unix seconds.
      const sec = Math.floor(parseInt(cursor.lastInternalDate, 10) / 1000);
      q = `after:${sec} in:inbox -from:me`;
    } else {
      // First run — last 14 days as default seed window.
      q = "newer_than:14d in:inbox -from:me";
    }
  }

  const list = await gmail.users.messages.list({
    userId: "me",
    q,
    maxResults: opts.maxResults ?? 50,
  });

  const ids = (list.data.messages ?? []).map((m) => m.id!).filter(Boolean);
  if (ids.length === 0) return [];

  // Fetch each message with full metadata + payload (limit concurrency).
  const out: GmailMessage[] = [];
  const concurrency = 5;
  for (let i = 0; i < ids.length; i += concurrency) {
    const batch = ids.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map((id) =>
        gmail.users.messages.get({ userId: "me", id, format: "full" }).then((r) => r.data),
      ),
    );
    for (const m of results) {
      const payload = m.payload as GmailPayload;
      const headers = payload?.headers;
      const from = header(headers, "From");
      const body = extractPlainText(payload).slice(0, 5000);
      out.push({
        id: m.id!,
        threadId: m.threadId!,
        date: header(headers, "Date"),
        internalDate: String(m.internalDate ?? "0"),
        from,
        fromEmail: emailOf(from),
        to: header(headers, "To"),
        subject: header(headers, "Subject"),
        inReplyTo: header(headers, "In-Reply-To"),
        references: header(headers, "References"),
        snippet: m.snippet ?? "",
        body,
      });
    }
  }

  // Update cursor to the newest internalDate we just processed.
  if (out.length > 0) {
    const newest = out.reduce((a, b) => (BigInt(a.internalDate) > BigInt(b.internalDate) ? a : b));
    saveCursor({ lastInternalDate: newest.internalDate });
  }

  return out;
}
