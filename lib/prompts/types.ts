// Versioned prompt registry — the agent's system prompts live in versioned
// files so the self-iteration loop can propose new versions safely without
// overwriting what's already working in production.

export type PromptKey =
  | "cover-letter-en"
  | "cover-letter-es"
  | "email-application-en"
  | "email-application-es"
  | "email-sprint-es"
  | "short-answer-en"
  | "short-answer-es";

export type PromptVersion = {
  key: PromptKey;
  version: string;          // semver-like: "1.0.0", "1.1.0"
  createdAt: string;        // ISO timestamp
  parentVersion: string | null;
  notes: string;            // what changed vs parent, why
  derivedFrom: {
    iterationId: string | null;     // ID of the prompt-iterate run that produced this version
    sampleSize: number | null;      // # of applications analyzed
    replyRate: number | null;       // observed reply rate on sample (0..1)
  };
  systemPrompt: string;
};
