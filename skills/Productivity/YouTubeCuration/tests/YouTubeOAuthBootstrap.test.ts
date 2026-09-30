/**
 * YouTubeOAuthBootstrap.test.ts — verifies the playlist-write consent flow's
 * scope choice and secrets-merge behavior.
 *
 * The loopback browser flow itself is not exercised in CI (requires a real
 * Google consent screen — same as OAuthBootstrap.test.ts's own note); this
 * suite covers the URL this build actually sends Google and the secrets
 * write it performs, both pure and hermetic.
 */

import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// cross-skill-allowed: test exercises the real, already-tested pure helper this build's YouTubeOAuthBootstrap.ts reuses (see that file's own cross-skill-allowed comment for the rationale).
import { buildConsentUrl, mergeSecretsFile } from "../../AppUsageTracker/Tools/OAuthBootstrap.ts";
import { YOUTUBE_SCOPES } from "../Tools/YouTubeOAuthBootstrap.ts";

test("YOUTUBE_SCOPES: exactly one scope, youtube.force-ssl", () => {
  expect(YOUTUBE_SCOPES).toEqual(["https://www.googleapis.com/auth/youtube.force-ssl"]);
});

test("buildConsentUrl(YOUTUBE_SCOPES): access_type=offline, prompt=consent, no include_granted_scopes", () => {
  const url = buildConsentUrl({
    clientId: "abc.apps.googleusercontent.com",
    redirectUri: "http://localhost:51234/callback",
    scopes: YOUTUBE_SCOPES,
    state: "nonce-yt",
  });
  const parsed = new URL(url);
  expect(parsed.host).toBe("accounts.google.com");
  expect(parsed.searchParams.get("access_type")).toBe("offline");
  expect(parsed.searchParams.get("prompt")).toBe("consent");
  expect(parsed.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/youtube.force-ssl");
  expect(parsed.searchParams.get("state")).toBe("nonce-yt");
  // Deliberately unset — see YouTubeOAuthBootstrap.ts's comment above its
  // buildConsentUrl call for why (kept a standalone grant, not merged with
  // the DPA authorization already on this client).
  expect(parsed.searchParams.get("include_granted_scopes")).toBeNull();
});

test("mergeSecretsFile(GOOGLE_YOUTUBE_* keys): preserves unrelated keys including DPA keys", () => {
  const tmp = mkdtempSync(join(tmpdir(), "yt-oauth-bootstrap-"));
  try {
    const secretsPath = join(tmp, "secrets.json");
    writeFileSync(secretsPath, JSON.stringify({
      YOUTUBE_API_KEY: "AIza-existing",
      GOOGLE_DPA_REFRESH_TOKEN: "1//dpa-refresh",
      GOOGLE_DPA_ACCESS_TOKEN: "ya29.dpa-access",
      GOOGLE_DPA_ACCESS_TOKEN_EXPIRES_AT: "1000000",
      GOOGLE_DPA_GRANTED_SCOPES: "https://www.googleapis.com/auth/dataportability.myactivity.youtube",
      UNRELATED_KEY: "untouched",
    }, null, 2));

    mergeSecretsFile(secretsPath, {
      GOOGLE_YOUTUBE_REFRESH_TOKEN: "1//yt-refresh",
      GOOGLE_YOUTUBE_ACCESS_TOKEN: "ya29.yt-access",
      GOOGLE_YOUTUBE_ACCESS_TOKEN_EXPIRES_AT: "2000000",
      GOOGLE_YOUTUBE_GRANTED_SCOPES: "https://www.googleapis.com/auth/youtube.force-ssl",
    });

    const merged = JSON.parse(readFileSync(secretsPath, "utf8")) as Record<string, unknown>;
    // New keys landed.
    expect(merged.GOOGLE_YOUTUBE_REFRESH_TOKEN).toBe("1//yt-refresh");
    expect(merged.GOOGLE_YOUTUBE_ACCESS_TOKEN).toBe("ya29.yt-access");
    expect(merged.GOOGLE_YOUTUBE_ACCESS_TOKEN_EXPIRES_AT).toBe("2000000");
    expect(merged.GOOGLE_YOUTUBE_GRANTED_SCOPES).toBe("https://www.googleapis.com/auth/youtube.force-ssl");
    // DPA keys and every other unrelated key are byte-identical to before.
    expect(merged.GOOGLE_DPA_REFRESH_TOKEN).toBe("1//dpa-refresh");
    expect(merged.GOOGLE_DPA_ACCESS_TOKEN).toBe("ya29.dpa-access");
    expect(merged.GOOGLE_DPA_ACCESS_TOKEN_EXPIRES_AT).toBe("1000000");
    expect(merged.GOOGLE_DPA_GRANTED_SCOPES).toBe("https://www.googleapis.com/auth/dataportability.myactivity.youtube");
    expect(merged.YOUTUBE_API_KEY).toBe("AIza-existing");
    expect(merged.UNRELATED_KEY).toBe("untouched");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
