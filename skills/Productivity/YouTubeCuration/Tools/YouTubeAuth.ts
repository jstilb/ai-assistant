#!/usr/bin/env bun
/**
 * YouTubeAuth.ts — access-token helper for YouTube Data API playlist calls.
 *
 * Slices 5-6 (wl someday-adds, per-topic playlists, dropped-topic cleanup —
 * spec.md §7/§8) import `getYouTubeAccessToken()` to authenticate playlist
 * and playlistItem writes. This does NOT run the interactive
 * consent flow — that's YouTubeOAuthBootstrap.ts, a one-time Jm-in-the-
 * browser CONSENT-class action. This helper only refreshes an
 * already-granted credential and fails loud (pointing at the bootstrap CLI)
 * when there's nothing to refresh.
 *
 * Caching: an access token is valid ~1h (`expires_in` from Google). We cache
 * it + its expiry into secrets.json (GOOGLE_YOUTUBE_ACCESS_TOKEN /
 * _EXPIRES_AT) so repeated calls within that window skip the network round
 * trip entirely — mirrors YouTubeDataPortability.ts's refreshAccessToken,
 * except that one refreshes unconditionally on every call (its caller,
 * pullDPAArchive, runs at most a few times a day) where playlist calls in a
 * single steer/wl pass can number in the dozens (spec.md §7: ≤10 adds ×
 * several topics), so unconditional refresh would be wasteful and would
 * needlessly rewrite secrets.json on every call.
 */

import { existsSync, readFileSync } from "node:fs";
// cross-skill-allowed: reuse AppUsageTracker's pure, HttpFetcher-injectable mergeSecretsFile rather than forking a second copy of the same read-json/spread-merge/write-json logic.
import { mergeSecretsFile } from "../../AppUsageTracker/Tools/OAuthBootstrap.ts";
// cross-skill-allowed: loadGoogleOAuthClient reads the one Desktop OAuth client Kaya already has registered (gcalcli's file) for project kaya-484418 — the same client YouTubeOAuthBootstrap.ts authorized.
import { loadGoogleOAuthClient } from "../../AppUsageTracker/Tools/YouTubeDataPortability.ts";

const HOME = process.env.HOME ?? "/Users/[user]";
const DEFAULT_SECRETS_PATH = `${HOME}/.claude/secrets.json`;
const TOKEN_URL = "https://oauth2.googleapis.com/token";

// Refresh this many seconds before the cached token's actual expiry, so a
// token that's technically still valid but about to expire mid-batch
// doesn't get used for a request that fails partway through.
const EXPIRY_SKEW_SEC = 60;

export interface HttpRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type HttpFetcher = (req: HttpRequest) => Promise<HttpResponse>;

const defaultHttp: HttpFetcher = async (req) => {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.method === "GET" ? undefined : req.body,
  });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => { headers[k] = v; });
  return { status: res.status, headers, body: await res.text() };
};

export interface GetAccessTokenOptions {
  /** Defaults to ~/.claude/secrets.json; override in tests with an mkdtemp path. */
  secretsPath?: string;
  /** Defaults to the gcalcli client_secret.json path (loadGoogleOAuthClient's own default). */
  clientPath?: string;
  http?: HttpFetcher;
  /** Defaults to Date.now(). Inject for deterministic expiry tests. */
  now?: () => number;
}

const RECONSENT_POINTER =
  "run `bun skills/Productivity/YouTubeCuration/Tools/YouTubeOAuthBootstrap.ts` to (re-)grant playlist-write consent";

interface StoredSecrets {
  GOOGLE_YOUTUBE_REFRESH_TOKEN?: unknown;
  GOOGLE_YOUTUBE_ACCESS_TOKEN?: unknown;
  GOOGLE_YOUTUBE_ACCESS_TOKEN_EXPIRES_AT?: unknown;
}

function readSecrets(path: string): StoredSecrets {
  if (!existsSync(path)) {
    throw new Error(`secrets file missing at ${path} — no YouTube playlist-write consent has ever been granted; ${RECONSENT_POINTER}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`secrets file at ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`secrets file at ${path} did not parse to an object`);
  }
  return parsed as StoredSecrets;
}

interface RefreshTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

/**
 * Returns a live YouTube Data API access token, refreshing from the stored
 * refresh_token when the cached access token is missing or within
 * EXPIRY_SKEW_SEC of expiring. Fails loud — never silently falls back to an
 * expired/absent token — when:
 *   - no refresh token has ever been granted (consent never run), or
 *   - the refresh call itself fails (commonly a revoked grant — Google
 *     returns invalid_grant).
 * Both cases point the caller at YouTubeOAuthBootstrap.ts to re-consent.
 */
export async function getYouTubeAccessToken(opts: GetAccessTokenOptions = {}): Promise<string> {
  const secretsPath = opts.secretsPath ?? DEFAULT_SECRETS_PATH;
  const http = opts.http ?? defaultHttp;
  const now = opts.now ?? (() => Date.now());
  const nowSec = Math.floor(now() / 1000);

  const secrets = readSecrets(secretsPath);
  const refreshToken = secrets.GOOGLE_YOUTUBE_REFRESH_TOKEN;
  if (typeof refreshToken !== "string" || !refreshToken) {
    throw new Error(`GOOGLE_YOUTUBE_REFRESH_TOKEN missing from ${secretsPath} — ${RECONSENT_POINTER}`);
  }

  const cachedToken = secrets.GOOGLE_YOUTUBE_ACCESS_TOKEN;
  const cachedExpiresAt = Number(secrets.GOOGLE_YOUTUBE_ACCESS_TOKEN_EXPIRES_AT ?? 0);
  if (typeof cachedToken === "string" && cachedToken && cachedExpiresAt - EXPIRY_SKEW_SEC > nowSec) {
    return cachedToken;
  }

  const { clientId, clientSecret } = loadGoogleOAuthClient(opts.clientPath);
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  }).toString();
  const res = await http({
    url: TOKEN_URL,
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (res.status !== 200) {
    const revokedHint = res.body.includes("invalid_grant") ? " (invalid_grant — the grant was likely revoked)" : "";
    throw new Error(`YouTube access-token refresh failed: HTTP ${res.status}${revokedHint} — ${res.body.slice(0, 300)}; ${RECONSENT_POINTER}`);
  }
  const parsed = JSON.parse(res.body) as Partial<RefreshTokenResponse>;
  if (!parsed.access_token || typeof parsed.expires_in !== "number") {
    throw new Error(`YouTube access-token refresh: malformed response — ${res.body.slice(0, 300)}; ${RECONSENT_POINTER}`);
  }

  mergeSecretsFile(secretsPath, {
    GOOGLE_YOUTUBE_ACCESS_TOKEN: parsed.access_token,
    GOOGLE_YOUTUBE_ACCESS_TOKEN_EXPIRES_AT: String(nowSec + parsed.expires_in),
  });

  return parsed.access_token;
}
