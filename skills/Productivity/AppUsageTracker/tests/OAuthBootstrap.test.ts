/**
 * OAuthBootstrap.test.ts — verifies pure helpers in OAuthBootstrap.ts.
 * The loopback browser flow is not exercised in CI (requires a real Google
 * consent screen); we cover URL building + code exchange + secrets merge.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildConsentUrl,
  exchangeCodeForTokens,
  mergeSecretsFile,
  type HttpFetcher,
} from "../Tools/OAuthBootstrap.ts";

let tmp: string;
let secretsPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "oauth-bootstrap-"));
  secretsPath = join(tmp, "secrets.json");
});

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

test("buildConsentUrl: encodes scopes, redirect_uri, access_type=offline, prompt=consent", () => {
  const url = buildConsentUrl({
    clientId: "abc.apps.googleusercontent.com",
    redirectUri: "http://localhost:51234/callback",
    scopes: [
      "https://www.googleapis.com/auth/dataportability.myactivity.youtube",
      "https://www.googleapis.com/auth/dataportability.chrome.history",
    ],
    state: "nonce-abc",
  });
  const parsed = new URL(url);
  expect(parsed.host).toBe("accounts.google.com");
  expect(parsed.pathname).toBe("/o/oauth2/v2/auth");
  expect(parsed.searchParams.get("client_id")).toBe("abc.apps.googleusercontent.com");
  expect(parsed.searchParams.get("redirect_uri")).toBe("http://localhost:51234/callback");
  expect(parsed.searchParams.get("response_type")).toBe("code");
  expect(parsed.searchParams.get("access_type")).toBe("offline");
  expect(parsed.searchParams.get("prompt")).toBe("consent");
  expect(parsed.searchParams.get("state")).toBe("nonce-abc");
  const scope = parsed.searchParams.get("scope");
  expect(scope).toContain("dataportability.myactivity.youtube");
  expect(scope).toContain("dataportability.chrome.history");
  // DPA scopes are incompatible with incremental auth — Google returns 400
  // invalid_request if include_granted_scopes is set. Lock this in.
  expect(parsed.searchParams.get("include_granted_scopes")).toBeNull();
});

test("exchangeCodeForTokens: posts form body, returns parsed refresh_token + access_token", async () => {
  const seen: { url: string; body?: string } = { url: "" };
  const http: HttpFetcher = async (req) => {
    seen.url = req.url;
    seen.body = req.body;
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        access_token: "ya29.access",
        refresh_token: "1//refresh",
        expires_in: 3599,
        token_type: "Bearer",
        scope: "https://www.googleapis.com/auth/dataportability.myactivity.youtube",
      }),
    };
  };
  const result = await exchangeCodeForTokens(
    {
      clientId: "abc.apps.googleusercontent.com",
      clientSecret: "GOCSPX-xyz",
      redirectUri: "http://127.0.0.1:51234/callback",
      code: "auth-code-123",
    },
    http,
  );
  expect(result.refresh_token).toBe("1//refresh");
  expect(result.access_token).toBe("ya29.access");
  expect(seen.url).toBe("https://oauth2.googleapis.com/token");
  expect(seen.body).toContain("grant_type=authorization_code");
  expect(seen.body).toContain("code=auth-code-123");
  expect(seen.body).toContain("client_id=abc.apps.googleusercontent.com");
  expect(seen.body).toContain("client_secret=GOCSPX-xyz");
});

test("exchangeCodeForTokens: surfaces error from token endpoint with HTTP status + body", async () => {
  const http: HttpFetcher = async () => ({
    status: 400,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ error: "invalid_grant", error_description: "Bad code" }),
  });
  await expect(
    exchangeCodeForTokens(
      { clientId: "x", clientSecret: "y", redirectUri: "http://127.0.0.1/cb", code: "bad" },
      http,
    ),
  ).rejects.toThrow(/invalid_grant|Bad code|400/);
});

test("mergeSecretsFile: preserves unrelated keys, adds new ones, overwrites duplicates", () => {
  writeFileSync(secretsPath, JSON.stringify({ EXISTING: "x", YOUTUBE_API_KEY: "AIza" }, null, 2));
  mergeSecretsFile(secretsPath, {
    GOOGLE_DPA_CLIENT_ID: "client-id-123",
    GOOGLE_DPA_CLIENT_SECRET: "secret-xyz",
    GOOGLE_DPA_REFRESH_TOKEN: "1//refresh",
  });
  const merged = JSON.parse(readFileSync(secretsPath, "utf8")) as Record<string, unknown>;
  expect(merged.EXISTING).toBe("x");
  expect(merged.YOUTUBE_API_KEY).toBe("AIza");
  expect(merged.GOOGLE_DPA_CLIENT_ID).toBe("client-id-123");
  expect(merged.GOOGLE_DPA_REFRESH_TOKEN).toBe("1//refresh");
});

test("mergeSecretsFile: creates file when missing", () => {
  mergeSecretsFile(secretsPath, { GOOGLE_DPA_REFRESH_TOKEN: "1//refresh" });
  const created = JSON.parse(readFileSync(secretsPath, "utf8")) as Record<string, unknown>;
  expect(created.GOOGLE_DPA_REFRESH_TOKEN).toBe("1//refresh");
});
