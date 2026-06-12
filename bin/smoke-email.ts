import { readFileSync } from "node:fs";
import { draftEmail } from "../lib/email-apply.ts";

const ctx = readFileSync("CLAUDE.md", "utf8");
const d = await draftEmail({
  company: "Orenva",
  role: "Founding engineer",
  jobText:
    "Orenva | AI Agentic Founding Engineer | REMOTE | LATAM ok. We are building agentic systems for legal/compliance workflows using Claude + TypeScript + Postgres. Looking for a founding engineer who has shipped solo. Send a brief intro + a project link to dani@pm.me.",
  candidateCtx: ctx,
  toEmail: "dani@pm.me",
});
console.log("SUBJECT:", d.subject);
console.log("---BODY---");
console.log(d.body);
