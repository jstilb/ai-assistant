/**
 * RemoteAccess.ts — opt-in phone/Tailscale access for Kaya's local web UIs.
 *
 * Every local UI binds loopback and is auth-free by default. To reach one from
 * the Pixel (Tailscale or LAN), set `<prefix>_bind` (e.g. "0.0.0.0") in
 * ~/.claude/secrets.json — NOT the launchd plist, which rebuild-plists.sh
 * regenerates — then kickstart the service. A non-loopback bind REQUIRES a
 * token (`<prefix>_token` in secrets.json, or the service's token env var); the
 * resolver throws without one so the server refuses to start unauthenticated.
 * First visit: http://<host>:<port>/?token=<token> (sets a cookie); everything
 * after rides the cookie. Health paths stay open for the liveness watchdogs.
 *
 * Same contract as the LucidTasks board (BoardServer.ts "Remote-access auth").
 */

import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { getKayaHome } from "./KayaHome.ts";
import { join } from "node:path";

export const LOOPBACK = "127.0.0.1";

export interface RemoteAccessOptions {
  /** secrets.json key prefix: reads `<prefix>_bind` and `<prefix>_token`. */
  secretPrefix: string;
  /** Env var that overrides the bind address. */
  bindEnv: string;
  /** Env var that overrides the token (and enforces auth even on loopback). */
  tokenEnv: string;
  /** Test seam: secrets.json path. */
  secretsPath?: string;
  /** Test seam: environment. */
  env?: Record<string, string | undefined>;
}

export interface RemoteAccess {
  bind: string;
  /** null = auth off (loopback bind with no explicit env token). */
  token: string | null;
}

/**
 * Bind: env > `<prefix>_bind` secret > loopback. Token: an explicit env token
 * always applies; the secrets.json token only activates for non-loopback
 * binds, so local browsing stays cookie-free once the secret exists.
 */
export function resolveRemoteAccess(opts: RemoteAccessOptions): RemoteAccess {
  const env = opts.env ?? process.env;
  const secretsPath = opts.secretsPath ?? join(getKayaHome(), "secrets.json");
  const bind = env[opts.bindEnv] || readSecretString(secretsPath, `${opts.secretPrefix}_bind`) || LOOPBACK;
  const envToken = env[opts.tokenEnv] || null;
  const token = bind === LOOPBACK
    ? envToken
    : envToken ?? readSecretString(secretsPath, `${opts.secretPrefix}_token`);
  if (bind !== LOOPBACK && token === null) {
    throw new Error(
      `bind=${bind} requires a token (env ${opts.tokenEnv} or ${opts.secretPrefix}_token in ` +
      `~/.claude/secrets.json). Refusing to expose the server unauthenticated.`,
    );
  }
  return { bind, token };
}

export interface RemoteAuthResult {
  ok: boolean;
  /** Set-Cookie header value to attach when a valid ?token= just authenticated. */
  setCookie?: string;
}

/**
 * Gate one request. `token === null` means auth is off. `cookieName` must be
 * unique per service — browsers scope cookies by host, not port, so two UIs on
 * the same Mac share one cookie jar.
 */
export function checkRemoteAuth(
  req: Request,
  token: string | null,
  cookieName: string,
  openPaths: readonly string[] = [],
): RemoteAuthResult {
  if (token === null) return { ok: true };
  const url = new URL(req.url);
  if (openPaths.includes(url.pathname)) return { ok: true };
  const q = url.searchParams.get("token");
  if (q !== null) {
    if (!timingSafeEq(q, token)) return { ok: false };
    return {
      ok: true,
      setCookie: `${cookieName}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000`,
    };
  }
  const m = (req.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${cookieName}=([^;]+)`));
  return { ok: m !== null && timingSafeEq(decodeURIComponent(m[1]), token) };
}

/** Wrap a fetch handler with the auth gate (401 on failure, cookie on first valid ?token=). */
export function withRemoteAuth(
  handler: (req: Request) => Response | Promise<Response>,
  token: string | null,
  cookieName: string,
  openPaths: readonly string[] = [],
): (req: Request) => Promise<Response> {
  return async (req) => {
    const auth = checkRemoteAuth(req, token, cookieName, openPaths);
    if (!auth.ok) return new Response("unauthorized", { status: 401 });
    const res = await handler(req);
    if (auth.setCookie) res.headers.set("set-cookie", auth.setCookie);
    return res;
  };
}

function readSecretString(path: string, key: string): string | null {
  try {
    const v = (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)[key];
    return typeof v === "string" && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

function timingSafeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
