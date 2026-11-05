import { describe, it, expect, afterAll, spyOn } from "bun:test";
import * as VoiceCommon from "./VoiceCommon.ts";

// The server reads its auth token from secrets.json at import time. Inject a fake
// so the test never reads the live secrets file (hermetic on any host).
const secretsSpy = spyOn(VoiceCommon, "loadSecrets").mockImplementation(() => ({
  voice_auth_token: "test-voice-auth-token",
}));
const { checkServiceHealth } = (await import(
  "./RealtimeVoiceServer.ts" + "?health-test"
)) as typeof import("./RealtimeVoiceServer.ts");

afterAll(() => {
  secretsSpy.mockRestore();
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
