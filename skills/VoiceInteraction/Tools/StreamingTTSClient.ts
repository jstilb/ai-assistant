#!/usr/bin/env bun
/**
 * @deprecated Use LocalTTSClient.ts instead.
 * Kept for rollback purposes until voice migration is confirmed stable (2+ weeks).
 * See: skills/VoiceInteraction/Tools/LocalTTSClient.ts
 *
 * StreamingTTSClient.ts - WebSocket streaming TTS via ElevenLabs
 *
 * Connects to the ElevenLabs WebSocket streaming API for real-time
 * text-to-speech. Sends text chunks and receives audio chunks with
 * minimal latency. Features:
 *
 * - WebSocket connection to ElevenLabs stream-input API
 * - 2-second TTFB timeout triggers automatic batch fallback
 * - Feature flag via StateManager (streaming.enabled, default: true)
 * - Event emission: 'chunk', 'complete', 'error', 'fallback'
 * - Clean cancellation for interruption handling
 * - AudioBufferQueue integration for sequential playback
 *
 * Usage (library):
 *   import { StreamingTTSClient } from "./StreamingTTSClient.ts";
 *
 *   const client = new StreamingTTSClient();
 *   const isEnabled = await client.isStreamingEnabled();
 *   if (isEnabled) {
 *     await client.streamText("Hello world");
 *   }
 *
 * @module StreamingTTSClient
 * @version 1.0.0
 */

import { EventEmitter } from "events";
import { join } from "path";
import { z } from "zod";
import { createStateManager, type StateManager } from "../../CORE/Tools/StateManager.ts";
import {
  getElevenLabsConfig,
  type ElevenLabsConfig,
} from "./VoiceCommon.ts";
import { AudioBufferQueue, createAudioChunk, type AudioChunk } from "./AudioBufferQueue.ts";
import { generateSpeechBatch, type BatchTTSResult } from "./batch-fallback.ts";

// ============================================
// CONSTANTS
// ============================================

/** Default timeout for first audio chunk (ms). If no chunk arrives within this
 *  window, streaming is abandoned and batch fallback is triggered. */
const DEFAULT_STREAMING_TIMEOUT_MS = 2000;

/** ElevenLabs WebSocket streaming API base URL */
const ELEVENLABS_WS_BASE = "wss://api.elevenlabs.io/v1/text-to-speech";

/** State file path for streaming feature flags */
const STREAMING_STATE_PATH = "/tmp/voice-interaction/streaming-config.json";

// ============================================
// TYPES
// ============================================

/**
 * Events emitted by StreamingTTSClient
 */
export interface StreamingTTSEvents {
  /** Emitted when an audio chunk is received */
  chunk: (chunk: AudioChunk) => void;
  /** Emitted when streaming completes successfully */
  complete: (stats: StreamingStats) => void;
  /** Emitted when an error occurs during streaming */
  error: (error: Error) => void;
  /** Emitted when streaming fails and batch fallback is activated */
  fallback: (reason: string) => void;
}

/**
 * Statistics from a streaming TTS session
 */
export interface StreamingStats {
  /** Total chunks received */
  totalChunks: number;
  /** Total bytes received */
  totalBytes: number;
  /** Time to first byte in milliseconds */
  ttfb_ms: number;
  /** Total duration in milliseconds */
  duration_ms: number;
  /** Whether batch fallback was used */
  usedFallback: boolean;
}

/**
 * Streaming configuration persisted via StateManager
 */
const StreamingConfigSchema = z.object({
  /** Whether streaming TTS is enabled (default: true) */
  enabled: z.boolean(),
  /** Timeout in ms before falling back to batch (default: 2000) */
  timeoutMs: z.number(),
  /** Total streaming requests made */
  totalRequests: z.number(),
  /** Total fallback activations */
  totalFallbacks: z.number(),
  /** Last updated timestamp */
  lastUpdated: z.string(),
});

type StreamingConfig = z.infer<typeof StreamingConfigSchema>;

// ============================================
// STATE MANAGER
// ============================================

let _streamingConfigManager: StateManager<StreamingConfig> | null = null;

/**
 * Get the StateManager instance for streaming configuration.
 * Uses lazy initialization with singleton pattern.
 */
function getStreamingConfigManager(): StateManager<StreamingConfig> {
  if (!_streamingConfigManager) {
    _streamingConfigManager = createStateManager({
      path: STREAMING_STATE_PATH,
      schema: StreamingConfigSchema,
      defaults: {
        enabled: true,
        timeoutMs: DEFAULT_STREAMING_TIMEOUT_MS,
        totalRequests: 0,
        totalFallbacks: 0,
        lastUpdated: new Date().toISOString(),
      },
    });
  }
  return _streamingConfigManager;
}

// ============================================
// STREAMING TTS CLIENT
// ============================================

/**
 * WebSocket-based streaming TTS client for ElevenLabs.
 *
 * Sends text to the ElevenLabs WebSocket stream-input API and receives
 * audio chunks in real-time. If the first audio chunk does not arrive
 * within the configured timeout (default 2s), the client automatically
 * falls back to the batch REST API.
 *
 * The client emits events for each phase of the streaming lifecycle:
 * - 'chunk': Audio chunk received (integrate with AudioBufferQueue)
 * - 'complete': Streaming finished successfully
 * - 'error': Error occurred
 * - 'fallback': Batch fallback activated
 */
export class StreamingTTSClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private audioBuffer: AudioBufferQueue;
  private cancelled: boolean = false;
  private chunkIndex: number = 0;
  private startTime: number = 0;
  private firstChunkTime: number = 0;
  private totalBytes: number = 0;

  constructor(bufferOptions?: { maxSize?: number }) {
    super();
    this.audioBuffer = new AudioBufferQueue(bufferOptions);
  }

  /**
   * Check if streaming TTS is enabled via feature flag.
   * Reads from StateManager-persisted configuration.
   */
  async isStreamingEnabled(): Promise<boolean> {
    const manager = getStreamingConfigManager();
    const config = await manager.load();
    return config.enabled;
  }

  /**
   * Set the streaming feature flag.
   *
   * @param enabled - Whether to enable streaming TTS
   */
  async setStreamingEnabled(enabled: boolean): Promise<void> {
    const manager = getStreamingConfigManager();
    await manager.update((config) => ({
      ...config,
      enabled,
    }));
  }

  /**
   * Get the current streaming configuration.
   */
  async getConfig(): Promise<StreamingConfig> {
    const manager = getStreamingConfigManager();
    return manager.load();
  }

  /**
   * Stream text to audio via ElevenLabs WebSocket API.
   *
   * If streaming is disabled via feature flag, falls back to batch immediately.
   * If the first chunk does not arrive within the timeout, triggers batch fallback.
   *
   * @param text - The text to convert to speech
   * @returns StreamingStats with timing and size metrics
   */
  async streamText(text: string): Promise<StreamingStats> {
    const manager = getStreamingConfigManager();
    const streamConfig = await manager.load();

    // Track request
    await manager.update((c) => ({
      ...c,
      totalRequests: c.totalRequests + 1,
    }));

    // If streaming is disabled, go straight to batch fallback
    if (!streamConfig.enabled) {
      return this.executeBatchFallback(text, "streaming_disabled");
    }

    this.cancelled = false;
    this.chunkIndex = 0;
    this.startTime = Date.now();
    this.firstChunkTime = 0;
    this.totalBytes = 0;

    const elevenConfig = getElevenLabsConfig();

    if (!elevenConfig.apiKey || !elevenConfig.voiceId) {
      return this.executeBatchFallback(text, "missing_config");
    }

    const timeoutMs = streamConfig.timeoutMs || DEFAULT_STREAMING_TIMEOUT_MS;

    try {
      return await this.connectAndStream(text, elevenConfig, timeoutMs);
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      // Streaming failed -- activate batch fallback
      const reason = error.name === "AbortError" ? "timeout" : error.message;
      this.emit("error", error);
      return this.executeBatchFallback(text, reason);
    }
  }

  /**
   * Cancel the current streaming session.
   * Closes WebSocket, flushes audio buffer, emits 'interrupted' event.
   */
  cancel(): void {
    this.cancelled = true;
    this.disconnect();
    this.audioBuffer.clear();
  }

  /**
   * Get the internal AudioBufferQueue for playback integration.
   */
  getAudioBuffer(): AudioBufferQueue {
    return this.audioBuffer;
  }

  // ============================================
  // PRIVATE METHODS
  // ============================================

  /**
   * Connect to ElevenLabs WebSocket and stream text.
   */
  private connectAndStream(
    text: string,
    config: ElevenLabsConfig,
    timeoutMs: number
  ): Promise<StreamingStats> {
    return new Promise<StreamingStats>((resolve, reject) => {
      const wsUrl = `${ELEVENLABS_WS_BASE}/${config.voiceId}/stream-input?model_id=eleven_turbo_v2_5&output_format=mp3_44100_128`;

      // Set up timeout for first chunk
      const timeoutHandle = setTimeout(() => {
        if (this.firstChunkTime === 0 && !this.cancelled) {
          this.disconnect();
          reject(new Error(`Streaming TTFB timeout after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      try {
        this.ws = new WebSocket(wsUrl);
      } catch (wsErr: unknown) {
        clearTimeout(timeoutHandle);
        const error = wsErr instanceof Error ? wsErr : new Error(String(wsErr));
        reject(error);
        return;
      }

      this.ws.onopen = () => {
        if (this.cancelled) {
          this.disconnect();
          clearTimeout(timeoutHandle);
          reject(new Error("Cancelled before connection established"));
          return;
        }

        // Send initial configuration message
        const initMessage = JSON.stringify({
          text: " ",
          voice_settings: {
            stability: config.stability,
            similarity_boost: config.similarity_boost,
            style: config.style,
          },
          xi_api_key: config.apiKey,
        });
        this.ws?.send(initMessage);

        // Send the actual text
        const textMessage = JSON.stringify({
          text: text,
          try_trigger_generation: true,
        });
        this.ws?.send(textMessage);

        // Send end-of-stream signal
        const eosMessage = JSON.stringify({ text: "" });
        this.ws?.send(eosMessage);
      };

      this.ws.onmessage = (event: MessageEvent) => {
        if (this.cancelled) return;

        try {
          const message = JSON.parse(
            typeof event.data === "string" ? event.data : ""
          );

          if (message.audio) {
            // Decode base64 audio chunk
            const audioData = Buffer.from(message.audio, "base64");

            if (this.firstChunkTime === 0) {
              this.firstChunkTime = Date.now();
              clearTimeout(timeoutHandle);
            }

            const chunk = createAudioChunk(audioData, this.chunkIndex++);
            this.totalBytes += chunk.byteLength;
            this.audioBuffer.enqueue(chunk);
            this.emit("chunk", chunk);
          }

          if (message.isFinal) {
            const stats: StreamingStats = {
              totalChunks: this.chunkIndex,
              totalBytes: this.totalBytes,
              ttfb_ms: this.firstChunkTime > 0
                ? this.firstChunkTime - this.startTime
                : 0,
              duration_ms: Date.now() - this.startTime,
              usedFallback: false,
            };
            this.disconnect();
            this.emit("complete", stats);
            resolve(stats);
          }
        } catch (parseErr: unknown) {
          // Non-JSON message or parse error -- skip
          console.error("WebSocket message parse error:", parseErr);
        }
      };

      this.ws.onerror = (event: Event) => {
        clearTimeout(timeoutHandle);
        const error = new Error("WebSocket connection error");
        this.disconnect();
        reject(error);
      };

      this.ws.onclose = () => {
        clearTimeout(timeoutHandle);
        // If we never got a final message but got chunks, still resolve
        if (this.chunkIndex > 0 && !this.cancelled) {
          const stats: StreamingStats = {
            totalChunks: this.chunkIndex,
            totalBytes: this.totalBytes,
            ttfb_ms: this.firstChunkTime > 0
              ? this.firstChunkTime - this.startTime
              : 0,
            duration_ms: Date.now() - this.startTime,
            usedFallback: false,
          };
          this.emit("complete", stats);
          resolve(stats);
        }
        // If no chunks at all, this will be handled by timeout or onerror
      };
    });
  }

  /**
   * Execute batch TTS as a fallback when streaming fails.
   */
  private async executeBatchFallback(
    text: string,
    reason: string
  ): Promise<StreamingStats> {
    this.emit("fallback", reason);

    const manager = getStreamingConfigManager();
    await manager.update((c) => ({
      ...c,
      totalFallbacks: c.totalFallbacks + 1,
    }));

    const startTime = Date.now();

    try {
      const result: BatchTTSResult = await generateSpeechBatch(text);

      // Enqueue the entire batch result as a single chunk
      const chunk = createAudioChunk(result.audio, 0);
      this.audioBuffer.enqueue(chunk);
      this.emit("chunk", chunk);

      const stats: StreamingStats = {
        totalChunks: 1,
        totalBytes: result.size_bytes,
        ttfb_ms: result.duration_ms,
        duration_ms: Date.now() - startTime,
        usedFallback: true,
      };

      this.emit("complete", stats);
      return stats;
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit("error", error);
      throw error;
    }
  }

  /**
   * Close the WebSocket connection and clean up.
   */
  private disconnect(): void {
    if (this.ws) {
      try {
        if (
          this.ws.readyState === WebSocket.OPEN ||
          this.ws.readyState === WebSocket.CONNECTING
        ) {
          this.ws.close();
        }
      } catch {
        // WebSocket may already be closed
      }
      this.ws = null;
    }
  }
}

/**
 * Create a StreamingTTSClient instance.
 * Factory function for consistent creation pattern.
 */
export function createStreamingTTSClient(
  bufferOptions?: { maxSize?: number }
): StreamingTTSClient {
  return new StreamingTTSClient(bufferOptions);
}

// ============================================
// CLI INTERFACE
// ============================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case "status": {
      const client = new StreamingTTSClient();
      const config = await client.getConfig();
      console.log(JSON.stringify(config, null, 2));
      break;
    }

    case "enable": {
      const client = new StreamingTTSClient();
      await client.setStreamingEnabled(true);
      console.log(JSON.stringify({ streaming: true }));
      break;
    }

    case "disable": {
      const client = new StreamingTTSClient();
      await client.setStreamingEnabled(false);
      console.log(JSON.stringify({ streaming: false }));
      break;
    }

    case "stream": {
      const text = args.slice(1).join(" ");
      if (!text) {
        console.error("Usage: stream <text>");
        process.exit(1);
      }

      const client = new StreamingTTSClient();
      client.on("chunk", (chunk: AudioChunk) => {
        console.error(`Chunk ${chunk.index}: ${chunk.byteLength} bytes`);
      });
      client.on("fallback", (reason: string) => {
        console.error(`Fallback activated: ${reason}`);
      });
      client.on("error", (error: Error) => {
        console.error(`Error: ${error.message}`);
      });

      const stats = await client.streamText(text);
      console.log(JSON.stringify(stats, null, 2));
      break;
    }

    default:
      console.log(`StreamingTTSClient - WebSocket streaming TTS

Commands:
  stream <text>    Stream text to audio via WebSocket
  status           Show streaming configuration
  enable           Enable streaming TTS
  disable          Disable streaming TTS (use batch only)`);
      break;
  }
}

if (import.meta.main) {
  main().catch((err: Error) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}
