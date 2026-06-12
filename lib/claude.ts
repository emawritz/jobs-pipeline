import "./env.ts"; // side-effect: load .env into process.env
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

// We shell out to the Claude Code CLI instead of the Anthropic SDK so the user's
// existing Claude Code subscription covers the cost ($0 marginal).
//
// Flags chosen to keep each call clean and fast:
//   --no-session-persistence  → don't pollute /resume history with thousands of scoring calls
//   --tools ""                → disable all tools (we only need text generation)
//   --disable-slash-commands  → skip skill resolution
//   --model <alias>           → "haiku" or "sonnet" alias
//   --output-format text      → plain stdout, no JSON envelope
//   --system-prompt <prompt>  → fully override the system prompt
//
// We run from tmpdir() so the project's CLAUDE.md is not auto-discovered and
// re-injected as system prompt on top of ours.

export const SCORE_MODEL = "haiku";
export const DRAFT_MODEL = "sonnet";

type CallOpts = {
  system?: string;
  model?: string;
  timeoutMs?: number;
};

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";

export function callText(user: string, opts: CallOpts = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      "-p",
      "--no-session-persistence",
      "--tools",
      "",
      "--disable-slash-commands",
      "--output-format",
      "text",
      "--model",
      opts.model ?? SCORE_MODEL,
    ];
    if (opts.system) args.push("--system-prompt", opts.system);
    args.push(user);

    const proc = spawn(CLAUDE_BIN, args, {
      cwd: tmpdir(),
      env: { ...process.env, CLAUDE_CODE_NO_HOOKS: "1" },
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`claude CLI timeout after ${opts.timeoutMs ?? 90000}ms`));
    }, opts.timeoutMs ?? 90000);

    proc.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`claude CLI exited ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

export async function callJSON<T>(user: string, opts: CallOpts = {}): Promise<T> {
  const raw = await callText(user, opts);
  // Strip code fences anywhere in the body
  const cleaned = raw.replace(/```(?:json)?\s*\n?/gi, "").replace(/```/g, "");
  // Walk braces to extract the first complete JSON object instead of greedy regex
  const start = cleaned.indexOf("{");
  if (start < 0) throw new Error(`No JSON object in response: ${raw.slice(0, 200)}`);
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (escape) { escape = false; continue; }
    if (c === "\\") { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        return JSON.parse(cleaned.slice(start, i + 1)) as T;
      }
    }
  }
  throw new Error(`Unbalanced JSON in response: ${raw.slice(0, 200)}`);
}
