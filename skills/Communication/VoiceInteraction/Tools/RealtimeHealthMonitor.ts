#!/usr/bin/env bun
/**
 * RealtimeHealthMonitor.ts - Health checks, session tracking, and metrics
 *
 * Monitors the real-time voice server's operational health:
 *   - Active session count and capacity
 *   - Process memory usage (RSS)
 *   - STT/TTS server availability via periodic health checks
 *   - Latency metrics per turn
 *   - Error counters
 *
 * Provides data for the /health endpoint on the WebSocket server.
 *
 * CLI:
 *   bun RealtimeHealthMonitor.ts status   # Print current health
 */

import { getRealtimeVoiceConfig, type RealtimeVoiceConfig } from "./VoiceCommon.ts";
import { httpClient } from "../../../../lib/core/CachedHTTPClient.ts";

// ============================================================================
// Types
// ============================================================================

type OverallStatus = "healthy" | "degraded" | "unhealthy";
type TtsMode = "mlx" | "macos-say" | "text-only";

interface HealthStatus {
  status: OverallStatus;
  uptime: number;
  activeSessions: number;
  maxSessions: number;
  sttAvailable: boolean;
  ttsAvailable: boolean;
  ttsMode: TtsMode;
  memoryMB: number;
  memoryWarningMB: number;
  lastError: { time: string; message: string } | null;
  metrics: HealthMetrics;
}

interface HealthMetrics {
  totalSessions: number;
  totalTurns: number;
  avgLatencyMs: number;
  sttSuccessRate: number;
  ttsSuccessRate: number;
  ttsFallbackCount: number;
  llmTimeoutCount: number;
  reconnectionCount: number;
}

interface TurnLatency {
  sttMs: number;
  llmMs: number;
  ttsMs: number;
  totalMs: number;
}

// ============================================================================
// Health Monitor
// ============================================================================

class RealtimeHealthMonitor {
  private config: RealtimeVoiceConfig;
  private startedAt: number;
  private activeSessions: number = 0;
  private sttAvailable: boolean = true;
  private ttsAvailable: boolean = true;
  private ttsMode: TtsMode = "mlx";
  private lastError: { time: string; message: string } | null = null;

  // Metrics counters
  private totalSessions: number = 0;
  private totalTurns: number = 0;
  private latencySum: number = 0;
  private sttSuccessCount: number = 0;
  private sttFailCount: number = 0;
  private ttsSuccessCount: number = 0;
  private ttsFailCount: number = 0;
  private ttsFallbackCount: number = 0;
  private llmTimeoutCount: number = 0;
  private reconnectionCount: number = 0;

  // Health check intervals
  private sttCheckInterval: ReturnType<typeof setInterval> | null = null;
  private ttsCheckInterval: ReturnType<typeof setInterval> | null = null;
  private memoryCheckInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config?: RealtimeVoiceConfig) {
    this.config = config ?? getRealtimeVoiceConfig();
    this.startedAt = Date.now();
  }

  // --------------------------------------------------------------------------
  // Session Management
  // --------------------------------------------------------------------------

  /** Register a new session. Returns false if at capacity. */
  sessionOpened(): boolean {
    if (this.activeSessions >= this.config.maxSessions) {
      return false;
    }
    this.activeSessions++;
    this.totalSessions++;
    return true;
  }

  /** Deregister a session. */
  sessionClosed(): void {
    if (this.activeSessions > 0) {
      this.activeSessions--;
    }
  }

  /** Check if the server can accept a new session. */
  canAcceptSession(): boolean {
    if (this.activeSessions >= this.config.maxSessions) {
      return false;
    }
    // Also check memory pressure
    const memoryMB = this.getMemoryMB();
    if (memoryMB > this.config.memoryWarningMB) {
      console.warn(`[HealthMonitor] Memory pressure: ${memoryMB.toFixed(0)}MB > ${this.config.memoryWarningMB}MB warning threshold`);
      // Don't reject, but log warning
    }
    return true;
  }

  /** Get current active session count. */
  getActiveSessions(): number {
    return this.activeSessions;
  }

  // --------------------------------------------------------------------------
  // Metric Recording
  // --------------------------------------------------------------------------

  /** Record a completed turn with latency breakdown. */
  recordTurn(latency: TurnLatency): void {
    this.totalTurns++;
    this.latencySum += latency.totalMs;
  }

  /** Record STT result. */
  recordSTTResult(success: boolean): void {
    if (success) {
      this.sttSuccessCount++;
    } else {
      this.sttFailCount++;
    }
  }

  /** Record TTS result. */
  recordTTSResult(success: boolean, fallback: boolean = false): void {
    if (success) {
      this.ttsSuccessCount++;
    } else {
      this.ttsFailCount++;
    }
    if (fallback) {
      this.ttsFallbackCount++;
    }
  }

  /** Record LLM timeout. */
  recordLLMTimeout(): void {
    this.llmTimeoutCount++;
  }

  /** Record client reconnection. */
  recordReconnection(): void {
    this.reconnectionCount++;
  }

  /** Record an error. */
  recordError(message: string): void {
    this.lastError = {
      time: new Date().toISOString(),
      message: message.length > 200 ? message.slice(0, 200) + "..." : message,
    };
  }

  // --------------------------------------------------------------------------
  // Service Health Checks
  // --------------------------------------------------------------------------

  /** Update STT availability status. */
  setSTTAvailable(available: boolean): void {
    this.sttAvailable = available;
  }

  /** Update TTS availability status and mode. */
  setTTSAvailable(available: boolean, mode: TtsMode = "mlx"): void {
    this.ttsAvailable = available;
    this.ttsMode = mode;
  }

  /** Ping a service URL and return availability + latency. */
  async pingService(url: string): Promise<{ available: boolean; latencyMs: number }> {
    const start = Date.now();
    try {
      const response = await httpClient.fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(3000),
      });
      // 405 means service is running but endpoint requires POST
      const available = response.ok || response.status === 405;
      return { available, latencyMs: Date.now() - start };
    } catch {
      return { available: false, latencyMs: Date.now() - start };
    }
  }

  /** Run periodic health checks on STT and TTS services. */
  startHealthChecks(intervalMs: number = 30000): void {
    // STT health check
    this.sttCheckInterval = setInterval(async () => {
      const result = await this.pingService(this.config.sttHealthUrl);
      this.sttAvailable = result.available;
      if (!result.available) {
        console.warn(`[HealthMonitor] STT service unavailable (${result.latencyMs}ms)`);
      }
    }, intervalMs);

    // TTS health check
    this.ttsCheckInterval = setInterval(async () => {
      const result = await this.pingService(this.config.ttsHealthUrl);
      this.ttsAvailable = result.available;
      if (!result.available) {
        this.ttsMode = this.config.macOsSayFallback ? "macos-say" : "text-only";
        console.warn(`[HealthMonitor] TTS service unavailable, mode: ${this.ttsMode}`);
      } else {
        this.ttsMode = "mlx";
      }
    }, intervalMs);

    // Memory check
    this.memoryCheckInterval = setInterval(() => {
      const memoryMB = this.getMemoryMB();
      if (memoryMB > this.config.memoryWarningMB) {
        console.warn(`[HealthMonitor] High memory: ${memoryMB.toFixed(0)}MB (threshold: ${this.config.memoryWarningMB}MB)`);
      }
    }, 60000); // Every 60 seconds
  }

  /** Stop periodic health checks. */
  stopHealthChecks(): void {
    if (this.sttCheckInterval) {
      clearInterval(this.sttCheckInterval);
      this.sttCheckInterval = null;
    }
    if (this.ttsCheckInterval) {
      clearInterval(this.ttsCheckInterval);
      this.ttsCheckInterval = null;
    }
    if (this.memoryCheckInterval) {
      clearInterval(this.memoryCheckInterval);
      this.memoryCheckInterval = null;
    }
  }

  // --------------------------------------------------------------------------
  // Health Status
  // --------------------------------------------------------------------------

  /** Get current memory usage in MB. */
  private getMemoryMB(): number {
    return process.memoryUsage().rss / (1024 * 1024);
  }

  /** Check overall health status for the /health endpoint. */
  checkHealth(): HealthStatus {
    const memoryMB = this.getMemoryMB();
    const uptime = (Date.now() - this.startedAt) / 1000;

    // Determine overall status
    let status: OverallStatus = "healthy";
    if (!this.sttAvailable) {
      status = "unhealthy"; // Can't transcribe = can't function
    } else if (!this.ttsAvailable || memoryMB > this.config.memoryWarningMB) {
      status = "degraded"; // Can function but with reduced quality
    }

    const totalSTT = this.sttSuccessCount + this.sttFailCount;
    const totalTTS = this.ttsSuccessCount + this.ttsFailCount;

    return {
      status,
      uptime: Math.round(uptime),
      activeSessions: this.activeSessions,
      maxSessions: this.config.maxSessions,
      sttAvailable: this.sttAvailable,
      ttsAvailable: this.ttsAvailable,
      ttsMode: this.ttsMode,
      memoryMB: Math.round(memoryMB),
      memoryWarningMB: this.config.memoryWarningMB,
      lastError: this.lastError,
      metrics: {
        totalSessions: this.totalSessions,
        totalTurns: this.totalTurns,
        avgLatencyMs: this.totalTurns > 0 ? Math.round(this.latencySum / this.totalTurns) : 0,
        sttSuccessRate: totalSTT > 0 ? Math.round((this.sttSuccessCount / totalSTT) * 100) : 100,
        ttsSuccessRate: totalTTS > 0 ? Math.round((this.ttsSuccessCount / totalTTS) * 100) : 100,
        ttsFallbackCount: this.ttsFallbackCount,
        llmTimeoutCount: this.llmTimeoutCount,
        reconnectionCount: this.reconnectionCount,
      },
    };
  }
}

// ============================================================================
// CLI
// ============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case "status": {
      // Check the running server's health endpoint
      const config = getRealtimeVoiceConfig();
      try {
        const response = await httpClient.fetch(`http://localhost:${config.port}/health`, {
          signal: AbortSignal.timeout(3000),
        });

        if (response.ok) {
          const health = await response.json();
          console.log(JSON.stringify(health, null, 2));
        } else {
          console.log(JSON.stringify({
            status: "unreachable",
            error: `Server returned HTTP ${response.status}`,
            port: config.port,
          }, null, 2));
        }
      } catch {
        // Server not running, show local health check
        console.log(JSON.stringify({
          status: "offline",
          message: `Real-time voice server not running on port ${config.port}`,
          port: config.port,
        }, null, 2));
      }
      break;
    }

    case "--help":
    case "help":
    default: {
      console.log(`RealtimeHealthMonitor - Health checks and metrics for real-time voice

Commands:
  status    Check real-time voice server health (queries /health endpoint)
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

export { RealtimeHealthMonitor };
export type { HealthStatus, HealthMetrics, TurnLatency, OverallStatus, TtsMode };
