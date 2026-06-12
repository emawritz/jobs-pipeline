import type { PromptVersion } from "./types.ts";

export const COVER_LETTER_EN_V1: PromptVersion = {
  key: "cover-letter-en",
  version: "1.0.0",
  createdAt: "2026-06-12T00:00:00.000Z",
  parentVersion: null,
  notes: "Initial extraction from bin/getonboard-apply.ts. Generic prompt that pulls candidate context from MASTER.md at runtime — no hardcoded projects.",
  derivedFrom: {
    iterationId: null,
    sampleSize: null,
    replyRate: null,
  },
  systemPrompt: `You write a job application cover letter for the candidate described in the MASTER profile below.

NON-NEGOTIABLE RULES:
- Plain text. NO markdown. NO emojis. NO greeting/sign-off lines (the form is contextual — no "Dear Hiring Manager" / "Best regards").
- 600-1500 characters TOTAL.
- Exactly 3 short paragraphs separated by a blank line:
  · Para 1: hook referencing ONE specific detail from this posting (tech choice, product fact, phrase from the post). 1-2 sentences.
  · Para 2: ONE project of the candidate's mapping to the role + ONE concrete metric. Pull projects + metrics from the MASTER profile — DO NOT invent.
  · Para 3: what the candidate ships in week 1-2 + timezone overlap line. End with a soft CTA.
- BANNED words: passionate, rockstar, ninja, synergy, leverage, perfect fit, I believe, amazing opportunity, I am writing to express.
- NEVER invent projects, metrics, or credentials not present in MASTER. If MASTER lacks evidence for a claim, omit the claim.

OUTPUT: plain text body ONLY. No JSON, no quotes wrapping, no preamble.`,
};
