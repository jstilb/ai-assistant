/**
 * RealtimeHealthMonitor.test.ts - Tests for health monitoring and metrics
 *
 * Tests: session counting, metric recording, checkHealth status logic,
 * health check intervals, edge cases.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { RealtimeVoiceConfig } from "../VoiceCommon.ts";

// Mock VoiceCommon
vi.mock("../VoiceCommon.ts", () => ({
  getRealtimeVoiceConfig: vi.fn(() => ({
    port: 8882,
    maxSessions: 3,
    geminiModel: "gemini-2.0-flash",
    llmTimeoutMs: 15000,
    sttUrl: "http://localhost:8881/v1/audio/transcriptions",
    ttsUrl: "http://localhost:8880/v1/audio/speech",
    sttHealthUrl: "http://localhost:8881/v1/audio/transcriptions",
    ttsHealthUrl: "http://localhost:8880/v1/models",
    heartbeatIntervalMs: 15000,
    heartbeatMaxMisses: 2,
    memoryWarningMB: 512,
    contextTimeoutMs: 3000,
    macOsSayFallback: true,
    systemPromptTemplatePath: null,
  })),
}));

import { RealtimeHealthMonitor } from "../RealtimeHealthMonitor.ts";
import type { TurnLatency } from "../RealtimeHealthMonitor.ts";

// ============================================================================
// Helper
// ============================================================================

function createMonitor(overrides?: Partial<RealtimeVoiceConfig>): RealtimeHealthMonitor {
  const config = {
    port: 8882,
    maxSessions: 3,
    geminiModel: "gemini-2.0-flash",
    llmTimeoutMs: 15000,
    sttUrl: "http://localhost:8881/v1/audio/transcriptions",
    ttsUrl: "http://localhost:8880/v1/audio/speech",
    sttHealthUrl: "http://localhost:8881/v1/audio/transcriptions",
    ttsHealthUrl: "http://localhost:8880/v1/models",
    heartbeatIntervalMs: 15000,
    heartbeatMaxMisses: 2,
    memoryWarningMB: 512,
    contextTimeoutMs: 3000,
    macOsSayFallback: true,
    systemPromptTemplatePath: null,
    ...overrides,
  };
  return new RealtimeHealthMonitor(config);
}

// ============================================================================
// Session Management
// ============================================================================

describe("session management", () => {
  it("sessionOpened increments active count", () => {
    const monitor = createMonitor();
    expect(monitor.getActiveSessions()).toBe(0);
    monitor.sessionOpened();
    expect(monitor.getActiveSessions()).toBe(1);
  });

  it("sessionClosed decrements active count", () => {
    const monitor = createMonitor();
    monitor.sessionOpened();
    monitor.sessionOpened();
    expect(monitor.getActiveSessions()).toBe(2);
    monitor.sessionClosed();
    expect(monitor.getActiveSessions()).toBe(1);
  });

  it("sessionOpened returns false at capacity", () => {
    const monitor = createMonitor({ maxSessions: 2 });
    expect(monitor.sessionOpened()).toBe(true);
    expect(monitor.sessionOpened()).toBe(true);
    expect(monitor.sessionOpened()).toBe(false);
    expect(monitor.getActiveSessions()).toBe(2);
  });

  it("sessionClosed never goes below 0", () => {
    const monitor = createMonitor();
    monitor.sessionClosed();
    monitor.sessionClosed();
    expect(monitor.getActiveSessions()).toBe(0);
  });

  it("canAcceptSession returns true when under capacity", () => {
    const monitor = createMonitor({ maxSessions: 3 });
    monitor.sessionOpened();
    expect(monitor.canAcceptSession()).toBe(true);
  });

  it("canAcceptSession returns false at capacity", () => {
    const monitor = createMonitor({ maxSessions: 1 });
    monitor.sessionOpened();
    expect(monitor.canAcceptSession()).toBe(false);
  });

  it("session lifecycle tracks total sessions", () => {
    const monitor = createMonitor();
    monitor.sessionOpened();
    monitor.sessionClosed();
    monitor.sessionOpened();

    const health = monitor.checkHealth();
    expect(health.metrics.totalSessions).toBe(2);
    expect(health.activeSessions).toBe(1);
  });
});

// ============================================================================
// Metric Recording
// ============================================================================

describe("metric recording", () => {
  it("recordTurn increments turn count", () => {
    const monitor = createMonitor();
    const latency: TurnLatency = { sttMs: 100, llmMs: 200, ttsMs: 150, totalMs: 450 };
    monitor.recordTurn(latency);
    monitor.recordTurn(latency);

    const health = monitor.checkHealth();
    expect(health.metrics.totalTurns).toBe(2);
  });

  it("calculates average latency correctly", () => {
    const monitor = createMonitor();
    monitor.recordTurn({ sttMs: 100, llmMs: 200, ttsMs: 100, totalMs: 400 });
    monitor.recordTurn({ sttMs: 200, llmMs: 300, ttsMs: 100, totalMs: 600 });

    const health = monitor.checkHealth();
    expect(health.metrics.avgLatencyMs).toBe(500); // (400 + 600) / 2
  });

  it("returns 0 avg latency when no turns recorded", () => {
    const monitor = createMonitor();
    const health = monitor.checkHealth();
    expect(health.metrics.avgLatencyMs).toBe(0);
  });

  it("tracks STT success rate", () => {
    const monitor = createMonitor();
    monitor.recordSTTResult(true);
    monitor.recordSTTResult(true);
    monitor.recordSTTResult(false);

    const health = monitor.checkHealth();
    expect(health.metrics.sttSuccessRate).toBe(67); // 2/3 ≈ 67%
  });

  it("tracks TTS success rate and fallback count", () => {
    const monitor = createMonitor();
    monitor.recordTTSResult(true);
    monitor.recordTTSResult(false);
    monitor.recordTTSResult(true, true); // success but via fallback

    const health = monitor.checkHealth();
    expect(health.metrics.ttsSuccessRate).toBe(67); // 2/3
    expect(health.metrics.ttsFallbackCount).toBe(1);
  });

  it("tracks LLM timeouts", () => {
    const monitor = createMonitor();
    monitor.recordLLMTimeout();
    monitor.recordLLMTimeout();

    const health = monitor.checkHealth();
    expect(health.metrics.llmTimeoutCount).toBe(2);
  });

  it("tracks reconnections", () => {
    const monitor = createMonitor();
    monitor.recordReconnection();

    const health = monitor.checkHealth();
    expect(health.metrics.reconnectionCount).toBe(1);
  });

  it("recordError stores last error with truncation", () => {
    const monitor = createMonitor();
    const longMsg = "x".repeat(300);
    monitor.recordError(longMsg);

    const health = monitor.checkHealth();
    expect(health.lastError).not.toBeNull();
    expect(health.lastError!.message.length).toBeLessThanOrEqual(203); // 200 + "..."
    expect(health.lastError!.message.endsWith("...")).toBe(true);
  });

  it("recordError stores short messages without truncation", () => {
    const monitor = createMonitor();
    monitor.recordError("Short error");

    const health = monitor.checkHealth();
    expect(health.lastError!.message).toBe("Short error");
  });

  it("returns 100% success rate when no STT/TTS calls made", () => {
    const monitor = createMonitor();
    const health = monitor.checkHealth();
    expect(health.metrics.sttSuccessRate).toBe(100);
    expect(health.metrics.ttsSuccessRate).toBe(100);
  });
});

// ============================================================================
// checkHealth Status Logic
// ============================================================================

describe("checkHealth status", () => {
  it("returns healthy when all services available", () => {
    const monitor = createMonitor();
    const health = monitor.checkHealth();
    expect(health.status).toBe("healthy");
  });

  it("returns unhealthy when STT unavailable", () => {
    const monitor = createMonitor();
    monitor.setSTTAvailable(false);

    const health = monitor.checkHealth();
    expect(health.status).toBe("unhealthy");
  });

  it("returns degraded when TTS unavailable", () => {
    const monitor = createMonitor();
    monitor.setTTSAvailable(false);

    const health = monitor.checkHealth();
    expect(health.status).toBe("degraded");
  });

  it("includes correct maxSessions from config", () => {
    const monitor = createMonitor({ maxSessions: 7 });
    const health = monitor.checkHealth();
    expect(health.maxSessions).toBe(7);
  });

  it("includes memoryMB as a number", () => {
    const monitor = createMonitor();
    const health = monitor.checkHealth();
    expect(typeof health.memoryMB).toBe("number");
    expect(health.memoryMB).toBeGreaterThan(0);
  });

  it("includes uptime as seconds", () => {
    const monitor = createMonitor();
    const health = monitor.checkHealth();
    expect(typeof health.uptime).toBe("number");
    expect(health.uptime).toBeGreaterThanOrEqual(0);
  });

  it("includes ttsMode field", () => {
    const monitor = createMonitor();
    monitor.setTTSAvailable(true, "mlx");
    const health = monitor.checkHealth();
    expect(health.ttsMode).toBe("mlx");
  });

  it("updates ttsMode when set", () => {
    const monitor = createMonitor();
    monitor.setTTSAvailable(false, "macos-say");
    const health = monitor.checkHealth();
    expect(health.ttsMode).toBe("macos-say");
  });

  it("lastError is null when no errors recorded", () => {
    const monitor = createMonitor();
    const health = monitor.checkHealth();
    expect(health.lastError).toBeNull();
  });

  it("lastError includes time and message after recordError", () => {
    const monitor = createMonitor();
    monitor.recordError("Test failure");

    const health = monitor.checkHealth();
    expect(health.lastError).not.toBeNull();
    expect(health.lastError!.time).toBeTruthy();
    expect(health.lastError!.message).toBe("Test failure");
  });
});

// ============================================================================
// Health Check Intervals
// ============================================================================

describe("health check intervals", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("startHealthChecks does not throw", () => {
    const monitor = createMonitor();
    expect(() => monitor.startHealthChecks(60000)).not.toThrow();
    monitor.stopHealthChecks();
  });

  it("stopHealthChecks clears intervals", () => {
    const monitor = createMonitor();
    monitor.startHealthChecks(60000);
    expect(() => monitor.stopHealthChecks()).not.toThrow();
    // Calling stop again should be safe
    expect(() => monitor.stopHealthChecks()).not.toThrow();
  });
});

// ============================================================================
// Service availability
// ============================================================================

describe("setSTTAvailable / setTTSAvailable", () => {
  it("setSTTAvailable updates health status", () => {
    const monitor = createMonitor();
    expect(monitor.checkHealth().sttAvailable).toBe(true);

    monitor.setSTTAvailable(false);
    expect(monitor.checkHealth().sttAvailable).toBe(false);

    monitor.setSTTAvailable(true);
    expect(monitor.checkHealth().sttAvailable).toBe(true);
  });

  it("setTTSAvailable updates both availability and mode", () => {
    const monitor = createMonitor();
    expect(monitor.checkHealth().ttsAvailable).toBe(true);
    expect(monitor.checkHealth().ttsMode).toBe("mlx");

    monitor.setTTSAvailable(false, "text-only");
    expect(monitor.checkHealth().ttsAvailable).toBe(false);
    expect(monitor.checkHealth().ttsMode).toBe("text-only");
  });
});
