// Pipeline funnel — counts at each stage of the job/freelance acquisition
// flow, with conversion rates between adjacent stages.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

type Application = {
  id: string;
  url: string;
  platform: string;
  company?: string;
  title?: string;
  status: string;
  appliedAt: string;
  notes: string[];
};

type DigestItem = { job: { url: string }; score: { total: number } };

export type FunnelStage = {
  key: string;
  label: string;
  count: number;
  detail?: string;
  // Conversion percentage vs the previous stage (0-100). Null for first stage.
  convPct?: number | null;
};

export type Funnel = {
  generatedAt: string;
  stages: FunnelStage[];
  byChannel: { channel: string; sent: number; replied: number; convPct: number }[];
  scrapers: { name: string; jobs?: number }[];
};

function safe<T>(path: string, fb: T): T {
  if (!existsSync(path)) return fb;
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return fb; }
}

function latestDigest(root: string): { items: DigestItem[]; date: string | null } {
  const dir = join(root, "data/digests");
  if (!existsSync(dir)) return { items: [], date: null };
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort().reverse();
  if (files.length === 0) return { items: [], date: null };
  const data = safe<{ items?: DigestItem[]; date?: string }>(join(dir, files[0]), {});
  return { items: data.items ?? [], date: data.date ?? null };
}

function listScrapers(root: string): { name: string }[] {
  const dir = join(root, "scrapers");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => ({ name: f.replace(/\.ts$/, "") }));
}

function pct(numer: number, denom: number): number {
  if (denom === 0) return 0;
  return Math.round((numer / denom) * 100);
}

function platformChannel(p: string): string {
  if (p.startsWith("auto:email")) return "Email (fundadores)";
  if (p.startsWith("auto:apply") || p.startsWith("auto:web")) return "Web auto-apply";
  if (p.startsWith("auto:workana")) return "Workana";
  if (p === "outreach-linkedin") return "LinkedIn (manual)";
  if (p.startsWith("auto:hn")) return "HN poster";
  return p || "otros";
}

export function getFunnel(root: string): Funnel {
  const apps = safe<Application[]>(join(root, "data/applications.json"), []);
  const digest = latestDigest(root);
  const scrapers = listScrapers(root);

  // Stage 1 — scrapers configurados (estructural, no runtime).
  const scraperCount = scrapers.length;

  // Stage 2 — empleos scrapeados (último digest).
  const digestCount = digest.items.length;

  // Stage 3 — empleos que pasaron filtro (score >= 60).
  const filteredCount = digest.items.filter((i) => i.score.total >= 60).length;

  // Stage 4 — aplicaciones enviadas (sum of all platform groups).
  const sentCount = apps.length;

  // Stage 5 — respuestas (status replied/interviewing/offer).
  const repliedCount = apps.filter((a) =>
    ["replied", "interviewing", "offer"].includes(a.status),
  ).length;

  // Stage 6 — entrevistas + ofertas.
  const interviewing = apps.filter((a) => a.status === "interviewing" || a.status === "offer").length;

  // Stage 7 — ofertas (signed or in negotiation).
  const offers = apps.filter((a) => a.status === "offer").length;

  const stages: FunnelStage[] = [
    {
      key: "scrapers",
      label: "Fuentes activas",
      count: scraperCount,
      detail: "16 scrapers de empleos remotos en HN, RemoteOK, YC, GetOnBoard, etc.",
      convPct: null,
    },
    {
      key: "digest",
      label: "Empleos scrapeados",
      count: digestCount,
      detail: digest.date ? `último digest ${digest.date}` : "sin digest todavía",
      convPct: scraperCount > 0 ? Math.min(100, digestCount) : 0,
    },
    {
      key: "filtered",
      label: "Empleos top (score ≥60)",
      count: filteredCount,
      detail: "filtrados por Claude Haiku por stack match + seniority + comp",
      convPct: pct(filteredCount, digestCount),
    },
    {
      key: "sent",
      label: "Aplicaciones enviadas (acumulado)",
      count: sentCount,
      detail: "total histórico de todos los canales",
      convPct: null, // not a true conversion (cumulative vs current digest)
    },
    {
      key: "replied",
      label: "Conversaciones abiertas",
      count: repliedCount,
      detail: "respondieron + entrevistando + oferta",
      convPct: pct(repliedCount, sentCount),
    },
    {
      key: "interviewing",
      label: "En entrevistas",
      count: interviewing,
      detail: "entrevistando + oferta",
      convPct: pct(interviewing, repliedCount),
    },
    {
      key: "offers",
      label: "Ofertas",
      count: offers,
      detail: "ofertas firmadas o en negociación",
      convPct: pct(offers, interviewing),
    },
  ];

  // Per-channel conversion.
  const channelMap = new Map<string, { sent: number; replied: number }>();
  for (const a of apps) {
    const ch = platformChannel(a.platform);
    const cur = channelMap.get(ch) ?? { sent: 0, replied: 0 };
    cur.sent += 1;
    if (["replied", "interviewing", "offer"].includes(a.status)) cur.replied += 1;
    channelMap.set(ch, cur);
  }
  const byChannel = Array.from(channelMap.entries())
    .map(([channel, v]) => ({ channel, sent: v.sent, replied: v.replied, convPct: pct(v.replied, v.sent) }))
    .sort((a, b) => b.sent - a.sent);

  return {
    generatedAt: new Date().toISOString(),
    stages,
    byChannel,
    scrapers,
  };
}
