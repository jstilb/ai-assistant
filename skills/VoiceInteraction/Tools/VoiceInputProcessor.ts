#!/usr/bin/env bun
/**
 * VoiceInputProcessor.ts - Speech-to-Text processing for VoiceInteraction
 *
 * Unified STT interface supporting:
 * - Local Whisper (desktop, low-latency)
 * - Gemini API (Telegram OGG voice messages)
 *
 * Usage:
 *   bun VoiceInputProcessor.ts transcribe-file <path>            # Transcribe audio file (Whisper)
 *   bun VoiceInputProcessor.ts transcribe-buffer <base64>        # Transcribe base64 audio (Gemini)
 *   bun VoiceInputProcessor.ts record-and-transcribe             # Record from mic + transcribe
 */

import { spawnSync } from "child_process";
import { existsSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";
import { httpClient } from "../../CORE/Tools/CachedHTTPClient.ts";
import {
  KAYA_HOME,
  VOICE_INPUT_TOOL,
  ensureTempDir,
  getVoiceInteractionConfig,
  getSecret,
} from "./VoiceCommon.ts";
import { polishTranscription } from "./STTPolishPipeline.ts";

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
  const extractScript = join(KAYA_HOME, "skills/CORE/Tools/extract-transcript.py");

  const result = spawnSync("uv", [
    "run", extractScript, audioPath,
    "--model", whisperModel,
    "--format", "txt",
  ], {
    encoding: "utf-8",
    timeout: 120000,
    maxBuffer: 10 * 1024 * 1024,
  });

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

  const data = await response.json() as any;
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
      const result = await transcribeWithGemini(base64, mime);
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
  transcribe-buffer <b64>      Transcribe base64 audio via Gemini
  record-and-transcribe        Record from mic + transcribe (Whisper)`);
      break;
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});

export { transcribeWithWhisper, transcribeWithGemini, recordAndTranscribe };
export type { TranscriptionResult };
