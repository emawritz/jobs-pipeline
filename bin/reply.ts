import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { callText, DRAFT_MODEL } from "../lib/claude.ts";
import { readJSON, writeJSON, writeText, today } from "../lib/storage.ts";

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

const SYSTEM = `You draft replies on behalf of the candidate (full profile in MASTER).

- Use projects + metrics from the MASTER.md profile. Do NOT invent any.

NON-NEGOTIABLE RULES:
- Match the tone of the incoming reply. If they were casual, be casual. If formal, be formal.
- BANNED: "thanks for reaching out", "appreciate your message", "passionate", "exciting opportunity", "look forward to hearing", "let me know if".
- Be specific about what's next. Suggest a concrete time window OR confirm a specific time they offered.
- If they ask a question, answer it directly. If they ask for code samples or portfolio, point to: app.example.com, github.com/YOUR_USERNAME/share-sharvis, github.com/YOUR_USERNAME/sesion.
- If they ask about rates, quote: contract USD 80-100/hr (floor 60), full-time USD 90-140k. Don't apologize for rate.
- If they ask about timezone, say "Buenos Aires GMT-3, 9am-7pm US Eastern overlap, can shift earlier if needed."
- If they ask about availability, say "available immediately full-time, 40+ hrs/week."
- If they say "we passed", reply graceful: thank them, leave door open ("if priorities shift in the next 3 months, happy to re-engage"), max 25 words.
- Length: match what they wrote. Short for short. Cap at 150 words regardless.

Output: reply body only. No greeting line if they didn't open with one. No signature.`;

function pbcopy(text: string) {
  spawnSync("pbcopy", [], { input: text });
}

function pbpaste(): string {
  const r = spawnSync("pbpaste", [], { encoding: "utf8" });
  return r.stdout ?? "";
}

function loadCV(): string {
  const parts: string[] = [];
  if (existsSync("CLAUDE.md")) parts.push(`=== CLAUDE.md ===\n${readFileSync("CLAUDE.md", "utf8")}`);
  return parts.join("\n\n");
}

async function main() {
  const args = process.argv.slice(2);
  const id = args.find((a) => !a.startsWith("--"));
  const fromClipboard = args.includes("--from-clipboard");
  const noCopy = args.includes("--no-copy");

  if (!id) {
    console.error(`usage: tsx bin/reply.ts <application-id> [--from-clipboard] [--no-copy]
  --from-clipboard   read the incoming reply text from pbpaste instead of stdin
  --no-copy          don't copy the draft back to clipboard

without --from-clipboard, paste the incoming reply on stdin then Ctrl+D.`);
    process.exit(1);
  }

  const apps = readJSON<Application[]>(PATH, []);
  const app = apps.find((a) => a.id === id);
  if (!app) {
    console.error(`no application with id ${id}`);
    process.exit(1);
  }

  let incoming = "";
  if (fromClipboard) {
    incoming = pbpaste();
    if (!incoming.trim()) {
      console.error("clipboard is empty");
      process.exit(1);
    }
  } else {
    console.error("paste the incoming reply, then Ctrl+D:");
    incoming = readFileSync(0, "utf8");
  }
  if (!incoming.trim()) {
    console.error("no input");
    process.exit(1);
  }

  const ctx = loadCV();
  const user = `CANDIDATE CONTEXT:
${ctx}

APPLICATION CONTEXT:
- Company: ${app.company ?? "?"}
- Role: ${app.title ?? "?"}
- Platform: ${app.platform}
- URL: ${app.url}
- Applied: ${app.appliedAt}
- Current status: ${app.status}

INCOMING MESSAGE FROM THEM (this is what we are replying to):
"""
${incoming.trim()}
"""

Draft the candidate's reply now. Match their tone and length.`;

  const reply = await callText(user, { system: SYSTEM, model: DRAFT_MODEL });
  const path = `data/drafts/reply-${app.id}-${today()}.md`;
  writeText(
    path,
    `<!-- reply to: ${app.company ?? "?"} · ${app.title ?? "?"} -->\n<!-- incoming: ${incoming.slice(0, 200).replace(/\n/g, " ")} -->\n\n${reply}\n`,
  );

  console.log("\n" + reply + "\n");
  console.log(`saved → ${path}`);

  // Auto-bump status to 'replied' if currently 'applied'
  if (app.status === "applied") {
    app.status = "replied";
    app.lastUpdate = today();
    app.notes.push(`${today()}: replied to incoming message`);
    writeJSON(PATH, apps);
    console.log(`status: applied → replied`);
  }

  if (!noCopy) {
    pbcopy(reply);
    console.log(`(copied to clipboard)`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
