// One-time OAuth setup for Gmail. Opens browser, asks for auth code, saves
// refresh token. Run once: `npm run gmail-auth`.

import { google } from "googleapis";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { loadCredentials, GMAIL_SCOPES, saveToken } from "../lib/gmail-reader.ts";

async function main() {
  const creds = loadCredentials();
  if (!creds) {
    console.error("✗ falta data/gmail/credentials.json");
    console.error("  → seguí los pasos de data/gmail/SETUP.md");
    process.exit(1);
  }
  const c = creds.installed ?? creds.web;
  if (!c) {
    console.error("✗ credentials.json no tiene la sección 'installed' o 'web'");
    process.exit(1);
  }

  const oauth = new google.auth.OAuth2(c.client_id, c.client_secret, c.redirect_uris[0]);
  const authUrl = oauth.generateAuthUrl({
    access_type: "offline",
    scope: GMAIL_SCOPES,
    prompt: "consent",
  });

  console.log(`\n══════════════════════════════════════════════════════════════════`);
  console.log(`  Abriendo el navegador para autorizar Gmail.`);
  console.log(`  Si no se abre solo, copiá este link:`);
  console.log(`\n  ${authUrl}\n`);
  console.log(`══════════════════════════════════════════════════════════════════\n`);

  spawnSync("open", [authUrl]);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const code = (await rl.question("Pegá acá el código que te dio Google: ")).trim();
  rl.close();

  if (!code) {
    console.error("✗ código vacío, abortando");
    process.exit(1);
  }

  const { tokens } = await oauth.getToken(code);
  if (!tokens.refresh_token) {
    console.error("✗ Google no devolvió refresh_token. Revocá acceso en");
    console.error("  https://myaccount.google.com/permissions y volvé a correr.");
    process.exit(1);
  }
  saveToken(tokens);
  console.log("\n✓ token guardado en data/gmail/token.json");
  console.log("  Ahora corré: npm run gmail-poll  para verificar que lea inbox.\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
