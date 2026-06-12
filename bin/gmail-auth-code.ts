// Headless OAuth exchange — takes the `code` returned by Google after the
// user approves in the browser, exchanges it for a token, saves to disk.
// Used by the dashboard's autonomous setup flow (instead of bin/gmail-auth.ts
// which is interactive).
//
// Usage: npx tsx bin/gmail-auth-code.ts <CODE>

import { google } from "googleapis";
import { loadCredentials, saveToken } from "../lib/gmail-reader.ts";

async function main() {
  const code = process.argv[2];
  if (!code) {
    console.error("uso: npx tsx bin/gmail-auth-code.ts <CODE>");
    process.exit(1);
  }
  const creds = loadCredentials();
  if (!creds) {
    console.error("falta data/gmail/credentials.json");
    process.exit(1);
  }
  const c = creds.installed ?? creds.web;
  if (!c) {
    console.error("credentials.json mal formado");
    process.exit(1);
  }
  const oauth = new google.auth.OAuth2(c.client_id, c.client_secret, c.redirect_uris[0]);
  const { tokens } = await oauth.getToken(code);
  if (!tokens.refresh_token) {
    console.error("✗ Google no devolvió refresh_token. Revocá en https://myaccount.google.com/permissions y reintentá.");
    process.exit(1);
  }
  saveToken(tokens);
  console.log("✓ token guardado en data/gmail/token.json");
  console.log(`  expires_in: ${tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : "?"}`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
