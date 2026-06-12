// Loads .env into process.env if the file exists. No external deps.
// Imported as a side-effect at the top of any module that reads process.env
// (lib/claude.ts, lib/captcha.ts).
//
// Semantics: existing process.env vars win over .env values (matches dotenv
// default behavior). Lines starting with # are comments. Quoted values get
// the surrounding quotes stripped.

import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = join(PROJECT_ROOT, ".env");

if (existsSync(ENV_PATH)) {
  const content = readFileSync(ENV_PATH, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    // Don't clobber values already exported by the shell.
    if (!(key in process.env)) {
      process.env[key] = val;
    }
  }
}
