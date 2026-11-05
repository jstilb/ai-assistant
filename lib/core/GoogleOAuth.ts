/**
 * GoogleOAuth.ts — shared Google OAuth (Desktop client, loopback consent) helpers.
 *
 * Used by AppUsageTracker (Data Portability consent) and YouTubeCuration
 * (playlist-write consent). Both flows are the same code and differ only in the
 * scope list and the secrets keys they write. Extracted here so skills do not
 * import each other (ADR-006).
 *
 * Pure helpers (buildConsentUrl, exchangeCodeForTokens, mergeSecretsFile) take an
 * injectable HttpFetcher so tests need no network.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

/** The Desktop OAuth client gcalcli registered for the Kaya Cloud project. */
function gcalcliClientSecretPath(home: string = process.env.HOME ?? homedir()): string {
  return `${home}/.local/share/gcalcli/oauth/client_secret.json`;
}

interface ConsentParams {
  clientId: string;
  redirectUri: string;
  scopes: readonly string[] | string[];
  state: string;
}

export function buildConsentUrl(p: ConsentParams): string {
  const url = new URL(GOOGLE_AUTH_URL);
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
  // It also keeps each skill's grant separately revocable.
  return url.toString();
}

interface ExchangeParams {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
}

interface TokenExchangeResult {
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

export const defaultHttp: HttpFetcher = async (req) => {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.method === "GET" ? undefined : req.body,
  });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k] = v;
  });
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
    url: GOOGLE_TOKEN_URL,
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (res.status !== 200) {
    throw new Error(`code exchange failed: HTTP ${res.status} — ${res.body.slice(0, 300)}`);
  }
  const parsed = JSON.parse(res.body) as Partial<TokenExchangeResult>;
  if (!parsed.refresh_token) {
    throw new Error(
      `code exchange: no refresh_token in response (consent flow must use access_type=offline + prompt=consent). Body: ${res.body.slice(0, 200)}`,
    );
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

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

interface GcalcliClientFile {
  installed?: { client_id?: string; client_secret?: string };
  web?: { client_id?: string; client_secret?: string };
}

/** Load the Google OAuth Desktop client (client_id + client_secret) from the
 * gcalcli-managed JSON file. */
export function loadGoogleOAuthClient(path: string = gcalcliClientSecretPath()): OAuthClient {
  if (!existsSync(path)) {
    throw new Error(`OAuth client_secret.json missing at ${path} — run gcalcli setup or place the file there`);
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as GcalcliClientFile;
  const installed = parsed.installed ?? parsed.web ?? {};
  const clientId = installed.client_id;
  const clientSecret = installed.client_secret;
  if (typeof clientId !== "string" || !clientId) throw new Error(`client_id missing from ${path}`);
  if (typeof clientSecret !== "string" || !clientSecret) throw new Error(`client_secret missing from ${path}`);
  return { clientId, clientSecret };
}

function openBrowser(url: string): void {
  // macOS only — the only platform this Kaya install targets.
  const child = spawn("open", [url], { stdio: "ignore", detached: true });
  child.unref();
}

interface LoopbackConsentOptions {
  clientId: string;
  clientSecret: string;
  scopes: readonly string[] | string[];
  /** Text shown in the success page heading, e.g. "Kaya OAuth grant captured". */
  successHeading: string;
  /** Extra console line printed after the URL, e.g. the requested scopes. */
  announce?: string;
  timeoutMs?: number;
}

/**
 * Interactive loopback consent: starts a localhost server, opens the consent
 * URL in the browser, waits for Google's redirect, exchanges the code for
 * tokens. Callers persist the tokens (mergeSecretsFile) under their own keys.
 */
export async function runLoopbackConsent(opts: LoopbackConsentOptions): Promise<TokenExchangeResult> {
  if (typeof Bun === "undefined" || !Bun.serve) throw new Error("Bun.serve unavailable — run with bun");
  const state = crypto.randomUUID();

  let resolveCb: (r: { code: string; state: string }) => void = () => {};
  let rejectCb: (e: Error) => void = () => {};
  const cbPromise = new Promise<{ code: string; state: string }>((resolve, reject) => {
    resolveCb = resolve;
    rejectCb = reject;
  });

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
      if (err) {
        rejectCb(new Error(`OAuth error: ${err}`));
        return new Response(`OAuth error: ${err}`, { status: 400 });
      }
      if (!code || !st) {
        rejectCb(new Error("missing code/state"));
        return new Response("missing", { status: 400 });
      }
      if (st !== state) {
        rejectCb(new Error("state mismatch"));
        return new Response("state mismatch", { status: 400 });
      }
      resolveCb({ code, state: st });
      return new Response(
        `<html><body style="font-family:system-ui;padding:2rem"><h2>${opts.successHeading} ✓</h2><p>You can close this tab. Token written to <code>~/.claude/secrets.json</code>.</p></body></html>`,
        { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });

  const redirectUri = `http://localhost:${server.port as number}/callback`;
  const consentUrl = buildConsentUrl({ clientId: opts.clientId, redirectUri, scopes: opts.scopes, state });

  console.log(`Loopback server listening on ${redirectUri}`);
  if (opts.announce) console.log(opts.announce);
  console.log(`Opening consent URL in browser…`);
  console.log(`If the browser doesn't open, copy this URL:\n  ${consentUrl}`);
  openBrowser(consentUrl);

  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
  const timer = setTimeout(() => rejectCb(new Error(`OAuth callback timed out after ${timeoutMs}ms`)), timeoutMs);

  let cb: { code: string; state: string };
  try {
    cb = await cbPromise;
  } finally {
    clearTimeout(timer);
    server.stop(true);
  }

  console.log(`Exchange code for tokens…`);
  return exchangeCodeForTokens({
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
    redirectUri,
    code: cb.code,
  });
}
