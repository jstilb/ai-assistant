#!/usr/bin/env bun
/**
 * LocalTTSClient.ts - Local TTS via mlx-audio (Kokoro-82M)
 *
 * Replaces StreamingTTSClient + batch-fallback with a single client that
 * targets the mlx-audio server at localhost:8880 (OpenAI-compatible API).
 *
 * Features:
 * - CachedHTTPClient for all HTTP calls (no raw fetch)
 * - StateManager for config persistence
 * - Supports kokoro, chatterbox, qwen3-tts models
 * - Falls back to macOS `say` when mlx-audio is unreachable
 * - generateSpeechBatch compatibility wrapper for legacy callers
 *
 * Usage:
 *   bun LocalTTSClient.ts speak "Hello User"
 *   bun LocalTTSClient.ts health
 *   bun LocalTTSClient.ts status
 *   bun LocalTTSClient.ts set-voice af_heart
 *   bun LocalTTSClient.ts set-model kokoro
 */

import { z } from "zod";
import { createStateManager, type StateManager } from "../../CORE/Tools/StateManager.ts";
import { httpClient } from "../../CORE/Tools/CachedHTTPClient.ts";

// ============================================
// CONSTANTS
// ============================================

/** Default mlx-audio server URL */
const DEFAULT_MLX_AUDIO_URL = "http://localhost:8880";

/** OpenAI-compatible speech endpoint */
const SPEECH_ENDPOINT = "/v1/audio/speech";

/** Default timeout for TTS generation (ms) */
const DEFAULT_TIMEOUT_MS = 15000;

/** State file path for local TTS configuration */
const LOCAL_TTS_STATE_PATH = "/tmp/voice-interaction/local-tts-config.json";

// ============================================
// TYPES
// ============================================

/** Supported TTS models */
export type TTSModel = "kokoro" | "chatterbox" | "qwen3-tts";

/** Model ID mapping */
const MODEL_IDS: Record<TTSModel, string> = {
  kokoro: "prince-canuma/Kokoro-82M",
  chatterbox: "chatterbox-turbo",        // Update when MLX version available
  "qwen3-tts": "Qwen/Qwen3-TTS-0.6B",   // Update when MLX version available
};

/** TTS generation result */
export interface TTSResult {
  /** Audio data as Buffer */
  audio: Buffer;
  /** Size in bytes */
  size_bytes: number;
  /** Generation time in milliseconds */
  duration_ms: number;
  /** Audio format */
  format: "mp3" | "wav";
  /** Which model was used */
  model: TTSModel;
  /** Whether macOS say fallback was used */
  usedFallback: boolean;
}

/** TTS generation options */
export interface TTSOptions {
  /** Voice ID from Kokoro's voice set (default: from config) */
  voice?: string;
  /** TTS model to use (default: kokoro) */
  model?: TTSModel;
  /** Speech speed multiplier (default: 1.1) */
  speed?: number;
  /** Output format (default: mp3) */
  format?: "mp3" | "wav";
  /** Timeout in ms (default: 15000) */
  timeout?: number;
}

/** Streaming stats for compatibility with existing code */
export interface StreamingStats {
  totalChunks: number;
  totalBytes: number;
  ttfb_ms: number;
  duration_ms: number;
  usedFallback: boolean;
}

// ============================================
// STATE SCHEMA
// ============================================

const LocalTTSConfigSchema = z.object({
  /** Whether local TTS is enabled */
  enabled: z.boolean(),
  /** mlx-audio server URL */
  serverUrl: z.string(),
  /** Default model */
  defaultModel: z.enum(["kokoro", "chatterbox", "qwen3-tts"]),
  /** Default voice ID */
  defaultVoice: z.string(),
  /** Default speed */
  defaultSpeed: z.number(),
  /** Timeout in ms */
  timeoutMs: z.number(),
  /** Total requests counter */
  totalRequests: z.number(),
  /** Total fallback activations */
  totalFallbacks: z.number(),
  /** Last updated */
  lastUpdated: z.string(),
});

type LocalTTSConfig = z.infer<typeof LocalTTSConfigSchema>;

// ============================================
// STATE MANAGER (singleton)
// ============================================

let _configManager: StateManager<LocalTTSConfig> | null = null;

function getConfigManager(): StateManager<LocalTTSConfig> {
  if (!_configManager) {
    _configManager = createStateManager({
      path: LOCAL_TTS_STATE_PATH,
      schema: LocalTTSConfigSchema,
      defaults: {
        enabled: true,
        serverUrl: DEFAULT_MLX_AUDIO_URL,
        defaultModel: "kokoro",
        defaultVoice: "af_heart",
        defaultSpeed: 1.1,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        totalRequests: 0,
        totalFallbacks: 0,
        lastUpdated: new Date().toISOString(),
      },
    });
  }
  return _configManager;
}

// ============================================
// PUBLIC API
// ============================================

/**
 * Generate speech audio via local mlx-audio server.
 *
 * Uses CachedHTTPClient (no raw fetch) per Kaya conventions.
 * Falls back to macOS `say` if the local server is unreachable.
 *
 * @param text - Text to convert to speech
 * @param options - TTS options (voice, model, speed, format, timeout)
 * @returns TTSResult with audio Buffer and metadata
 */
export async function generateSpeech(
  text: string,
  options: TTSOptions = {}
): Promise<TTSResult> {
  const manager = getConfigManager();
  const config = await manager.load();

  // If disabled, go straight to fallback
  if (!config.enabled) {
    return generateFallbackSpeech(text, Date.now());
  }

  // Track request
  await manager.update((c) => ({
    ...c,
    totalRequests: c.totalRequests + 1,
    lastUpdated: new Date().toISOString(),
  }));

  const model = options.model ?? config.defaultModel;
  const voice = options.voice ?? config.defaultVoice;
  const speed = options.speed ?? config.defaultSpeed;
  const format = options.format ?? "mp3";
  const timeout = options.timeout ?? config.timeoutMs;
  const serverUrl = config.serverUrl;

  const startTime = Date.now();

  try {
    const response = await httpClient.fetch(
      `${serverUrl}${SPEECH_ENDPOINT}`,
      {
        cache: "none",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODEL_IDS[model],
          input: text,
          voice: voice,
          response_format: format,
          speed: speed,
        }),
        timeout: timeout,
      }
    );

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`mlx-audio API error (${response.status}): ${errorBody}`);
    }

    const audioBuffer = Buffer.from(await response.arrayBuffer());

    return {
      audio: audioBuffer,
      size_bytes: audioBuffer.length,
      duration_ms: Date.now() - startTime,
      format,
      model,
      usedFallback: false,
    };
  } catch (err: unknown) {
    // Fallback to macOS say
    console.error(`Local TTS failed: ${err instanceof Error ? err.message : err}`);
    return generateFallbackSpeech(text, startTime);
  }
}

/**
 * Generate speech using macOS `say` command as emergency fallback.
 */
async function generateFallbackSpeech(
  text: string,
  startTime: number
): Promise<TTSResult> {
  const manager = getConfigManager();
  await manager.update((c) => ({
    ...c,
    totalFallbacks: c.totalFallbacks + 1,
  }));

  const { spawnSync } = await import("child_process");
  const { mkdirSync, existsSync } = await import("fs");

  const tmpDir = "/tmp/voice-interaction";
  if (!existsSync(tmpDir)) {
    mkdirSync(tmpDir, { recursive: true });
  }

  const outputPath = `${tmpDir}/fallback-${Date.now()}.aiff`;

  const result = spawnSync("/usr/bin/say", [
    "-v", "Samantha",
    "-r", "180",
    "-o", outputPath,
    "--data-format=LEF32@22050",
    text,
  ], { timeout: 30000 });

  if (result.status !== 0) {
    throw new Error("macOS say fallback also failed");
  }

  const { readFileSync, unlinkSync } = await import("fs");
  const audioBuffer = Buffer.from(readFileSync(outputPath));

  // Cleanup
  try {
    unlinkSync(outputPath);
  } catch { /* ignore */ }

  return {
    audio: audioBuffer,
    size_bytes: audioBuffer.length,
    duration_ms: Date.now() - startTime,
    format: "wav",
    model: "kokoro",
    usedFallback: true,
  };
}

/**
 * Check if the local TTS server is reachable.
 */
export async function isServerHealthy(): Promise<boolean> {
  const manager = getConfigManager();
  const config = await manager.load();

  try {
    const response = await httpClient.fetch(
      `${config.serverUrl}/v1/models`,
      { cache: "none", timeout: 3000 }
    );
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Get current configuration.
 */
export async function getConfig(): Promise<LocalTTSConfig> {
  const manager = getConfigManager();
  return manager.load();
}

/**
 * Update configuration.
 */
export async function updateConfig(
  updates: Partial<LocalTTSConfig>
): Promise<void> {
  const manager = getConfigManager();
  await manager.update((config) => ({
    ...config,
    ...updates,
    lastUpdated: new Date().toISOString(),
  }));
}

/**
 * Compatibility wrapper: generateSpeechBatch for code that imports from batch-fallback.
 * Drop-in replacement signature.
 */
export async function generateSpeechBatch(
  text: string,
  _outputFormat?: string
): Promise<{ audio: Buffer; size_bytes: number; duration_ms: number; format: "mp3" | "ogg" }> {
  const result = await generateSpeech(text, { format: "mp3" });
  return {
    audio: result.audio,
    size_bytes: result.size_bytes,
    duration_ms: result.duration_ms,
    format: "mp3",
  };
}

// ============================================
// CLI INTERFACE
// ============================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case "speak": {
      const text = args.slice(1).join(" ");
      if (!text) {
        console.error("Usage: speak <text>");
        process.exit(1);
      }
      const { writeFileSync, unlinkSync } = await import("fs");
      const { spawnSync } = await import("child_process");
      const { mkdirSync, existsSync } = await import("fs");

      const tmpDir = "/tmp/voice-interaction";
      if (!existsSync(tmpDir)) {
        mkdirSync(tmpDir, { recursive: true });
      }

      const result = await generateSpeech(text);
      const ext = result.format === "wav" ? "wav" : "mp3";
      const tempPath = `${tmpDir}/tts-${Date.now()}.${ext}`;
      writeFileSync(tempPath, result.audio);
      spawnSync("afplay", [tempPath], { timeout: 60000 });
      try { unlinkSync(tempPath); } catch { /* ignore */ }
      console.log(JSON.stringify({ ...result, audio: `<${result.size_bytes} bytes>` }, null, 2));
      break;
    }

    case "health": {
      const healthy = await isServerHealthy();
      const config = await getConfig();
      console.log(JSON.stringify({ healthy, ...config }, null, 2));
      break;
    }

    case "status": {
      const config = await getConfig();
      console.log(JSON.stringify(config, null, 2));
      break;
    }

    case "set-voice": {
      const voice = args[1];
      if (!voice) {
        console.error("Usage: set-voice <voice-id>");
        process.exit(1);
      }
      await updateConfig({ defaultVoice: voice });
      console.log(JSON.stringify({ voice }));
      break;
    }

    case "set-model": {
      const model = args[1] as TTSModel;
      if (!model || !MODEL_IDS[model]) {
        console.error("Usage: set-model <kokoro|chatterbox|qwen3-tts>");
        process.exit(1);
      }
      await updateConfig({ defaultModel: model });
      console.log(JSON.stringify({ model }));
      break;
    }

    default:
      console.log(`LocalTTSClient - Local TTS via mlx-audio

Commands:
  speak <text>              Generate + play speech
  health                    Check server health + config
  status                    Show current configuration
  set-voice <voice-id>      Set default voice (e.g., af_heart)
  set-model <model>         Set default model (kokoro, chatterbox, qwen3-tts)`);
      break;
  }
}

if (import.meta.main) {
  main().catch((err: Error) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}
