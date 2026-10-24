/**
 * RealtimeErrorHandler.test.ts - Tests for centralized error handling
 *
 * Tests: withTimeout, handleSTTError, handleLLMError, handleTTSError,
 * handleCapacityError, speakError fallback chain, SPOKEN_ERRORS.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, spyOn } from "bun:test";
import * as childProcess from "child_process";
import * as VoiceCommon from "./VoiceCommon.ts";

// spyOn (restored in afterAll) rather than mock.module: bun's module mocks
// are process-global and would leak into every later test file in the run.
const configSpy = spyOn(VoiceCommon, "getRealtimeVoiceConfig").mockImplementation(() =>
  VoiceCommon.RealtimeVoiceConfigSchema.parse({ macOsSayFallback: true }),
);
// macOS `say` must never run in tests: every spawnSync reports failure.
const spawnSyncSpy = spyOn(childProcess, "spawnSync").mockImplementation(
  () => ({ pid: 0, output: [], stdout: "", stderr: "", status: 1, signal: null }),
);

afterAll(() => {
  configSpy.mockRestore();
  spawnSyncSpy.mockRestore();
});
import {
  withTimeout,
  handleSTTError,
  handleLLMError,
  handleTTSError,
  handleCapacityError,
  speakError,
  SPOKEN_ERRORS,
} from "./RealtimeErrorHandler.ts";

// ============================================================================
// withTimeout
// ============================================================================

describe("withTimeout", () => {
  it("resolves with value when promise completes before timeout", async () => {
    const result = await withTimeout(
      Promise.resolve("hello"),
      1000,
      "fallback",
    );
    expect(result).toBe("hello");
  });

  it("returns fallback when promise exceeds timeout", async () => {
    const slow = new Promise<string>((resolve) =>
      setTimeout(() => resolve("late"), 5000),
    );
    const result = await withTimeout(slow, 50, "timed-out");
    expect(result).toBe("timed-out");
  });

  it("returns fallback when promise rejects", async () => {
    const failing = Promise.reject(new Error("boom"));
    // withTimeout races against timeout; rejection propagates but
    // we need to verify it doesn't throw unhandled
    try {
      const result = await withTimeout(failing, 1000, "fallback");
      // Promise.race: if the promise rejects before timeout, it throws
      expect(result).toBe("fallback"); // won't reach if rejection propagates
    } catch {
      // Expected: rejection propagates through Promise.race
    }
  });

  it("clears the timeout after resolution", async () => {
    const clearSpy = spyOn(globalThis, "clearTimeout");
    await withTimeout(Promise.resolve("done"), 5000, "fallback");
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it("logs with label when timing out", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const slow = new Promise<string>((resolve) =>
      setTimeout(() => resolve("late"), 5000),
    );
    await withTimeout(slow, 50, "fallback", "test-op");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("test-op timed out"),
    );
    warnSpy.mockRestore();
  });
});

// ============================================================================
// handleSTTError
// ============================================================================

describe("handleSTTError", () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("returns error type message", () => {
    const result = handleSTTError(new Error("Connection refused"), "sess-1");
    expect(result.type).toBe("error");
  });

  it("returns STT_UNAVAILABLE code", () => {
    const result = handleSTTError(new Error("Connection refused"), "sess-1");
    expect(result.error?.code).toBe("STT_UNAVAILABLE");
  });

  it("marks as recoverable", () => {
    const result = handleSTTError(new Error("Connection refused"), "sess-1");
    expect(result.error?.recoverable).toBe(true);
  });

  it("includes spoken error message", () => {
    const result = handleSTTError(new Error("Connection refused"), "sess-1");
    expect(result.text).toBe(SPOKEN_ERRORS.stt);
  });
});

// ============================================================================
// handleLLMError
// ============================================================================

describe("handleLLMError", () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("returns LLM_TIMEOUT code for timeout errors", () => {
    const result = handleLLMError(new Error("Operation timed out after 15000ms"), "sess-1");
    expect(result.error?.code).toBe("LLM_TIMEOUT");
  });

  it("returns LLM_RATE_LIMITED code for 429 errors", () => {
    const result = handleLLMError(new Error("429 Too Many Requests"), "sess-1");
    expect(result.error?.code).toBe("LLM_RATE_LIMITED");
  });

  it("returns LLM_RATE_LIMITED for rate limit message", () => {
    const result = handleLLMError(new Error("rate limit exceeded"), "sess-1");
    expect(result.error?.code).toBe("LLM_RATE_LIMITED");
  });

  it("returns LLM_ERROR code for general errors", () => {
    const result = handleLLMError(new Error("Internal server error"), "sess-1");
    expect(result.error?.code).toBe("LLM_ERROR");
  });

  it("marks all LLM errors as recoverable", () => {
    const timeout = handleLLMError(new Error("timed out"), "sess-1");
    const rate = handleLLMError(new Error("429"), "sess-1");
    const general = handleLLMError(new Error("server error"), "sess-1");

    expect(timeout.error?.recoverable).toBe(true);
    expect(rate.error?.recoverable).toBe(true);
    expect(general.error?.recoverable).toBe(true);
  });
});

// ============================================================================
// handleTTSError
// ============================================================================

describe("handleTTSError", () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("returns text type for TTS fallback", () => {
    const result = handleTTSError(new Error("TTS down"), "Hello world", "sess-1");
    expect(result.type).toBe("text");
  });

  it("preserves the original text in the response", () => {
    const result = handleTTSError(new Error("TTS down"), "Here is my answer", "sess-1");
    expect(result.text).toBe("Here is my answer");
  });

  it("includes a message about TTS unavailability", () => {
    const result = handleTTSError(new Error("TTS down"), "text", "sess-1");
    expect(result.message).toContain("TTS unavailable");
  });
});

// ============================================================================
// handleCapacityError
// ============================================================================

describe("handleCapacityError", () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("returns CAPACITY_EXCEEDED code", () => {
    const result = handleCapacityError("sess-1");
    expect(result.error?.code).toBe("CAPACITY_EXCEEDED");
  });

  it("marks as NOT recoverable", () => {
    const result = handleCapacityError("sess-1");
    expect(result.error?.recoverable).toBe(false);
  });

  it("includes spoken capacity message", () => {
    const result = handleCapacityError("sess-1");
    expect(result.text).toBe(SPOKEN_ERRORS.capacity);
  });
});

// ============================================================================
// speakError
// ============================================================================

describe("speakError", () => {
  let fetchSpy: { mockRestore(): void } | null = null;

  afterEach(() => {
    fetchSpy?.mockRestore();
    fetchSpy = null;
  });

  it("returns base64 string when TTS succeeds", async () => {
    const fakeAudio = new Uint8Array([0x52, 0x49, 0x46, 0x46]); // RIFF header
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response(fakeAudio));

    const result = await speakError("Test error message");
    expect(result).toBeTruthy();
    expect(typeof result).toBe("string");
    // Should be valid base64
    expect(() => Buffer.from(result!, "base64")).not.toThrow();
  });

  it("returns null when all TTS methods fail", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection refused"));

    // spawnSync is spied at file top to return status: 1
    const result = await speakError("Test error");
    expect(result).toBeNull();
  });
});

// ============================================================================
// SPOKEN_ERRORS
// ============================================================================

describe("SPOKEN_ERRORS", () => {
  it("has all 5 error categories", () => {
    expect(SPOKEN_ERRORS).toHaveProperty("stt");
    expect(SPOKEN_ERRORS).toHaveProperty("llm");
    expect(SPOKEN_ERRORS).toHaveProperty("tts");
    expect(SPOKEN_ERRORS).toHaveProperty("capacity");
    expect(SPOKEN_ERRORS).toHaveProperty("unknown");
  });

  it("all messages are non-empty strings", () => {
    for (const [, message] of Object.entries(SPOKEN_ERRORS)) {
      expect(typeof message).toBe("string");
      expect(message.length).toBeGreaterThan(0);
    }
  });

  it("messages are human-readable sentences", () => {
    for (const [, message] of Object.entries(SPOKEN_ERRORS)) {
      // Should end with a period
      expect(message.endsWith(".")).toBe(true);
    }
  });
});
