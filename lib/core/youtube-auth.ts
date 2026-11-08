#!/usr/bin/env bun
/**
 * youtube-auth.ts - One-time OAuth2 flow for YouTube Data API
 *
 * Usage:
 *   bun ~/.claude/lib/core/youtube-auth.ts
 *
 * Opens browser for Google consent, saves refresh token to
 * ~/.config/google/youtube-token.json
 *
 * The loopback consent + token exchange is GoogleOAuth.runLoopbackConsent
 * (shared with UnixCLI's reauth-sheets.ts).
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadGoogleOAuthClient, runLoopbackConsent, writeTokenFile } from "./GoogleOAuth.ts";

const CREDENTIALS_PATH = join(homedir(), ".config", "google", "credentials.json");
const TOKEN_PATH = join(homedir(), ".config", "google", "youtube-token.json");
const SCOPES = ["https://www.googleapis.com/auth/youtube.readonly"];
const REDIRECT_PORT = 3847;

if (!existsSync(CREDENTIALS_PATH)) {
  console.error("Error: Google credentials not found at", CREDENTIALS_PATH);
  process.exit(1);
}

if (existsSync(TOKEN_PATH)) {
  console.log("YouTube token already exists at", TOKEN_PATH);
  console.log("Delete it first if you want to re-authenticate.");
  process.exit(0);
}

const { clientId, clientSecret } = loadGoogleOAuthClient(CREDENTIALS_PATH);

console.log("\nOpening browser for Google authorization...\n");

try {
  const tokens = await runLoopbackConsent({
    clientId,
    clientSecret,
    scopes: SCOPES,
    port: REDIRECT_PORT,
    callbackPath: "", // redirect_uri http://localhost:3847, as registered
    successHeading: "YouTube authorization successful!",
    successDetail: "You can return to the terminal.",
  });
  writeTokenFile(TOKEN_PATH, tokens);
  console.log("Token saved to", TOKEN_PATH);
  console.log("YouTube OAuth setup complete!\n");
  process.exit(0);
} catch (err) {
  console.error(`Authorization failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
