import type { Page } from "playwright";
import { callJSON, DRAFT_MODEL } from "./claude.ts";

// Given a page that's NOT an apply form (a careers index, company landing, etc.),
// extract all link candidates that could lead to specific job postings, and ask
// Claude to pick the best one based on the target company + role context.

const EXTRACT_FN = `(() => {
  const seen = new Set();
  const out = [];
  const links = document.querySelectorAll('a[href]');
  for (const a of links) {
    const href = a.getAttribute('href');
    if (!href || href.startsWith('javascript:') || href.startsWith('mailto:') || href === '#') continue;
    const abs = (() => { try { return new URL(href, location.href).toString(); } catch { return null; } })();
    if (!abs) continue;
    if (seen.has(abs)) continue;
    seen.add(abs);
    const text = (a.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 140);
    if (!text) continue;
    out.push({ href: abs, text });
    if (out.length >= 200) break;
  }
  return out;
})()`;

const JOB_LINK_HINTS = /(\/jobs?\/|\/job-|\/positions?\/|\/role\/|\/opening|\/apply|\/o\/|\/p\/|\/listings?\/|lever\.co|greenhouse\.io|ashbyhq\.com|workable\.com|breezy\.hr|smartrecruiters\.com|recruitee\.com|workatastartup\.com)/i;
const JOB_TEXT_HINTS = /\b(engineer|developer|architect|founding|senior|staff|lead|principal|product|backend|frontend|fullstack|full-stack|swe|sde)\b/i;

type Link = { href: string; text: string };

async function extractAllLinks(page: Page): Promise<Link[]> {
  return (await page.evaluate(EXTRACT_FN)) as Link[];
}

function rankLinks(links: Link[], currentHost: string): Link[] {
  // Score each link, return top 30 sorted desc.
  const scored = links.map((l) => {
    let score = 0;
    if (JOB_LINK_HINTS.test(l.href)) score += 5;
    if (JOB_TEXT_HINTS.test(l.text)) score += 4;
    if (JOB_TEXT_HINTS.test(l.href)) score += 2;
    if (/apply|application/i.test(l.text)) score += 3;
    // Same-host preference (jobs page on same domain is good).
    try {
      const linkHost = new URL(l.href).hostname;
      if (linkHost === currentHost) score += 1;
      // ATS subdomain (jobs.lever.co, boards.greenhouse.io) is the strongest signal
      if (/^(jobs|boards|apply|careers)\./i.test(linkHost)) score += 6;
    } catch {}
    // Penalise pure-nav links.
    if (/^(home|about|contact|blog|pricing|login|sign in|signup|privacy|terms)$/i.test(l.text)) score -= 5;
    return { link: l, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.filter((s) => s.score > 0).slice(0, 30).map((s) => s.link);
}

const PICK_SYSTEM = `You pick ONE job posting link from a list of links on a careers/company page.

Given:
- The target company name
- The target role description (from the original posting that brought us here)
- A ranked list of candidate links scraped from the page

Pick the SINGLE link that most likely points to the specific apply form for that role.

Rules:
- Prefer links whose text or URL contains role-specific keywords matching the target (e.g., "Senior Engineer", "Founding", "Backend").
- Prefer ATS subdomains (jobs.lever.co/X/uuid, boards.greenhouse.io/X/jobs/N).
- Reject links that go to "All jobs", "Careers", "About", login, or anything generic.
- If no link is clearly correct, return {"href": null, "reason": "<why>"}.

OUTPUT: strict JSON only:
{"href":"<full url>","reason":"<one sentence why>"}
OR
{"href":null,"reason":"<one sentence why nothing matched>"}`;

export async function findApplyLink(
  page: Page,
  context: { company: string; role: string; jobText: string },
): Promise<{ href: string | null; reason: string }> {
  const currentUrl = page.url();
  const currentHost = (() => { try { return new URL(currentUrl).hostname; } catch { return ""; } })();
  const all = await extractAllLinks(page);
  if (all.length === 0) return { href: null, reason: "no links on page" };
  const ranked = rankLinks(all, currentHost);
  if (ranked.length === 0) return { href: null, reason: "no job-like links on page" };

  const user = `TARGET:
Company: ${context.company}
Role: ${context.role}
Original posting (truncated):
${context.jobText.slice(0, 1500)}

CURRENT PAGE URL: ${currentUrl}

CANDIDATE LINKS (top ${ranked.length}):
${ranked.map((l, i) => `${i + 1}. [${l.text}] ${l.href}`).join("\n")}

Pick the one most likely to be the specific apply form for that role. Return JSON.`;

  type Out = { href: string | null; reason: string };
  try {
    const out = await callJSON<Out>(user, { system: PICK_SYSTEM, model: DRAFT_MODEL, timeoutMs: 60000 });
    return out;
  } catch (e) {
    return { href: null, reason: `LLM failed: ${(e as Error).message}` };
  }
}
