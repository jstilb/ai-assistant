#!/usr/bin/env bun
/**
 * VoiceResponseGenerator.ts - Text-to-Speech via Local mlx-audio for VoiceInteraction
 *
 * Generates voice responses using local Kokoro TTS (via LocalTTSClient).
 * Replaced ElevenLabs streaming/batch with a single local TTS path.
 * All exported function signatures are preserved for backward compatibility.
 *
 * Usage:
 *   bun VoiceResponseGenerator.ts speak "Hello Jm"             # Generate + play
 *   bun VoiceResponseGenerator.ts generate "text" [output.mp3]  # Generate to file
 *   bun VoiceResponseGenerator.ts telegram "text" [output.ogg]  # Generate for Telegram
 *   bun VoiceResponseGenerator.ts stop                           # Stop current playback
 */

import { spawnSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import {
  generateSpeech as localGenerateSpeech,
  type TTSOptions,
} from "./LocalTTSClient.ts";
import {
  TEMP_DIR,
  ensureTempDir,
  getLocalTTSConfig,
  resolveVoiceId,
} from "./VoiceCommon.ts";

// Kept for backward compatibility with any code that imports this constant
const STREAMING_TTFB_TIMEOUT_MS = 2000;

interface GenerationResult {
  outputPath: string;
  duration_ms: number;
  size_bytes: number;
  format: "mp3" | "ogg";
  streaming?: boolean;
  ttfb_ms?: number;
}

/**
 * Generate speech audio using local TTS.
 * Replaces the ElevenLabs batch API call.
 *
 * @param text - Text to convert to speech
 * @param outputFormat - Format string (mp3_44100_128 or ogg_vorbis for legacy compat)
 */
async function generateSpeech(
  text: string,
  outputFormat: "mp3_44100_128" | "ogg_vorbis" = "mp3_44100_128"
): Promise<Buffer> {
  const format = outputFormat === "ogg_vorbis" ? "wav" : "mp3";
  const config = getLocalTTSConfig();
  const voice = resolveVoiceId(config.voiceId);

  const result = await localGenerateSpeech(text, {
    format: format as "mp3" | "wav",
    voice,
  });
  return result.audio;
}

/**
 * Generate speech and save to file.
 * Local TTS returns the full audio in one response (no streaming concern).
 */
async function generateSpeechLocal(
  text: string,
  outputPath: string
): Promise<{ size_bytes: number; duration_ms: number; usedFallback: boolean }> {
  const result = await localGenerateSpeech(text);

  if (result.audio.length > 0) {
    writeFileSync(outputPath, result.audio);
  }

  return {
    size_bytes: result.size_bytes,
    duration_ms: result.duration_ms,
    usedFallback: result.usedFallback,
  };
}

/**
 * Generate speech and save to file (public API - batch mode compatible).
 */
async function generateToFile(
  text: string,
  outputPath?: string,
  format: "mp3" | "ogg" = "mp3"
): Promise<GenerationResult> {
  const startTime = Date.now();
  // mlx-audio supports mp3 and wav but not ogg natively.
  // For ogg requests, generate wav locally (Telegram compatibility note in spec).
  const ttsFormat = format === "ogg" ? "wav" : "mp3";
  const ext = format === "ogg" ? ".ogg" : ".mp3";

  const finalPath = outputPath || join(TEMP_DIR, `response-${Date.now()}${ext}`);

  const result = await localGenerateSpeech(text, {
    format: ttsFormat as "mp3" | "wav",
  });

  writeFileSync(finalPath, result.audio);

  return {
    outputPath: finalPath,
    duration_ms: Date.now() - startTime,
    size_bytes: result.size_bytes,
    format,
    streaming: false,
  };
}

/**
 * Generate speech and play through system speakers.
 * Uses local TTS (no streaming needed for local server).
 *
 * @param text - Text to speak
 * @param forceBatch - Ignored (kept for backward compatibility)
 */
async function speakText(text: string, forceBatch = false): Promise<GenerationResult> {
  const startTime = Date.now();
  const outputPath = join(TEMP_DIR, `response-${Date.now()}.mp3`);

  const streamResult = await generateSpeechLocal(text, outputPath);

  // Play using afplay (macOS)
  const play = spawnSync("afplay", [outputPath], { timeout: 60000 });
  if (play.status !== 0) {
    console.error(`Playback failed: ${play.stderr?.toString()}`);
  }

  // Clean up temp file
  try { unlinkSync(outputPath); } catch { /* ignore */ }

  return {
    outputPath,
    duration_ms: Date.now() - startTime,
    size_bytes: streamResult.size_bytes,
    format: "mp3",
    streaming: false,
  };
}

/**
 * Generate OGG audio suitable for Telegram voice messages.
 * Note: mlx-audio outputs wav for non-mp3 formats.
 * If Telegram requires strict OGG, use ffmpeg externally.
 */
async function generateForTelegram(
  text: string,
  outputPath?: string
): Promise<GenerationResult> {
  return generateToFile(text, outputPath, "ogg");
}

/**
 * Stop any currently playing audio (for interruption handling).
 */
function stopPlayback(): boolean {
  const result = spawnSync("pkill", ["-f", "afplay"], {
    encoding: "utf-8",
  });
  return result.status === 0;
}

// --- CLI ---

async function main() {
  const [command, ...args] = process.argv.slice(2);

  ensureTempDir();

  switch (command) {
    case "speak": {
      const forceBatch = args.includes("--batch");
      const text = args.filter((a) => a !== "--batch").join(" ");
      if (!text) {
        console.error("Usage: speak [--batch] <text>");
        process.exit(1);
      }
      const result = await speakText(text, forceBatch);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case "generate": {
      const text = args[0];
      const outputPath = args[1];
      if (!text) {
        console.error("Usage: generate <text> [output-path]");
        process.exit(1);
      }
      const result = await generateToFile(text, outputPath, "mp3");
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case "telegram": {
      const text = args[0];
      const outputPath = args[1];
      if (!text) {
        console.error("Usage: telegram <text> [output-path.ogg]");
        process.exit(1);
      }
      const result = await generateForTelegram(text, outputPath);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case "stop": {
      const stopped = stopPlayback();
      console.log(JSON.stringify({ stopped }));
      break;
    }

    default:
      console.log(`VoiceResponseGenerator - TTS via Local mlx-audio (Kokoro)

Commands:
  speak [--batch] <text>         Generate + play (--batch flag ignored, local is always fast)
  generate <text> [output.mp3]   Generate to MP3 file
  telegram <text> [output.ogg]   Generate audio for Telegram voice
  stop                           Stop current playback`);
      break;
  }
}

main().catch((err: Error) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});

export {
  generateToFile,
  speakText,
  generateForTelegram,
  stopPlayback,
  STREAMING_TTFB_TIMEOUT_MS,
  generateSpeech as generateSpeechStreaming,
};
export type { TTSOptions as VoiceConfig, GenerationResult };
