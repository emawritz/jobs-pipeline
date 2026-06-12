import { readFileSync, existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { callText, DRAFT_MODEL } from "../lib/claude.ts";
import { readJSON, writeText, today } from "../lib/storage.ts";

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

const PATH = "data/applications.json";

function daysSince(iso: string) {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

function dueWindow(days: number): "day-4" | "day-10" | "day-17+" | null {
  if (days === 4) return "day-4";
  if (days === 10) return "day-10";
  if (days >= 17 && days % 7 === 3) return "day-17+";
  return null;
}

const TONE: Record<string, string> = {
  "day-4": "Light check-in. Acknowledge they're busy. Add ONE specific piece of value (a relevant link, a thought on something they shipped). Max 50 words.",
  "day-10": "Slightly firmer. Surface a new datapoint that's relevant — a recent ship of theirs, a related hire they made, a market move. Re-anchor on the role's specific gap. Max 60 words.",
  "day-17+": "Final touch. Make it easy for them to say 'not now' without burning the bridge. Offer to circle back in 3 months or to send something concrete if useful. Max 50 words.",
};

const SYSTEM_BASE = `You draft followup messages to a cold application or outreach that went silent.

- Use projects + metrics from the MASTER.md profile. Do NOT invent any.

NON-NEGOTIABLE RULES:
- BANNED: "just following up", "circling back", "wanted to bump this", "passionate", "synergy", "rockstar", "exciting opportunity".
- DO NOT restate the candidate's whole pitch — assume they read the first message. Reference it briefly if at all.
- The followup MUST add something new — a value-add, a specific update, a new angle. If you cannot, write "no followup justified" and nothing else.
- Tone: peer-to-peer. No apologies for following up. No "sorry to bother."
- Output: message body only. No greeting line. No signature.`;

function findContextDraft(app: Application): string | null {
  const dir = "data/drafts";
  if (!existsSync(dir)) return null;
  // Try to find a draft whose filename hash matches the application URL
  const slug = app.url.toLowerCase().replace(/https?:\/\//, "").replace(/[^a-z0-9]+/g, "-").slice(0, 60);
  const matching = readdirSync(dir).find((f) => f.includes(slug.slice(0, 30)));
  if (matching) return readFileSync(`${dir}/${matching}`, "utf8");
  return null;
}

function pbcopy(text: string) {
  spawnSync("pbcopy", [], { input: text });
}

async function generateOne(app: Application, window: "day-4" | "day-10" | "day-17+"): Promise<string> {
  const draft = findContextDraft(app);
  const ctxParts: string[] = [];
  if (existsSync("CLAUDE.md")) ctxParts.push(`=== CLAUDE.md ===\n${readFileSync("CLAUDE.md", "utf8")}`);

  const user = `CANDIDATE CONTEXT:
${ctxParts.join("\n\n")}

APPLICATION:
- Company: ${app.company ?? "?"}
- Role: ${app.title ?? "?"}
- Platform: ${app.platform}
- URL: ${app.url}
- Applied: ${app.appliedAt} (${daysSince(app.appliedAt)} days ago)
- Last contact: ${app.lastUpdate}
${draft ? `\nORIGINAL MESSAGE SENT:\n${draft}` : "(no original message stored)"}

WINDOW: ${window}
TONE FOR THIS WINDOW: ${TONE[window]}

Draft the followup now.`;

  return await callText(user, { system: SYSTEM_BASE, model: DRAFT_MODEL });
}

async function main() {
  const args = process.argv.slice(2);
  const draftMode = args.includes("--draft");
  const allMode = args.includes("--all");
  const copyMode = args.includes("--copy"); // copy first one to clipboard

  const apps = readJSON<Application[]>(PATH, []);
  if (apps.length === 0) {
    console.log("no applications tracked yet.");
    return;
  }

  const due = apps
    .filter((a) => a.status === "applied" || a.status === "replied")
    .map((a) => ({ app: a, days: daysSince(a.lastUpdate), window: dueWindow(daysSince(a.lastUpdate)) }))
    .filter((x) => (allMode ? x.days >= 4 : x.window !== null));

  if (due.length === 0) {
    console.log("nothing due today. (use --all to include any app with d+4 or more)");
    return;
  }

  console.log(`${due.length} followup${due.length === 1 ? "" : "s"} due:\n`);
  for (const { app, days, window } of due) {
    console.log(`  ${app.id}  d+${days}  ${app.company ?? "?"} — ${app.title ?? "?"} — ${app.platform}`);
  }

  if (!draftMode) {
    console.log(`\npass --draft to generate followup messages with Claude.`);
    return;
  }

  console.log(`\ndrafting...\n`);
  for (const { app, days, window } of due) {
    const w = (window ?? "day-17+") as "day-4" | "day-10" | "day-17+";
    try {
      const msg = await generateOne(app, w);
      const path = `data/drafts/followup-${app.id}-d${days}.md`;
      writeText(path, `<!-- followup for ${app.company ?? "?"} · ${app.title ?? "?"} · d+${days} -->\n\n${msg}\n`);
      console.log(`\n=== ${app.company ?? "?"} (d+${days}) → ${path} ===\n${msg}\n`);
      if (copyMode && app === due[0].app) {
        pbcopy(msg);
        console.log(`(copied first to clipboard)`);
      }
    } catch (e) {
      console.error(`${app.id} FAIL:`, (e as Error).message);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
