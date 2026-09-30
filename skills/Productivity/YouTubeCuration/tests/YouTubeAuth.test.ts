/**
 * YouTubeAuth.test.ts — getYouTubeAccessToken(): refresh, cache reuse, and
 * fail-loud paths. Hermetic: secrets.json is an mkdtemp path, HTTP is a
 * stub, the gcalcli client file is an mkdtemp fixture — no live tree, no
 * real network.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getYouTubeAccessToken, type HttpFetcher } from "../Tools/YouTubeAuth.ts";

let tmp: string;
let secretsPath: string;
let clientPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "yt-auth-test-"));
  secretsPath = join(tmp, "secrets.json");
  clientPath = join(tmp, "client_secret.json");
  writeFileSync(clientPath, JSON.stringify({
    installed: { client_id: "abc.apps.googleusercontent.com", client_secret: "GOCSPX-xyz" },
  }));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("getYouTubeAccessToken: refreshes when no cached token, returns access_token", async () => {
  writeFileSync(secretsPath, JSON.stringify({ GOOGLE_YOUTUBE_REFRESH_TOKEN: "1//yt-refresh" }));
  const seen: { url: string; body?: string }[] = [];
  const http: HttpFetcher = async (req) => {
    seen.push({ url: req.url, body: req.body });
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ access_token: "ya29.fresh", expires_in: 3600, token_type: "Bearer" }),
    };
  };

  const token = await getYouTubeAccessToken({ secretsPath, clientPath, http, now: () => 1_000_000_000 });

  expect(token).toBe("ya29.fresh");
  expect(seen).toHaveLength(1);
  expect(seen[0]?.url).toBe("https://oauth2.googleapis.com/token");
  expect(seen[0]?.body).toContain("grant_type=refresh_token");
  expect(seen[0]?.body).toContain("refresh_token=1%2F%2Fyt-refresh");
});

test("getYouTubeAccessToken: caches the refreshed token to secrets.json (expiry field included)", async () => {
  writeFileSync(secretsPath, JSON.stringify({ GOOGLE_YOUTUBE_REFRESH_TOKEN: "1//yt-refresh" }));
  const http: HttpFetcher = async () => ({
    status: 200,
    headers: {},
    body: JSON.stringify({ access_token: "ya29.fresh", expires_in: 3600, token_type: "Bearer" }),
  });
  const nowSec = 1_000_000_000;

  await getYouTubeAccessToken({ secretsPath, clientPath, http, now: () => nowSec * 1000 });

  const written = JSON.parse(await Bun.file(secretsPath).text()) as Record<string, unknown>;
  expect(written.GOOGLE_YOUTUBE_ACCESS_TOKEN).toBe("ya29.fresh");
  expect(written.GOOGLE_YOUTUBE_ACCESS_TOKEN_EXPIRES_AT).toBe(String(nowSec + 3600));
});

test("getYouTubeAccessToken: reuses cached access token when not near expiry, makes zero HTTP calls", async () => {
  const nowSec = 1_000_000_000;
  writeFileSync(secretsPath, JSON.stringify({
    GOOGLE_YOUTUBE_REFRESH_TOKEN: "1//yt-refresh",
    GOOGLE_YOUTUBE_ACCESS_TOKEN: "ya29.cached",
    // Expires an hour from "now" — well outside the 60s skew window.
    GOOGLE_YOUTUBE_ACCESS_TOKEN_EXPIRES_AT: String(nowSec + 3600),
  }));
  let calls = 0;
  const http: HttpFetcher = async () => { calls += 1; throw new Error("must not be called — cache should be reused"); };

  const token = await getYouTubeAccessToken({ secretsPath, clientPath, http, now: () => nowSec * 1000 });

  expect(token).toBe("ya29.cached");
  expect(calls).toBe(0);
});

test("getYouTubeAccessToken: refreshes when cached token is within the expiry-skew window", async () => {
  const nowSec = 1_000_000_000;
  writeFileSync(secretsPath, JSON.stringify({
    GOOGLE_YOUTUBE_REFRESH_TOKEN: "1//yt-refresh",
    GOOGLE_YOUTUBE_ACCESS_TOKEN: "ya29.stale",
    // Expires in 30s — inside the 60s skew window, must trigger a refresh.
    GOOGLE_YOUTUBE_ACCESS_TOKEN_EXPIRES_AT: String(nowSec + 30),
  }));
  let calls = 0;
  const http: HttpFetcher = async () => {
    calls += 1;
    return { status: 200, headers: {}, body: JSON.stringify({ access_token: "ya29.renewed", expires_in: 3600, token_type: "Bearer" }) };
  };

  const token = await getYouTubeAccessToken({ secretsPath, clientPath, http, now: () => nowSec * 1000 });

  expect(calls).toBe(1);
  expect(token).toBe("ya29.renewed");
});

test("getYouTubeAccessToken: fails loud with the re-consent pointer when refresh token is missing, never calls HTTP", async () => {
  writeFileSync(secretsPath, JSON.stringify({ YOUTUBE_API_KEY: "AIza-existing" }));
  let calls = 0;
  const http: HttpFetcher = async () => { calls += 1; return { status: 200, headers: {}, body: "{}" }; };

  await expect(getYouTubeAccessToken({ secretsPath, clientPath, http })).rejects.toThrow(
    /GOOGLE_YOUTUBE_REFRESH_TOKEN missing.*YouTubeOAuthBootstrap\.ts/s,
  );
  expect(calls).toBe(0);
});

test("getYouTubeAccessToken: fails loud with the re-consent pointer when the refresh call is rejected (revoked grant)", async () => {
  writeFileSync(secretsPath, JSON.stringify({ GOOGLE_YOUTUBE_REFRESH_TOKEN: "1//revoked" }));
  const http: HttpFetcher = async () => ({
    status: 400,
    headers: {},
    body: JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." }),
  });

  await expect(getYouTubeAccessToken({ secretsPath, clientPath, http })).rejects.toThrow(
    /invalid_grant.*YouTubeOAuthBootstrap\.ts/s,
  );
});

test("getYouTubeAccessToken: fails loud (not a silent empty-string return) when secrets.json is entirely missing", async () => {
  const missingPath = join(tmp, "does-not-exist.json");
  await expect(getYouTubeAccessToken({ secretsPath: missingPath, clientPath })).rejects.toThrow(
    /secrets file missing.*YouTubeOAuthBootstrap\.ts/s,
  );
});

test("getYouTubeAccessToken: a refresh preserves unrelated secrets.json keys including DPA keys", async () => {
  writeFileSync(secretsPath, JSON.stringify({
    GOOGLE_YOUTUBE_REFRESH_TOKEN: "1//yt-refresh",
    GOOGLE_DPA_REFRESH_TOKEN: "1//dpa-refresh",
    GOOGLE_DPA_ACCESS_TOKEN: "ya29.dpa-access",
    YOUTUBE_API_KEY: "AIza-existing",
  }));
  const http: HttpFetcher = async () => ({
    status: 200,
    headers: {},
    body: JSON.stringify({ access_token: "ya29.fresh", expires_in: 3600, token_type: "Bearer" }),
  });

  await getYouTubeAccessToken({ secretsPath, clientPath, http });

  const written = JSON.parse(await Bun.file(secretsPath).text()) as Record<string, unknown>;
  expect(written.GOOGLE_YOUTUBE_ACCESS_TOKEN).toBe("ya29.fresh");
  expect(written.GOOGLE_DPA_REFRESH_TOKEN).toBe("1//dpa-refresh");
  expect(written.GOOGLE_DPA_ACCESS_TOKEN).toBe("ya29.dpa-access");
  expect(written.YOUTUBE_API_KEY).toBe("AIza-existing");
});
