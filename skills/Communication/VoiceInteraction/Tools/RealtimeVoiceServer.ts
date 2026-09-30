#!/usr/bin/env bun
/**
 * RealtimeVoiceServer.ts - Bun WebSocket server for real-time voice conversation
 *
 * Orchestrates the full voice pipeline:
 *   1. Receive audio from WebSocket client
 *   2. Transcribe via mlx-whisper (localhost:8881)
 *   3. Stream response through Gemini API (with Kaya voice system prompt)
 *   4. Chunk streaming tokens at sentence boundaries
 *   5. Generate speech via mlx-audio/Kokoro (localhost:8880) with TTS fallback chain
 *   6. Stream TTS audio back to client
 *
 * Phase 4 additions:
 *   - Voice-optimized system prompt from VoiceSystemPrompt.ts (Kaya personality)
 *   - Centralized error handling via RealtimeErrorHandler.ts
 *   - Health monitoring via RealtimeHealthMonitor.ts
 *   - Session capacity management (maxSessions)
 *   - TTS fallback chain: MLX TTS -> macOS say -> text-only
 *   - Memory pressure monitoring
 *
 * Port: 8882 (binds 127.0.0.1 by default — the only access control besides
 *   that is the `?key=` token + origin check, so it must stay loopback-only;
 *   the Cloudflare tunnel ingress reaches it as http://localhost:8882)
 * Protocol: WebSocket (binary audio + JSON control messages)
 *
 * Services:
 *   - STT: POST http://localhost:8881/v1/audio/transcriptions (mlx-whisper)
 *   - LLM: Claude CLI persistent session (stream-json protocol, full Kaya)
 *   - TTS: POST http://localhost:8880/v1/audio/speech (mlx-audio/Kokoro)
 *
 * Usage:
 *   bun skills/Communication/VoiceInteraction/Tools/RealtimeVoiceServer.ts
 */

import { z } from "zod";
import { join } from "path";
import { spawn, spawnSync } from "child_process";
import { CLAUDE_PATH, buildHardenedClaudeEnv } from "../../../../lib/core/Inference.ts";
import { getIdentity, getRealtimeVoiceConfig, loadSecrets } from "./VoiceCommon.ts";
import { SentenceChunker } from "./SentenceChunker.ts";
import { polishTranscription } from "./STTPolishPipeline.ts";
import { buildVoiceSystemPrompt, getMinimalContext } from "./VoiceSystemPrompt.ts";
import { withTimeout, handleSTTError, handleLLMError, handleTTSError, handleCapacityError, speakError } from "./RealtimeErrorHandler.ts";
import { RealtimeHealthMonitor } from "./RealtimeHealthMonitor.ts";
import { httpClient } from "../../../../lib/core/CachedHTTPClient.ts";
import type { Server, ServerWebSocket } from "bun";

// ============================================================================
// Configuration
// ============================================================================

const config = getRealtimeVoiceConfig();
const PORT = config.port;
const HOST = config.host;
const STT_URL = config.sttUrl;
const TTS_URL = config.ttsUrl;
const MAX_TOKENS = config.maxTokens;
const RATE_LIMIT_MS = 500;

const TUNNEL_DOMAIN = "voice.kayaai.dev";
const ALLOWED_ORIGINS: ReadonlyArray<string> = [
  `https://${TUNNEL_DOMAIN}`,
  "http://localhost:8882",
  "http://127.0.0.1:8882",
];

// Load the pre-shared voice auth token via VoiceCommon.loadSecrets().
// Clients must pass ?key=<token> on WebSocket upgrade.
// Uses the shared abstraction so both this server and other voice tools resolve
// secrets.json via the same KAYA_HOME path (not a separate process.env.HOME lookup).
const secrets = loadSecrets();
const VOICE_AUTH_TOKEN = secrets.voice_auth_token;
if (!VOICE_AUTH_TOKEN || typeof VOICE_AUTH_TOKEN !== "string") {
  console.error("[Auth] FATAL: voice_auth_token not found in secrets.json");
  process.exit(1);
}

/**
 * Validate WebSocket origin header.
 * Accepts known origins, null (Telegram WebView), and Telegram domains.
 */
function isOriginAllowed(origin: string | null): boolean {
  // Accept JavaScript null (no Origin header) for Telegram WebView compatibility.
  // NOTE: this also passes curl, Electron, and local file requests — acceptable given
  // the Cloudflare tunnel + voice_auth_token as the primary auth layer.
  if (origin === null) {
    console.warn("[Auth] Null-origin WebSocket connection accepted (Telegram WebView bypass active)");
    return true;
  }
  // Explicitly reject the string "null" — this is what browser extensions send.
  // MUST NOT accept: browser extensions and local HTML files send "null" as a string.
  if (origin === "null") {
    console.warn('[Auth] Rejected string "null" origin — likely a browser extension');
    return false;
  }

  // Exact match against known origins
  if (ALLOWED_ORIGINS.includes(origin)) return true;

  // Telegram domains (web.telegram.org, various subdomains)
  if (origin.endsWith(".telegram.org") || origin === "https://telegram.org") return true;

  // Reject unknown origins
  console.warn(`[Origin] Rejected WebSocket from origin: ${origin}`);
  return false;
}

// Build voice-optimized system prompt from DAIDENTITY.md + settings.json
const FALLBACK_SYSTEM_PROMPT = buildVoiceSystemPrompt();

/**
 * Load context for a voice session.
 *
 * ContextManager (per-prompt profile routing) was removed; the
 * "voice-conversation" profile loaded essentially nothing anyway, so voice
 * sessions now use the fixed minimal context directly.
 */
async function loadSessionContext(): Promise<string> {
  return getMinimalContext();
}

// Initialize health monitor
const healthMonitor = new RealtimeHealthMonitor(config);

// ============================================================================
// Types
// ============================================================================

type SessionStateValue = "listening" | "thinking" | "speaking";

interface SessionConfig {
  voice: string;
  maxTokens: number;
  systemPrompt: string;
}

interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

interface SessionState {
  id: string;
  conversationHistory: ConversationMessage[];
  maxTurns: number;
  abortController: AbortController | null;
  state: SessionStateValue;
  config: SessionConfig;
  lastAudioTimestamp: number;
  claudeSession: ClaudeSession | null;
}

// Zod schemas for client message validation
const AudioMessageSchema = z.object({
  type: z.literal("audio"),
});

const InterruptMessageSchema = z.object({
  type: z.literal("interrupt"),
});

const PingMessageSchema = z.object({
  type: z.literal("ping"),
});

const ConfigMessageSchema = z.object({
  type: z.literal("config"),
  voice: z.string().optional(),
  maxTurns: z.number().min(1).max(200).optional(),
  systemPrompt: z.string().optional(),
  maxTokens: z.number().min(1).max(4096).optional(),
});

const TextMessageSchema = z.object({
  type: z.literal("text"),
  text: z.string().min(1).max(4096),
});

const SessionInitMessageSchema = z.object({
  type: z.literal("session_init"),
  sessionId: z.string().optional(),
});

const ClientMessageSchema = z.discriminatedUnion("type", [
  AudioMessageSchema,
  InterruptMessageSchema,
  PingMessageSchema,
  ConfigMessageSchema,
  TextMessageSchema,
  SessionInitMessageSchema,
]);

type ClientMessage = z.infer<typeof ClientMessageSchema>;

// Server -> Client message types
interface TranscriptMessage {
  type: "transcript";
  text: string;
}

interface ResponseTextMessage {
  type: "response_text";
  text: string;
}

interface AudioOutMessage {
  type: "audio";
  data: string; // base64-encoded WAV
}

interface StatusMessage {
  type: "status";
  state: SessionStateValue;
}

interface ErrorMessage {
  type: "error";
  message: string;
}

interface PongMessage {
  type: "pong";
}

interface SessionAckMessage {
  type: "session_ack";
  sessionId: string;
  resumed: boolean;
  conversationLength: number;
}

type ServerMessage = TranscriptMessage | ResponseTextMessage | AudioOutMessage | StatusMessage | ErrorMessage | PongMessage | SessionAckMessage;

// ============================================================================
// ClaudeSession: Persistent interactive Claude subprocess (stream-json)
// ============================================================================

class ClaudeSession {
  private proc: ReturnType<typeof spawn>;
  private alive = true;
  private stdoutBuffer = "";
  private pendingResolvers: Array<(line: string | null) => void> = [];
  private lineQueue: Array<string | null> = [];
  private inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

  constructor(systemPrompt: string) {
    // Inject the static OAuth setup-token (subscription billing) so this
    // process never falls through to the rotating macOS Keychain credential,
    // which would poison concurrent interactive sessions.
    const env = buildHardenedClaudeEnv();
    // Ensure bun is on PATH for hooks (launchd doesn't inherit shell PATH)
    if (env.PATH && !env.PATH.includes("/opt/homebrew/bin")) {
      env.PATH = `/opt/homebrew/bin:${env.PATH}`;
    }

    const voiceSettingsPath = join(import.meta.dir, "../Config/voice-session-settings.json");

    this.proc = spawn(CLAUDE_PATH, [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--model", "sonnet",
      "--permission-mode", "bypassPermissions",
      "--settings", voiceSettingsPath,
      "--append-system-prompt", [
        "CRITICAL VOICE MODE OVERRIDE — SUPERSEDES ALL OTHER FORMAT INSTRUCTIONS:",
        "This is a real-time voice conversation. Your response will be converted to speech via TTS.",
        "",
        "FORMAT RULES (override CLAUDE.md):",
        "- Do NOT use the 📋 SUMMARY / 🔍 ANALYSIS / ⚡ ACTIONS / ⭐ RATE / 🗣️ Kaya format.",
        "- Do NOT use emoji, markdown, bullet points, numbered lists, or headers.",
        "- Respond in 1-3 natural spoken sentences only.",
        "- Speak as if talking to someone in person. Be warm, concise, direct.",
        "- The user's name is Jm. You are Kaya.",
        "",
        systemPrompt,
      ].join("\n"),
    ], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.stdout!.on("data", (chunk: Buffer) => {
      this.stdoutBuffer += chunk.toString();
      const lines = this.stdoutBuffer.split("\n");
      this.stdoutBuffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        if (this.pendingResolvers.length > 0) {
          const resolve = this.pendingResolvers.shift()!;
          resolve(line);
        } else {
          this.lineQueue.push(line);
        }
      }
    });

    this.proc.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) console.warn(`[ClaudeSession] stderr: ${text}`);
    });

    this.proc.on("exit", (code) => {
      this.alive = false;
      console.log(`[ClaudeSession] Process exited with code ${code}`);
      // Flush null to unblock any pending readers
      for (const resolve of this.pendingResolvers) {
        resolve(null);
      }
      this.pendingResolvers = [];
    });

    this.resetInactivityTimer();
  }

  isAlive(): boolean {
    return this.alive && !this.proc.killed;
  }

  kill(): void {
    if (this.inactivityTimer) clearTimeout(this.inactivityTimer);
    if (this.isAlive()) {
      this.proc.kill("SIGTERM");
    }
    this.alive = false;
  }

  private resetInactivityTimer(): void {
    if (this.inactivityTimer) clearTimeout(this.inactivityTimer);
    this.inactivityTimer = setTimeout(() => {
      console.log(`[ClaudeSession] Inactivity timeout (30 min) — killing`);
      this.kill();
    }, this.INACTIVITY_TIMEOUT_MS);
  }

  private nextLine(): Promise<string | null> {
    if (this.lineQueue.length > 0) {
      return Promise.resolve(this.lineQueue.shift()!);
    }
    if (!this.isAlive()) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.pendingResolvers.push(resolve);
    });
  }

  async *sendMessage(text: string): AsyncGenerator<string, void, unknown> {
    if (!this.isAlive()) {
      throw new Error("Claude session is dead");
    }

    this.resetInactivityTimer();

    // Write user message to stdin
    const userMessage = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text }],
      },
    });
    this.proc.stdin!.write(userMessage + "\n");

    // Read stdout lines until we get a "result" event
    while (true) {
      const line = await this.nextLine();
      if (line === null) break; // process died

      try {
        const event = JSON.parse(line);

        // Token-level streaming: yield text deltas
        if (
          event.type === "stream_event" &&
          event.event?.type === "content_block_delta" &&
          event.event?.delta?.type === "text_delta" &&
          event.event?.delta?.text
        ) {
          yield event.event.delta.text;
        }

        // Turn complete
        if (event.type === "result") {
          break;
        }
      } catch {
        // Skip non-JSON lines
      }
    }
  }
}

// ============================================================================
// Session Management
// ============================================================================

const sessions = new Map<ServerWebSocket<{ sessionId: string }>, SessionState>();

function createSession(): SessionState {
  return {
    id: `voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    conversationHistory: [],
    maxTurns: 50,
    abortController: null,
    state: "listening",
    config: {
      voice: "af_heart",
      maxTokens: MAX_TOKENS,
      systemPrompt: FALLBACK_SYSTEM_PROMPT,
    },
    lastAudioTimestamp: 0,
    claudeSession: null,
  };
}

function trimConversationHistory(session: SessionState): void {
  while (session.conversationHistory.length > session.maxTurns * 2) {
    session.conversationHistory.shift();
  }
}

// ============================================================================
// Session Recovery Store
// ============================================================================

interface StoredSession {
  session: SessionState;
  disconnectedAt: number | null;
}

const sessionStore = new Map<string, StoredSession>();
const SESSION_RECOVERY_TTL_MS = 300_000; // 5 minutes

// Clean up expired sessions every 60 seconds
const sessionCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of sessionStore) {
    if (entry.disconnectedAt !== null && now - entry.disconnectedAt > SESSION_RECOVERY_TTL_MS) {
      sessionStore.delete(id);
    }
  }
}, 60_000);
// Don't block process exit
if (sessionCleanupInterval.unref) sessionCleanupInterval.unref();

/**
 * Handle session_init message: recover an existing session or acknowledge a new one.
 */
function handleSessionInit(
  ws: ServerWebSocket<{ sessionId: string }>,
  requestedSessionId: string | undefined,
): void {
  const currentSession = sessions.get(ws);
  if (!currentSession) return;

  if (requestedSessionId) {
    const stored = sessionStore.get(requestedSessionId);
    const now = Date.now();

    if (stored && (stored.disconnectedAt === null || now - stored.disconnectedAt < SESSION_RECOVERY_TTL_MS)) {
      // Recover the stored session
      const recovered = stored.session;
      recovered.abortController = null;
      recovered.state = "listening";
      sessions.set(ws, recovered);
      stored.disconnectedAt = null;

      healthMonitor.recordReconnection();
      console.log(`[${recovered.id}] Session recovered (${recovered.conversationHistory.length} messages)`);

      sendMessage(ws, {
        type: "session_ack",
        sessionId: recovered.id,
        resumed: true,
        conversationLength: recovered.conversationHistory.length,
      });
      return;
    }
  }

  // No recovery -- acknowledge the fresh session
  sessionStore.set(currentSession.id, { session: currentSession, disconnectedAt: null });
  sendMessage(ws, {
    type: "session_ack",
    sessionId: currentSession.id,
    resumed: false,
    conversationLength: 0,
  });
}

// ============================================================================
// WebSocket Helpers
// ============================================================================

function sendMessage(ws: ServerWebSocket<{ sessionId: string }>, msg: ServerMessage): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch (error) {
    console.error(`[${getSessionId(ws)}] Failed to send message:`, error);
  }
}

function sendStatus(ws: ServerWebSocket<{ sessionId: string }>, state: SessionStateValue): void {
  const session = sessions.get(ws);
  if (session) session.state = state;
  sendMessage(ws, { type: "status", state });
}

function sendError(ws: ServerWebSocket<{ sessionId: string }>, message: string): void {
  console.error(`[${getSessionId(ws)}] Error: ${message}`);
  sendMessage(ws, { type: "error", message });
}

function getSessionId(ws: ServerWebSocket<{ sessionId: string }>): string {
  return sessions.get(ws)?.id ?? "unknown";
}

// ============================================================================
// STT: Speech-to-Text via mlx-whisper
// ============================================================================

async function transcribeAudio(audioData: ArrayBuffer, sessionId: string): Promise<string | null> {
  const formData = new FormData();
  const blob = new Blob([audioData], { type: "audio/wav" });
  formData.append("file", blob, "audio.wav");
  formData.append("model", "whisper-large-v3-turbo");

  const sttStart = Date.now();

  try {
    const response = await withTimeout(
      httpClient.fetch(STT_URL, {
        method: "POST",
        body: formData,
        signal: AbortSignal.timeout(30000), // 30s for large model cold starts
        cache: "none",
      }),
      30000, // Match AbortSignal timeout — large-v3-turbo cold start can exceed 15s
      null as Response | null,
      "STT",
    );

    if (!response) {
      healthMonitor.recordSTTResult(false);
      return null;
    }

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[${sessionId}] STT error (${response.status}): ${errorText}`);
      healthMonitor.recordSTTResult(false);
      return null;
    }

    const result = await response.json() as { text?: string };
    const sttLatency = Date.now() - sttStart;
    console.log(`[${sessionId}] STT completed in ${sttLatency}ms`);
    healthMonitor.recordSTTResult(true);
    return result.text?.trim() || null;
  } catch (error) {
    console.error(`[${sessionId}] STT service unavailable:`, error);
    healthMonitor.recordSTTResult(false);
    return null;
  }
}

// ============================================================================
// LLM: Claude CLI Persistent Session (stream-json protocol)
// ============================================================================

async function* streamLLM(
  session: SessionState,
  signal: AbortSignal,
): AsyncGenerator<string, void, unknown> {
  // Spawn ClaudeSession on first turn if not already running
  if (!session.claudeSession?.isAlive()) {
    console.log(`[${session.id}] Spawning persistent Claude session`);
    session.claudeSession = new ClaudeSession(session.config.systemPrompt);
  }

  // Get the latest user message
  const lastMessage = session.conversationHistory[session.conversationHistory.length - 1];
  if (!lastMessage || lastMessage.role !== "user") {
    throw new Error("No user message to send");
  }

  // Stream tokens from the persistent session
  for await (const token of session.claudeSession.sendMessage(lastMessage.content)) {
    if (signal.aborted) break;
    yield token;
  }
}

// ============================================================================
// TTS: Text-to-Speech via mlx-audio/Kokoro with fallback chain
// ============================================================================

async function synthesizeSpeech(
  text: string,
  voice: string,
  sessionId: string,
): Promise<ArrayBuffer | null> {
  // Try MLX TTS (primary)
  try {
    const response = await httpClient.fetch(TTS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "prince-canuma/Kokoro-82M",
        input: text,
        voice,
        response_format: "wav",
      }),
      signal: AbortSignal.timeout(10000),
      cache: "none",
    });

    if (response.ok) {
      healthMonitor.recordTTSResult(true);
      return response.arrayBuffer();
    }

    const errorText = await response.text();
    console.error(`[${sessionId}] TTS error (${response.status}): ${errorText}`);
  } catch (error) {
    console.error(`[${sessionId}] TTS service unavailable:`, error);
  }

  // Fallback 1: macOS say
  if (config.macOsSayFallback) {
    try {
      const tmpFile = `/tmp/voice-tts-${Date.now()}.aiff`;
      const result = spawnSync("say", ["-o", tmpFile, text], { timeout: 10000 });

      if (result.status === 0) {
        const file = Bun.file(tmpFile);
        if (await file.exists()) {
          const buffer = await file.arrayBuffer();
          // Clean up temp file
          try { await Bun.write(`${tmpFile}.cleanup`, ""); } catch { /* ignore */ }
          healthMonitor.recordTTSResult(true, true); // true = fallback
          healthMonitor.setTTSAvailable(true, "macos-say");
          console.warn(`[${sessionId}] TTS: Using macOS say fallback`);
          return buffer;
        }
      }
    } catch {
      // macOS say also failed
    }
  }

  // All TTS failed
  healthMonitor.recordTTSResult(false);
  healthMonitor.setTTSAvailable(false, "text-only");
  return null;
}

// ============================================================================
// Pipeline: LLM + TTS (shared between audio and text input)
// ============================================================================

/**
 * Run the LLM streaming + TTS pipeline for a user message already in history.
 * Extracted from handleAudioTurn so text messages can reuse the same pipeline.
 *
 * @param sttMs - STT latency (0 for text input)
 */
async function runLLMAndTTSPipeline(
  ws: ServerWebSocket<{ sessionId: string }>,
  session: SessionState,
  sttMs: number,
): Promise<void> {
  const turnStart = Date.now();

  // Abort any in-flight response
  if (session.abortController) {
    session.abortController.abort();
    session.abortController = null;
  }

  const abortController = new AbortController();
  session.abortController = abortController;

  sendStatus(ws, "thinking");

  const chunker = new SentenceChunker();
  let fullResponse = "";
  let firstAudioSent = false;
  const llmStart = Date.now();

  try {
    const tokenStream = streamLLM(session, abortController.signal);

    for await (const token of tokenStream) {
      if (abortController.signal.aborted) break;

      fullResponse += token;
      const sentence = chunker.addToken(token);

      if (sentence) {
        const audioBuffer = await synthesizeSpeech(
          sentence,
          session.config.voice,
          session.id,
        );

        if (abortController.signal.aborted) break;

        if (audioBuffer) {
          if (!firstAudioSent) {
            sendStatus(ws, "speaking");
            firstAudioSent = true;
          }
          const base64Audio = Buffer.from(audioBuffer).toString("base64");
          sendMessage(ws, { type: "audio", data: base64Audio });
        } else {
          console.warn(`[${session.id}] TTS failed for sentence, sending text only`);
          sendMessage(ws, { type: "response_text", text: sentence });
        }
      }
    }

    const llmMs = Date.now() - llmStart;

    // Flush remaining buffer
    if (!abortController.signal.aborted) {
      const remaining = chunker.flush();
      if (remaining) {
        const audioBuffer = await synthesizeSpeech(
          remaining,
          session.config.voice,
          session.id,
        );

        if (!abortController.signal.aborted && audioBuffer) {
          if (!firstAudioSent) {
            sendStatus(ws, "speaking");
            firstAudioSent = true;
          }
          const base64Audio = Buffer.from(audioBuffer).toString("base64");
          sendMessage(ws, { type: "audio", data: base64Audio });
        }
      }
    }

    // Send full response text
    if (!abortController.signal.aborted && fullResponse.length > 0) {
      sendMessage(ws, { type: "response_text", text: fullResponse });

      session.conversationHistory.push({
        role: "assistant",
        content: fullResponse,
      });
      trimConversationHistory(session);
    }

    // Record turn metrics
    const totalMs = Date.now() - turnStart;
    healthMonitor.recordTurn({
      sttMs,
      llmMs,
      ttsMs: totalMs - sttMs - llmMs,
      totalMs,
    });

    console.log(
      `[${session.id}] Turn complete: STT=${sttMs}ms, LLM=${llmMs}ms, total=${totalMs}ms`,
    );
  } catch (error) {
    if (abortController.signal.aborted) {
      console.log(`[${session.id}] Turn aborted`);
    } else {
      const errorObj = error instanceof Error ? error : new Error(String(error));
      const errorMessage = errorObj.message;
      console.error(`[${session.id}] Pipeline error: ${errorMessage}`);
      healthMonitor.recordError(errorMessage);

      if (errorMessage.includes("Gemini") || errorMessage.includes("429") || errorMessage.includes("timeout")) {
        const errMsg = handleLLMError(errorObj, session.id);
        sendError(ws, errMsg.text ?? "I'm having trouble right now.");

        if (errorMessage.includes("timeout")) {
          healthMonitor.recordLLMTimeout();
        }

        const errorAudio = await speakError(errMsg.text ?? "I'm having trouble thinking right now.", session.config.voice);
        if (errorAudio) {
          sendMessage(ws, { type: "audio", data: errorAudio });
        }
      } else {
        sendError(ws, `Pipeline error: ${errorMessage}`);
      }
    }
  } finally {
    if (session.abortController === abortController) {
      session.abortController = null;
    }
    if (!abortController.signal.aborted) {
      sendStatus(ws, "listening");
    }
  }
}

// ============================================================================
// Pipeline: Full voice turn (audio input -> STT -> LLM -> TTS)
// ============================================================================

async function handleAudioTurn(
  ws: ServerWebSocket<{ sessionId: string }>,
  audioData: ArrayBuffer,
): Promise<void> {
  const session = sessions.get(ws);
  if (!session) return;

  // Rate limiting: max 1 audio per 500ms
  const now = Date.now();
  if (now - session.lastAudioTimestamp < RATE_LIMIT_MS) {
    sendError(ws, "Rate limited: please wait before sending more audio");
    return;
  }
  session.lastAudioTimestamp = now;

  // Step 1: Transcribe audio
  sendStatus(ws, "thinking");
  const sttStart = Date.now();
  const transcript = await transcribeAudio(audioData, session.id);
  const sttMs = Date.now() - sttStart;

  if (!transcript) {
    const errMsg = handleSTTError(new Error("Transcription failed"), session.id);
    sendError(ws, errMsg.text ?? "Could not transcribe audio.");

    const errorAudio = await speakError(errMsg.text ?? "I can't hear you right now.", session.config.voice);
    if (errorAudio) {
      sendMessage(ws, { type: "audio", data: errorAudio });
    }

    sendStatus(ws, "listening");
    return;
  }

  if (transcript.length === 0) {
    sendStatus(ws, "listening");
    return;
  }

  // Step 2: Polish transcript (fixes spelling/punctuation, saves pairs for training)
  let finalTranscript = transcript;
  try {
    const polishResult = await polishTranscription(transcript);
    if (polishResult.polished) {
      console.log(`[${session.id}] STT polished: "${transcript}" → "${polishResult.text}" (${polishResult.model}, ${polishResult.duration_ms}ms)`);
      finalTranscript = polishResult.text;
    }
  } catch (err) {
    console.warn(`[${session.id}] STT polish failed, using raw transcript:`, err);
  }

  // Send transcript to client
  sendMessage(ws, { type: "transcript", text: finalTranscript });

  // Step 2.5: LifeOS capture gate — if transcript is a capture-shaped
  // POS entry (EXPERIENCE_LOG, HABIT_CHECK, LEAD_ENTRY, IDEA_CANDIDATE, TASK,
  // INSIGHT, REFLECTION, CALENDAR), route it directly and skip Claude. If
  // the classifier itself returns NOT_A_CAPTURE / UNKNOWN (conversational,
  // question, control command) or an approval-required label, fall through
  // to the normal LLM pipeline.
  if (await tryCaptureGate(ws, session, finalTranscript, sttMs)) {
    return; // captured — voice-server already spoke the confirmation
  }

  // Add user message to conversation
  session.conversationHistory.push({ role: "user", content: finalTranscript });
  trimConversationHistory(session);

  // Step 3: Run LLM + TTS pipeline
  await runLLMAndTTSPipeline(ws, session, sttMs);
}

/**
 * Handle a text message (no STT needed).
 * Adds the text to conversation history and runs the LLM+TTS pipeline.
 */
async function handleTextTurn(
  ws: ServerWebSocket<{ sessionId: string }>,
  text: string,
): Promise<void> {
  const session = sessions.get(ws);
  if (!session) return;

  // Send transcript-style echo
  sendMessage(ws, { type: "transcript", text });

  // Same capture-gate path as voice — keeps parity between channels.
  if (await tryCaptureGate(ws, session, text, 0)) return;

  // Add user message to conversation
  session.conversationHistory.push({ role: "user", content: text });
  trimConversationHistory(session);

  // Run LLM + TTS pipeline (sttMs = 0 for text input)
  await runLLMAndTTSPipeline(ws, session, 0);
}

// ============================================================================
// LifeOS capture gate — classifies every transcript (no code-level
// pre-filter) and routes POS-shaped ones before they reach the persistent
// Claude session. Returns true if captured (voice-server must
// short-circuit), false otherwise.
// ============================================================================

async function tryCaptureGate(
  ws: ServerWebSocket<{ sessionId: string }>,
  session: SessionState,
  transcript: string,
  sttMs: number,
): Promise<boolean> {
  // cross-skill-allowed: CLAUDE.md-mandated voice-boundary capture gate — type-only (erased at runtime); types the dynamically-imported CaptureGate module below
  let captureGate: typeof import("../../../Productivity/LifeOS/Capture/CaptureGate.ts").captureGate;
  try {
    // Dynamic import so a broken skill never hard-fails the voice-server.
    // cross-skill-allowed: CLAUDE.md-mandated voice-boundary capture gate — captures are gated here BEFORE reaching the conversational Claude process
    ({ captureGate } = await import("../../../Productivity/LifeOS/Capture/CaptureGate.ts"));
  } catch (err) {
    console.warn(`[${session.id}] CaptureGate module load failed; skipping gate:`, err);
    return false;
  }

  const gateStart = Date.now();
  let result: Awaited<ReturnType<typeof captureGate>>;
  try {
    result = await captureGate(transcript, { autoApprove: true });
  } catch (err) {
    console.error(`[${session.id}] CaptureGate error (falling through to Claude):`, err);
    return false;
  }

  if (!result.captured) {
    console.log(`[${session.id}] CaptureGate bypass (${result.bypassReason}) in ${Date.now() - gateStart}ms`);
    return false;
  }

  console.log(
    `[${session.id}] CaptureGate captured: ${result.classification?.label}/${result.classification?.domain ?? "—"} → ${result.routeResult?.plan.destination} (loop ${result.routeResult?.plan.loopId ?? "—"}) in ${Date.now() - gateStart}ms`,
  );

  // Speak the confirmation and finish the turn. We intentionally skip the
  // conversationHistory push so the persistent Claude session stays focused
  // on conversational threads.
  const summary = result.summary ?? "Logged.";
  const audioBuffer = await synthesizeSpeech(summary, session.config.voice, session.id);
  if (audioBuffer) {
    sendStatus(ws, "speaking");
    const base64Audio = Buffer.from(audioBuffer).toString("base64");
    sendMessage(ws, { type: "audio", data: base64Audio });
  }
  sendMessage(ws, { type: "response_text", text: summary });

  // Record telemetry under a lightweight "turn" so health monitors see the event.
  const totalMs = Date.now() - gateStart + sttMs;
  healthMonitor.recordTurn({ sttMs, llmMs: Date.now() - gateStart, ttsMs: 0, totalMs });
  sendStatus(ws, "listening");
  return true;
}

// ============================================================================
// Client Message Handling
// ============================================================================

function handleClientMessage(
  ws: ServerWebSocket<{ sessionId: string }>,
  message: ClientMessage,
): void {
  const session = sessions.get(ws);
  if (!session) return;

  switch (message.type) {
    case "interrupt": {
      console.log(`[${session.id}] Interrupt received`);
      if (session.abortController) {
        session.abortController.abort();
        session.abortController = null;
      }
      sendStatus(ws, "listening");
      break;
    }

    case "config": {
      if (message.voice !== undefined) {
        session.config.voice = message.voice;
      }
      if (message.maxTurns !== undefined) {
        session.maxTurns = message.maxTurns;
      }
      if (message.systemPrompt !== undefined) {
        session.config.systemPrompt = message.systemPrompt;
      }
      if (message.maxTokens !== undefined) {
        session.config.maxTokens = message.maxTokens;
      }
      console.log(`[${session.id}] Config updated:`, {
        voice: session.config.voice,
        maxTurns: session.maxTurns,
        maxTokens: session.config.maxTokens,
      });
      break;
    }

    case "ping": {
      // Respond to keepalive ping
      sendMessage(ws, { type: "pong" });
      break;
    }

    case "audio": {
      // Audio messages are handled separately via binary data
      // This case handles the JSON audio message type if client sends metadata
      break;
    }

    case "text": {
      console.log(`[${session.id}] Text input: "${message.text.slice(0, 80)}"`);
      handleTextTurn(ws, message.text).catch((error) => {
        const errorObj = error instanceof Error ? error : new Error(String(error));
        console.error(`[${session.id}] Text turn error:`, errorObj);
        healthMonitor.recordError(errorObj.message);
        sendError(ws, "Internal error processing text");
        sendStatus(ws, "listening");
      });
      break;
    }

    case "session_init": {
      handleSessionInit(ws, message.sessionId);
      break;
    }
  }
}

// ============================================================================
// Health Check (enhanced with RealtimeHealthMonitor)
// ============================================================================

interface ServiceHealth {
  status: "ok" | "error";
  latencyMs?: number;
  error?: string;
}

async function checkServiceHealth(
  url: string,
  _name: string,
): Promise<ServiceHealth> {
  const start = Date.now();
  try {
    const response = await httpClient.fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(3000),
    });
    // 405 (Method Not Allowed) means the service is running -- the endpoint
    // exists but only accepts POST (e.g., mlx-whisper /v1/audio/transcriptions)
    const alive = response.ok || response.status === 405;
    return {
      status: alive ? "ok" : "error",
      latencyMs: Date.now() - start,
      error: alive ? undefined : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      status: "error",
      latencyMs: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function getHealthStatus(): Promise<Record<string, unknown>> {
  const [stt, tts] = await Promise.all([
    checkServiceHealth(config.sttHealthUrl, "stt"),
    checkServiceHealth(config.ttsHealthUrl, "tts"),
  ]);

  // Update health monitor with service status
  healthMonitor.setSTTAvailable(stt.status === "ok");
  if (tts.status === "ok") {
    healthMonitor.setTTSAvailable(true, "mlx");
  }

  // Check Claude CLI availability
  let llm: ServiceHealth;
  try {
    const result = spawnSync(CLAUDE_PATH, ["--version"], { timeout: 5000 });
    llm = result.status === 0
      ? { status: "ok" }
      : { status: "error", error: "Claude CLI not responding" };
  } catch {
    llm = { status: "error", error: "Claude CLI not found" };
  }

  // Get comprehensive health from monitor
  const monitorHealth = healthMonitor.checkHealth();

  return {
    status: monitorHealth.status,
    activeSessions: monitorHealth.activeSessions,
    maxSessions: monitorHealth.maxSessions,
    sttAvailable: monitorHealth.sttAvailable,
    ttsAvailable: monitorHealth.ttsAvailable,
    ttsMode: monitorHealth.ttsMode,
    memoryMB: monitorHealth.memoryMB,
    services: { stt, tts, llm },
    metrics: monitorHealth.metrics,
    lastError: monitorHealth.lastError,
    uptime: monitorHealth.uptime,
    timestamp: new Date().toISOString(),
  };
}

// ============================================================================
// Server
// ============================================================================

function startServer(port: number = PORT, hostname: string = HOST): Server {
  // Start periodic health checks
  healthMonitor.startHealthChecks(30000);

  const srv: Server = Bun.serve<{ sessionId: string }>({
    port,
    hostname,

    async fetch(req, server) {
      const url = new URL(req.url);

      // CORS preflight
      if (req.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": `https://${TUNNEL_DOMAIN}`,
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Max-Age": "86400",
          },
        });
      }

      // Health check endpoint
      if (url.pathname === "/health" && req.method === "GET") {
        const health = await getHealthStatus();
        return new Response(JSON.stringify(health, null, 2), {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": `https://${TUNNEL_DOMAIN}`,
          },
        });
      }

      // WebSocket upgrade
      if (url.pathname === "/ws" || url.pathname === "/") {
        const upgradeHeader = req.headers.get("upgrade");
        if (upgradeHeader?.toLowerCase() === "websocket") {
          // Pre-shared token validation (required for all connections)
          const authKey = url.searchParams.get("key");
          if (authKey !== VOICE_AUTH_TOKEN) {
            console.warn(`[Server] Rejected WebSocket — invalid or missing auth key`);
            return new Response("Unauthorized", { status: 401 });
          }

          // Origin validation for WebSocket connections
          const origin = req.headers.get("origin");
          if (!isOriginAllowed(origin)) {
            console.warn(`[Server] Rejected WebSocket from origin: ${origin}`);
            return new Response("Forbidden", { status: 403 });
          }

          // Capacity check
          if (!healthMonitor.canAcceptSession()) {
            console.warn(`[Server] Capacity exceeded, rejecting connection`);
            const errMsg = handleCapacityError("new-connection");
            return new Response(JSON.stringify(errMsg), {
              status: 503,
              headers: { "Content-Type": "application/json" },
            });
          }

          const sessionId = `voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const success = server.upgrade(req, {
            data: { sessionId },
          });
          if (success) return undefined;
          return new Response("WebSocket upgrade failed", { status: 500 });
        }
      }

      // Serve Mini App HTML (requires auth key)
      if (url.pathname === "/" && req.method === "GET") {
        const pageKey = url.searchParams.get("key");
        if (pageKey !== VOICE_AUTH_TOKEN) {
          return new Response("Unauthorized", { status: 401 });
        }
        try {
          const htmlPath = join(import.meta.dir, "../WebApp/index.html");
          let html = await Bun.file(htmlPath).text();
          // Inject the auth key into the client-side JS so WebSocket connects with it
          html = html.replace(
            "return `${proto}//${host}/ws`;",
            `return \`\${proto}//\${host}/ws?key=${VOICE_AUTH_TOKEN}\`;`
          );
          return new Response(html, {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Access-Control-Allow-Origin": `https://${TUNNEL_DOMAIN}`,
              "Content-Security-Policy": [
                "default-src 'self'",
                "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://cdn.jsdelivr.net https://unpkg.com https://telegram.org https://static.cloudflareinsights.com",
                "style-src 'self' 'unsafe-inline'",
                `connect-src 'self' ws://localhost:${port} wss://${TUNNEL_DOMAIN} wss: https:`,
                "worker-src 'self' blob:",
                "media-src 'self' blob:",
                "img-src 'self' data:",
              ].join("; "),
            },
          });
        } catch (err) {
          console.error("[Server] Failed to read index.html:", err);
          return new Response("Mini App HTML not found", { status: 404 });
        }
      }

      return new Response("Not Found", { status: 404 });
    },

    websocket: {
      open(ws) {
        // Register session with health monitor
        const accepted = healthMonitor.sessionOpened();
        if (!accepted) {
          // Should not happen (checked in fetch), but guard anyway
          ws.close(1013, "Server at capacity");
          return;
        }

        const session = createSession();
        sessions.set(ws, session);
        sessionStore.set(session.id, { session, disconnectedAt: null });
        console.log(`[${session.id}] Client connected (${sessions.size} active)`);
        sendStatus(ws, "listening");
        sendMessage(ws, {
          type: "session_ack",
          sessionId: session.id,
          resumed: false,
          conversationLength: 0,
        });

        // Fire-and-forget: upgrade system prompt with dynamic context
        loadSessionContext().then((snippet) => {
          // Only upgrade if conversation hasn't started yet
          if (session.conversationHistory.length === 0) {
            session.config.systemPrompt = buildVoiceSystemPrompt({ contextSnippet: snippet });
            console.log(`[${session.id}] System prompt upgraded with dynamic context`);
          }
        }).catch((err) => {
          console.warn(`[${session.id}] Context loading failed:`, err);
        });
      },

      message(ws, message) {
        const session = sessions.get(ws);
        if (!session) return;

        // Binary data = audio
        if (message instanceof ArrayBuffer || message instanceof Uint8Array) {
          const audioData =
            message instanceof Uint8Array ? message.buffer.slice(message.byteOffset, message.byteOffset + message.byteLength) : message;
          handleAudioTurn(ws, audioData).catch((error) => {
            const errorObj = error instanceof Error ? error : new Error(String(error));
            console.error(`[${session.id}] Audio turn error:`, errorObj);
            healthMonitor.recordError(errorObj.message);
            sendError(ws, "Internal error processing audio");
            sendStatus(ws, "listening");
          });
          return;
        }

        // Text data = JSON control messages
        if (typeof message === "string") {
          try {
            const parsed = JSON.parse(message);
            const validated = ClientMessageSchema.parse(parsed);
            handleClientMessage(ws, validated);
          } catch (error) {
            if (error instanceof z.ZodError) {
              const issues = Array.isArray(error.issues) ? error.issues : [];
              sendError(ws, `Invalid message format: ${issues.map((e: { message: string }) => e.message).join(", ") || "validation failed"}`);
            } else {
              sendError(ws, "Failed to parse message as JSON");
            }
          }
        }
      },

      close(ws) {
        const session = sessions.get(ws);
        if (session) {
          // Abort any in-flight response
          if (session.abortController) {
            session.abortController.abort();
          }
          // Kill persistent Claude session
          if (session.claudeSession) {
            session.claudeSession.kill();
            session.claudeSession = null;
          }
          console.log(`[${session.id}] Client disconnected (${sessions.size - 1} active)`);
          sessions.delete(ws);
          healthMonitor.sessionClosed();

          // Mark session as disconnected for possible recovery (don't delete from store)
          const stored = sessionStore.get(session.id);
          if (stored) {
            stored.disconnectedAt = Date.now();
          }
        }
      },

      drain(_ws) {
        // Backpressure handling -- Bun calls this when the send buffer drains
        // No-op for now; could implement flow control in the future
      },
    },
  });

  console.log(`Voice server listening on ${hostname}:${port}`);
  console.log(`  WebSocket: ws://${hostname}:${port}/ws`);
  console.log(`  Health:    http://${hostname}:${port}/health`);
  console.log(`  Max sessions: ${config.maxSessions}`);
  console.log(`  LLM: Claude CLI (sonnet) via ${CLAUDE_PATH}`);
  console.log(`  System prompt: Kaya voice personality loaded`);

  return srv;
}

function gracefulShutdown(srv: Server): void {
  console.log("[Server] Shutdown signal received, cleaning up...");
  healthMonitor.stopHealthChecks();

  for (const [ws, session] of sessions) {
    if (session.abortController) {
      session.abortController.abort();
    }
    try { ws.close(1001, "Server shutting down"); } catch {}
  }
  sessions.clear();
  clearInterval(sessionCleanupInterval);
  srv.stop(true);

  console.log("[Server] Shutdown complete");
  process.exit(0);
}

let server: Server | undefined;
if (typeof Bun !== "undefined" && import.meta.main) {
  server = startServer();

  process.on("SIGTERM", () => { if (server) gracefulShutdown(server); });
  process.on("SIGINT", () => { if (server) gracefulShutdown(server); });
}

export { server, startServer, createSession, SentenceChunker, sessions, sessionStore, getHealthStatus, handleAudioTurn, handleTextTurn, handleClientMessage, handleSessionInit, runLLMAndTTSPipeline, transcribeAudio, streamLLM, synthesizeSpeech, sendMessage, sendStatus, sendError, healthMonitor, SESSION_RECOVERY_TTL_MS };
export type {
  SessionState,
  SessionConfig,
  ConversationMessage,
  ClientMessage,
  ServerMessage,
  SessionAckMessage,
  SessionStateValue,
};
