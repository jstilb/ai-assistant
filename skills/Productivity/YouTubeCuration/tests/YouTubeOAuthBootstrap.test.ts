/**
 * YouTubeOAuthBootstrap.test.ts — verifies the playlist-write consent flow's
 * scope choice.
 *
 * The loopback browser flow itself is not exercised in CI (requires a real
 * Google consent screen — same as OAuthBootstrap.test.ts's own note); this
 * suite covers the URL this build actually sends Google. The secrets write
 * (updateSecrets) is covered in lib/core/Secrets.test.ts.
 */

import { expect, test } from "bun:test";
import { buildConsentUrl } from "../../../../lib/core/GoogleOAuth.ts";
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
