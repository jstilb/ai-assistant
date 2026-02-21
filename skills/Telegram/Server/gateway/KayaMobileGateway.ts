/**
 * KayaMobileGateway.ts - Platform-agnostic mobile gateway interface
 *
 * Defines the contract for all mobile gateway implementations (Telegram, WhatsApp, etc.)
 * Phase 1: Telegram. Phase 2: Additional platforms via this same interface.
 *
 * The gateway normalizes all inbound messages to MobileMessage,
 * enriches them with session/context, routes through Claude, and
 * captures learning signals from the exchange.
 */

// ──────────────────────────────────────────────
// Core Types
// ──────────────────────────────────────────────

export type MessageType = "text" | "voice" | "image" | "audio" | "command";

export interface MobileMessage {
  /** Unique message identifier from the platform */
  messageId: string;
  /** Normalized channel/chat identifier */
  channelId: string;
  /** ISO timestamp of message receipt */
  timestamp: string;
  /** Detected message type */
  type: MessageType;
  /** Text content (original or transcribed) */
  text: string;
  /** Original transcription for voice messages */
  transcription?: string;
  /** Base64 image data for image messages */
  imageData?: string;
  /** Image caption if provided */
  imageCaption?: string;
  /** MIME type for media */
  mimeType?: string;
  /** Source platform */
  platform: "telegram" | "whatsapp" | "signal";
  /** Raw platform-specific data (opaque to gateway) */
  rawPlatformData?: unknown;
}

export interface MobileResponse {
  /** Full text response from Claude */
  text: string;
  /** Extracted voice line for TTS (the voice emoji line) */
  voiceLine: string;
  /** Pre-generated TTS audio buffer (OGG format) */
  voiceAudio?: Buffer;
  /** Whether the response was truncated for mobile */
  truncated: boolean;
  /** Response metadata */
  metadata: {
    model: string;
    tokensUsed?: number;
    latencyMs: number;
    sessionId: string;
    profile?: string;
  };
}

export interface ProcessedMedia {
  /** Resolved text representation of the media */
  text: string;
  /** Media type that was processed */
  type: "voice_transcription" | "image_analysis" | "audio_transcription";
  /** Processing confidence (0-1) */
  confidence: number;
  /** Original media size in bytes */
  originalSizeBytes: number;
}

export interface ContextPayload {
  /** System prompt including personality, context, and session history */
  systemPrompt: string;
  /** Detected intent profile from ContextManager */
  profile: string;
  /** Classification confidence */
  confidence: number;
  /** Token budget allocated for this request */
  tokenBudget: number;
}

export interface Exchange {
  /** The normalized inbound message */
  message: MobileMessage;
  /** The generated response */
  response: MobileResponse;
  /** Session at time of exchange */
  session: Session;
  /** Detected rating (if user rated in message) */
  detectedRating?: number;
  /** Detected sentiment */
  detectedSentiment?: string;
}

export interface Notification {
  /** Notification title */
  title: string;
  /** Notification body */
  body: string;
  /** Priority level */
  priority: "low" | "normal" | "high";
  /** Optional voice narration */
  voiceLine?: string;
}

// ──────────────────────────────────────────────
// Session Types
// ──────────────────────────────────────────────

export interface SessionExchange {
  timestamp: string;
  userText: string;
  assistantText: string;
  voiceLine?: string;
  source: MessageType;
  profile?: string;
}

export interface Session {
  /** Unique session identifier */
  sessionId: string;
  /** Channel this session belongs to */
  channelId: string;
  /** ISO timestamp of session creation */
  createdAt: string;
  /** ISO timestamp of last activity */
  lastActivityAt: string;
  /** Number of exchanges in this session */
  exchangeCount: number;
  /** Current summary of older exchanges (for context overflow) */
  summary: string;
  /** Recent exchanges (last N, not yet summarized) */
  recentExchanges: SessionExchange[];
  /** Current context profile */
  currentProfile: string;
  /** Whether this session has been force-summarized */
  forceSummarized: boolean;
}

// ──────────────────────────────────────────────
// Gateway Interface
// ──────────────────────────────────────────────

export interface KayaMobileGateway {
  /**
   * Normalize a raw platform message into a MobileMessage.
   * Handles text, voice, image, and audio normalization.
   */
  receiveMessage(raw: unknown): Promise<MobileMessage>;

  /**
   * Send a response back to the user via the platform.
   * Handles message splitting, formatting, and optional voice delivery.
   */
  sendResponse(channelId: string, response: MobileResponse): Promise<void>;

  /**
   * Process media content (transcribe voice, analyze image).
   * Returns text representation for Claude processing.
   */
  handleMedia(message: MobileMessage): Promise<ProcessedMedia>;

  /**
   * Inject Kaya context into the message pipeline.
   * Uses ContextManager to classify intent and load profile context.
   */
  injectContext(message: MobileMessage, session: Session): Promise<ContextPayload>;

  /**
   * Capture learning signals from a completed exchange.
   * Detects ratings, sentiment, writes to MEMORY/LEARNING/SIGNALS.
   */
  captureLearning(exchange: Exchange): Promise<void>;

  /**
   * Load or create a session for the given channel.
   * Handles session continuity (new segment after 6h idle).
   */
  loadSession(channelId: string): Promise<Session>;

  /**
   * Save session state after an exchange.
   */
  saveSession(session: Session): Promise<void>;

  /**
   * Generate a summary of older session exchanges.
   * Called when exchange count exceeds threshold.
   */
  summarizeSession(session: Session): Promise<string>;

  /**
   * Send a proactive notification to the user.
   */
  notify(notification: Notification): Promise<void>;
}

// ──────────────────────────────────────────────
// Rate Limiting Types
// ──────────────────────────────────────────────

export interface RateLimitConfig {
  messagesPerHour: number;
  imagesPerHour: number;
  windowMs: number;
}

export interface RateLimitState {
  messageTimestamps: number[];
  imageTimestamps: number[];
}

export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  messagesPerHour: 60,
  imagesPerHour: 10,
  windowMs: 60 * 60 * 1000, // 1 hour
};
