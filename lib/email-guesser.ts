// Email pattern guesser for LATAM/Spanish companies.
//
// Given a company name (and optionally a website URL), generate a ranked
// list of probable contact emails and verify each domain has MX records
// (cheap, native node DNS).
//
// Patterns tried (in priority order for LATAM/ES convention):
//   hola@        — LATAM Spanish convention
//   contacto@    — LATAM Spanish convention
//   careers@     — universal
//   jobs@        — universal
//   hello@       — global/Spanish-speaking startups
//   talent@      — newer startups
//   team@        — small startups
//   hr@          — corporate-style
//   recruiting@  — corporate-style
//   info@        — fallback (usually a black hole, last resort)

import { promises as dns } from "node:dns";

const PATTERNS = [
  "hola", "contacto", "careers", "jobs", "hello", "talent", "team", "hr", "recruiting", "info",
];

// LATAM/ES TLDs to try (in addition to common ones).
const TLD_GUESSES = [
  ".com", ".co", ".io", ".ai", ".app",
  ".com.ar", ".com.mx", ".com.br", ".com.co", ".com.pe",
  ".mx", ".cl", ".ar", ".pe", ".es", ".uy", ".com.uy",
];

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function normalizeCompany(raw: string): string {
  return stripAccents(raw)
    .toLowerCase()
    .replace(/\s+(inc|s\.?a\.?(s\.?)?|sas|ltd|llc|corp|corporation|s\.?l\.?|gmbh|ag|co\.?|company)\.?$/i, "")
    .replace(/[^a-z0-9]/g, "");
}

// Detect TLD-like suffix in company name ("Coderslab.io", "easyaudit.ai", "company.app").
function detectBakedTld(raw: string): { slug: string; tld: string } | null {
  const s = stripAccents(raw.toLowerCase()).replace(/\s+(inc|llc|s\.?a\.?|sas|ltd|gmbh|corp)\.?$/i, "").trim();
  const m = s.match(/^(.+?)\.(io|ai|app|dev|tech|sh)$/);
  if (m) return { slug: m[1].replace(/[^a-z0-9]/g, ""), tld: "." + m[2] };
  // Also handle " AI" as suffix → .ai
  const aiSuffix = s.match(/^(.+?)\s+ai$/);
  if (aiSuffix) return { slug: aiSuffix[1].replace(/[^a-z0-9]/g, ""), tld: ".ai" };
  return null;
}

async function hasMxRecord(domain: string): Promise<boolean> {
  try {
    const recs = await dns.resolveMx(domain);
    return recs.length > 0;
  } catch {
    return false;
  }
}

function deriveDomainFromUrl(url?: string): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    let host = u.hostname.toLowerCase();
    if (host.startsWith("www.")) host = host.slice(4);
    // Skip known job board domains.
    if (/getonbrd|workana|lever|greenhouse|ashby|linkedin|wellfound|angel\.co/.test(host)) return null;
    return host;
  } catch { return null; }
}

export type EmailGuess = {
  email: string;
  pattern: string;
  domain: string;
  verified: boolean; // true if domain has MX records
};

export async function guessEmails(opts: {
  company: string;
  websiteUrl?: string;
  maxTlds?: number;       // limit TLD guesses if no website (default 5)
  patternLimit?: number;  // try only top N patterns (default 4)
}): Promise<EmailGuess[]> {
  const maxTlds = opts.maxTlds ?? 5;
  const patternLimit = opts.patternLimit ?? 4;

  // Build candidate domains.
  const candidateDomains: string[] = [];
  const fromUrl = deriveDomainFromUrl(opts.websiteUrl);
  if (fromUrl) candidateDomains.push(fromUrl);

  // If the company name already contains a TLD-like suffix, try that first.
  const baked = detectBakedTld(opts.company);
  if (baked) {
    const d = `${baked.slug}${baked.tld}`;
    if (!candidateDomains.includes(d)) candidateDomains.push(d);
  }

  const slug = normalizeCompany(opts.company);
  if (slug.length >= 3) {
    for (const tld of TLD_GUESSES.slice(0, maxTlds)) {
      const d = `${slug}${tld}`;
      if (!candidateDomains.includes(d)) candidateDomains.push(d);
    }
  }

  // Verify MX (in parallel, capped concurrency).
  const verified: string[] = [];
  for (let i = 0; i < candidateDomains.length; i += 5) {
    const batch = candidateDomains.slice(i, i + 5);
    const results = await Promise.all(batch.map(async (d) => ({ d, ok: await hasMxRecord(d) })));
    for (const r of results) {
      if (r.ok) verified.push(r.d);
    }
    if (verified.length > 0) break; // first hit is enough
  }

  // Build email candidates from first verified domain.
  if (verified.length === 0) return [];
  const domain = verified[0];
  return PATTERNS.slice(0, patternLimit).map((p) => ({
    email: `${p}@${domain}`,
    pattern: p,
    domain,
    verified: true,
  }));
}

// Cheap synchronous helper for tests / debugging.
export function patternsFor(slug: string, tlds = ["com"]): string[] {
  return tlds.flatMap((tld) =>
    PATTERNS.map((p) => `${p}@${normalizeCompany(slug)}.${tld}`),
  );
}
