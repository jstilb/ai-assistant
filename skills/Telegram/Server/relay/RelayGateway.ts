/**
 * RelayGateway.ts - KayaMobileGateway implementation for relay channel
 *
 * Implements the KayaMobileGateway interface from Phase 1 to provide
 * the same pipeline (session management, context injection, learning capture)
 * over the Cloudflare Workers relay connection instead of Telegram.
 *
 * This class sits between the RelayClient (WebSocket transport) and
 * the shared gateway components (SessionManager, ContextInjector, etc.).
 */

import { spawn } from "child_process";
import { loadSession, saveSession, recordExchange, formatSessionContext } from "../gateway/SessionManager";
import { injectContext } from "../gateway/ContextInjector";
import { captureLearning } from "../gateway/LearningCapture";
import { generateVoiceResponse } from "../gateway/VoiceResponder";
import { transcribeAudio } from "../gateway/GeminiSTT";
import type {
  KayaMobileGateway,
  MobileMessage,
  MobileResponse,
  ProcessedMedia,
  ContextPayload,
  Exchange,
  Notification,
  Session,
} from "../gateway/KayaMobileGateway";
import type { RelayFrame, MessagePayload, VoiceChunkPayload, ResponsePayload, NotificationPayload } from "./types/relay";

// Import relay types from relay package
type RelayTypes = {
  RelayFrame: RelayFrame;
  MessagePayload: MessagePayload;
  VoiceChunkPayload: VoiceChunkPayload;
  ResponsePayload: ResponsePayload;
  NotificationPayload: NotificationPayload;
};

/** Callback to send a frame via the WebSocket connection */
export type SendFrameCallback = (frame: RelayFrame) => void;

/** Handler for voice audio chunks from desktop */
export type VoiceChunkHandler = (chunk: VoiceChunkPayload) => void;

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * RelayGateway implements KayaMobileGateway for the relay channel.
 * Uses the shared pipeline from Phase 1.
 */
export class RelayGateway implements KayaMobileGateway {
  private sendFrame: SendFrameCallback;
  private encryptPayload: (payload: unknown) => { encrypted: string; nonce: string };
  private decryptPayload: <T>(encrypted: string, nonce: string) => T;
  private voiceChunkHandlers: VoiceChunkHandler[] = [];
  private voiceBuffers: Map<string, Buffer[]> = new Map();

  constructor(
    sendFrame: SendFrameCallback,
    encryptPayload: (payload: unknown) => { encrypted: string; nonce: string },
    decryptPayload: <T>(encrypted: string, nonce: string) => T
  ) {
    this.sendFrame = sendFrame;
    this.encryptPayload = encryptPayload;
    this.decryptPayload = decryptPayload;
  }

  // ─────────────────────────────────────────────────────────
  // KayaMobileGateway Interface Implementation
  // ─────────────────────────────────────────────────────────

  async receiveMessage(raw: unknown): Promise<MobileMessage> {
    const frame = raw as RelayFrame;

    if (frame.type === "message") {
      const payload = this.decryptPayload<MessagePayload>(frame.encrypted, frame.nonce);

      return {
        messageId: frame.id,
        channelId: payload.sessionId,
        timestamp: new Date(frame.timestamp).toISOString(),
        type: payload.mediaRef ? "image" : "text",
        text: payload.text,
        imageCaption: payload.caption,
        platform: "signal" as const, // relay channel
        rawPlatformData: frame,
      };
    }

    if (frame.type === "voice_chunk") {
      const payload = this.decryptPayload<VoiceChunkPayload>(frame.encrypted, frame.nonce);

      // Notify voice chunk handlers (used by VoiceResponder)
      for (const handler of this.voiceChunkHandlers) {
        handler(payload);
      }

      // Accumulate audio chunks
      const sessionId = payload.sessionId;
      if (!this.voiceBuffers.has(sessionId)) {
        this.voiceBuffers.set(sessionId, []);
      }
      this.voiceBuffers.get(sessionId)!.push(Buffer.from(payload.audio, "base64"));

      if (payload.isLast) {
        // Concatenate all chunks and transcribe
        const allChunks = this.voiceBuffers.get(sessionId)!;
        this.voiceBuffers.delete(sessionId);
        const fullAudio = Buffer.concat(allChunks);

        let transcription = "";
        try {
          transcription = await transcribeAudio(fullAudio);
          console.log(`[RelayGateway] Transcribed ${fullAudio.length} bytes: "${transcription.substring(0, 50)}..."`);
        } catch (error) {
          console.error("[RelayGateway] STT failed:", error);
          transcription = "[Voice message - transcription failed]";
        }

        return {
          messageId: frame.id,
          channelId: sessionId,
          timestamp: new Date(frame.timestamp).toISOString(),
          type: "voice",
          text: transcription,
          transcription,
          platform: "signal" as const,
          rawPlatformData: { frame, payload, audioSize: fullAudio.length },
        };
      }

      // Not last chunk - return a marker that processMessageFrame should skip
      return {
        messageId: frame.id,
        channelId: sessionId,
        timestamp: new Date(frame.timestamp).toISOString(),
        type: "voice",
        text: "",  // Empty = intermediate chunk
        platform: "signal" as const,
        rawPlatformData: { frame, payload, isIntermediate: true },
      };
    }

    throw new Error(`Unsupported frame type: ${(frame as RelayFrame).type}`);
  }

  async sendResponse(channelId: string, response: MobileResponse): Promise<void> {
    const payload: ResponsePayload = {
      text: response.text,
      sessionId: channelId,
      metadata: {
        contextProfile: response.metadata.profile ?? "general",
        responseTimeMs: response.metadata.latencyMs,
        source: "relay",
      },
    };

    const { encrypted, nonce } = this.encryptPayload(payload);

    this.sendFrame({
      type: "response",
      id: generateId(),
      encrypted,
      nonce,
      timestamp: Date.now(),
    });

    // If voice audio, stream it as voice_chunks
    if (response.voiceAudio) {
      await this.streamVoiceAudio(response.voiceAudio, channelId);
    }
  }

  async handleMedia(message: MobileMessage): Promise<ProcessedMedia> {
    // For relay channel, media is already processed (comes as mediaRef pointing to R2)
    // The desktop downloads from R2 and processes locally
    if (message.imageData) {
      return {
        text: `[Image: ${message.imageCaption ?? "No caption"}]`,
        type: "image_analysis",
        confidence: 1.0,
        originalSizeBytes: message.imageData.length,
      };
    }

    return {
      text: message.text,
      type: "voice_transcription",
      confidence: 1.0,
      originalSizeBytes: 0,
    };
  }

  async injectContext(message: MobileMessage, session: Session): Promise<ContextPayload> {
    return injectContext(message, session);
  }

  async captureLearning(exchange: Exchange): Promise<void> {
    return captureLearning(exchange);
  }

  async loadSession(channelId: string): Promise<Session> {
    return loadSession(channelId);
  }

  async saveSession(session: Session): Promise<void> {
    return saveSession(session);
  }

  async summarizeSession(session: Session): Promise<string> {
    // Delegate to the shared session manager
    const { recentExchanges } = session;
    if (recentExchanges.length === 0) return "";

    const exchangeText = recentExchanges
      .map((e) => `User: ${e.userText}\nAssistant: ${e.assistantText}`)
      .join("\n\n");

    return new Promise((resolve) => {
      const env = { ...process.env };
      delete env["ANTHROPIC_API_KEY"];

      const proc = spawn("claude", [
        "-p",
        "--model", "haiku",
        "--output-format", "text",
        `Summarize this conversation concisely (max 300 words): ${exchangeText}`,
      ], { env, stdio: ["ignore", "pipe", "pipe"] });

      let stdout = "";
      proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
      setTimeout(() => { proc.kill("SIGTERM"); resolve(""); }, 15000);
      proc.on("close", (code: number | null) => {
        resolve(code === 0 ? stdout.trim() : "");
      });
    });
  }

  async notify(notification: Notification): Promise<void> {
    const payload: NotificationPayload = {
      title: notification.title,
      body: notification.body,
      category: "alert",
      actionUrl: undefined,
    };

    const { encrypted, nonce } = this.encryptPayload(payload);

    this.sendFrame({
      type: "notification",
      id: generateId(),
      encrypted,
      nonce,
      timestamp: Date.now(),
    });
  }

  // ─────────────────────────────────────────────────────────
  // Voice Streaming
  // ─────────────────────────────────────────────────────────

  onVoiceChunk(handler: VoiceChunkHandler): void {
    this.voiceChunkHandlers.push(handler);
  }

  private async streamVoiceAudio(audio: Buffer, sessionId: string): Promise<void> {
    const CHUNK_SIZE = 4096; // 4KB chunks
    const totalChunks = Math.ceil(audio.length / CHUNK_SIZE);

    for (let i = 0; i < totalChunks; i++) {
      const chunk = audio.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      const payload: VoiceChunkPayload = {
        audio: chunk.toString("base64"),
        sampleRate: 24000,
        isFirst: i === 0,
        isLast: i === totalChunks - 1,
        sessionId,
      };

      const { encrypted, nonce } = this.encryptPayload(payload);
      this.sendFrame({
        type: "voice_chunk",
        id: generateId(),
        encrypted,
        nonce,
        timestamp: Date.now(),
      });

      // Small delay to avoid overwhelming the WebSocket buffer
      if (i < totalChunks - 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  }

  // ─────────────────────────────────────────────────────────
  // Message Processing Pipeline
  // ─────────────────────────────────────────────────────────

  /**
   * Full pipeline: receive frame → session → context → claude → response
   * Called by RelayClient for each incoming message frame.
   */
  async processMessageFrame(frame: RelayFrame): Promise<void> {
    const startTime = Date.now();

    try {
      const message = await this.receiveMessage(frame);

      // Skip empty voice frames (intermediate chunks)
      if (message.type === "voice" && !message.text) {
        return;
      }

      // Send processing indicator to mobile for voice messages
      if (message.type === "voice") {
        const processingPayload = { code: "processing", message: "Transcribing voice message..." };
        const { encrypted: procEnc, nonce: procNonce } = this.encryptPayload(processingPayload);
        this.sendFrame({
          type: "status",
          id: generateId(),
          encrypted: procEnc,
          nonce: procNonce,
          timestamp: Date.now(),
        });
      }

      // Load session
      const session = await this.loadSession(message.channelId);

      // Inject context
      const context = await this.injectContext(message, session);

      // Build prompt with session context
      const sessionContext = formatSessionContext(session);
      const fullPrompt = sessionContext
        ? `${context.systemPrompt}\n\n${sessionContext}\n\nUser: ${message.text}`
        : message.text;

      // Call Claude
      const responseText = await this.callClaude(fullPrompt, context);

      // Generate voice if applicable
      let voiceAudio: Buffer | undefined;
      try {
        const voiceResult = await generateVoiceResponse(responseText);
        if (voiceResult.success && voiceResult.audioBuffer) {
          voiceAudio = voiceResult.audioBuffer;
        }
      } catch {
        // Voice is best-effort
      }

      const response: MobileResponse = {
        text: responseText,
        voiceLine: "",
        voiceAudio,
        truncated: false,
        metadata: {
          model: "claude",
          latencyMs: Date.now() - startTime,
          sessionId: session.sessionId,
          profile: context.profile,
        },
      };

      // Send response
      await this.sendResponse(message.channelId, response);

      // Record exchange and capture learning
      const exchange: Exchange = {
        message,
        response,
        session,
      };

      await recordExchange(session, {
        timestamp: message.timestamp,
        userText: message.text,
        assistantText: responseText,
        source: message.type,
        profile: context.profile,
      });

      await this.captureLearning(exchange);
    } catch (error) {
      console.error("[RelayGateway] Error processing frame:", error);

      // Send error status back to mobile
      const errorPayload = { code: "error", message: "Processing failed" };
      const { encrypted, nonce } = this.encryptPayload(errorPayload);
      this.sendFrame({
        type: "status",
        id: generateId(),
        encrypted,
        nonce,
        timestamp: Date.now(),
      });
    }
  }

  private async callClaude(
    prompt: string,
    context: ContextPayload
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const env = { ...process.env };
      delete env["ANTHROPIC_API_KEY"];

      const args = [
        "-p",
        "--model", "sonnet",
        "--output-format", "text",
        "--system", context.systemPrompt,
        prompt,
      ];

      let stdout = "";
      let stderr = "";

      const proc = spawn("claude", args, {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
      proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

      const timeoutId = setTimeout(() => {
        proc.kill("SIGTERM");
        reject(new Error("Claude timeout after 30s"));
      }, 30000);

      proc.on("close", (code: number | null) => {
        clearTimeout(timeoutId);
        if (code === 0 && stdout.trim()) {
          resolve(stdout.trim());
        } else {
          reject(new Error(`Claude exited with code ${code}: ${stderr}`));
        }
      });

      proc.on("error", (err: Error) => {
        clearTimeout(timeoutId);
        reject(err);
      });
    });
  }
}

// ─────────────────────────────────────────────────────────
// Re-export relay types for relay module consumers
// ─────────────────────────────────────────────────────────

export type { RelayFrame, MessagePayload, VoiceChunkPayload, ResponsePayload, NotificationPayload };
