import { describe, it, expect, afterAll, spyOn } from "bun:test";
import * as VoiceCommon from "./VoiceCommon.ts";

// STT and TTS both live on one host. A circuit breaker keyed on hostname
// (lib/core/CachedHTTPClient.ts) would let STT outages block TTS. This proves
// TTS still works after repeated STT connection failures on the same host.

const deadStt = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("unused") });
const sttUrl = `http://127.0.0.1:${deadStt.port}/v1/audio/transcriptions`;
await deadStt.stop(true); // port now refuses connections

let ttsHits = 0;
const tts = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: () => {
    ttsHits++;
    return new Response(new Uint8Array([0x52, 0x49, 0x46, 0x46]), { headers: { "Content-Type": "audio/wav" } });
  },
});
const ttsUrl = `http://127.0.0.1:${tts.port}/v1/audio/speech`;

const configSpy = spyOn(VoiceCommon, "getRealtimeVoiceConfig").mockImplementation(() =>
  VoiceCommon.RealtimeVoiceConfigSchema.parse({ sttUrl, ttsUrl, macOsSayFallback: false }),
);
// Query suffix = a fresh server module evaluated with the stub URLs above.
const server = (await import("./RealtimeVoiceServer.ts?breaker-test")) as typeof import("./RealtimeVoiceServer.ts");

afterAll(async () => {
  configSpy.mockRestore();
  await tts.stop(true);
});

describe("STT failures do not block TTS", () => {
  it("synthesizes speech after 6 STT connection failures on the same host", async () => {
    for (let i = 0; i < 6; i++) {
      const text = await server.transcribeAudio(new ArrayBuffer(16), "breaker-test");
      expect(text).toBeNull();
    }

    const audio = await server.synthesizeSpeech("Hello.", "af_heart", "breaker-test");
    expect(audio).not.toBeNull();
    expect(ttsHits).toBe(1);
  });
});
