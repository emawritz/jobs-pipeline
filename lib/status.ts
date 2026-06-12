// Channel/system status report — feeds the dashboard's status pills.
// Pure file/dir inspection. No spawning. No network calls.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Application = { id: string; platform: string; status: string; appliedAt: string };

export type Status = {
  applications: {
    total: number;
    last24h: number;
    last7d: number;
    byStatus: Record<string, number>;
  };
  channels: {
    email: { sentTotal: number; sent24h: number };
    web: { sentTotal: number; sent24h: number };
    workana: { sentTotal: number; sent24h: number; profileNote: string };
    linkedin: { sentTotal: number };
    hn: { sentTotal: number };
  };
  scrapers: {
    lastDigestAt: string | null;
    lastDigestCount: number | null;
  };
  cron: {
    daily: { plistInstalled: boolean; lastRunAt: string | null };
    hnPoster: { plistInstalled: boolean };
  };
  pipelines: {
    spainTargetsExist: boolean;
    spainTargetsCount: number;
    workanaDraftsExist: boolean;
  };
  sessions: {
    playwrightDataDir: boolean;
  };
  outreach: {
    total: number;
    sent: number;
    pending: number;
  };
};

function safeReadJSON<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return fallback; }
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function countNewer(apps: Application[], cutoff: Date): number {
  const c = cutoff.toISOString().slice(0, 10);
  return apps.filter((a) => a.appliedAt >= c).length;
}

function latestFileMtime(dir: string, ext = ".log"): string | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith(ext));
  if (files.length === 0) return null;
  let latest = 0;
  for (const f of files) {
    const m = statSync(join(dir, f)).mtimeMs;
    if (m > latest) latest = m;
  }
  return new Date(latest).toISOString();
}

function countTargetsFile(path: string): number {
  if (!existsSync(path)) return 0;
  try {
    const arr = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(arr) ? arr.length : 0;
  } catch { return 0; }
}

function countOutreachTargets(root: string): { total: number; sent: number } {
  const files = ["outreach/targets.md", "outreach/targets-v2.md", "outreach/targets-v3.md"]
    .map((f) => join(root, f))
    .filter(existsSync);
  let total = 0;
  for (const f of files) {
    const md = readFileSync(f, "utf8");
    total += (md.match(/^##\s+\d+\.\s+/gm) ?? []).length;
  }
  const apps = safeReadJSON<Application[]>(join(root, "data/applications.json"), []);
  const sent = apps.filter((a) => a.platform === "outreach-linkedin").length;
  return { total, sent };
}

function lastDigest(root: string): { at: string | null; count: number | null } {
  const dir = join(root, "data/digests");
  if (!existsSync(dir)) return { at: null, count: null };
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort().reverse();
  if (files.length === 0) return { at: null, count: null };
  const latest = files[0];
  const fp = join(dir, latest);
  const mtime = new Date(statSync(fp).mtimeMs).toISOString();
  const data = safeReadJSON<{ items?: unknown[] }>(fp, {});
  return { at: mtime, count: Array.isArray(data.items) ? data.items.length : null };
}

function plistInstalled(name: string): boolean {
  return existsSync(join(homedir(), "Library/LaunchAgents", name));
}

export function getStatus(root: string): Status {
  const apps = safeReadJSON<Application[]>(join(root, "data/applications.json"), []);
  const cut1 = daysAgo(1);
  const cut7 = daysAgo(7);

  const byStatus: Record<string, number> = {};
  for (const a of apps) byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;

  function chCount(prefix: string) {
    const matching = apps.filter((a) => a.platform.startsWith(prefix));
    return {
      sentTotal: matching.length,
      sent24h: matching.filter((a) => a.appliedAt >= cut1.toISOString().slice(0, 10)).length,
    };
  }

  const workanaProfile = (() => {
    // We can't programmatically know if Workana approved the profile (would
    // require login + parsing). Surface a heuristic message instead.
    if (!existsSync(join(root, ".playwright-data"))) return "no playwright session";
    return "session cached — check Workana directly for approval state";
  })();

  const digest = lastDigest(root);
  const outreach = countOutreachTargets(root);

  return {
    applications: {
      total: apps.length,
      last24h: countNewer(apps, cut1),
      last7d: countNewer(apps, cut7),
      byStatus,
    },
    channels: {
      email: chCount("auto:email"),
      web: chCount("auto:apply"),
      workana: { ...chCount("auto:workana"), profileNote: workanaProfile },
      linkedin: { sentTotal: apps.filter((a) => a.platform === "outreach-linkedin").length },
      hn: { sentTotal: apps.filter((a) => a.platform === "auto:hn-wants-hired").length },
    },
    scrapers: {
      lastDigestAt: digest.at,
      lastDigestCount: digest.count,
    },
    cron: {
      daily: {
        plistInstalled: plistInstalled("dev.jobs-pipeline.daily.plist"),
        lastRunAt: latestFileMtime(join(root, "data/daily-logs"), ".log"),
      },
      hnPoster: {
        plistInstalled: plistInstalled("dev.jobs-pipeline.hn-poster.plist"),
      },
    },
    pipelines: {
      spainTargetsExist: existsSync(join(root, "data/spain-targets.json")),
      spainTargetsCount: countTargetsFile(join(root, "data/spain-targets.json")),
      workanaDraftsExist: existsSync(join(root, "data/workana-drafts.md")),
    },
    sessions: {
      playwrightDataDir: existsSync(join(root, ".playwright-data")),
    },
    outreach: {
      total: outreach.total,
      sent: outreach.sent,
      pending: Math.max(0, outreach.total - outreach.sent),
    },
  };
}
