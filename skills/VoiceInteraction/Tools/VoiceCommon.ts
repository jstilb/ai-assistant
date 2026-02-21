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
import { loadSettings } from "../../CORE/Tools/ConfigLoader.ts";
import { createStateManager, type StateManager } from "../../CORE/Tools/StateManager.ts";

// ============================================
// SHARED CONSTANTS
// ============================================

export const KAYA_HOME = process.env.HOME + "/.claude";
export const TEMP_DIR = "/tmp/voice-interaction";

export const VOICE_INPUT_TOOL = join(KAYA_HOME, "skills/CORE/Tools/VoiceInput.ts");
export const VOICE_RESPONSE_TOOL = join(KAYA_HOME, "skills/VoiceInteraction/Tools/VoiceResponseGenerator.ts");
export const INTERRUPTION_TOOL = join(KAYA_HOME, "skills/VoiceInteraction/Tools/InterruptionHandler.ts");
export const INFERENCE_TOOL = join(KAYA_HOME, "skills/CORE/Tools/Inference.ts");
export const TELEGRAM_CLIENT = join(KAYA_HOME, "skills/Telegram/Tools/TelegramClient.ts");
export const DESKTOP_CLIENT = join(KAYA_HOME, "skills/VoiceInteraction/Tools/DesktopVoiceClient.ts");

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

const CUSTOMIZATION_DIR = join(KAYA_HOME, "skills/CORE/USER/SKILLCUSTOMIZATIONS/VoiceInteraction");

/**
 * Load user customizations from SKILLCUSTOMIZATIONS directory
 */
export function loadCustomizations(): Record<string, any> {
  if (!existsSync(CUSTOMIZATION_DIR)) return {};

  const prefs: Record<string, any> = {};

  // Load PREFERENCES.md if it exists
  const prefsPath = join(CUSTOMIZATION_DIR, "PREFERENCES.md");
  if (existsSync(prefsPath)) {
    prefs.preferencesContent = readFileSync(prefsPath, "utf-8");
  }

  // Load any JSON config overrides
  const configPath = join(CUSTOMIZATION_DIR, "config.json");
  if (existsSync(configPath)) {
    try {
      const overrides = JSON.parse(readFileSync(configPath, "utf-8"));
      Object.assign(prefs, overrides);
    } catch {
      // Skip malformed JSON
    }
  }

  return prefs;
}

// ============================================
// CONFIG LOADING (replaces raw JSON.parse of settings.json)
// ============================================

export interface VoiceInteractionConfig {
  mode: "push-to-talk" | "vad";
  whisperModel: string;
  silenceThreshold: number;
  silenceDuration: number;
  maxDuration: number;
  inferenceLevel: "fast" | "standard" | "smart";
}

/**
 * Load voice interaction config from settings.json via ConfigLoader.
 * Merges with user customizations from SKILLCUSTOMIZATIONS.
 * Replaces raw JSON.parse(readFileSync(settings.json)) pattern.
 */
export function getVoiceInteractionConfig(): VoiceInteractionConfig {
  try {
    const settings = loadSettings();
    const vi = (settings as any).voiceInteraction || {};

    // Load user customizations and merge
    const customizations = loadCustomizations();

    return {
      mode: (customizations.mode as "push-to-talk" | "vad") || (vi.activation === "vad" ? "vad" : "push-to-talk"),
      whisperModel: (customizations.whisperModel as string) || vi.whisperModel || "base.en",
      silenceThreshold: (customizations.silenceThreshold as number) || vi.silenceThreshold || 1.0,
      silenceDuration: (customizations.silenceDuration as number) || vi.silenceDuration || 1.5,
      maxDuration: (customizations.maxDuration as number) || vi.maxRecordingDuration || 120,
      inferenceLevel: (customizations.inferenceLevel as "fast" | "standard" | "smart") || vi.inferenceLevel || "standard",
    };
  } catch {
    return {
      mode: "push-to-talk",
      whisperModel: "base.en",
      silenceThreshold: 1.0,
      silenceDuration: 1.5,
      maxDuration: 120,
      inferenceLevel: "standard",
    };
  }
}

/**
 * Load identity info (assistant name, user name) from settings.json via ConfigLoader.
 * Replaces raw JSON.parse(readFileSync(settings.json)) for identity lookups.
 */
export function getIdentity(): { assistantName: string; userName: string } {
  try {
    const settings = loadSettings();
    return {
      assistantName: (settings as any).daidentity?.name || "Kaya",
      userName: (settings as any).principal?.name || "User",
    };
  } catch {
    return { assistantName: "Kaya", userName: "User" };
  }
}

// ============================================
// SECRETS LOADING (replaces raw JSON.parse of secrets.json)
// ============================================

// Cache secrets to avoid repeated file reads within the same process
let _cachedSecrets: Record<string, any> | null = null;

/**
 * Load secrets from secrets.json with caching.
 * Replaces raw JSON.parse(readFileSync(secrets.json)) pattern.
 */
export function loadSecrets(): Record<string, any> {
  if (_cachedSecrets) return _cachedSecrets;

  const secretsPath = join(KAYA_HOME, "secrets.json");
  if (!existsSync(secretsPath)) {
    throw new Error("secrets.json not found at " + secretsPath);
  }

  _cachedSecrets = JSON.parse(readFileSync(secretsPath, "utf-8"));
  return _cachedSecrets!;
}

/**
 * Get a specific secret by key. Throws if not found.
 */
export function getSecret(key: string): string {
  const secrets = loadSecrets();
  const value = secrets[key];
  if (!value) {
    throw new Error(`${key} not found in secrets.json`);
  }
  return value;
}

// ============================================
// VOICE CONFIG (ElevenLabs settings - DEPRECATED)
// ============================================

/** @deprecated Use LocalTTSConfig and getLocalTTSConfig() instead. Kept for rollback. */
export interface ElevenLabsConfig {
  apiKey: string;
  voiceId: string;
  stability: number;
  similarity_boost: number;
  style: number;
  speed: number;
}

/** @deprecated Use getLocalTTSConfig() instead. Kept for rollback. */
export function getElevenLabsConfig(): ElevenLabsConfig {
  const secrets = loadSecrets();
  const settings = loadSettings();
  const voiceSettings = (settings as any).daidentity?.voice || {};

  return {
    apiKey: secrets.ELEVENLABS_API_KEY,
    voiceId: (settings as any).daidentity?.voiceId || secrets.ELEVENLABS_VOICE_ID,
    stability: voiceSettings.stability ?? 0.35,
    similarity_boost: voiceSettings.similarity_boost ?? 0.8,
    style: voiceSettings.style ?? 0.9,
    speed: voiceSettings.speed ?? 1.1,
  };
}

// ============================================
// LOCAL TTS CONFIG
// ============================================

/** Supported TTS model names */
export type TTSModel = "kokoro" | "chatterbox" | "qwen3-tts";

/** Local TTS configuration (replaces ElevenLabsConfig) */
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
    const settings = loadSettings();
    const localVoice = (settings as any).daidentity?.localVoice || {};
    const voiceSettings = (settings as any).daidentity?.voice || {};
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
 * Map voice preset names and legacy ElevenLabs voice IDs to Kokoro voice IDs.
 * Used in LocalTTSClient and VoiceServer for backward compatibility.
 */
export const VOICE_PRESETS: Record<string, string> = {
  // Kaya's default voice
  kaya: "af_heart",
  default: "af_heart",
  // Agent voices
  architect: "am_adam",
  engineer: "am_liam",
  researcher: "af_bella",
  // Legacy ElevenLabs voice IDs mapped to Kokoro equivalents
  XrExE9yKIg1WjnnlVkGX: "af_heart", // Kaya's old ElevenLabs ID
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
  /** Maximum concurrent WebSocket sessions */
  maxSessions: number;
  /** Gemini model for voice inference */
  geminiModel: string;
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
}

export const RealtimeVoiceConfigSchema = z.object({
  port: z.number().default(8882),
  maxSessions: z.number().default(5),
  geminiModel: z.string().default("gemini-2.0-flash"),
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
});

/** Load real-time voice config with defaults */
export function getRealtimeVoiceConfig(): RealtimeVoiceConfig {
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
