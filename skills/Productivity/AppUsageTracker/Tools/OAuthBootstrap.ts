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

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { logFailure } from "./Db.ts";

const HOME = process.env.HOME ?? "/Users/[user]";
const SECRETS_PATH = `${HOME}/.claude/secrets.json`;

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

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

export interface ConsentParams {
  clientId: string;
  redirectUri: string;
  scopes: readonly string[] | string[];
  state: string;
}

export function buildConsentUrl(p: ConsentParams): string {
  const url = new URL(AUTH_URL);
  url.searchParams.set("client_id", p.clientId);
  url.searchParams.set("redirect_uri", p.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", p.scopes.join(" "));
  url.searchParams.set("access_type", "offline");
  // prompt=consent forces re-display of the consent screen, which ensures the
  // response includes a refresh_token even if the user has previously
  // granted scopes for this client.
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", p.state);
  // Deliberately NOT setting include_granted_scopes: Google rejects the
  // consent request with "Incremental auth is not allowed for the requested
  // scopes" / 400 invalid_request when DPA scopes are combined with
  // include_granted_scopes=true. DPA requires fresh standalone authorization.
  return url.toString();
}

export interface ExchangeParams {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
}

export interface TokenExchangeResult {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope?: string;
}

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

export async function exchangeCodeForTokens(
  p: ExchangeParams,
  http: HttpFetcher = defaultHttp,
): Promise<TokenExchangeResult> {
  const body = new URLSearchParams({
    code: p.code,
    client_id: p.clientId,
    client_secret: p.clientSecret,
    redirect_uri: p.redirectUri,
    grant_type: "authorization_code",
  }).toString();
  const res = await http({
    url: TOKEN_URL,
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (res.status !== 200) {
    throw new Error(`code exchange failed: HTTP ${res.status} — ${res.body.slice(0, 300)}`);
  }
  const parsed = JSON.parse(res.body) as Partial<TokenExchangeResult>;
  if (!parsed.refresh_token) {
    throw new Error(`code exchange: no refresh_token in response (consent flow must use access_type=offline + prompt=consent). Body: ${res.body.slice(0, 200)}`);
  }
  if (!parsed.access_token) {
    throw new Error(`code exchange: no access_token in response. Body: ${res.body.slice(0, 200)}`);
  }
  return parsed as TokenExchangeResult;
}

export function mergeSecretsFile(path: string, keys: Record<string, string>): void {
  let existing: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      existing = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch {
      existing = {};
    }
  }
  const merged = { ...existing, ...keys };
  writeFileSync(path, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 });
}

// ────────────────────────────────────────────────────────────────────────
// Loopback HTTP server — captures the code from Google's redirect
// ────────────────────────────────────────────────────────────────────────

interface CallbackResult {
  code: string;
  state: string;
}

function openBrowser(url: string): void {
  // macOS only — the only platform this Kaya install targets.
  const child = spawn("open", [url], { stdio: "ignore", detached: true });
  child.unref();
}

// ────────────────────────────────────────────────────────────────────────
// CLI entry
// ────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Reuse the same Desktop OAuth client gcalcli already registered for the
  // Kaya Cloud project. Project id: kaya-484418. DPA scopes must be enabled
  // on that project's OAuth consent screen.
  const { loadGoogleOAuthClient } = await import("./YouTubeDataPortability.ts");
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
        `<html><body style="font-family:system-ui;padding:2rem"><h2>Kaya OAuth grant captured ✓</h2><p>You can close this tab. Token written to <code>~/.claude/secrets.json</code>.</p></body></html>`,
        { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });

  const port = server.port as number;
  const redirectUri = `http://localhost:${port}/callback`;
  const consentUrl = buildConsentUrl({ clientId, redirectUri, scopes: DEFAULT_SCOPES, state });

  console.log(`Loopback server listening on ${redirectUri}`);
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
    GOOGLE_DPA_REFRESH_TOKEN: tokens.refresh_token,
    GOOGLE_DPA_ACCESS_TOKEN: tokens.access_token,
    GOOGLE_DPA_ACCESS_TOKEN_EXPIRES_AT: String(Math.floor(Date.now() / 1000) + tokens.expires_in),
    GOOGLE_DPA_GRANTED_SCOPES: tokens.scope ?? DEFAULT_SCOPES.join(" "),
  });

  console.log(`Refresh token saved to ${SECRETS_PATH}`);
  console.log(`Granted scopes: ${tokens.scope ?? "(not reported by Google)"}`);
  console.log(`Done. You can now run: bun Tools/YouTubeDataPortability.ts`);
}

if (import.meta.main) {
  main().catch(async err => {
    await logFailure("OAuthBootstrap", err);
    console.error(`[OAuthBootstrap] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
