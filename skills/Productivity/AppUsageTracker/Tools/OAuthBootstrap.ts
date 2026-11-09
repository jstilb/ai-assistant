#!/usr/bin/env bun
/**
 * OAuthBootstrap.ts — one-time interactive flow that grants Jm's consent for
 * the Data Portability scopes and persists a long-lived refresh_token into
 * ~/.claude/secrets.json.
 *
 * Run:   bun Tools/OAuthBootstrap.ts
 *        (or:  bun Tools/OAuthBootstrap.ts --duration=180)
 *
 * Flow:
 *  1. Loads the Desktop OAuth client_id + client_secret from gcalcli's file at
 *     ~/.local/share/gcalcli/oauth/client_secret.json (same Kaya Cloud project
 *     where DPA is enabled).
 *  2. Spins up a localhost server on a free port. Builds the Google consent
 *     URL with redirect_uri = http://localhost:<port>/callback (matches the
 *     registered redirect URI on that OAuth client). Opens it in default browser.
 *  3. Jm reviews + grants. Google redirects to the callback with ?code=…
 *  4. Local handler captures the code, POSTs to /token, gets refresh_token.
 *  5. Merges {GOOGLE_DPA_REFRESH_TOKEN, GOOGLE_DPA_ACCESS_TOKEN, expires_at,
 *     granted_scopes} into ~/.claude/secrets.json without disturbing other keys.
 *
 * Time-based access: Google's consent screen shows "Share for 7 days / 30 days
 * / 180 days" radio buttons (Desktop apps in testing-mode cap at 7d). The
 * duration is selected by Jm in the browser — we don't request it via param.
 */

import { loadGoogleOAuthClient, runLoopbackConsent } from "../../../../lib/core/GoogleOAuth.ts";
import { secretsFilePath, updateSecrets } from "../../../../lib/core/Secrets.ts";
import { logFailure } from "./Db.ts";

// The default scopes we want consent for. Chrome history is included so we
// can resolve the phone-Chrome blind spot from
// memory/project_chrome_sync_absence.md.
export const DEFAULT_SCOPES = [
  "https://www.googleapis.com/auth/dataportability.myactivity.youtube",
  "https://www.googleapis.com/auth/dataportability.chrome.history",
] as const;

// ────────────────────────────────────────────────────────────────────────
// Pure helpers (testable)
// ────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────
// CLI entry
// ────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Reuse the same Desktop OAuth client gcalcli already registered for the
  // Kaya Cloud project. Project id: kaya-484418. DPA scopes must be enabled
  // on that project's OAuth consent screen.
  const { clientId, clientSecret } = loadGoogleOAuthClient();

  const tokens = await runLoopbackConsent({
    clientId,
    clientSecret,
    scopes: DEFAULT_SCOPES,
    successHeading: "Kaya OAuth grant captured",
  });

  updateSecrets((doc) => ({
    ...doc,
    GOOGLE_DPA_REFRESH_TOKEN: tokens.refresh_token,
    GOOGLE_DPA_ACCESS_TOKEN: tokens.access_token,
    GOOGLE_DPA_ACCESS_TOKEN_EXPIRES_AT: String(Math.floor(Date.now() / 1000) + tokens.expires_in),
    GOOGLE_DPA_GRANTED_SCOPES: tokens.scope ?? DEFAULT_SCOPES.join(" "),
  }));

  console.log(`Refresh token saved to ${secretsFilePath()}`);
  console.log(`Granted scopes: ${tokens.scope ?? "(not reported by Google)"}`);
  console.log(`Done. You can now run: bun Tools/YouTubeDataPortability.ts`);
}

if (import.meta.main) {
  main().catch(async (err) => {
    await logFailure("OAuthBootstrap", err);
    console.error(`[OAuthBootstrap] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
