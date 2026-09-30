#!/usr/bin/env bun
/**
 * YouTubeDataPortability.ts — pull a user's YouTube activity history (and
 * optionally Chrome history) via Google's Data Portability API, save the
 * resulting archive(s) into youtube-takeout-inbox/, so that YouTubeIngest.ts
 * picks them up unchanged.
 *
 * REPLACES the manual takeout.google.com flow described in YouTubeIngest.ts.
 *
 * ====== ONE-TIME SETUP (Jm) ===============================================
 *
 * 1. Google Cloud Console (project kaya-484418, where gcalcli already lives):
 *    a. APIs & Services → Library → enable "Data Portability API".
 *    b. OAuth consent screen → Add or Remove Scopes → add
 *         https://www.googleapis.com/auth/dataportability.myactivity.youtube
 *         https://www.googleapis.com/auth/dataportability.chrome.history
 *    c. Confirm [user-email] is on the Test users list.
 *    The existing Desktop OAuth client at
 *      ~/.local/share/gcalcli/oauth/client_secret.json
 *    is reused — no need to create a new OAuth client.
 * 2. Run `bun Tools/OAuthBootstrap.ts` (loopback flow). A browser opens, you
 *    grant the DPA scopes for the longest window offered (180d in production,
 *    7d in testing mode). The resulting refresh_token is written to
 *      ~/.claude/secrets.json  → GOOGLE_DPA_REFRESH_TOKEN
 *    (client_id and client_secret are read from the gcalcli file at runtime.)
 *
 * ====== WHAT THIS TOOL DOES ===============================================
 *
 * - Refreshes an access token from the long-lived refresh_token.
 * - POSTs to /v1/portabilityArchive:initiate for the configured resources.
 * - Polls /v1/archiveJobs/{id}/portabilityArchiveState until COMPLETE or
 *   FAILED/CANCELLED (or timeout).
 * - Downloads each signed Cloud Storage URL into the takeout inbox dir.
 * - Output filenames embed archiveJobId so re-pulls don't overwrite.
 *
 * Time-based access (preferred) — Jm grants 30 or 180 days during consent.
 * Within the window, this tool can re-pull every 24h without re-consent
 * (Google enforces a per-resource 24h cooldown). After window expires,
 * Jm re-grants and gets a new refresh token.
 *
 * Scope/url docs (verified 2026-05):
 *   https://developers.google.com/data-portability/user-guide/scopes
 *   https://developers.google.com/data-portability/reference/rest
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logFailure } from "./Db.ts";

const HOME = process.env.HOME ?? "/Users/[user]";
const SECRETS_PATH = `${HOME}/.claude/secrets.json`;
// Reuse the OAuth client gcalcli already registered for project kaya-484418.
// Same project where Data Portability API is enabled. Avoids forcing Jm to
// create a second Desktop OAuth client.
export const GCALCLI_CLIENT_SECRET_PATH = `${HOME}/.local/share/gcalcli/oauth/client_secret.json`;
export const DPA_INBOX = `${HOME}/.claude/MEMORY/AppUsage/youtube-takeout-inbox`;

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DPA_BASE = "https://dataportability.googleapis.com/v1";

// Bake the "myactivity." prefix into the resource enum — Google's
// initiatePortabilityArchive `resources[]` accepts the short form that follows
// the scope URL. e.g. for scope dataportability.myactivity.youtube the
// resource is "myactivity.youtube".
export const RESOURCE_YOUTUBE_ACTIVITY = "myactivity.youtube" as const;
export const RESOURCE_CHROME_HISTORY = "chrome.history" as const;

export interface DPAConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export type AccessType = "ACCESS_TYPE_ONE_TIME" | "ACCESS_TYPE_TIME_BASED" | string;
export type ArchiveState = "STATE_UNSPECIFIED" | "IN_PROGRESS" | "COMPLETE" | "FAILED" | "CANCELLED" | string;

export interface InitiateResult {
  archiveJobId: string;
  accessType: AccessType;
}

export interface PortabilityArchiveState {
  state: ArchiveState;
  urls: string[];
  name: string;
  startTime?: string;
  exportTime?: string;
}

export interface PullResult {
  archiveJobId: string;
  accessType: AccessType;
  files: string[];
}

// Minimal HTTP abstraction so tests can stub without spinning up a fake
// server. body can be a string (JSON / form) or Uint8Array (binary).
export interface HttpRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string | Uint8Array;
}

export type HttpFetcher = (req: HttpRequest) => Promise<HttpResponse>;

// ────────────────────────────────────────────────────────────────────────
// secrets.json helpers
// ────────────────────────────────────────────────────────────────────────

interface GcalcliClientFile {
  installed?: { client_id?: string; client_secret?: string };
  web?: { client_id?: string; client_secret?: string };
}

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

/** Load the Google OAuth Desktop client (client_id + client_secret) from the
 * gcalcli-managed JSON file. This is the same Cloud project where DPA is
 * enabled, so the same client works for both. */
export function loadGoogleOAuthClient(path: string = GCALCLI_CLIENT_SECRET_PATH): OAuthClient {
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

export function loadDPAConfig(
  secretsPath: string = SECRETS_PATH,
  clientPath: string = GCALCLI_CLIENT_SECRET_PATH,
): DPAConfig {
  const client = loadGoogleOAuthClient(clientPath);
  if (!existsSync(secretsPath)) {
    throw new Error(`secrets file missing at ${secretsPath}`);
  }
  const parsed = JSON.parse(readFileSync(secretsPath, "utf8")) as Record<string, unknown>;
  const refreshToken = parsed.GOOGLE_DPA_REFRESH_TOKEN;
  if (typeof refreshToken !== "string" || !refreshToken) {
    throw new Error(`secrets.json missing GOOGLE_DPA_REFRESH_TOKEN — run OAuthBootstrap.ts first`);
  }
  return { clientId: client.clientId, clientSecret: client.clientSecret, refreshToken };
}

// ────────────────────────────────────────────────────────────────────────
// HTTP — production uses bun's fetch; tests pass a stub
// ────────────────────────────────────────────────────────────────────────

export const defaultHttp: HttpFetcher = async (req) => {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.method === "GET" ? undefined : req.body,
  });
  const ct = res.headers.get("content-type") ?? "";
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => { headers[k] = v; });
  // Treat anything that isn't text/json/form as binary
  const isText = /^(application\/json|application\/x-www-form-urlencoded|text\/)/.test(ct);
  const body: string | Uint8Array = isText
    ? await res.text()
    : new Uint8Array(await res.arrayBuffer());
  return { status: res.status, headers, body };
};

function bodyAsString(body: string | Uint8Array): string {
  return typeof body === "string" ? body : new TextDecoder().decode(body);
}

// ────────────────────────────────────────────────────────────────────────
// OAuth token refresh
// ────────────────────────────────────────────────────────────────────────

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

export async function refreshAccessToken(cfg: DPAConfig, http: HttpFetcher = defaultHttp): Promise<string> {
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: cfg.refreshToken,
    grant_type: "refresh_token",
  }).toString();
  const res = await http({
    url: TOKEN_URL,
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (res.status !== 200) {
    throw new Error(`OAuth token refresh failed: HTTP ${res.status} — ${bodyAsString(res.body).slice(0, 300)}`);
  }
  const parsed = JSON.parse(bodyAsString(res.body)) as TokenResponse;
  if (!parsed.access_token) throw new Error(`OAuth token refresh: no access_token in response`);
  return parsed.access_token;
}

// ────────────────────────────────────────────────────────────────────────
// Data Portability API calls
// ────────────────────────────────────────────────────────────────────────

export async function initiateArchive(
  http: HttpFetcher,
  accessToken: string,
  resources: string[],
  opts: { startTime?: string; endTime?: string } = {},
): Promise<InitiateResult> {
  const reqBody: Record<string, unknown> = { resources };
  if (opts.startTime) reqBody.startTime = opts.startTime;
  if (opts.endTime) reqBody.endTime = opts.endTime;
  const res = await http({
    url: `${DPA_BASE}/portabilityArchive:initiate`,
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(reqBody),
  });
  if (res.status !== 200) {
    throw new Error(`initiateArchive failed: HTTP ${res.status} — ${bodyAsString(res.body).slice(0, 500)}`);
  }
  const parsed = JSON.parse(bodyAsString(res.body)) as InitiateResult;
  if (!parsed.archiveJobId) throw new Error(`initiateArchive: missing archiveJobId in response: ${bodyAsString(res.body).slice(0, 200)}`);
  return parsed;
}

export async function getArchiveState(
  http: HttpFetcher,
  accessToken: string,
  archiveJobId: string,
): Promise<PortabilityArchiveState> {
  const res = await http({
    url: `${DPA_BASE}/archiveJobs/${encodeURIComponent(archiveJobId)}/portabilityArchiveState`,
    method: "GET",
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (res.status !== 200) {
    throw new Error(`getArchiveState failed: HTTP ${res.status} — ${bodyAsString(res.body).slice(0, 300)}`);
  }
  const parsed = JSON.parse(bodyAsString(res.body)) as PortabilityArchiveState;
  return {
    state: parsed.state ?? "STATE_UNSPECIFIED",
    urls: Array.isArray(parsed.urls) ? parsed.urls : [],
    name: parsed.name ?? "",
    startTime: parsed.startTime,
    exportTime: parsed.exportTime,
  };
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function pollUntilComplete(
  http: HttpFetcher,
  accessToken: string,
  archiveJobId: string,
  opts: { intervalMs?: number; maxWaitMs?: number } = {},
): Promise<PortabilityArchiveState> {
  const intervalMs = opts.intervalMs ?? 5_000;
  const maxWaitMs = opts.maxWaitMs ?? 10 * 60 * 1000; // 10 minutes
  const start = Date.now();
  while (true) {
    const state = await getArchiveState(http, accessToken, archiveJobId);
    if (state.state === "COMPLETE") return state;
    if (state.state === "FAILED" || state.state === "CANCELLED") {
      throw new Error(`Archive ${archiveJobId} ended in state ${state.state}`);
    }
    const elapsed = Date.now() - start;
    if (elapsed + intervalMs > maxWaitMs) {
      throw new Error(`pollUntilComplete: maxWaitMs (${maxWaitMs}ms) exceeded; last state ${state.state}`);
    }
    await sleep(intervalMs);
  }
}

// ────────────────────────────────────────────────────────────────────────
// Download signed archive URLs to disk
// ────────────────────────────────────────────────────────────────────────

export async function downloadArchive(
  http: HttpFetcher,
  urls: string[],
  destDir: string,
  archiveJobId: string,
): Promise<string[]> {
  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
  const files: string[] = [];
  let i = 0;
  for (const url of urls) {
    i += 1;
    const res = await http({ url, method: "GET", headers: {} });
    if (res.status !== 200) {
      throw new Error(`download failed: HTTP ${res.status} for ${url.slice(0, 80)}…`);
    }
    const buf = typeof res.body === "string" ? new TextEncoder().encode(res.body) : res.body;
    const safeJobId = archiveJobId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const filename = `dpa-${safeJobId}-${String(i).padStart(4, "0")}.zip`;
    const path = join(destDir, filename);
    writeFileSync(path, buf);
    files.push(path);
  }
  return files;
}

// ────────────────────────────────────────────────────────────────────────
// Orchestrator
// ────────────────────────────────────────────────────────────────────────

export interface PullOpts {
  http?: HttpFetcher;
  intervalMs?: number;
  maxWaitMs?: number;
  startTime?: string;
  endTime?: string;
}

export async function pullDPAArchive(
  cfg: DPAConfig,
  resources: string[],
  destDir: string,
  opts: PullOpts = {},
): Promise<PullResult> {
  const http = opts.http ?? defaultHttp;
  const accessToken = await refreshAccessToken(cfg, http);
  const init = await initiateArchive(http, accessToken, resources, { startTime: opts.startTime, endTime: opts.endTime });
  const state = await pollUntilComplete(http, accessToken, init.archiveJobId, { intervalMs: opts.intervalMs, maxWaitMs: opts.maxWaitMs });
  const files = await downloadArchive(http, state.urls, destDir, init.archiveJobId);
  return { archiveJobId: init.archiveJobId, accessType: init.accessType, files };
}

// ────────────────────────────────────────────────────────────────────────
// CLI entrypoint — `bun YouTubeDataPortability.ts`
// ────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const resources: string[] = [];
  let resourceFlag = false;
  for (const a of args) {
    if (a === "--chrome") resources.push(RESOURCE_CHROME_HISTORY), (resourceFlag = true);
    else if (a === "--youtube") resources.push(RESOURCE_YOUTUBE_ACTIVITY), (resourceFlag = true);
    else if (a.startsWith("--")) { /* ignore unknown */ }
  }
  if (!resourceFlag) resources.push(RESOURCE_YOUTUBE_ACTIVITY);

  const cfg = loadDPAConfig();
  console.log(`DPA pull: resources=[${resources.join(",")}] dest=${DPA_INBOX}`);
  try {
    const result = await pullDPAArchive(cfg, resources, DPA_INBOX, { intervalMs: 10_000, maxWaitMs: 15 * 60 * 1000 });
    console.log(`DPA pull complete: job=${result.archiveJobId} accessType=${result.accessType}`);
    for (const f of result.files) console.log(`  saved → ${f}`);
  } catch (err) {
    await logFailure("YouTubeDataPortability", err, { resources });
    throw err;
  }
}

if (import.meta.main) {
  main().catch(err => {
    console.error(`[YouTubeDataPortability] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
