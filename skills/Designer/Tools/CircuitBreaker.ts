#!/usr/bin/env bun
/**
 * CircuitBreaker.ts - Circuit breaker pattern for adapter fallback protection
 *
 * Prevents cascading failures by tracking consecutive failures and temporarily
 * stopping calls to unhealthy services. Three states: CLOSED (normal),
 * OPEN (rejecting), HALF_OPEN (testing).
 *
 * Configured per-adapter:
 *   - Claude Vision:   3 failures, 60s cooldown
 *   - Gemini MCP:      2 failures, 120s cooldown
 *   - Shopping Skill:  5 failures, 300s cooldown
 *
 * Usage:
 *   import { createCircuitBreaker } from './CircuitBreaker';
 *   const breaker = createCircuitBreaker({ name: 'claude', failureThreshold: 3, cooldownMs: 60000 });
 *   const result = await breaker.execute(() => callService());
 *
 * @module CircuitBreaker
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export enum CircuitBreakerState {
  CLOSED = "CLOSED",
  OPEN = "OPEN",
  HALF_OPEN = "HALF_OPEN",
}

export interface CircuitBreakerConfig {
  name: string;
  failureThreshold: number;
  cooldownMs: number;
}

export interface StateTransition {
  from: CircuitBreakerState;
  to: CircuitBreakerState;
  timestamp: string;
  reason: string;
}

export interface CircuitBreaker {
  getState(): CircuitBreakerState;
  canAttempt(): boolean;
  getFailureCount(): number;
  recordSuccess(): void;
  recordFailure(): void;
  reset(): void;
  execute<T>(fn: () => Promise<T>): Promise<T>;
  getTransitionLog(): StateTransition[];
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCircuitBreaker(config: CircuitBreakerConfig): CircuitBreaker {
  let state: CircuitBreakerState = CircuitBreakerState.CLOSED;
  let failureCount = 0;
  let lastFailureTime = 0;
  const transitions: StateTransition[] = [];

  function logTransition(from: CircuitBreakerState, to: CircuitBreakerState, reason: string): void {
    transitions.push({
      from,
      to,
      timestamp: new Date().toISOString(),
      reason,
    });
    console.error(`[CircuitBreaker:${config.name}] ${from} -> ${to}: ${reason}`);
  }

  function transitionTo(newState: CircuitBreakerState, reason: string): void {
    if (state !== newState) {
      const oldState = state;
      state = newState;
      logTransition(oldState, newState, reason);
    }
  }

  return {
    getState(): CircuitBreakerState {
      return state;
    },

    canAttempt(): boolean {
      switch (state) {
        case CircuitBreakerState.CLOSED:
          return true;

        case CircuitBreakerState.OPEN: {
          const elapsed = Date.now() - lastFailureTime;
          if (elapsed >= config.cooldownMs) {
            transitionTo(CircuitBreakerState.HALF_OPEN, `Cooldown elapsed (${elapsed}ms >= ${config.cooldownMs}ms)`);
            return true;
          }
          return false;
        }

        case CircuitBreakerState.HALF_OPEN:
          return true;

        default:
          return false;
      }
    },

    getFailureCount(): number {
      return failureCount;
    },

    recordSuccess(): void {
      failureCount = 0;
      if (state === CircuitBreakerState.HALF_OPEN || state === CircuitBreakerState.OPEN) {
        transitionTo(CircuitBreakerState.CLOSED, "Successful call");
      }
    },

    recordFailure(): void {
      failureCount++;
      lastFailureTime = Date.now();

      if (state === CircuitBreakerState.HALF_OPEN) {
        transitionTo(CircuitBreakerState.OPEN, "Failure during HALF_OPEN probe");
        return;
      }

      if (failureCount >= config.failureThreshold) {
        transitionTo(CircuitBreakerState.OPEN, `Reached failure threshold (${failureCount}/${config.failureThreshold})`);
      }
    },

    reset(): void {
      const oldState = state;
      failureCount = 0;
      lastFailureTime = 0;
      state = CircuitBreakerState.CLOSED;
      if (oldState !== CircuitBreakerState.CLOSED) {
        logTransition(oldState, CircuitBreakerState.CLOSED, "Manual reset");
      }
    },

    async execute<T>(fn: () => Promise<T>): Promise<T> {
      if (!this.canAttempt()) {
        throw new Error(`Circuit breaker [${config.name}] is OPEN. Call rejected.`);
      }

      try {
        const result = await fn();
        this.recordSuccess();
        return result;
      } catch (err) {
        this.recordFailure();
        throw err;
      }
    },

    getTransitionLog(): StateTransition[] {
      return [...transitions];
    },
  };
}

// ---------------------------------------------------------------------------
// Pre-configured breakers for Designer adapters
// ---------------------------------------------------------------------------

export const DESIGNER_BREAKER_CONFIGS: Record<string, CircuitBreakerConfig> = {
  claude_vision: {
    name: "claude-vision",
    failureThreshold: 3,
    cooldownMs: 60_000,
  },
  gemini_mcp: {
    name: "gemini-mcp",
    failureThreshold: 2,
    cooldownMs: 120_000,
  },
  shopping_skill: {
    name: "shopping-skill",
    failureThreshold: 5,
    cooldownMs: 300_000,
  },
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (import.meta.main) {
  console.log("Circuit Breaker configurations:");
  console.log(JSON.stringify(DESIGNER_BREAKER_CONFIGS, null, 2));
}
