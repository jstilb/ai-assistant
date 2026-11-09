import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretError } from "../../../../lib/core/Secrets.ts";

// The server reads its auth token from secrets.json at import time. Point
// KAYA_HOME at a temp fixture first so the test never reads the live secrets
// file (hermetic on any host); restored in afterAll.
const secretsHome = mkdtempSync(join(tmpdir(), "voice-health-test-"));
writeFileSync(join(secretsHome, "secrets.json"), JSON.stringify({ voice_auth_token: "test-voice-auth-token" }));
const savedKayaHome = process.env.KAYA_HOME;
process.env.KAYA_HOME = secretsHome;
const { checkServiceHealth } = (await import(
  "./RealtimeVoiceServer.ts" + "?health-test"
)) as typeof import("./RealtimeVoiceServer.ts");

afterAll(() => {
  if (savedKayaHome === undefined) delete process.env.KAYA_HOME;
  else process.env.KAYA_HOME = savedKayaHome;
  rmSync(secretsHome, { recursive: true, force: true });
});

describe("checkServiceHealth", () => {
  it("reports error on the first check after the service stops (no stale cache)", async () => {
    const stub = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const url = `http://127.0.0.1:${stub.port}/health`;

    const up = await checkServiceHealth(url, "stt");
    expect(up.status).toBe("ok");

    await stub.stop(true);

    const down = await checkServiceHealth(url, "stt");
    expect(down.status).toBe("error");
    expect(down.error).toBeDefined();
  });
});

describe("voice auth token read at import", () => {
  it("a malformed secrets.json fails the import with SecretError file-malformed, no file text", async () => {
    const badHome = mkdtempSync(join(tmpdir(), "voice-malformed-test-"));
    writeFileSync(join(badHome, "secrets.json"), '{"voice_auth_token": "SENTINEL-voice-0001",');
    process.env.KAYA_HOME = badHome;
    try {
      let caught: unknown;
      try {
        await import("./RealtimeVoiceServer.ts" + "?malformed-test");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(SecretError);
      if (!(caught instanceof SecretError)) throw new Error("expected SecretError");
      expect(caught.kind).toBe("file-malformed");
      expect(caught.message).not.toContain("SENTINEL");
    } finally {
      process.env.KAYA_HOME = secretsHome;
      rmSync(badHome, { recursive: true, force: true });
    }
  });
});
