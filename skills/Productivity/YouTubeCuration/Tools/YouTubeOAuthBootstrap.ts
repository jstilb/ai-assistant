#!/usr/bin/env bun
/**
 * YouTubeOAuthBootstrap.ts — one-time interactive flow that grants Jm's
 * consent for the YouTube Data API playlist-write scope and persists a
 * long-lived refresh_token into ~/.claude/secrets.json.
 *
 * Why this exists: spec.md §4 — slices 5-6 (wl someday-adds, per-topic
 * playlists, dropped-topic cleanup) need playlist CRUD via the YouTube Data
 * API. An API key (YOUTUBE_API_KEY, already in secrets.json for
 * YouTubeEnrich) cannot write playlists — only an OAuth credential with a
 * playlist-write scope can. This is a SEPARATE consent from the DPA flow
 * (OAuthBootstrap.ts): different scope, different secrets keys, run whenever
 * Jm is ready — not gated on DPA's region-block (spec.md §9, skipped).
 *
 * Run:   bun Tools/YouTubeOAuthBootstrap.ts
 *
 * Flow (same shape as AppUsageTracker's OAuthBootstrap.ts, reused verbatim
 * where the two flows are actually the same code — see the cross-skill
 * imports below):
 *  1. Loads the Desktop OAuth client_id + client_secret from gcalcli's file
 *     (same Kaya Cloud project, kaya-484418, where DPA is enabled).
 *  2. Spins up a localhost server on a free port, builds the Google consent
 *     URL for YOUTUBE_SCOPES, opens it in the default browser.
 *  3. Jm reviews + grants. Google redirects to the callback with ?code=…
 *  4. Local handler captures the code, exchanges it for tokens.
 *  5. Merges {GOOGLE_YOUTUBE_REFRESH_TOKEN, GOOGLE_YOUTUBE_ACCESS_TOKEN,
 *     GOOGLE_YOUTUBE_ACCESS_TOKEN_EXPIRES_AT, GOOGLE_YOUTUBE_GRANTED_SCOPES}
 *     into ~/.claude/secrets.json without disturbing GOOGLE_DPA_* or any
 *     other key (mergeSecretsFile only ever sets the four keys named above).
 */

import { spawn } from "node:child_process";
import { logFailure } from "../../../../lib/core/FailureLog.ts";
// cross-skill-allowed: reuse AppUsageTracker's pure, HttpFetcher-injectable OAuth helpers instead of forking a second copy — this flow is functionally identical to OAuthBootstrap.ts's, differing only in scope list and secrets key names (see file header).
import { buildConsentUrl, exchangeCodeForTokens, mergeSecretsFile } from "../../AppUsageTracker/Tools/OAuthBootstrap.ts";
// cross-skill-allowed: loadGoogleOAuthClient reads the one Desktop OAuth client Kaya already has registered (gcalcli's file) for project kaya-484418 — the same client this flow authorizes a new scope against.
import { loadGoogleOAuthClient } from "../../AppUsageTracker/Tools/YouTubeDataPortability.ts";

const HOME = process.env.HOME ?? "/Users/[user]";
const SECRETS_PATH = `${HOME}/.claude/secrets.json`;

/**
 * The single scope needed for playlist CRUD (playlists.insert/delete,
 * playlistItems.insert/delete — spec.md §4/§7/§8). `playlists.insert`,
 * `playlists.delete`, and `playlistItems.insert` each accept BOTH
 * `.../auth/youtube` and `.../auth/youtube.force-ssl` per their own
 * "Authorization" scope tables (developers.google.com/youtube/v3/docs/
 * {playlists,playlistItems}/*, verified 2026-08-12) — functionally
 * equivalent for what this build needs. `youtube.force-ssl` is chosen over
 * plain `youtube` as the narrower of the two equally-sufficient options:
 * `youtube`'s consent-screen label is the broader "Manage your YouTube
 * account" grant used elsewhere for channel-level administration this
 * build never touches, while `.force-ssl` covers exactly playlist +
 * playlistItems + videos.list/search.list and nothing more.
 */
export const YOUTUBE_SCOPES = ["https://www.googleapis.com/auth/youtube.force-ssl"] as const;

function openBrowser(url: string): void {
  // macOS only — the only platform this Kaya install targets.
  const child = spawn("open", [url], { stdio: "ignore", detached: true });
  child.unref();
}

interface CallbackResult {
  code: string;
  state: string;
}

async function main(): Promise<void> {
  const { clientId, clientSecret } = loadGoogleOAuthClient();

  const state = crypto.randomUUID();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Bun: any = (globalThis as any).Bun;
  if (!Bun?.serve) throw new Error("Bun.serve unavailable — run with bun");

  let resolveCb: (r: CallbackResult) => void;
  let rejectCb: (e: Error) => void;
  const cbPromise = new Promise<CallbackResult>((resolve, reject) => { resolveCb = resolve; rejectCb = reject; });

  const server = Bun.serve({
    // The gcalcli OAuth client registered redirect_uri "http://localhost".
    // Google's loopback rules let any port through, but the hostname must
    // match the registered one — use `localhost`, not `127.0.0.1`.
    hostname: "localhost",
    port: 0,
    fetch(req: Request) {
      const u = new URL(req.url);
      if (u.pathname !== "/callback") return new Response("not found", { status: 404 });
      const code = u.searchParams.get("code");
      const st = u.searchParams.get("state");
      const err = u.searchParams.get("error");
      if (err) { rejectCb(new Error(`OAuth error: ${err}`)); return new Response(`OAuth error: ${err}`, { status: 400 }); }
      if (!code || !st) { rejectCb(new Error("missing code/state")); return new Response("missing", { status: 400 }); }
      if (st !== state) { rejectCb(new Error("state mismatch")); return new Response("state mismatch", { status: 400 }); }
      resolveCb({ code, state: st });
      return new Response(
        `<html><body style="font-family:system-ui;padding:2rem"><h2>Kaya YouTube playlist-write consent captured ✓</h2><p>You can close this tab. Token written to <code>~/.claude/secrets.json</code>.</p></body></html>`,
        { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });

  const port = server.port as number;
  const redirectUri = `http://localhost:${port}/callback`;
  // buildConsentUrl (reused from OAuthBootstrap.ts) never sets
  // include_granted_scopes — for DPA that omission is forced (Google 400s
  // "Incremental auth is not allowed" for DPA scopes). For this
  // youtube.force-ssl scope there's no such technical block: regular API
  // scopes DO support Google's incremental-auth combining. We still
  // deliberately leave it unset here: setting it true would fold this
  // grant's authorization into the SAME authorization record as the DPA
  // scopes already granted to this client, so a refresh token minted from
  // this flow could end up covering DPA scopes too — defeating the point of
  // giving this credential its own GOOGLE_YOUTUBE_* secrets keys, separately
  // revocable from GOOGLE_DPA_* (spec.md §4: "same Desktop client works for
  // non-DPA scopes in a separate consent"). Omitting it keeps this a
  // standalone grant containing exactly YOUTUBE_SCOPES.
  const consentUrl = buildConsentUrl({ clientId, redirectUri, scopes: YOUTUBE_SCOPES, state });

  console.log(`Loopback server listening on ${redirectUri}`);
  console.log(`Requesting scope: ${YOUTUBE_SCOPES.join(", ")}`);
  console.log(`Opening consent URL in browser…`);
  console.log(`If the browser doesn't open, copy this URL:\n  ${consentUrl}`);
  openBrowser(consentUrl);

  const timeoutMs = 10 * 60 * 1000;
  const timer = setTimeout(() => rejectCb(new Error(`OAuth callback timed out after ${timeoutMs}ms`)), timeoutMs);

  let cb: CallbackResult;
  try {
    cb = await cbPromise;
  } finally {
    clearTimeout(timer);
    server.stop(true);
  }

  console.log(`Exchange code for tokens…`);
  const tokens = await exchangeCodeForTokens({
    clientId,
    clientSecret,
    redirectUri,
    code: cb.code,
  });

  mergeSecretsFile(SECRETS_PATH, {
    GOOGLE_YOUTUBE_REFRESH_TOKEN: tokens.refresh_token,
    GOOGLE_YOUTUBE_ACCESS_TOKEN: tokens.access_token,
    GOOGLE_YOUTUBE_ACCESS_TOKEN_EXPIRES_AT: String(Math.floor(Date.now() / 1000) + tokens.expires_in),
    GOOGLE_YOUTUBE_GRANTED_SCOPES: tokens.scope ?? YOUTUBE_SCOPES.join(" "),
  });

  console.log(`Refresh token saved to ${SECRETS_PATH}`);
  console.log(`Granted scopes: ${tokens.scope ?? "(not reported by Google)"}`);
  console.log(`Done. Future /youtube playlist calls use getYouTubeAccessToken() from YouTubeAuth.ts.`);
}

if (import.meta.main) {
  main().catch(err => {
    logFailure("YouTubeOAuthBootstrap", err);
    console.error(`[YouTubeOAuthBootstrap] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
