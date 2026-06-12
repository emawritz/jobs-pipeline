// Workana project scraper. Requires logged-in Chrome persistent context at
// .playwright-data/. Workana's job listings are auth-walled — public visitors
// see almost nothing. With a session, we get the full feed.
//
// Run `npm run workana-login` once to log in.
//
// Output shape — designed to feed lib/freelance-proposal.ts:
//   {
//     url, title, budget, currency, postedAgo, bidCount, skills[], description
//   }

import { chromium, type BrowserContext, type Page } from "playwright";

const USER_DATA_DIR = ".playwright-data";

// Spanish-language IT/programming projects, sorted by date desc.
// Language filter: 2 = Spanish. Workana also supports type=hourly|fixed but we
// take both — proposal generator handles either.
const LISTING_URL =
  "https://www.workana.com/jobs?category=it-programming&language=2&sort=date";

const STACK_KEYWORDS = [
  // strong match
  "typescript", "node", "nestjs", "next.js", "nextjs",
  "react", "angular", "svelte",
  "rust", "tauri",
  "postgres", "postgresql", "pgvector", "sql server", "redis",
  "claude", "anthropic", "openai", "gpt", "llm", "rag", "ai agent",
  "tailwind", "playwright",
  "stripe", "mercado pago", "afip",
  // domain — high-overlap with the candidate's portfolio
  "saas", "fintech", "proptech", "telemedicine", "telemedicina", "clinical",
  "scraping", "etl", "dashboard",
];

const EXCLUDE_KEYWORDS = [
  "wordpress", "elementor", "shopify theme", "magento",
  "crypto", "web3", "blockchain", "nft", "defi",
  "casino", "gambling", "apuestas",
  "diseño gráfico", "logo design", "ilustración", "after effects",
  "data entry", "carga de datos manual", "copy paste",
  "redacción", "redactor", "writer",
];

export type WorkanaProject = {
  url: string;
  title: string;
  budget: string;
  postedAgo: string;
  bidCount: number;
  skills: string[];
  description: string;
  clientCountry?: string;
};

function scoreProject(p: WorkanaProject): number {
  const blob = `${p.title} ${p.description} ${p.skills.join(" ")}`.toLowerCase();
  if (EXCLUDE_KEYWORDS.some((k) => blob.includes(k))) return -1;
  let score = 0;
  for (const k of STACK_KEYWORDS) {
    if (blob.includes(k)) score += 1;
  }
  // Tiny boost for low-competition projects
  if (p.bidCount <= 5) score += 2;
  else if (p.bidCount <= 10) score += 1;
  else if (p.bidCount >= 25) score -= 1;
  return score;
}

async function ensureSession(page: Page): Promise<boolean> {
  await page.goto("https://www.workana.com/jobs", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  // Logged in users see avatar / "Mi cuenta" — anonymous sees "Iniciar sesión".
  const loginLink = await page.$('a[href*="/login"]');
  return loginLink === null;
}

async function scrapeListingPage(page: Page): Promise<WorkanaProject[]> {
  await page.goto(LISTING_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1500);

  // Workana renders each project as a <div class="project-item"> or similar.
  // We use generic selectors and fall back to text mining.
  const projects = await page.$$eval("[class*='project-item'], article.project, li.project", (nodes) => {
    return nodes.map((n) => {
      const linkEl = n.querySelector("a[href*='/job/']") as HTMLAnchorElement | null;
      const href = linkEl?.href ?? "";
      const title = linkEl?.textContent?.trim() ?? "";
      const text = (n as HTMLElement).innerText ?? "";
      const budgetMatch = text.match(/(?:USD|US\$|\$)\s*[0-9.,]+(?:\s*-\s*\$?[0-9.,]+)?\s*(?:USD)?/i);
      const postedMatch = text.match(/(?:Publicado|hace)\s+([^·\n]+)/i);
      const bidsMatch = text.match(/(\d+)\s+propuesta/i);
      return {
        url: href,
        title,
        text,
        budget: budgetMatch ? budgetMatch[0].trim() : "",
        postedAgo: postedMatch ? postedMatch[1].trim() : "",
        bidCount: bidsMatch ? parseInt(bidsMatch[1], 10) : 0,
      };
    });
  });

  const dedup = new Map<string, typeof projects[0]>();
  for (const p of projects) {
    if (!p.url || !p.title) continue;
    if (!dedup.has(p.url)) dedup.set(p.url, p);
  }
  return Array.from(dedup.values()).map((p) => ({
    url: p.url,
    title: p.title,
    budget: p.budget,
    postedAgo: p.postedAgo,
    bidCount: p.bidCount,
    skills: [],
    description: "",
  }));
}

async function fetchProjectDetail(page: Page, project: WorkanaProject): Promise<WorkanaProject> {
  await page.goto(project.url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(800);

  const detail = await page.evaluate(() => {
    const bodyText = (document.body.innerText || "").trim();
    const desc = (document.querySelector(
      "[class*='project-description'], [class*='description-section'], article",
    ) as HTMLElement | null)?.innerText?.trim() ?? "";
    const skills = Array.from(
      document.querySelectorAll("a[href*='/jobs?skills']"),
    ).map((a) => (a.textContent ?? "").trim()).filter(Boolean);
    const country = (() => {
      const m = bodyText.match(/(?:de|from|en)\s+([A-Z][a-záéíóúñ]+(?:\s+[A-Z][a-záéíóúñ]+)?)\s*·/);
      return m ? m[1] : undefined;
    })();
    return { desc: desc || bodyText.slice(0, 5000), skills, country };
  });

  return {
    ...project,
    description: detail.desc.slice(0, 4500),
    skills: detail.skills.slice(0, 20),
    clientCountry: detail.country,
  };
}

export async function scrapeWorkana(opts: {
  maxProjects?: number;
  minScore?: number;
  maxAgeHours?: number;
  maxBids?: number;
} = {}): Promise<WorkanaProject[]> {
  const maxProjects = opts.maxProjects ?? 15;
  const minScore = opts.minScore ?? 2;
  const maxBids = opts.maxBids ?? 15;

  const ctx: BrowserContext = await chromium.launchPersistentContext(USER_DATA_DIR, {
    channel: "chrome",
    headless: true,
    viewport: { width: 1400, height: 900 },
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());

  try {
    const logged = await ensureSession(page);
    if (!logged) {
      throw new Error("Not logged in to Workana — run `npm run workana-login` first.");
    }

    const listings = await scrapeListingPage(page);
    console.log(`[workana] ${listings.length} projects in listing`);

    // Filter cheap signals first to avoid fetching every detail page.
    const candidates = listings.filter((p) => p.bidCount <= maxBids).slice(0, 40);

    const detailed: WorkanaProject[] = [];
    for (const p of candidates) {
      try {
        const full = await fetchProjectDetail(page, p);
        const score = scoreProject(full);
        if (score >= minScore) detailed.push(full);
      } catch (e) {
        console.warn(`[workana] detail failed for ${p.url}: ${(e as Error).message}`);
      }
      await page.waitForTimeout(800 + Math.random() * 800);
    }

    return detailed
      .sort((a, b) => scoreProject(b) - scoreProject(a))
      .slice(0, maxProjects);
  } finally {
    await ctx.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  scrapeWorkana({ maxProjects: 10 })
    .then((projects) => {
      console.log(`\n══════ Workana: ${projects.length} matched projects ══════`);
      for (const p of projects) {
        console.log(`\n→ ${p.title}`);
        console.log(`  ${p.budget || "(no budget)"} · ${p.postedAgo} · ${p.bidCount} bids · score=${scoreProject(p)}`);
        console.log(`  skills: ${p.skills.slice(0, 6).join(", ")}`);
        console.log(`  ${p.url}`);
      }
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
