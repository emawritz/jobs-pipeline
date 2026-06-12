// One-shot: send personalized emails to v3 high-priority candidates.
import { readFileSync, existsSync } from "node:fs";
import { emailApply, loadProfile } from "../lib/email-apply.ts";
import { loadAnswers } from "../lib/auto-apply.ts";
import { readJSON, writeJSON, today } from "../lib/storage.ts";

type Application = {
  id: string; url: string; platform: string; company?: string; title?: string;
  status: string; appliedAt: string; lastUpdate: string; notes: string[];
};

function genId() { return Math.random().toString(36).slice(2, 8); }

const TARGETS = [
  {
    email: "jack@emergences.ai",
    company: "Emergences Labs",
    role: "Founding Engineer (Tauri + Claude Code internals)",
    context: "We are building desktop AI software. Looking for someone with Claude Code internals understanding, Tauri/Rust desktop experience, and Python comfort. Small team, founding role. Reply with your background and a project link.",
  },
  {
    email: "jobs@toucantix.com",
    company: "ToucanTix",
    role: "Senior Full-Stack Engineer (Svelte + TypeScript + GraphQL)",
    context: "ToucanTix is a 2-engineer ticketing/events platform. Stack: SvelteKit, TypeScript, Node, GraphQL, Postgres. Remote-friendly. Looking for our 3rd engineer to own a product surface end-to-end.",
  },
  {
    email: "recruiting@stackable.tech",
    company: "Stackable.tech",
    role: "Senior Platform Engineer (Rust + Kubernetes operators)",
    context: "Stackable builds the open Data Platform for Kubernetes. Rust-heavy systems work, Kubernetes operators, data engineering primitives. Remote Europe-friendly.",
  },
];

async function main() {
  const ctx = loadProfile();
  const answers = loadAnswers();
  const apps = readJSON<Application[]>("data/applications.json", []);

  for (const t of TARGETS) {
    console.log(`\n→ ${t.company} (${t.email})`);
    try {
      const r = await emailApply({
        to: t.email,
        company: t.company,
        role: t.role,
        jobText: t.context,
        candidateCtx: ctx,
        resumePath: answers.resumeFile,
      });
      if (r.ok) {
        console.log(`  ✓ sent: "${r.subject}"`);
        apps.push({
          id: genId(),
          url: `mailto:${t.email}`,
          platform: "auto:email:v3",
          company: t.company,
          title: t.role,
          status: "applied",
          appliedAt: today(),
          lastUpdate: today(),
          notes: [`${today()}: v3 email sent — subject: ${r.subject}`],
        });
        writeJSON("data/applications.json", apps);
      } else {
        console.log(`  ✗ ${r.reason}`);
      }
    } catch (e) {
      console.error(`  ✗ ${(e as Error).message}`);
    }
    // Throttle between sends
    await new Promise((res) => setTimeout(res, 30000 + Math.random() * 60000));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
