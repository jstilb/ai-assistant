#!/usr/bin/env bun
/**
 * reauth-sheets.ts - One-time/re-auth OAuth2 flow for Google Sheets CLI
 *
 * WHY: TokenHealth.ts (S7/B3) points expired/expiring sheets-token.json
 * remediation here. The old pointer (configure-google-auth.sh) only wires
 * gcalcli/rclone/gog — it has no Sheets OAuth path at all, so following it
 * for a Sheets credential failure was a dead end. Same loopback flow as
 * lib/core/youtube-auth.ts (both use GoogleOAuth.runLoopbackConsent), but
 * requests the Sheets + Drive scopes that
 * skills/Development/UnixCLI/Tools/Sheets.ts actually calls (spreadsheets
 * read/write via Sheets API, list/duplicate/share via Drive API).
 *
 * Usage:
 *   bun ~/.claude/skills/Development/UnixCLI/Tools/reauth-sheets.ts
 *
 * Opens a browser for Google consent, then writes a fresh token to
 * ~/.config/google/sheets-token.json (overwriting any existing one — unlike
 * youtube-auth.ts, re-auth is the explicit point of running this script, so
 * an existing stale token must not block it).
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadGoogleOAuthClient, runLoopbackConsent, writeTokenFile } from "../../../../lib/core/GoogleOAuth.ts";

const CREDENTIALS_PATH = join(homedir(), ".config", "google", "credentials.json");
const TOKEN_PATH = join(homedir(), ".config", "google", "sheets-token.json");
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive"];
const REDIRECT_PORT = 3848; // distinct from youtube-auth.ts's 3847 so both can run independently

if (!existsSync(CREDENTIALS_PATH)) {
  console.error("Error: Google credentials not found at", CREDENTIALS_PATH);
  console.error("Download OAuth2 credentials from https://console.cloud.google.com/apis/credentials");
  console.error("(Desktop app type) and save them to", CREDENTIALS_PATH);
  process.exit(1);
}

let client: { clientId: string; clientSecret: string };
try {
  // Throws if client_id / client_secret is missing.
  client = loadGoogleOAuthClient(CREDENTIALS_PATH);
} catch (err) {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

console.log("\nOpening browser for Google Sheets authorization...\n");

try {
  const tokens = await runLoopbackConsent({
    ...client,
    scopes: SCOPES,
    port: REDIRECT_PORT,
    callbackPath: "", // redirect_uri http://localhost:3848, as before
    successHeading: "Google Sheets authorization successful!",
    successDetail: "You can return to the terminal.",
  });
  // Same token shape TokenHealth.ts/Sheets.ts expect, overwriting any
  // existing (possibly expired) sheets-token.json.
  writeTokenFile(TOKEN_PATH, tokens);
  console.log("Token saved to", TOKEN_PATH);
  console.log("Google Sheets OAuth re-auth complete!\n");
  process.exit(0);
} catch (err) {
  console.error(`Authorization failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
