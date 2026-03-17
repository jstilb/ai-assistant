#!/usr/bin/env bun
/**
 * ============================================================================
 * MessageRouter - Smart routing between jobs and notification channels
 * ============================================================================
 *
 * PURPOSE:
 * Maps CronJob output modes to MessageQueue channels with fallback chains,
 * quiet hours respect, and duration-aware escalation.
 *
 * USAGE:
 *   const router = createMessageRouter({ messageQueue });
 *
 *   // Route a job's output to appropriate channels
 *   router.route({
 *     content: "Daily briefing complete",
 *     outputMode: "voice",
 *     priority: "normal",
 *     jobDuration: 3000,
 *   });
 *
 * ============================================================================
 */

import type { MessageQueue, MessageChannel, MessagePriority } from './MessageQueue';
import type { CallDetectorConfig, CallDetectionResult } from '../core/CallDetector';
import { detectActiveCall } from '../core/CallDetector';

// ============================================================================
// Types
// ============================================================================

/**
 * Output mode from CronJob definition
 */
export type OutputMode = 'voice' | 'text' | 'both' | 'push' | 'discord' | 'telegram' | 'silent';

/**
 * Route request
 */
export interface RouteRequest {
  /** Message content */
  content: string;
  /** Job output mode */
  outputMode: OutputMode;
  /** Message priority */
  priority: MessagePriority;
  /** How long the job took (ms) - used for escalation */
  jobDuration?: number;
  /** Job ID for logging */
  jobId?: string;
}

/**
 * MessageRouter configuration
 */
export interface MessageRouterConfig {
  /** MessageQueue instance for enqueuing */
  messageQueue: MessageQueue;
  /** Duration threshold for escalation (ms, default: 300000 = 5min) */
  escalationThresholdMs?: number;
  /** Quiet hours config */
  quietHours?: {
    enabled: boolean;
    start: number; // Hour 0-23
    end: number;   // Hour 0-23
  };
  /** Call detection guard — downgrades voice to push during active calls */
  callGuard?: CallDetectorConfig;
}

/**
 * MessageRouter interface
 */
export interface MessageRouter {
  /** Route a message based on output mode */
  route(request: RouteRequest): string[];
}

// ============================================================================
// Channel Mapping
// ============================================================================

/**
 * Map output modes to primary notification channels
 */
const OUTPUT_TO_CHANNELS: Record<OutputMode, MessageChannel[]> = {
  voice: ['voice'],
  text: ['push'],        // Text-only goes to push notification
  both: ['voice', 'push'],
  push: ['push'],
  discord: ['discord'],
  telegram: ['push'],    // Telegram routes through push for now
  silent: [],            // No notification
};

/**
 * Fallback chains: if primary fails, try these
 */
const FALLBACK_CHAINS: Partial<Record<MessageChannel, MessageChannel[]>> = {
  voice: ['push', 'discord'],
  discord: ['push'],
  push: ['discord'],
};

// ============================================================================
// Implementation
// ============================================================================

/**
 * Check if current time is within quiet hours
 */
function isQuietHours(config?: { enabled: boolean; start: number; end: number }): boolean {
  if (!config?.enabled) return false;

  const hour = new Date().getHours();
  const { start, end } = config;

  if (start < end) {
    return hour >= start && hour < end;
  }
  // Wrap-around (e.g., 22:00 to 08:00)
  return hour >= start || hour < end;
}

/**
 * Create a MessageRouter instance
 */
export function createMessageRouter(config: MessageRouterConfig): MessageRouter {
  const { messageQueue, escalationThresholdMs = 300000, quietHours, callGuard } = config;

  // ── Call detection cache (30s TTL) ──
  const CALL_CACHE_TTL_MS = 30_000;
  let cachedCallState: CallDetectionResult = { onCall: false, detectedVia: null };
  let callStateCheckedAt = 0;

  function refreshCallStateCache(): void {
    if (!callGuard?.enabled) return;
    detectActiveCall(callGuard).then(result => {
      const changed = cachedCallState.onCall !== result.onCall;
      cachedCallState = result;
      callStateCheckedAt = Date.now();
      if (changed) {
        console.log(`[CallGuard] ${result.onCall ? `Call detected via ${result.detectedVia}` : 'Call ended'}`);
      }
    }).catch((err) => {
      console.log(`[CallGuard] Detection error (fail-open): ${err}`);
    });
  }

  function isOnCall(): boolean {
    if (!callGuard?.enabled) return false;
    const stale = Date.now() - callStateCheckedAt > CALL_CACHE_TTL_MS;
    if (stale) refreshCallStateCache();
    return cachedCallState.onCall;
  }

  // Warm the cache on creation
  refreshCallStateCache();

  function route(request: RouteRequest): string[] {
    const { content, outputMode, priority, jobDuration, jobId } = request;
    const messageIds: string[] = [];

    // Silent mode: log only, no messages
    if (outputMode === 'silent') {
      return messageIds;
    }

    // Get primary channels for this output mode
    let channels = [...(OUTPUT_TO_CHANNELS[outputMode] || [])];

    // During quiet hours, downgrade voice to push (unless critical)
    if (isQuietHours(quietHours) && priority !== 'critical') {
      channels = channels.map(ch => ch === 'voice' ? 'push' : ch);
      channels = [...new Set(channels)];
    }

    // During active calls, downgrade voice to push
    if (isOnCall() && !(callGuard?.allowCriticalOverride && priority === 'critical')) {
      channels = channels.map(ch => ch === 'voice' ? 'push' : ch);
      channels = [...new Set(channels)];
      console.log(`[CallGuard] Downgraded voice→push for ${jobId ?? 'unknown'} (detected via ${cachedCallState.detectedVia})`);
    }

    // Duration-aware escalation: if job took longer than threshold, also push
    if (jobDuration && jobDuration > escalationThresholdMs && !channels.includes('push')) {
      channels.push('push');
    }

    // Enqueue to each channel
    for (const channel of channels) {
      try {
        const prefix = jobId ? `[${jobId}] ` : '';
        const id = messageQueue.enqueue({
          content: `${prefix}${content}`,
          channel,
          priority,
        });
        messageIds.push(id);
      } catch (err) {
        // Channel might be disabled; try fallback
        const fallbacks = FALLBACK_CHAINS[channel];
        if (fallbacks) {
          for (const fallback of fallbacks) {
            try {
              const id = messageQueue.enqueue({
                content: `${jobId ? `[${jobId}] ` : ''}${content}`,
                channel: fallback,
                priority,
              });
              messageIds.push(id);
              break; // First successful fallback wins
            } catch {
              // Continue to next fallback
            }
          }
        }
      }
    }

    return messageIds;
  }

  return { route };
}
