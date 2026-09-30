#!/usr/bin/env bun
/**
 * VoiceCommon.ts - Shared utilities for VoiceInteraction skill
 *
 * Consolidates duplicated patterns across VoiceInteraction tools:
 * - Shared constants (paths, directories)
 * - Config loading via ConfigLoader (replaces raw JSON.parse(readFileSync()))
 * - Secrets loading (replaces raw JSON.parse(readFileSync(secrets.json)))
 * - StateManager instances for session, interruption, and schedule state
 * - Shared types used across multiple tools
 *
 * Usage:
 *   import { KAYA_HOME, TEMP_DIR, loadSecrets, getVoiceInteractionConfig, ... } from "./VoiceCommon.ts";
 */

import { existsSync, readFileSync, mkdirSync } from "fs";
import { join } from "path";
import { z } from "zod";
import { loadSettings } from "../../../../lib/core/ConfigLoader.ts";
import { createStateManager, type StateManager } from "../../../../lib/core/StateManager.ts";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";

// ============================================
// SHARED CONSTANTS
// ============================================

export const KAYA_HOME = getKayaHome();
export const TEMP_DIR = "/tmp/voice-interaction";

export const VOICE_INPUT_TOOL = join(KAYA_HOME, "lib/core/VoiceInput.ts");
export const VOICE_RESPONSE_TOOL = join(KAYA_HOME, "skills/Communication/VoiceInteraction/Tools/VoiceResponseGenerator.ts");
export const INTERRUPTION_TOOL = join(KAYA_HOME, "skills/Communication/VoiceInteraction/Tools/InterruptionHandler.ts");
export const INFERENCE_TOOL = join(KAYA_HOME, "lib/core/Inference.ts");
export const TELEGRAM_CLIENT = join(KAYA_HOME, "skills/Communication/Telegram/Tools/TelegramClient.ts");
export const DESKTOP_CLIENT = join(KAYA_HOME, "skills/Communication/VoiceInteraction/Tools/DesktopVoiceClient.ts");

// ============================================
// EXIT COMMANDS (shared across voice tools)
// ============================================

export const EXIT_COMMANDS = ["stop", "quit", "exit", "goodbye", "bye", "stop listening"];

/**
 * Check if user input matches an exit command.
 */
export function isExitCommand(input: string): boolean {
  const lower = input.toLowerCase();
  return EXIT_COMMANDS.some((cmd) => lower.includes(cmd));
}

// ============================================
// DIRECTORY SETUP
// ============================================

export function ensureTempDir(): void {
  if (!existsSync(TEMP_DIR)) {
    mkdirSync(TEMP_DIR, { recursive: true });
  }
}

// ============================================
// CUSTOMIZATION LOADING
// ============================================

const CUSTOMIZATION_DIR = join(KAYA_HOME, "USER/SKILLCUSTOMIZATIONS/VoiceInteraction");

/**
 * Typed shape of VoiceInteraction user customizations.
 * Known fields are typed; additional config keys are permitted as `unknown`.
 */
export interface VoiceCustomizations {
  preferencesContent?: string;
  voiceId?: string;
  speed?: number;
  volume?: number;
  systemPromptAppend?: string;
  mode?: string;
  whisperModel?: string;
  silenceThreshold?: number;
  silenceDuration?: number;
  maxDuration?: number;
  inferenceLevel?: string;
  allowCloudSTT?: boolean;
  allowCloudTTS?: boolean;
  [key: string]: unknown;
}

/**
 * Load user customizations from SKILLCUSTOMIZATIONS directory
 */
export function loadCustomizations(): VoiceCustomizations {
  if (!existsSync(CUSTOMIZATION_DIR)) return {};

  const prefs: VoiceCustomizations = {};

  // Load PREFERENCES.md if it exists
  const prefsPath = join(CUSTOMIZATION_DIR, "PREFERENCES.md");
  if (existsSync(prefsPath)) {
    prefs.preferencesContent = readFileSync(prefsPath, "utf-8");
  }

  // Load any JSON config overrides
  const configPath = join(CUSTOMIZATION_DIR, "config.json");
  if (existsSync(configPath)) {
    try {
      const configRaw = readFileSync(configPath, "utf-8");
      const overrides = JSON.parse(configRaw);
      Object.assign(prefs, overrides);
    } catch (err) {
      console.warn(
        `[VoiceCommon] config.json at ${configPath} is malformed — customizations not applied.`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  return prefs;
}

// ============================================
// CONFIG LOADING (replaces raw JSON.parse of settings.json)
// ============================================

/** Typed shape of the settings.json fields used by VoiceInteraction */
interface VoiceSettings {
  voiceInteraction?: {
    activation?: string;
    hotkey?: string;
    vadSensitivity?: number;
    silenceThreshold?: number;
    maxRecordingDuration?: number;
    whisperModel?: string;
    inferenceLevel?: string;
    autoPlayResponse?: boolean;
    silenceDuration?: number;
    allowCloudSTT?: boolean;
    allowCloudTTS?: boolean;
  };
  daidentity?: {
    name?: string;
    voice?: { stability?: number; similarity_boost?: number; style?: number; volume?: number; speed?: number };
    voiceId?: string;
    localVoice?: { id?: string; model?: string; speed?: number };
  };
  principal?: { name?: string };
}

/** Cast settings to typed shape (loadSettings returns Record<string, any>) */
function typedSettings(): VoiceSettings {
  return loadSettings() as VoiceSettings;
}

export interface VoiceInteractionConfig {
  mode: "push-to-talk" | "vad";
  whisperModel: string;
  silenceThreshold: number;
  silenceDuration: number;
  maxDuration: number;
  inferenceLevel: "fast" | "standard" | "smart";
  /**
   * Allow paid cloud STT (Gemini) as a fallback when local Whisper fails.
   * Default false — FREE is the hard constraint; Telegram voice messages
   * transcribe locally via Whisper instead of the Gemini API.
   */
  allowCloudSTT: boolean;
  /**
   * Allow paid cloud TTS (ElevenLabs) as a fallback when local Kokoro fails.
   * Default false — same FREE constraint as allowCloudSTT.
   */
  allowCloudTTS: boolean;
}

/**
 * Load voice interaction config from settings.json via ConfigLoader.
 * Merges with user customizations from SKILLCUSTOMIZATIONS.
 * Replaces raw JSON.parse(readFileSync(settings.json)) pattern.
 */
export function getVoiceInteractionConfig(): VoiceInteractionConfig {
  try {
    const settings = typedSettings();
    const vi = settings.voiceInteraction || {};

    // Load user customizations and merge
    const customizations = loadCustomizations();

    const modeRaw = customizations.mode;
    const mode: "push-to-talk" | "vad" =
      modeRaw === "push-to-talk" || modeRaw === "vad"
        ? modeRaw
        : vi.activation === "vad"
        ? "vad"
        : "push-to-talk";
    const inferenceRaw = customizations.inferenceLevel;
    const inferenceLevel: "fast" | "standard" | "smart" =
      inferenceRaw === "fast" || inferenceRaw === "standard" || inferenceRaw === "smart"
        ? inferenceRaw
        : (vi.inferenceLevel as "fast" | "standard" | "smart" | undefined) || "standard";
    return {
      mode,
      whisperModel: customizations.whisperModel ?? vi.whisperModel ?? "base.en",
      silenceThreshold: customizations.silenceThreshold ?? vi.silenceThreshold ?? 1.0,
      silenceDuration: customizations.silenceDuration ?? vi.silenceDuration ?? 1.5,
      maxDuration: customizations.maxDuration ?? vi.maxRecordingDuration ?? 120,
      inferenceLevel,
      allowCloudSTT: customizations.allowCloudSTT ?? vi.allowCloudSTT ?? false,
      allowCloudTTS: customizations.allowCloudTTS ?? vi.allowCloudTTS ?? false,
    };
  } catch {
    return {
      mode: "push-to-talk",
      whisperModel: "base.en",
      silenceThreshold: 1.0,
      silenceDuration: 1.5,
      maxDuration: 120,
      inferenceLevel: "standard",
      allowCloudSTT: false,
      allowCloudTTS: false,
    };
  }
}

/**
 * Load identity info (assistant name, user name) from settings.json via ConfigLoader.
 * Replaces raw JSON.parse(readFileSync(settings.json)) for identity lookups.
 */
export function getIdentity(): { assistantName: string; userName: string } {
  try {
    const settings = typedSettings();
    return {
      assistantName: settings.daidentity?.name || "Kaya",
      userName: settings.principal?.name || "Jm",
    };
  } catch {
    return { assistantName: "Kaya", userName: "Jm" };
  }
}

// ============================================
// SECRETS LOADING (replaces raw JSON.parse of secrets.json)
// ============================================

// Cache secrets with a TTL to support long-running servers (e.g., RealtimeVoiceServer).
// A 5-minute TTL means rotated credentials take effect within 5 minutes without restart.
const SECRETS_CACHE_TTL_MS = 5 * 60 * 1000;
let _cachedSecrets: Record<string, unknown> | null = null;
let _secretsCachedAt = 0;

/**
 * Load secrets from secrets.json with TTL-based caching.
 * Replaces raw JSON.parse(readFileSync(secrets.json)) pattern.
 * For long-running servers: cache expires every 5 minutes so rotated tokens
 * are picked up without requiring a process restart.
 */
export function loadSecrets(): Record<string, unknown> {
  const now = Date.now();
  if (_cachedSecrets && (now - _secretsCachedAt) < SECRETS_CACHE_TTL_MS) {
    return _cachedSecrets;
  }

  const secretsPath = join(KAYA_HOME, "secrets.json");
  if (!existsSync(secretsPath)) {
    throw new Error("secrets.json not found at " + secretsPath);
  }

  const secretsRaw = readFileSync(secretsPath, "utf-8");
  _cachedSecrets = JSON.parse(secretsRaw) as Record<string, unknown>;
  _secretsCachedAt = now;
  return _cachedSecrets;
}

/**
 * Get a specific secret by key. Throws if not found.
 */
export function getSecret(key: string): string {
  const secrets = loadSecrets();
  const value = secrets[key];
  if (!value || typeof value !== "string") {
    throw new Error(`${key} not found in secrets.json or is not a string`);
  }
  return value;
}

// ============================================
// LOCAL TTS CONFIG
// ============================================

/** Supported TTS model names */
export type TTSModel = "kokoro" | "chatterbox" | "qwen3-tts";

/** Local TTS configuration */
export interface LocalTTSConfig {
  voiceId: string;
  model: TTSModel;
  speed: number;
  volume: number;
  serverUrl: string;
}

/**
 * Load local TTS config from settings.json.
 * Falls back to sensible defaults if settings not found.
 */
export function getLocalTTSConfig(): LocalTTSConfig {
  try {
    const settings = typedSettings();
    const localVoice = settings.daidentity?.localVoice || {};
    const voiceSettings = settings.daidentity?.voice || {};
    return {
      voiceId: localVoice.id || "af_heart",
      model: (localVoice.model as TTSModel) || "kokoro",
      speed: localVoice.speed ?? voiceSettings.speed ?? 1.1,
      volume: voiceSettings.volume ?? 0.8,
      serverUrl: "http://localhost:8880",
    };
  } catch {
    return {
      voiceId: "af_heart",
      model: "kokoro",
      speed: 1.1,
      volume: 0.8,
      serverUrl: "http://localhost:8880",
    };
  }
}

// ============================================
// VOICE PRESET MAPPING
// ============================================

/**
 * Map voice preset names to Kokoro voice IDs.
 * Used in LocalTTSClient and VoiceServer.
 */
export const VOICE_PRESETS: Record<string, string> = {
  // Kaya's default voice
  kaya: "af_heart",
  default: "af_heart",
  // Agent voices
  architect: "am_adam",
  engineer: "am_liam",
  researcher: "af_bella",
};

/**
 * Resolve a voice ID or preset name to a Kokoro voice ID.
 * Returns the input unchanged if not found in VOICE_PRESETS.
 */
export function resolveVoiceId(voiceIdOrPreset: string): string {
  return VOICE_PRESETS[voiceIdOrPreset] || voiceIdOrPreset;
}

// ============================================
// REAL-TIME VOICE CONFIG
// ============================================

/** Real-time voice server configuration */
export interface RealtimeVoiceConfig {
  /** Port for WebSocket server */
  port: number;
  /** Bind address for WebSocket server. Defaults to loopback-only; the
   * `?key=` token auth and origin checks are the only access control, so
   * this must stay 127.0.0.1 unless a caller genuinely needs non-local
   * access (e.g. VOICE_SERVER_HOST). */
  host: string;
  /** Maximum concurrent WebSocket sessions */
  maxSessions: number;
  /** LLM API timeout in milliseconds */
  llmTimeoutMs: number;
  /** STT server URL */
  sttUrl: string;
  /** TTS server URL */
  ttsUrl: string;
  /** STT server health check URL */
  sttHealthUrl: string;
  /** TTS server health check URL */
  ttsHealthUrl: string;
  /** WebSocket heartbeat interval in milliseconds */
  heartbeatIntervalMs: number;
  /** Maximum heartbeat misses before declaring dead */
  heartbeatMaxMisses: number;
  /** Memory warning threshold in megabytes */
  memoryWarningMB: number;
  /** Context loading timeout in milliseconds */
  contextTimeoutMs: number;
  /** Enable macOS say TTS as fallback */
  macOsSayFallback: boolean;
  /** Path to a custom system prompt template (optional) */
  systemPromptTemplatePath: string | null;
  /** Maximum tokens for LLM response. Configurable via settings.json voice.maxTokens. Default 4096. */
  maxTokens: number;
}

export const RealtimeVoiceConfigSchema = z.object({
  port: z.number().default(8882),
  host: z.string().default("127.0.0.1"),
  maxSessions: z.number().default(5),
  llmTimeoutMs: z.number().default(15000),
  sttUrl: z.string().default("http://localhost:8881/v1/audio/transcriptions"),
  ttsUrl: z.string().default("http://localhost:8880/v1/audio/speech"),
  sttHealthUrl: z.string().default("http://localhost:8881/v1/audio/transcriptions"),
  ttsHealthUrl: z.string().default("http://localhost:8880/v1/models"),
  heartbeatIntervalMs: z.number().default(15000),
  heartbeatMaxMisses: z.number().default(2),
  memoryWarningMB: z.number().default(512),
  contextTimeoutMs: z.number().default(3000),
  macOsSayFallback: z.boolean().default(true),
  systemPromptTemplatePath: z.string().nullable().default(null),
  maxTokens: z.number().default(4096),
});

/** Load real-time voice config with defaults */
export function getRealtimeVoiceConfig(): RealtimeVoiceConfig {
  // Allow settings.json voice.maxTokens to override the default
  try {
    const rawSettings = loadSettings() as { voice?: { maxTokens?: number } };
    const maxTokensOverride = rawSettings.voice?.maxTokens;
    if (typeof maxTokensOverride === "number" && maxTokensOverride > 0) {
      return RealtimeVoiceConfigSchema.parse({ maxTokens: maxTokensOverride });
    }
  } catch {
    // Fall through to defaults
  }
  return RealtimeVoiceConfigSchema.parse({});
}

// ============================================
// STATE SCHEMAS & MANAGERS
// ============================================

// --- Conversation Session ---

export const ConversationMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  timestamp: z.string(),
});

export const ConversationSessionSchema = z.object({
  id: z.string(),
  startedAt: z.string(),
  messages: z.array(ConversationMessageSchema),
  turnCount: z.number(),
});

export type ConversationMessage = z.infer<typeof ConversationMessageSchema>;
export type ConversationSession = z.infer<typeof ConversationSessionSchema>;

let _sessionManager: StateManager<ConversationSession> | null = null;

export function getSessionManager(): StateManager<ConversationSession> {
  if (!_sessionManager) {
    _sessionManager = createStateManager({
      path: join(TEMP_DIR, "conversation-session.json"),
      schema: ConversationSessionSchema,
      defaults: () => ({
        id: `session-${Date.now()}`,
        startedAt: new Date().toISOString(),
        messages: [],
        turnCount: 0,
      }),
    });
  }
  return _sessionManager;
}

// --- Interruption State ---

export const ActiveResponseSchema = z.object({
  sessionId: z.string(),
  channel: z.enum(["desktop", "telegram"]),
  startedAt: z.string(),
  pid: z.number().optional(),
  audioFile: z.string().optional(),
});

export const InterruptionStateSchema = z.object({
  activeResponses: z.array(ActiveResponseSchema),
  lastInterruption: z.object({
    sessionId: z.string(),
    at: z.string(),
    reason: z.string(),
  }).optional(),
});

export type ActiveResponse = z.infer<typeof ActiveResponseSchema>;
export type InterruptionState = z.infer<typeof InterruptionStateSchema>;

let _interruptionManager: StateManager<InterruptionState> | null = null;

export function getInterruptionManager(): StateManager<InterruptionState> {
  if (!_interruptionManager) {
    _interruptionManager = createStateManager({
      path: join(TEMP_DIR, "active-responses.json"),
      schema: InterruptionStateSchema,
      defaults: { activeResponses: [] },
    });
  }
  return _interruptionManager;
}

// --- Scheduled Pings ---

export const ScheduledPingSchema = z.object({
  id: z.string(),
  message: z.string(),
  scheduledAt: z.string(),
  channel: z.enum(["desktop", "telegram", "auto"]).optional(),
  createdAt: z.string(),
  status: z.enum(["pending", "sent", "cancelled"]),
});

export const ScheduledPingsStateSchema = z.object({
  pings: z.array(ScheduledPingSchema),
});

export type ScheduledPing = z.infer<typeof ScheduledPingSchema>;
export type ScheduledPingsState = z.infer<typeof ScheduledPingsStateSchema>;

// --- Desktop Voice PID ---

export const DesktopPidSchema = z.object({
  pid: z.number().optional(),
  startedAt: z.string().optional(),
});

export type DesktopPidState = z.infer<typeof DesktopPidSchema>;

let _pidManager: StateManager<DesktopPidState> | null = null;

export function getPidManager(): StateManager<DesktopPidState> {
  if (!_pidManager) {
    _pidManager = createStateManager({
      path: join(TEMP_DIR, "desktop-voice-pid.json"),
      schema: DesktopPidSchema,
      defaults: {},
    });
  }
  return _pidManager;
}

// --- Scheduled Pings ---

let _pingsManager: StateManager<ScheduledPingsState> | null = null;

export function getPingsManager(): StateManager<ScheduledPingsState> {
  if (!_pingsManager) {
    _pingsManager = createStateManager({
      path: join(TEMP_DIR, "scheduled-pings.json"),
      schema: ScheduledPingsStateSchema,
      defaults: { pings: [] },
    });
  }
  return _pingsManager;
}
