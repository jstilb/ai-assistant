/**
 * VoiceInputProcessor.polishFallback.test.ts
 *
 * A polish failure must never lose the transcript. With a malformed secrets
 * file, cloud fallback on and Ollama down, polishTranscription() throws; the
 * Whisper path must return the raw transcript (and log the failure) instead
 * of propagating the throw.
 *
 * transcribeWithWhisper runs end to end against a fake `uv` on PATH that
 * writes the transcript file, so no real Whisper is needed. Hermetic:
 * KAYA_HOME is a mkdtemp dir; the polish mock delegates and is restored.
 */

import { describe, test, expect, mock, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpHome = mkdtempSync(join(tmpdir(), "vip-polish-"));
const binDir = join(tmpHome, "bin");
const prevHome = process.env.KAYA_HOME;
const prevPath = process.env.PATH;
process.env.KAYA_HOME = tmpHome;

// Fake `uv run <script> <audio> ...` — writes <audio-stem>.txt like extract-transcript.py.
await Bun.write(
  join(binDir, "uv"),
  `#!/bin/sh\naudio="$3"\nprintf '%s' "um so remind me to call mom tomorrow" > "\${audio%.*}.txt"\n`,
);
chmodSync(join(binDir, "uv"), 0o755);
process.env.PATH = `${binDir}:${prevPath}`;

import * as RealPolish from "./STTPolishPipeline.ts";
const realPolish = { ...RealPolish };

let polishImpl: typeof realPolish.polishTranscription = async () => {
  const err = new Error("secrets.json is not valid JSON");
  err.name = "SecretError";
  throw err;
};

mock.module("./STTPolishPipeline.ts", () => ({
  ...realPolish,
  polishTranscription: (...a: Parameters<typeof realPolish.polishTranscription>) => polishImpl(...a),
}));

const { transcribeWithWhisper, polishOrRaw } = await import("./VoiceInputProcessor.ts");

afterAll(() => {
  polishImpl = realPolish.polishTranscription;
  process.env.PATH = prevPath;
  if (prevHome === undefined) delete process.env.KAYA_HOME;
  else process.env.KAYA_HOME = prevHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

const failureLog = join(tmpHome, "MEMORY/MONITORING/failure-log.jsonl");
const polishFailures = () =>
  existsSync(failureLog)
    ? readFileSync(failureLog, "utf-8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((r) => r.source === "VoiceInputProcessor:polish")
    : [];

describe("transcribeWithWhisper keeps the transcript when polish throws", () => {
  test("polish failure returns the raw transcript and logs the failure", async () => {
    const audio = join(tmpHome, "note.ogg");
    writeFileSync(audio, "fake-audio");

    const result = await transcribeWithWhisper(audio, "base");

    expect(result.text).toBe("um so remind me to call mom tomorrow");
    expect(result.rawText).toBe("um so remind me to call mom tomorrow");
    expect(result.source).toBe("whisper");
    expect(result.polishModel).toBeUndefined();

    const rows = polishFailures();
    expect(rows.length).toBe(1);
    expect(rows[0].error.message).toContain("secrets.json is not valid JSON");
  });

  test("polishOrRaw passes a successful polish through untouched", async () => {
    const ok = await polishOrRaw("raw words here ok", async (t) => ({
      text: "Raw words here, OK.",
      rawText: t,
      polished: true,
      model: "test-model",
      duration_ms: 3,
      wordOverlap: 100,
    }));
    expect(ok.text).toBe("Raw words here, OK.");
    expect(ok.polished).toBe(true);
  });

  test("polishOrRaw returns raw text when polish throws", async () => {
    const out = await polishOrRaw("raw words here ok", async () => {
      throw new Error("ollama down");
    });
    expect(out).toMatchObject({ text: "raw words here ok", rawText: "raw words here ok", polished: false, model: "none" });
  });
});
