import { describe, it, expect } from "bun:test";
import { checkServiceHealth } from "./RealtimeVoiceServer.ts";

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
