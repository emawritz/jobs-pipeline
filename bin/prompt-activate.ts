// bin/prompt-activate.ts
//
// Sets the active version for a given prompt key. Writes to
// data/prompt-active.json. The registry reads this file at runtime.
//
// Usage:
//   npx tsx bin/prompt-activate.ts --key=cover-letter-en --version=1.1.0
//   npx tsx bin/prompt-activate.ts --key=cover-letter-en --version=1.0.0  # rollback

import { listVersions, setActiveVersion, getActivePrompt } from "../lib/prompts/registry.ts";
import type { PromptKey } from "../lib/prompts/types.ts";

function arg(flag: string): string | undefined {
  const m = process.argv.find((a) => a.startsWith(`${flag}=`));
  return m ? m.split("=")[1] : undefined;
}

async function main() {
  const key = arg("--key") as PromptKey | undefined;
  const version = arg("--version");

  if (!key) {
    console.error("missing --key. Available: cover-letter-en, cover-letter-es, email-application-en, email-application-es, email-sprint-es");
    process.exit(1);
  }

  if (!version) {
    // No version → just list available + current active.
    const active = await getActivePrompt(key);
    const versions = await listVersions(key);
    console.log(`Active for ${key}: ${active.version}`);
    console.log(`Available versions:`);
    for (const v of versions) {
      const marker = v.version === active.version ? " ← active" : "";
      console.log(`  ${v.version}  ${v.notes.slice(0, 70)}${marker}`);
    }
    return;
  }

  const versions = await listVersions(key);
  const exists = versions.find((v) => v.version === version);
  if (!exists) {
    console.error(`version ${version} not found for ${key}. Available: ${versions.map((v) => v.version).join(", ")}`);
    process.exit(2);
  }

  setActiveVersion(key, version);
  console.log(`✓ ${key} → ${version} activated`);
  console.log(`  ${exists.notes.slice(0, 200)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
