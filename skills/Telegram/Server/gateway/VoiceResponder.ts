/**
 * VoiceResponder.ts - TTS voice response delivery for Telegram
 *
 * Extracts the voice line from Kaya responses and generates TTS audio
 * for delivery as a Telegram voice message.
 *
 * TTS Pipeline:
 * 1. Extract voice emoji line from response text
 * 2. Generate audio via local mlx-audio (localhost:8880)
 * 3. Fallback to ElevenLabs if local unavailable
 * 4. Convert to OGG format for Telegram voice messages
 * 5. Fall back to text-only if all TTS fails
 *
 * Phase 2 will add full bidirectional voice conversation support.
 * Phase 1 scaffolds the infrastructure and provides best-effort TTS.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const KAYA_HOME = process.env.HOME + "/.claude";

// TTS Configuration
const MLX_AUDIO_URL = "http://localhost:8880";
const MLX_AUDIO_TIMEOUT = 10000; // 10 seconds

// Cache ffmpeg availability check
let ffmpegAvailable: boolean | null = null;

/**
 * Check if ffmpeg is installed and available on PATH.
 * Caches the result after first check.
 */
function isFFmpegAvailable(): boolean {
  if (ffmpegAvailable !== null) return ffmpegAvailable;
  try {
    execSync("which ffmpeg", { stdio: "ignore" });
    ffmpegAvailable = true;
  } catch {
    ffmpegAvailable = false;
  }
  return ffmpegAvailable;
}

interface VoiceResult {
  /** Whether TTS audio was successfully generated */
  success: boolean;
  /** Audio buffer in OGG format (for Telegram voice message) */
  audioBuffer?: Buffer;
  /** The extracted voice line text */
  voiceLine: string;
  /** Which TTS engine was used */
  engine?: "mlx-audio" | "elevenlabs" | "none";
  /** Error message if TTS failed */
  error?: string;
}

/**
 * Extract the voice line from a Kaya response.
 * Looks for the speaking emoji pattern: "(speaking emoji) Kaya: ..."
 */
export function extractVoiceLine(responseText: string): string {
  // Match the voice line pattern with various speaking-related emojis
  const voiceLinePattern = /^[\uD83D\uDDE3\u{1F5E3}].*$/mu;
  const lines = responseText.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    // Check for common voice line prefixes
    if (
      trimmed.startsWith("\u{1F5E3}") || // speaking head emoji
      trimmed.startsWith("\uD83D\uDDE3") || // speaking head (surrogate pair)
      trimmed.match(/^[\u{1F3A4}\u{1F3A7}\u{1F4AC}\u{1F4E2}\u{1F5E3}]/u) // mic, headphones, speech bubble, megaphone, speaking head
    ) {
      // Extract just the text content after the emoji and optional name prefix
      const textContent = trimmed
        .replace(/^[^\w]*(?:Kaya|Assistant)\s*:\s*/i, "")
        .trim();
      return textContent || trimmed;
    }
  }

  // Fallback: return first sentence if no voice line found
  const firstSentence = responseText.split(/[.!?]\s/)[0];
  if (firstSentence && firstSentence.length <= 200) {
    return firstSentence.trim();
  }

  return "";
}

/**
 * Check if mlx-audio TTS server is available
 */
async function isMlxAudioAvailable(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);

    // mlx-audio has no /health — use root endpoint which returns a welcome message
    const response = await fetch(`${MLX_AUDIO_URL}/`, {
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Convert WAV buffer to OGG/Opus via ffmpeg (required for Telegram voice messages)
 */
function convertWavToOgg(wavBuffer: Buffer): Buffer | null {
  if (!isFFmpegAvailable()) {
    console.log("[VoiceResponder] ffmpeg not found - voice messages require ffmpeg for WAV→OGG conversion");
    return null;
  }

  const tmpWav = `/tmp/kaya-tts-${Date.now()}.wav`;
  const tmpOgg = `/tmp/kaya-tts-${Date.now()}.ogg`;
  try {
    writeFileSync(tmpWav, wavBuffer);
    execSync(`ffmpeg -y -i ${tmpWav} -c:a libopus -b:a 64k -f ogg ${tmpOgg} 2>/dev/null`);
    const oggBuffer = readFileSync(tmpOgg);
    return Buffer.from(oggBuffer);
  } catch (error) {
    console.error("[VoiceResponder] ffmpeg conversion failed:", error);
    return null;
  } finally {
    try { unlinkSync(tmpWav); } catch { /* ignore */ }
    try { unlinkSync(tmpOgg); } catch { /* ignore */ }
  }
}

/**
 * Generate TTS audio via mlx-audio local server (OpenAI-compatible API)
 * Returns OGG/Opus buffer suitable for Telegram voice messages
 */
async function generateMlxAudio(text: string): Promise<Buffer | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), MLX_AUDIO_TIMEOUT);

    // Generate WAV from mlx-audio (ogg/opus not natively supported)
    const response = await fetch(`${MLX_AUDIO_URL}/v1/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "prince-canuma/Kokoro-82M",
        input: text,
        voice: "af_heart",
        response_format: "wav",
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.error(`[VoiceResponder] mlx-audio error: ${response.status}`);
      return null;
    }

    const wavBuffer = Buffer.from(await response.arrayBuffer());

    // Convert WAV to OGG/Opus for Telegram
    return convertWavToOgg(wavBuffer);
  } catch (error) {
    console.error("[VoiceResponder] mlx-audio failed:", error);
    return null;
  }
}

/**
 * Generate TTS audio via ElevenLabs API (fallback)
 */
async function generateElevenLabsAudio(
  text: string,
  voiceId: string,
  apiKey: string
): Promise<Buffer | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "xi-api-key": apiKey,
        },
        body: JSON.stringify({
          text,
          model_id: "eleven_turbo_v2_5",
          output_format: "ogg_opus",
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
          },
        }),
        signal: controller.signal,
      }
    );

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.error(`[VoiceResponder] ElevenLabs error: ${response.status}`);
      return null;
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (error) {
    console.error("[VoiceResponder] ElevenLabs failed:", error);
    return null;
  }
}

/**
 * Load ElevenLabs configuration from secrets
 */
function loadElevenLabsConfig(): {
  apiKey: string;
  voiceId: string;
} | null {
  const secretsPath = join(KAYA_HOME, "secrets.json");
  if (!existsSync(secretsPath)) return null;

  try {
    const secrets = JSON.parse(readFileSync(secretsPath, "utf-8"));
    const apiKey = secrets.ELEVENLABS_API_KEY;
    if (!apiKey) {
      console.log("[VoiceResponder] ElevenLabs API key not found in secrets.json - ElevenLabs TTS unavailable");
      return null;
    }

    // Use Kaya's configured voice or default
    const settingsPath = join(KAYA_HOME, "settings.json");
    let voiceId = "iLVmqjzCGGvqtMCk6vVQ"; // Default voice

    if (existsSync(settingsPath)) {
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      voiceId = settings.daidentity?.voice_id || voiceId;
    }

    return { apiKey, voiceId };
  } catch {
    return null;
  }
}

/**
 * Generate voice response for a Kaya text response.
 *
 * Priority:
 * 1. Local mlx-audio (fastest, free)
 * 2. ElevenLabs API (higher quality, costs credits)
 * 3. Text-only fallback (no audio)
 */
export async function generateVoiceResponse(
  responseText: string
): Promise<VoiceResult> {
  const voiceLine = extractVoiceLine(responseText);

  if (!voiceLine) {
    return {
      success: false,
      voiceLine: "",
      engine: "none",
      error: "No voice line found in response",
    };
  }

  const ttsStart = Date.now();

  // Try mlx-audio first (local, fast)
  const mlxAvailable = await isMlxAudioAvailable();
  if (mlxAvailable) {
    const audio = await generateMlxAudio(voiceLine);
    if (audio) {
      const elapsed = Date.now() - ttsStart;
      console.log(
        `[VoiceResponder] Generated ${audio.length} bytes via mlx-audio in ${elapsed}ms`
      );
      return {
        success: true,
        audioBuffer: audio,
        voiceLine,
        engine: "mlx-audio",
      };
    }
  }

  // Try ElevenLabs (cloud fallback)
  const elevenLabsConfig = loadElevenLabsConfig();
  if (elevenLabsConfig) {
    const audio = await generateElevenLabsAudio(
      voiceLine,
      elevenLabsConfig.voiceId,
      elevenLabsConfig.apiKey
    );
    if (audio) {
      const elapsed = Date.now() - ttsStart;
      console.log(
        `[VoiceResponder] Generated ${audio.length} bytes via ElevenLabs in ${elapsed}ms`
      );
      return {
        success: true,
        audioBuffer: audio,
        voiceLine,
        engine: "elevenlabs",
      };
    }
  }

  // Text-only fallback
  const elapsed = Date.now() - ttsStart;
  console.log(`[VoiceResponder] No TTS available after ${elapsed}ms, text-only response`);
  return {
    success: false,
    voiceLine,
    engine: "none",
    error: "No TTS engine available",
  };
}
