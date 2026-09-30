#!/usr/bin/env bun
/**
 * VoiceInputProcessor.ts - Speech-to-Text processing for VoiceInteraction
 *
 * Unified STT interface supporting:
 * - Local Whisper (desktop + Telegram OGG buffers, free)
 * - Gemini API (opt-in cloud fallback via allowCloudSTT config, default off)
 *
 * Usage:
 *   bun VoiceInputProcessor.ts transcribe-file <path>            # Transcribe audio file (Whisper)
 *   bun VoiceInputProcessor.ts transcribe-buffer <base64>        # Transcribe base64 audio (local-first)
 *   bun VoiceInputProcessor.ts record-and-transcribe             # Record from mic + transcribe
 */

import { spawn, spawnSync } from "child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { httpClient } from "../../../../lib/core/CachedHTTPClient.ts";
import {
  KAYA_HOME,
  VOICE_INPUT_TOOL,
  ensureTempDir,
  getVoiceInteractionConfig,
  getSecret,
} from "./VoiceCommon.ts";
import { polishTranscription } from "./STTPolishPipeline.ts";
import { buildWhisperPrompt } from "./VocabularyStore.ts";

/**
 * Async spawn with timeout. Whisper runs take seconds — spawnSync here would
 * block the caller's event loop (e.g. the Telegram bot) for the whole run.
 */
function runCommand(
  cmd: string,
  args: string[],
  timeoutMs: number
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
        return;
      }
      resolve({ status, stdout, stderr });
    });
  });
}

interface TranscriptionResult {
  text: string;
  rawText?: string;          // Original Whisper output before polish
  source: "whisper" | "gemini";
  duration_ms: number;
  model?: string;
  confidence?: number;
  polishModel?: string;      // Which model polished (if any)
  polishDuration_ms?: number;
}

/**
 * Transcribe an audio file using local Whisper via VoiceInput CORE tool
 */
async function transcribeWithWhisper(
  audioPath: string,
  model?: string
): Promise<TranscriptionResult> {
  const config = getVoiceInteractionConfig();
  const whisperModel = model || config.whisperModel;
  const startTime = Date.now();

  // Use the extract-transcript.py script directly for file transcription
  const extractScript = join(KAYA_HOME, "lib/core/extract-transcript.py");

  const args = [
    "run", extractScript, audioPath,
    "--model", whisperModel,
    "--format", "txt",
  ];

  // Personal vocabulary priming — biases decoding toward Jm's domain terms
  const vocabPrompt = buildWhisperPrompt();
  if (vocabPrompt) {
    args.push("--initial-prompt", vocabPrompt);
  }

  const result = await runCommand("uv", args, 120000);

  if (result.status !== 0) {
    throw new Error(`Whisper transcription failed: ${result.stderr}`);
  }

  // Read transcript file
  const transcriptPath = audioPath.replace(/\.\w+$/, ".txt");
  if (!existsSync(transcriptPath)) {
    throw new Error("Transcript file not created after Whisper processing");
  }

  const rawText = readFileSync(transcriptPath, "utf-8").trim();
  try { unlinkSync(transcriptPath); } catch { /* ignore */ }

  // Polish the raw transcription (Whisper output only -- Gemini is already clean)
  const polishResult = await polishTranscription(rawText);

  return {
    text: polishResult.text,
    rawText: polishResult.rawText,
    source: "whisper",
    duration_ms: Date.now() - startTime,
    model: whisperModel,
    polishModel: polishResult.polished ? polishResult.model : undefined,
    polishDuration_ms: polishResult.duration_ms,
  };
}

/**
 * Transcribe audio buffer using Gemini API (for Telegram OGG messages)
 */
async function transcribeWithGemini(
  audioBase64: string,
  mimeType: string = "audio/ogg"
): Promise<TranscriptionResult> {
  const startTime = Date.now();
  const apiKey = getSecret("GEMINI_API_KEY");

  const response = await httpClient.fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
    {
      cache: 'none', // Don't cache transcriptions
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [
            {
              text: "Transcribe this audio message exactly. Return ONLY the transcription text, no commentary, formatting, or quotation marks.",
            },
            {
              inline_data: {
                mime_type: mimeType,
                data: audioBase64,
              },
            },
          ],
        }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 2048,
        },
      }),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gemini API error (${response.status}): ${error}`);
  }

  interface GeminiResponse {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
    }>;
  }

  const data: GeminiResponse = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";

  if (!text) {
    throw new Error("Gemini returned empty transcription");
  }

  return {
    text,
    source: "gemini",
    duration_ms: Date.now() - startTime,
    model: "gemini-1.5-flash",
  };
}

/**
 * Transcribe a base64 audio buffer (e.g. a Telegram OGG voice message).
 *
 * Local-first: writes the buffer to a temp file and runs local Whisper
 * (faster-whisper decodes OGG via ffmpeg) — zero API cost. The Gemini API
 * is only tried when Whisper fails AND allowCloudSTT is enabled in config
 * (default false; FREE is the hard constraint for personal infra).
 */
async function transcribeBuffer(
  audioBase64: string,
  mimeType: string = "audio/ogg"
): Promise<TranscriptionResult> {
  const config = getVoiceInteractionConfig();
  ensureTempDir();

  const ext = mimeType.includes("ogg") ? "ogg"
    : mimeType.includes("mp3") || mimeType.includes("mpeg") ? "mp3"
    : mimeType.includes("wav") ? "wav"
    : mimeType.includes("m4a") || mimeType.includes("mp4") ? "m4a"
    : "ogg";
  const tempPath = join("/tmp/voice-interaction", `buffer-${Date.now()}.${ext}`);

  try {
    writeFileSync(tempPath, Buffer.from(audioBase64, "base64"));
    return await transcribeWithWhisper(tempPath);
  } catch (whisperError) {
    if (config.allowCloudSTT) {
      console.error(
        `Local Whisper failed (${whisperError instanceof Error ? whisperError.message : whisperError}); falling back to Gemini (allowCloudSTT=true)`
      );
      return transcribeWithGemini(audioBase64, mimeType);
    }
    throw new Error(
      `Local Whisper transcription failed and cloud STT is disabled (set allowCloudSTT=true in VoiceInteraction config to allow the paid Gemini fallback): ${whisperError instanceof Error ? whisperError.message : whisperError}`
    );
  } finally {
    try { unlinkSync(tempPath); } catch { /* ignore */ }
  }
}

/**
 * Record from microphone and transcribe using local Whisper
 */
async function recordAndTranscribe(): Promise<TranscriptionResult> {
  const config = getVoiceInteractionConfig();

  // Use VoiceInput tool in "once" mode
  const result = spawnSync("bun", [
    VOICE_INPUT_TOOL, "once",
    "--json",
    `--model=${config.whisperModel}`,
    `--silence-threshold=${config.silenceThreshold}`,
    `--silence-duration=${config.silenceDuration}`,
    `--max-duration=${config.maxDuration}`,
  ], {
    encoding: "utf-8",
    timeout: (config.maxDuration + 30) * 1000,
  });

  if (result.status !== 0) {
    throw new Error(`Recording failed: ${result.stderr}`);
  }

  try {
    const parsed = JSON.parse(result.stdout);
    return {
      text: parsed.transcript,
      source: "whisper",
      duration_ms: 0,
      model: config.whisperModel,
    };
  } catch {
    // Fallback: raw text output
    const text = result.stdout.trim();
    if (!text) {
      throw new Error("No speech detected");
    }
    return {
      text,
      source: "whisper",
      duration_ms: 0,
      model: config.whisperModel,
    };
  }
}

// --- CLI ---

async function main() {
  const [command, ...args] = process.argv.slice(2);

  ensureTempDir();

  switch (command) {
    case "transcribe-file": {
      const filePath = args[0];
      if (!filePath || !existsSync(filePath)) {
        console.error("Usage: transcribe-file <path-to-audio>");
        process.exit(1);
      }
      const result = await transcribeWithWhisper(filePath, args[1]);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case "transcribe-buffer": {
      const base64 = args[0];
      const mime = args[1] || "audio/ogg";
      if (!base64) {
        console.error("Usage: transcribe-buffer <base64-audio> [mime-type]");
        process.exit(1);
      }
      const result = await transcribeBuffer(base64, mime);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case "record-and-transcribe": {
      const result = await recordAndTranscribe();
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    default:
      console.log(`VoiceInputProcessor - STT for VoiceInteraction

Commands:
  transcribe-file <path>       Transcribe audio file via local Whisper
  transcribe-buffer <b64>      Transcribe base64 audio (local Whisper; Gemini only if allowCloudSTT)
  record-and-transcribe        Record from mic + transcribe (Whisper)`);
      break;
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}

export { transcribeWithWhisper, transcribeWithGemini, transcribeBuffer, recordAndTranscribe };
export type { TranscriptionResult };
