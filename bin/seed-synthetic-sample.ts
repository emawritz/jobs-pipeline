// Seeds data/cover-letters/ + data/applications.json with a synthetic sample
// to demonstrate the prompt-iterate flow end-to-end. EXPLICITLY MARKED AS
// SYNTHETIC. The iterate report will say so in its findings.
//
// Usage:
//   npx tsx bin/seed-synthetic-sample.ts --reset    # wipes existing samples
//   npx tsx bin/seed-synthetic-sample.ts            # appends

import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { saveCoverLetter } from "../lib/cover-letter-store.ts";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APPS_PATH = join(PROJECT_ROOT, "data", "applications.json");
const CL_DIR = join(PROJECT_ROOT, "data", "cover-letters");

type Application = {
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

type Sample = {
  appId: string;
  company: string;
  title: string;
  jobSnippet: string;
  body: string;
  outcome: "replied" | "ghosted" | "bounced";
};

const today = new Date().toISOString().slice(0, 10);
const dDays = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

// 12 synthetic cover letters. Patterns designed so an LLM critic can spot signal:
//  - REPLIED ones reference a specific tech choice / phrase from the JD and a
//    concrete metric from the candidate's projects.
//  - GHOSTED ones are vaguer, lead with the candidate's identity (not the
//    company's problem), and end with passive CTAs.
//  - BOUNCED ones aren't analyzed — they're filtered out by the iterate script.
const SAMPLES: Sample[] = [
  {
    appId: "syn-001",
    company: "Linear",
    title: "Senior Backend Engineer (NodeJS / Postgres)",
    jobSnippet: "We're rebuilding our query layer in Rust to keep p95 under 40ms across 80M issues. Looking for backend engineers who've shipped Rust in production and care about latency budgets.",
    body: `Your move from Node to Rust on the query layer is exactly the call I made last quarter — I rewrote the hot path of a serial-port driver in Rust and the p95 dropped from 180ms to 28ms across 12 retail clients.

I shipped <YOUR_SAAS_PROJECT> solo: 9 paying clients, 1+ year in production, Angular + NestJS + SQL Server with ~900KB of stored procedures plus a Tauri 2 + Rust agent talking to industrial scales over a custom serial protocol. The Rust binary runs in the system tray and survives the kind of hardware reset that kills naive event loops.

In weeks 1-2 I can profile your slowest query and put together a shadow-mode Rust port with side-by-side latency numbers before any cutover. GMT-3, full US Eastern morning overlap. Worth a 20-min call to see if the shape fits?`,
    outcome: "replied",
  },
  {
    appId: "syn-002",
    company: "Stripe Climate",
    title: "Senior Full-Stack Engineer",
    jobSnippet: "Stripe Climate. Founding team. Need a full-stack engineer comfortable shipping product end-to-end. TypeScript / Next.js / Postgres / Stripe payments.",
    body: `I'm a senior full-stack engineer with experience in TypeScript, Next.js, and Postgres. I've built multiple SaaS products from scratch and I'm comfortable shipping product end-to-end.

I'm passionate about climate tech and would love to contribute to your mission. I have strong experience with payment integrations including Stripe.

Available immediately. Happy to chat about the role and learn more about what you're looking for.`,
    outcome: "ghosted",
  },
  {
    appId: "syn-003",
    company: "Resend",
    title: "AI Engineer (Claude / LLM agents)",
    jobSnippet: "We're building deliverability tooling on top of LLMs. Looking for an engineer who has shipped Claude or GPT into production with measured cost / latency.",
    body: `Your deliverability angle on LLM tooling caught my attention — most email AI startups treat LLMs as magic boxes, but you've got the ops chops to make it actually ship.

I built <YOUR_AI_PROJECT>, a clinical SaaS where a Sonnet/Opus router handles 92% of conversations on Sonnet 4.6 and escalates 8% to Opus for crisis review. The unit economics are documented: $0.14 per patient per month, sub-3s latency on the 41-keyword safety net. Top 200/3000 at the Anthropic × Kaszek hackathon.

In the first two weeks I'd port one of your hot deliverability paths to a cost-aware router and ship a side-by-side dashboard so you can see exactly what changed. 20-min call?`,
    outcome: "replied",
  },
  {
    appId: "syn-004",
    company: "Vercel",
    title: "Senior Software Engineer",
    jobSnippet: "Vercel is hiring senior engineers across multiple teams. Strong TypeScript skills required. Interest in serverless architecture preferred.",
    body: `Hi Vercel team, I'm reaching out because I'm a senior software engineer with strong TypeScript skills and a deep interest in serverless architecture.

I believe I would be a great fit for your team given my background in modern web technologies. I've worked with frameworks like React, Next.js, and various serverless platforms throughout my career.

I am writing to express my interest in your open senior engineer roles. Please let me know if there's a good time to discuss further. Looking forward to hearing from you.`,
    outcome: "ghosted",
  },
  {
    appId: "syn-005",
    company: "Supabase",
    title: "Senior Engineer — Realtime",
    jobSnippet: "Realtime team at Supabase. You'll work on the Phoenix Channels infrastructure powering live updates across millions of clients. Strong Elixir or Erlang preferred but not required.",
    body: `Your Phoenix Channels scaling work is interesting because it's one of the few realtime stacks I've seen that actually delivers what it promises under load. I haven't shipped Elixir but I've shipped a self-hosted LiveKit cluster for clinical video where p99 connect time stays under 800ms across 4 regions.

The relevant project is <YOUR_AI_PROJECT> — clinical SaaS with realtime video, drafted with a Sonnet/Opus router. The infrastructure includes a 41-keyword safety classifier running in under 3 seconds, a Postgres + pgvector RAG that I tuned to <40ms p95, and a Postgres-backed message log that survives broker restarts cleanly.

I'd want the first two weeks to focus on reading your Channels stress test suite and writing a comparable one for the LiveKit-side of our stack so the comparison is honest. 20 min to talk shape?`,
    outcome: "replied",
  },
  {
    appId: "syn-006",
    company: "Notion",
    title: "Senior Frontend Engineer",
    jobSnippet: "Notion is looking for senior frontend engineers to work on our block editor and collaborative document infrastructure. React + TypeScript + WebSockets.",
    body: `I am a senior frontend engineer with React and TypeScript experience. I have used Notion as a customer for years and am excited about the opportunity to contribute.

I have built collaborative document features before in previous roles. I'd be happy to discuss my background in more detail and learn about the team.

Please let me know if my profile is a fit. Available for a call at your convenience.`,
    outcome: "ghosted",
  },
  {
    appId: "syn-007",
    company: "PostHog",
    title: "Senior Engineer — Data Pipeline",
    jobSnippet: "PostHog. We ingest 50B events per month. Looking for engineers who've worked at this scale with ClickHouse or similar columnar stores.",
    body: `Your 50B events/month load is the kind of scale where the database choice stops being academic. ClickHouse is the right call but the consistency story around real-time dashboards always gets brutal — I'd want to look at how you're handling lag between insert and query.

I shipped <YOUR_SAAS_PROJECT> with SQL Server stored procedures (~900KB total) handling 9 client tenants. Smaller scale but I've spent the last 18 months in the trenches with query plans, index hot spots, and the kind of pathological full-table-scans that look fine in staging and explode in prod.

First two weeks: read your slow-query repo, pick the top 3 queries by p99 cost, ship optimizations with before/after data. 20-min call if useful?`,
    outcome: "replied",
  },
  {
    appId: "syn-008",
    company: "Anthropic",
    title: "Senior Product Engineer",
    jobSnippet: "Anthropic. Senior product engineer for the Claude Code team. You'll be shipping CLI and IDE integrations that millions of developers use daily.",
    body: `I am a senior product engineer with experience building developer tools. I'm passionate about AI and Claude.

I have built CLI tools and IDE integrations in past roles. I'd love to contribute to the Claude Code team.

I'm available for a call. Looking forward to your response.`,
    outcome: "ghosted",
  },
  {
    appId: "syn-009",
    company: "Cal.com",
    title: "Founding Engineer — AI Booking",
    jobSnippet: "We're building an AI-driven booking layer on top of Cal.com. Need someone who has shipped both LLM features AND payment flows in production.",
    body: `Your AI booking layer needs the boring stuff to work — payment idempotency, timezone edge cases, refund flows — before the LLM magic matters. I've shipped both halves.

<YOUR_AI_PROJECT> has a Mercado Pago + Stripe billing layer running for clinical practices in Argentina (which means dealing with both LATAM tax integration and US card networks at once) plus the documented Claude router. <YOUR_SAAS_PROJECT> handles full AFIP electronic invoicing (WSAA + WSFE) end-to-end for 9 paying clients.

First two weeks: I'd own the booking-to-payment flow including the AI assistant's failure modes, and ship a dashboard showing every state transition. 20 min next week?`,
    outcome: "replied",
  },
  {
    appId: "syn-010",
    company: "Plausible",
    title: "Senior Engineer (Elixir / Phoenix)",
    jobSnippet: "Plausible Analytics. Privacy-first analytics. Elixir / Phoenix. Strong opinions on data privacy and EU compliance required.",
    body: `Hi Plausible team. I'm a senior engineer interested in your privacy-first approach to analytics.

I am passionate about data privacy and have followed your work for some time. While I haven't shipped Elixir specifically, I'm a strong learner.

I'd love to join your team. Please let me know if you're open to a call.`,
    outcome: "ghosted",
  },
  {
    appId: "syn-011",
    company: "Lemon Squeezy",
    title: "Senior Full-Stack Engineer",
    jobSnippet: "Lemon Squeezy. Merchant of Record for SaaS founders. Looking for senior engineers comfortable with multi-tenant billing edge cases.",
    body: `Multi-tenant billing edge cases are where SaaS goes to die — sales tax across jurisdictions, refund-vs-chargeback flows, dunning that doesn't make the customer hate you. I've been in that mud.

<YOUR_SAAS_PROJECT> is multi-tenant (9 paying clients), self-hosted, with full AFIP electronic invoicing for Argentina (WSAA + WSFE) — meaning I've already shipped the kind of country-specific tax handling that most Stripe-only stacks punt on. I also run Mercado Pago + Stripe side by side for <YOUR_AI_PROJECT>'s clinical billing, which keeps you honest about the differences in webhook timing and refund semantics.

First two weeks: pick one billing edge case that's been quietly costing you money and ship a fix with a measurable dollar impact. 20-min call?`,
    outcome: "replied",
  },
  {
    appId: "syn-012",
    company: "FakeMail",
    title: "Engineer",
    jobSnippet: "BOUNCED — fake address used to test the bounce filter.",
    body: "(this one will be filtered out by the iterate script — bounced)",
    outcome: "bounced",
  },
];

function makeMockApp(s: Sample): Application {
  // Replied / ghosted apps should be old enough to count for ghosted threshold.
  const daysOld = s.outcome === "ghosted" ? 10 : 5;
  return {
    id: s.appId,
    url: `https://example.com/jobs/${s.appId}`,
    platform: "synthetic:demo",
    company: s.company,
    title: s.title,
    status: s.outcome === "replied" ? "replied" : s.outcome === "bounced" ? "bounced" : "applied",
    appliedAt: dDays(daysOld),
    lastUpdate: today,
    notes: [
      `${dDays(daysOld)}: SYNTHETIC SAMPLE — drafted by seed script for prompt-iterate demo`,
      ...(s.outcome === "replied" ? [`${dDays(daysOld - 1)}: Reply received from ${s.company} hiring team`] : []),
      ...(s.outcome === "bounced" ? [`${dDays(daysOld)}: bounce auto-detectado (address-not-found)`] : []),
    ],
  };
}

function loadApps(): Application[] {
  if (!existsSync(APPS_PATH)) return [];
  try { return JSON.parse(readFileSync(APPS_PATH, "utf8")) as Application[]; } catch { return []; }
}

function saveApps(arr: Application[]): void {
  mkdirSync(dirname(APPS_PATH), { recursive: true });
  writeFileSync(APPS_PATH, JSON.stringify(arr, null, 2));
}

function main() {
  const reset = process.argv.includes("--reset");

  if (reset) {
    console.log("→ --reset: wiping existing synthetic samples + cover letters dir");
    if (existsSync(CL_DIR)) rmSync(CL_DIR, { recursive: true, force: true });
    const apps = loadApps().filter((a) => !a.id.startsWith("syn-"));
    saveApps(apps);
  }

  mkdirSync(CL_DIR, { recursive: true });

  const apps = loadApps();
  const appIds = new Set(apps.map((a) => a.id));

  for (const s of SAMPLES) {
    if (!appIds.has(s.appId)) {
      apps.push(makeMockApp(s));
    }
    saveCoverLetter({
      appId: s.appId,
      promptKey: "cover-letter-en",
      promptVersion: "1.0.0",
      language: "en",
      company: s.company,
      title: s.title,
      jobUrl: `https://example.com/jobs/${s.appId}`,
      jobTextSnippet: s.jobSnippet,
      subject: null,
      body: s.body,
      generatedAt: dDays(s.outcome === "ghosted" ? 10 : 5),
    });
  }

  saveApps(apps);

  console.log(`✓ seeded ${SAMPLES.length} synthetic cover letters`);
  console.log(`  applications.json now has ${apps.length} entries`);
  console.log(`  cover letters in ${CL_DIR}`);
  console.log("");
  console.log("Now run:");
  console.log("  npm run prompt-iterate -- --key=cover-letter-en --sample=20");
}

main();
