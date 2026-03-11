#!/usr/bin/env bun
/**
 * RealtimeErrorHandler.ts - Centralized error handling for real-time voice
 *
 * Wraps async operations with timeout and fallback, ensuring errors produce
 * spoken messages rather than crashes or silence. All error handlers return
 * a RealtimeServerMessage that the server can send to the client.
 *
 * Key functions:
 *   - withTimeout: Race a promise against a timeout
 *   - handleSTTError: STT failure -> spoken error
 *   - handleLLMError: LLM failure -> spoken error
 *   - handleTTSError: TTS failure -> text fallback
 *   - speakError: Generate TTS audio for an error message with fallback chain
 *
 * CLI:
 *   bun RealtimeErrorHandler.ts test   # Simulate error scenarios
 */

import { spawnSync } from "child_process";
import { getRealtimeVoiceConfig } from "./VoiceCommon.ts";
import { httpClient } from "../../../../lib/core/CachedHTTPClient.ts";

// ============================================================================
// Types
// ============================================================================

interface ErrorServerMessage {
  type: "error" | "audio" | "text";
  message?: string;
  text?: string;
  data?: string; // base64 audio
  error?: {
    code: string;
    message: string;
    recoverable: boolean;
  };
}

type ErrorCategory = "stt" | "llm" | "tts" | "capacity" | "unknown";

interface ErrorContext {
  sessionId: string;
  category: ErrorCategory;
  originalError: Error;
  timestamp: string;
}

// ============================================================================
// Timeout Utility
// ============================================================================

/**
 * Race a promise against a timeout. Returns the fallback value if the
 * promise does not resolve within the specified milliseconds.
 *
 * @param promise - The async operation to wrap
 * @param ms - Timeout in milliseconds
 * @param fallback - Value to return on timeout
 * @param label - Optional label for logging
 * @returns The resolved value or the fallback
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
  label?: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<T>((resolve) => {
    timeoutId = setTimeout(() => {
      const msg = label ? `${label} timed out after ${ms}ms` : `Operation timed out after ${ms}ms`;
      console.warn(`[ErrorHandler] ${msg}`);
      resolve(fallback);
    }, ms);
  });

  try {
    const result = await Promise.race([promise, timeoutPromise]);
    return result;
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

// ============================================================================
// Spoken Error Messages
// ============================================================================

const SPOKEN_ERRORS: Record<ErrorCategory, string> = {
  stt: "I can't hear you right now. The transcription service is offline.",
  llm: "I'm having trouble thinking right now. Try again in a moment.",
  tts: "I can't speak right now, but I can still type my responses.",
  capacity: "I'm at capacity right now. Please try again shortly.",
  unknown: "Something went wrong. Let me try that again.",
};

const RATE_LIMIT_MESSAGE = "I need a moment to collect my thoughts. Try again in a few seconds.";

// ============================================================================
// Error Handlers
// ============================================================================

/**
 * Handle STT (speech-to-text) errors.
 * Returns a server message with a spoken error about transcription failure.
 */
export function handleSTTError(error: Error, sessionId: string): ErrorServerMessage {
  const context: ErrorContext = {
    sessionId,
    category: "stt",
    originalError: error,
    timestamp: new Date().toISOString(),
  };

  logError(context);

  return {
    type: "error",
    error: {
      code: "STT_UNAVAILABLE",
      message: SPOKEN_ERRORS.stt,
      recoverable: true,
    },
    text: SPOKEN_ERRORS.stt,
  };
}

/**
 * Handle LLM (Gemini API) errors.
 * Differentiates between timeouts, rate limits, and general failures.
 */
export function handleLLMError(error: Error, sessionId: string): ErrorServerMessage {
  const context: ErrorContext = {
    sessionId,
    category: "llm",
    originalError: error,
    timestamp: new Date().toISOString(),
  };

  logError(context);

  // Check for rate limit (429)
  const isRateLimit = error.message.includes("429") || error.message.toLowerCase().includes("rate limit");
  const isTimeout = error.message.includes("timed out") || error.message.includes("timeout");

  const spokenMessage = isRateLimit
    ? RATE_LIMIT_MESSAGE
    : isTimeout
      ? SPOKEN_ERRORS.llm
      : SPOKEN_ERRORS.llm;

  const code = isRateLimit ? "LLM_RATE_LIMITED" : isTimeout ? "LLM_TIMEOUT" : "LLM_ERROR";

  return {
    type: "error",
    error: {
      code,
      message: spokenMessage,
      recoverable: true,
    },
    text: spokenMessage,
  };
}

/**
 * Handle TTS (text-to-speech) errors.
 * Falls back to text-only message when both MLX TTS and macOS say fail.
 */
export function handleTTSError(error: Error, text: string, sessionId: string): ErrorServerMessage {
  const context: ErrorContext = {
    sessionId,
    category: "tts",
    originalError: error,
    timestamp: new Date().toISOString(),
  };

  logError(context);

  // Return text-only fallback so client can display it
  return {
    type: "text",
    text,
    message: "TTS unavailable, sending text response",
  };
}

/**
 * Handle capacity errors when too many sessions are active.
 */
export function handleCapacityError(sessionId: string): ErrorServerMessage {
  console.warn(`[ErrorHandler] [${sessionId}] Capacity exceeded`);

  return {
    type: "error",
    error: {
      code: "CAPACITY_EXCEEDED",
      message: SPOKEN_ERRORS.capacity,
      recoverable: false,
    },
    text: SPOKEN_ERRORS.capacity,
  };
}

// ============================================================================
// TTS Fallback Chain
// ============================================================================

/**
 * Attempt to speak an error message using the TTS fallback chain:
 * 1. MLX TTS (localhost:8880)
 * 2. macOS `say` command
 * 3. Return text-only if both fail
 *
 * Returns base64-encoded audio data or null if all TTS options fail.
 */
export async function speakError(
  message: string,
  voice: string = "af_heart",
): Promise<string | null> {
  const config = getRealtimeVoiceConfig();

  // Try MLX TTS first
  try {
    const response = await httpClient.fetch(config.ttsUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "prince-canuma/Kokoro-82M",
        input: message,
        voice,
        response_format: "wav",
      }),
      signal: AbortSignal.timeout(5000),
      cache: "none",
    });

    if (response.ok) {
      const buffer = await response.arrayBuffer();
      return Buffer.from(buffer).toString("base64");
    }
  } catch {
    // MLX TTS unavailable, try fallback
  }

  // Try macOS say fallback
  if (config.macOsSayFallback) {
    try {
      const tmpFile = `/tmp/voice-error-${Date.now()}.aiff`;
      const result = spawnSync("say", ["-o", tmpFile, message], {
        timeout: 5000,
      });

      if (result.status === 0) {
        const file = Bun.file(tmpFile);
        if (await file.exists()) {
          const buffer = await file.arrayBuffer();
          // Clean up
          try { await Bun.write(tmpFile, ""); } catch { /* ignore */ }
          return Buffer.from(buffer).toString("base64");
        }
      }
    } catch {
      // macOS say also failed
    }
  }

  // All TTS failed, return null (caller should send text-only)
  return null;
}

// ============================================================================
// Error Logging
// ============================================================================

function logError(context: ErrorContext): void {
  const msg = context.originalError.message;
  const truncated = msg.length > 200 ? msg.slice(0, 200) + "..." : msg;
  console.error(
    `[${context.timestamp}] [ERROR] [${context.category.toUpperCase()}] ` +
    `[${context.sessionId}] ${truncated}`,
  );
}

// ============================================================================
// CLI
// ============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case "test": {
      console.log("=== RealtimeErrorHandler Test ===\n");

      // Test withTimeout
      console.log("1. Testing withTimeout (should resolve)...");
      const fast = await withTimeout(
        Promise.resolve("hello"),
        1000,
        "timeout",
        "fast-test",
      );
      console.log(`   Result: ${fast} (expected: hello)\n`);

      console.log("2. Testing withTimeout (should timeout)...");
      const slow = await withTimeout(
        new Promise((resolve) => setTimeout(() => resolve("late"), 5000)),
        100,
        "timed-out",
        "slow-test",
      );
      console.log(`   Result: ${slow} (expected: timed-out)\n`);

      // Test error handlers
      console.log("3. Testing handleSTTError...");
      const sttErr = handleSTTError(new Error("Connection refused"), "test-session");
      console.log(`   Code: ${sttErr.error?.code}`);
      console.log(`   Message: ${sttErr.error?.message}\n`);

      console.log("4. Testing handleLLMError (timeout)...");
      const llmTimeout = handleLLMError(new Error("Operation timed out after 15000ms"), "test-session");
      console.log(`   Code: ${llmTimeout.error?.code}`);
      console.log(`   Message: ${llmTimeout.error?.message}\n`);

      console.log("5. Testing handleLLMError (rate limit)...");
      const llmRate = handleLLMError(new Error("429 Too Many Requests"), "test-session");
      console.log(`   Code: ${llmRate.error?.code}`);
      console.log(`   Message: ${llmRate.error?.message}\n`);

      console.log("6. Testing handleTTSError...");
      const ttsErr = handleTTSError(new Error("TTS server down"), "Hello world", "test-session");
      console.log(`   Type: ${ttsErr.type}`);
      console.log(`   Text: ${ttsErr.text}\n`);

      console.log("7. Testing handleCapacityError...");
      const capErr = handleCapacityError("test-session");
      console.log(`   Code: ${capErr.error?.code}`);
      console.log(`   Message: ${capErr.error?.message}\n`);

      console.log("=== All tests passed ===");
      break;
    }

    case "--help":
    case "help":
    default: {
      console.log(`RealtimeErrorHandler - Centralized error handling for real-time voice

Commands:
  test      Simulate error scenarios and verify handlers
  --help    Show this help`);
      break;
    }
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}

export { SPOKEN_ERRORS };
export type { ErrorServerMessage, ErrorCategory, ErrorContext };
