import { readJSON, writeJSON, today } from "../lib/storage.ts";

type Status = "applied" | "replied" | "interviewing" | "offer" | "rejected" | "ghosted";

type Application = {
  id: string;
  url: string;
  platform: string;
  company?: string;
  title?: string;
  status: Status;
  appliedAt: string;
  lastUpdate: string;
  notes: string[];
};

const PATH = "data/applications.json";

function load(): Application[] {
  return readJSON<Application[]>(PATH, []);
}

function save(apps: Application[]) {
  writeJSON(PATH, apps);
}

function genId(): string {
  return Math.random().toString(36).slice(2, 8);
}

function daysSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

function cmdAdd(url: string, platform: string, extra: Record<string, string>) {
  const apps = load();
  const app: Application = {
    id: genId(),
    url,
    platform,
    company: extra.company,
    title: extra.title,
    status: "applied",
    appliedAt: today(),
    lastUpdate: today(),
    notes: [],
  };
  apps.push(app);
  save(apps);
  console.log(`+ ${app.id}  ${platform}  ${url}`);
}

function cmdStatus() {
  const apps = load();
  const buckets: Record<Status, Application[]> = {
    applied: [],
    replied: [],
    interviewing: [],
    offer: [],
    rejected: [],
    ghosted: [],
  };
  for (const a of apps) buckets[a.status].push(a);
  for (const s of Object.keys(buckets) as Status[]) {
    if (buckets[s].length === 0) continue;
    console.log(`\n== ${s.toUpperCase()} (${buckets[s].length}) ==`);
    for (const a of buckets[s]) {
      console.log(`  ${a.id}  ${a.platform.padEnd(12)}  ${a.company ?? "?"}  —  ${a.title ?? "?"}  (d+${daysSince(a.appliedAt)})`);
    }
  }
  console.log(`\nTotal: ${apps.length}`);
}

function cmdFollowups() {
  const apps = load();
  const due: Application[] = [];
  for (const a of apps) {
    if (a.status !== "applied" && a.status !== "replied") continue;
    const d = daysSince(a.lastUpdate);
    if (d === 4 || d === 10 || (d > 10 && d % 7 === 0)) due.push(a);
  }
  if (due.length === 0) {
    console.log("nothing due today.");
    return;
  }
  console.log(`FOLLOWUPS DUE (${due.length}):\n`);
  for (const a of due) {
    console.log(`  ${a.id}  d+${daysSince(a.lastUpdate)}  ${a.platform}  ${a.company ?? "?"}  ${a.url}`);
  }
}

function cmdUpdate(id: string, status: string, note?: string) {
  const apps = load();
  const a = apps.find((x) => x.id === id);
  if (!a) {
    console.error(`no app with id ${id}`);
    process.exit(1);
  }
  a.status = status as Status;
  a.lastUpdate = today();
  if (note) a.notes.push(`${today()}: ${note}`);
  save(apps);
  console.log(`updated ${id} -> ${status}`);
}

function usage() {
  console.log(`tracker — applications CRM

usage:
  tracker add <url> <platform> [--company X] [--title Y]
  tracker status
  tracker followups
  tracker update <id> <status> [note...]

statuses: applied | replied | interviewing | offer | rejected | ghosted`);
}

function parseFlags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      out[args[i].slice(2)] = args[i + 1] ?? "";
      i++;
    }
  }
  return out;
}

const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case "add": {
    const [url, platform, ...flagArgs] = rest;
    if (!url || !platform) {
      usage();
      process.exit(1);
    }
    cmdAdd(url, platform, parseFlags(flagArgs));
    break;
  }
  case "status":
    cmdStatus();
    break;
  case "followups":
    cmdFollowups();
    break;
  case "update": {
    const [id, status, ...noteParts] = rest;
    if (!id || !status) {
      usage();
      process.exit(1);
    }
    cmdUpdate(id, status, noteParts.join(" ") || undefined);
    break;
  }
  default:
    usage();
}
