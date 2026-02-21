#!/usr/bin/env bun
/**
 * Voice Server - Personal AI Voice notification server using Local TTS (mlx-audio / Kokoro)
 *
 * Standalone notification server (port 8888). Uses raw fetch() to call mlx-audio
 * at localhost:8880 -- this is acceptable because the VoiceServer is a standalone
 * server process, not a Kaya skill tool, and does not import CORE skill utilities.
 *
 * Endpoints:
 *   POST /notify  - Send a voice notification (supports voice_id, voice_settings)
 *   POST /pai     - Kaya default voice notification
 *   GET  /health  - Server health + mlx-audio status
 */

import { serve } from "bun";
import { spawn } from "child_process";
import { homedir } from "os";
import { join } from "path";
import { existsSync, readFileSync } from "fs";

// Load secrets from ~/.claude/secrets.json (preferred) or fallback to .env
const secretsPath = join(homedir(), '.claude', 'secrets.json');
const envPath = join(homedir(), '.claude', '.env');

if (existsSync(secretsPath)) {
  try {
    const secrets = JSON.parse(await Bun.file(secretsPath).text());
    Object.entries(secrets).forEach(([key, value]) => {
      if (typeof value === 'string' && !key.startsWith('$') && !key.startsWith('_')) {
        process.env[key] = value;
      }
    });
  } catch (err) {
    console.error('Failed to load secrets.json:', err);
  }
} else if (existsSync(envPath)) {
  // Fallback to .env for backwards compatibility
  const envContent = await Bun.file(envPath).text();
  envContent.split('\n').forEach(line => {
    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) return;
    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    // Strip surrounding quotes (single or double)
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && value && !key.startsWith('#')) {
      process.env[key] = value;
    }
  });
}

const PORT = parseInt(process.env.PORT || "8888");
const MLX_AUDIO_URL = "http://localhost:8880";

/** Map legacy ElevenLabs voice IDs and agent names to Kokoro voice IDs */
const VOICE_MAP: Record<string, string> = {
  // Legacy ElevenLabs voice IDs mapped to Kokoro equivalents
  "XrExE9yKIg1WjnnlVkGX": "af_heart",  // Kaya's old ElevenLabs voice ID
  // Kaya default
  "kaya": "af_heart",
  "default": "af_heart",
  // Agent personalities
  "architect": "am_adam",
  "engineer": "am_liam",
  "researcher": "af_bella",
};

// Load settings.json for DA identity and default voice
let daVoiceProsody: ProsodySettings | null = null;
let daName = "Kaya";
let daDefaultVoice = "af_heart";
try {
  const settingsPath = join(homedir(), '.claude', 'settings.json');
  if (existsSync(settingsPath)) {
    const settingsContent = readFileSync(settingsPath, 'utf-8');
    const settings = JSON.parse(settingsContent);
    if (settings.daidentity?.localVoice?.id) {
      daDefaultVoice = settings.daidentity.localVoice.id;
      console.log(`Loaded local voice ID from settings.json: ${daDefaultVoice}`);
    } else if (settings.daidentity?.voiceId) {
      // Legacy ElevenLabs ID - map to Kokoro
      const mapped = VOICE_MAP[settings.daidentity.voiceId];
      if (mapped) {
        daDefaultVoice = mapped;
        console.log(`Mapped legacy voice ID ${settings.daidentity.voiceId} -> ${mapped}`);
      }
    }
    if (settings.daidentity?.name) {
      daName = settings.daidentity.name;
    }
    if (settings.daidentity?.voice) {
      daVoiceProsody = settings.daidentity.voice as ProsodySettings;
      console.log(`Loaded DA voice prosody from settings.json`);
    }
  }
} catch (error) {
  console.warn('Failed to load DA voice settings from settings.json');
}

// Voice configuration types
interface ProsodySettings {
  stability: number;
  similarity_boost: number;
  style: number;
  speed: number;
  use_speaker_boost: boolean;
  volume?: number;
}

interface VoiceConfig {
  voice_id: string;
  voice_name: string;
  stability: number;
  similarity_boost: number;
  style?: number;
  speed?: number;
  use_speaker_boost?: boolean;
  prosody?: ProsodySettings;
  description: string;
  type: string;
}

interface VoicesConfig {
  voices: Record<string, VoiceConfig>;
}

// Default speed setting
const DEFAULT_SPEED = 1.1;

// Load voices configuration from CORE skill (canonical source for agent voices)
let voicesConfig: VoicesConfig | null = null;
try {
  const corePersonalitiesPath = join(homedir(), '.claude', 'skills', 'CORE', 'SYSTEM', 'AGENTPERSONALITIES.md');
  if (existsSync(corePersonalitiesPath)) {
    const markdownContent = readFileSync(corePersonalitiesPath, 'utf-8');
    // Extract JSON block from markdown
    const jsonMatch = markdownContent.match(/```json\n([\s\S]*?)\n```/);
    if (jsonMatch && jsonMatch[1]) {
      voicesConfig = JSON.parse(jsonMatch[1]);
      console.log('Loaded agent voice personalities from AGENTPERSONALITIES.md');
    }
  }
} catch (error) {
  console.warn('Failed to load agent voice personalities');
}

// Load user pronunciation customizations
let pronunciations: Record<string, string> = {};
try {
  const pronunciationsPath = join(homedir(), '.claude', 'skills', 'CORE', 'USER', 'pronunciations.json');
  if (existsSync(pronunciationsPath)) {
    const content = readFileSync(pronunciationsPath, 'utf-8');
    pronunciations = JSON.parse(content);
    console.log(`Loaded ${Object.keys(pronunciations).length} pronunciation(s) from USER config`);
  }
} catch (error) {
  console.warn('Failed to load pronunciation customizations');
}

// Apply pronunciation substitutions to text before TTS
function applyPronunciations(text: string): string {
  let result = text;
  for (const [term, pronunciation] of Object.entries(pronunciations)) {
    const regex = new RegExp(`\\b${term}\\b`, 'gi');
    result = result.replace(regex, pronunciation);
  }
  return result;
}

// Escape special characters for AppleScript
function escapeForAppleScript(input: string): string {
  return input.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// Strip any bracket markers from message (legacy cleanup)
function stripMarkers(message: string): string {
  return message.replace(/\[[^\]]*\]/g, '').trim();
}

// Get voice configuration by voice ID or agent name
function getVoiceConfig(identifier: string): VoiceConfig | null {
  if (!voicesConfig) return null;

  // Try direct agent name lookup
  if (voicesConfig.voices[identifier]) {
    return voicesConfig.voices[identifier];
  }

  // Try voice_id lookup
  for (const config of Object.values(voicesConfig.voices)) {
    if (config.voice_id === identifier) {
      return config;
    }
  }

  return null;
}

/**
 * Resolve a voice identifier to a Kokoro voice ID.
 * Handles legacy ElevenLabs IDs, agent names, and direct Kokoro IDs.
 */
function resolveVoice(identifier: string): string {
  // Check direct mapping (legacy ElevenLabs IDs and named presets)
  if (VOICE_MAP[identifier]) return VOICE_MAP[identifier];

  // Check agent personalities config - get voice_id, then map it
  const voiceConfig = getVoiceConfig(identifier);
  if (voiceConfig?.voice_id) {
    return VOICE_MAP[voiceConfig.voice_id] || voiceConfig.voice_id;
  }

  // If it looks like a Kokoro voice ID already (starts with af_, am_, bf_, bm_), use directly
  if (/^[ab][fm]_/.test(identifier)) return identifier;

  // Default to Kaya's voice
  return daDefaultVoice;
}

// Sanitize input for TTS and notifications
function sanitizeForSpeech(input: string): string {
  const cleaned = input
    .replace(/<script/gi, '')
    .replace(/\.\.\//g, '')
    .replace(/[;&|><`$\\]/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/#{1,6}\s+/g, '')
    .trim()
    .substring(0, 500);

  return cleaned;
}

// Validate user input
function validateInput(input: unknown): { valid: boolean; error?: string; sanitized?: string } {
  if (!input || typeof input !== 'string') {
    return { valid: false, error: 'Invalid input type' };
  }

  if (input.length > 500) {
    return { valid: false, error: 'Message too long (max 500 characters)' };
  }

  const sanitized = sanitizeForSpeech(input);

  if (!sanitized || sanitized.length === 0) {
    return { valid: false, error: 'Message contains no valid content after sanitization' };
  }

  return { valid: true, sanitized };
}

/**
 * Generate speech using local mlx-audio server (Kokoro TTS).
 *
 * Note: Uses raw fetch() because VoiceServer is a standalone server process,
 * not a Kaya skill tool. It does not import CORE utilities. This is intentional.
 */
async function generateSpeech(
  text: string,
  voiceId: string,
  prosody?: Partial<ProsodySettings>
): Promise<ArrayBuffer> {
  const voice = resolveVoice(voiceId);
  const speed = prosody?.speed ?? daVoiceProsody?.speed ?? DEFAULT_SPEED;

  const response = await fetch(`${MLX_AUDIO_URL}/v1/audio/speech`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: "prince-canuma/Kokoro-82M",
      input: text,
      voice: voice,
      response_format: "mp3",
      speed: speed,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`mlx-audio API error: ${response.status} - ${errorText}`);
  }

  return await response.arrayBuffer();
}

// Get volume setting from DA config or request (defaults to 1.0 = 100%)
function getVolumeSetting(requestVolume?: number): number {
  if (typeof requestVolume === 'number' && requestVolume >= 0 && requestVolume <= 1) {
    return requestVolume;
  }
  if (daVoiceProsody?.volume !== undefined && daVoiceProsody.volume >= 0 && daVoiceProsody.volume <= 1) {
    return daVoiceProsody.volume;
  }
  return 1.0;
}

// Play audio using afplay (macOS)
async function playAudio(audioBuffer: ArrayBuffer, requestVolume?: number): Promise<void> {
  const tempFile = `/tmp/voice-${Date.now()}.mp3`;

  await Bun.write(tempFile, audioBuffer);

  const volume = getVolumeSetting(requestVolume);

  return new Promise((resolve, reject) => {
    const proc = spawn('/usr/bin/afplay', ['-v', volume.toString(), tempFile]);

    proc.on('error', (error) => {
      console.error('Error playing audio:', error);
      reject(error);
    });

    proc.on('exit', (code) => {
      spawn('/bin/rm', [tempFile]);

      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`afplay exited with code ${code}`));
      }
    });
  });
}

// Spawn a process safely
function spawnSafe(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args);

    proc.on('error', (error) => {
      console.error(`Error spawning ${command}:`, error);
      reject(error);
    });

    proc.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code}`));
      }
    });
  });
}

// Send macOS notification with voice
async function sendNotification(
  title: string,
  message: string,
  voiceEnabled = true,
  voiceId: string | null = null,
  requestProsody?: Partial<ProsodySettings>
) {
  const titleValidation = validateInput(title);
  const messageValidation = validateInput(message);

  if (!titleValidation.valid) {
    throw new Error(`Invalid title: ${titleValidation.error}`);
  }

  if (!messageValidation.valid) {
    throw new Error(`Invalid message: ${messageValidation.error}`);
  }

  const safeTitle = titleValidation.sanitized!;
  let safeMessage = stripMarkers(messageValidation.sanitized!);

  if (voiceEnabled) {
    let usedFallback = false;

    try {
      const voice = voiceId || daDefaultVoice;

      // Get voice configuration (personality settings)
      const voiceConfig = getVoiceConfig(voice);

      // Build prosody: request > voice config > DA config > defaults
      let prosody: Partial<ProsodySettings> = {};

      if (voiceConfig) {
        if (voiceConfig.prosody) {
          prosody = voiceConfig.prosody;
        } else {
          prosody = {
            stability: voiceConfig.stability,
            similarity_boost: voiceConfig.similarity_boost,
            style: voiceConfig.style ?? 0.0,
            speed: voiceConfig.speed ?? DEFAULT_SPEED,
            use_speaker_boost: voiceConfig.use_speaker_boost ?? true,
          };
        }
        console.log(`Voice: ${voiceConfig.description}`);
      } else if (daVoiceProsody) {
        prosody = daVoiceProsody;
        console.log(`Voice: DA default (${daName})`);
      }

      if (requestProsody) {
        prosody = { ...prosody, ...requestProsody };
      }

      const speed = prosody.speed ?? DEFAULT_SPEED;
      const volume = (prosody as ProsodySettings & { volume?: number })?.volume ?? daVoiceProsody?.volume;
      console.log(`Generating speech (voice: ${voice}, speed: ${speed}, volume: ${volume ?? 1.0})`);

      const spokenMessage = applyPronunciations(safeMessage);
      const audioBuffer = await generateSpeech(spokenMessage, voice, prosody);
      await playAudio(audioBuffer, volume);
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error("mlx-audio TTS error:", errorMsg);
      console.warn("Using macOS say fallback");
      usedFallback = true;
    }

    // Fallback to macOS say command
    if (usedFallback) {
      try {
        const spokenMessage = applyPronunciations(safeMessage);
        console.log(`Using macOS say fallback`);
        await spawnSafe('/usr/bin/say', ['-v', 'Samantha', '-r', '180', spokenMessage]);
      } catch (fallbackError) {
        console.error("Fallback say also failed:", fallbackError);
      }
    }
  }

  // Display macOS notification
  try {
    const escapedTitle = escapeForAppleScript(safeTitle);
    const escapedMessage = escapeForAppleScript(safeMessage);
    const script = `display notification "${escapedMessage}" with title "${escapedTitle}" sound name ""`;
    await spawnSafe('/usr/bin/osascript', ['-e', script]);
  } catch (error) {
    console.error("Notification display error:", error);
  }
}

// Rate limiting
const requestCounts = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT = 10;
const RATE_WINDOW = 60000;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const record = requestCounts.get(ip);

  if (!record || now > record.resetTime) {
    requestCounts.set(ip, { count: 1, resetTime: now + RATE_WINDOW });
    return true;
  }

  if (record.count >= RATE_LIMIT) {
    return false;
  }

  record.count++;
  return true;
}

// Start HTTP server
const server = serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    const clientIp = req.headers.get('x-forwarded-for') || 'localhost';

    const corsHeaders = {
      "Access-Control-Allow-Origin": "http://localhost",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };

    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders, status: 204 });
    }

    if (!checkRateLimit(clientIp)) {
      return new Response(
        JSON.stringify({ status: "error", message: "Rate limit exceeded" }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 429
        }
      );
    }

    if (url.pathname === "/notify" && req.method === "POST") {
      try {
        const data = await req.json() as Record<string, unknown>;
        const title = (data.title as string) || "Kaya Notification";
        const message = (data.message as string) || "Task completed";
        const voiceEnabled = data.voice_enabled !== false;
        const voiceId = (data.voice_id as string | null) || (data.voice_name as string | null) || null;

        const voiceSettings: Partial<ProsodySettings> | undefined = data.voice_settings
          ? { ...(data.voice_settings as Partial<ProsodySettings>), volume: (data.volume as number | undefined) ?? (data.voice_settings as Partial<ProsodySettings> & { volume?: number }).volume }
          : data.volume !== undefined
            ? { volume: data.volume as number }
            : undefined;

        if (voiceId && typeof voiceId !== 'string') {
          throw new Error('Invalid voice_id');
        }

        console.log(`Notification: "${title}" - "${message}" (voice: ${voiceEnabled}, voiceId: ${voiceId || daDefaultVoice})`);

        await sendNotification(title, message, voiceEnabled, voiceId, voiceSettings);

        return new Response(
          JSON.stringify({ status: "success", message: "Notification sent" }),
          {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: 200
          }
        );
      } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : "Internal server error";
        console.error("Notification error:", error);
        return new Response(
          JSON.stringify({ status: "error", message: errMsg }),
          {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: errMsg.includes('Invalid') ? 400 : 500
          }
        );
      }
    }

    if (url.pathname === "/pai" && req.method === "POST") {
      try {
        const data = await req.json() as Record<string, unknown>;
        const title = (data.title as string) || "Kaya Assistant";
        const message = (data.message as string) || "Task completed";

        console.log(`Kaya notification: "${title}" - "${message}"`);

        await sendNotification(title, message, true, null);

        return new Response(
          JSON.stringify({ status: "success", message: "Kaya notification sent" }),
          {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: 200
          }
        );
      } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : "Internal server error";
        console.error("Kaya notification error:", error);
        return new Response(
          JSON.stringify({ status: "error", message: errMsg }),
          {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: errMsg.includes('Invalid') ? 400 : 500
          }
        );
      }
    }

    if (url.pathname === "/health") {
      // Test if mlx-audio is reachable
      let mlxHealthy = false;
      try {
        const check = await fetch(`${MLX_AUDIO_URL}/v1/models`, { signal: AbortSignal.timeout(2000) });
        mlxHealthy = check.ok;
      } catch { /* server unreachable */ }

      return new Response(
        JSON.stringify({
          status: mlxHealthy ? "healthy" : "degraded",
          port: PORT,
          voice_system: "mlx-audio (Kokoro-82M)",
          mlx_audio_url: MLX_AUDIO_URL,
          mlx_audio_healthy: mlxHealthy,
          default_voice: daDefaultVoice,
          fallback: "macOS say",
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 200
        }
      );
    }

    return new Response("Voice Server - POST to /notify or /pai", {
      headers: corsHeaders,
      status: 200
    });
  },
});

console.log(`Voice Server running on port ${PORT}`);
console.log(`Using local TTS: mlx-audio (Kokoro-82M) at ${MLX_AUDIO_URL}`);
console.log(`Default voice: ${daDefaultVoice}`);
console.log(`POST to http://localhost:${PORT}/notify`);
console.log(`Security: CORS restricted to localhost, rate limiting enabled`);
