#!/usr/bin/env bun
/**
 * ============================================================================
 * MessageQueue - Outbound message queue for proactive notifications
 * ============================================================================
 *
 * PURPOSE:
 * Multi-channel message queue inspired by ClawdBot patterns. Handles:
 * - Outbound notifications across voice, push, email, discord
 * - Priority-based routing
 * - Rate limiting to prevent spam
 * - Offline persistence for failed/queued messages
 * - Deduplication to prevent repeat messages
 * - User preferences (quiet hours, disabled channels)
 * - Exponential backoff retry logic
 *
 * USAGE:
 *   // Singleton usage
 *   const messageId = enqueue({
 *     content: "Workflow complete",
 *     channel: "voice",
 *     priority: "high"
 *   });
 *
 *   await process();
 *   const status = getQueueStatus();
 *
 *   // Custom instance
 *   const queue = createMessageQueue({
 *     queuePath: "/custom/path.json",
 *     maxRetries: 5
 *   });
 *
 * INTEGRATION:
 *   Uses NotificationService for actual message delivery.
 *   Persists queue state to ~/.claude/MEMORY/daemon/message-queue.json
 *
 * ============================================================================
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import {
  createNotificationService,
  type NotificationChannel,
  type NotificationPriority,
  type NotificationService,
} from '../../skills/CORE/Tools/NotificationService';

// ============================================================================
// Types
// ============================================================================

/**
 * Message channel types - extends NotificationService channels with telegram
 */
export type MessageChannel = NotificationChannel | 'telegram';

/**
 * Message priority levels
 */
export type MessagePriority = NotificationPriority;

/**
 * Message structure
 */
export interface Message {
  /** Unique message ID */
  id: string;
  /** Message content */
  content: string;
  /** Target channel */
  channel: MessageChannel;
  /** Priority level */
  priority: MessagePriority;
  /** Optional scheduled delivery time */
  scheduledFor?: Date;
  /** Number of delivery attempts */
  retries: number;
  /** Message creation timestamp */
  createdAt: Date;
  /** Last attempt timestamp */
  lastAttemptAt?: Date;
  /** Message status */
  status: 'pending' | 'processing' | 'sent' | 'failed';
}

/**
 * Configuration for MessageQueue
 */
export interface MessageQueueConfig {
  /** Path to queue persistence file */
  queuePath?: string;
  /** Maximum retry attempts */
  maxRetries?: number;
  /** Deduplication time window in milliseconds */
  deduplicationWindowMs?: number;
  /** Rate limits per channel */
  rateLimits?: {
    [K in MessageChannel]?: {
      maxPerMinute?: number;
      maxPerHour?: number;
    };
  };
  /** User preferences */
  userPreferences?: {
    quietHours?: {
      enabled: boolean;
      start: number; // Hour 0-23
      end: number; // Hour 0-23
    };
    disabledChannels?: MessageChannel[];
  };
  /** Custom process handler for testing */
  onProcess?: (message: Message) => Promise<boolean>;
}

/**
 * Queue status statistics
 */
export interface QueueStatus {
  /** Number of pending messages */
  pending: number;
  /** Number of failed messages */
  failed: number;
  /** Number of successfully processed messages */
  processed: number;
}

/**
 * MessageQueue interface
 */
export interface MessageQueue {
  /** Enqueue a message */
  enqueue(params: {
    content: string;
    channel: MessageChannel;
    priority: MessagePriority;
    scheduledFor?: Date;
  }): string;
  /** Process pending messages */
  process(): Promise<void>;
  /** Get queue statistics */
  getQueueStatus(): QueueStatus;
}

// ============================================================================
// Internal Types
// ============================================================================

interface PersistedQueue {
  messages: Message[];
  processed: Message[];
  failed: Message[];
}

interface RateLimitTracker {
  [channel: string]: {
    timestamps: number[];
  };
}

// ============================================================================
// Constants
// ============================================================================

const KAYA_DIR = (typeof process !== 'undefined' && process.env?.KAYA_DIR) || join(homedir(), '.claude');
const DEFAULT_QUEUE_PATH = join(KAYA_DIR, 'MEMORY', 'daemon', 'message-queue.json');
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_DEDUP_WINDOW_MS = 60000; // 1 minute
const BACKOFF_BASE_MS = 100;
const BACKOFF_MAX_MS = 5000;

// Priority weights for sorting
const PRIORITY_WEIGHTS: Record<MessagePriority, number> = {
  critical: 4,
  high: 3,
  normal: 2,
  low: 1,
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Generate unique message ID
 */
function generateMessageId(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 9);
  return `msg_${timestamp}_${random}`;
}

/**
 * Calculate exponential backoff delay
 */
function getBackoffDelay(attempt: number): number {
  return Math.min(BACKOFF_BASE_MS * Math.pow(2, attempt), BACKOFF_MAX_MS);
}

/**
 * Check if current time is within quiet hours
 */
function isInQuietHours(quietHours?: { enabled: boolean; start: number; end: number }): boolean {
  if (!quietHours || !quietHours.enabled) {
    return false;
  }

  const now = new Date();
  const currentHour = now.getHours();
  const { start, end } = quietHours;

  // Handle wrap-around (e.g., 22:00 to 08:00)
  if (start < end) {
    return currentHour >= start && currentHour < end;
  } else {
    return currentHour >= start || currentHour < end;
  }
}

/**
 * Load queue from disk
 */
function loadQueue(queuePath: string): PersistedQueue {
  try {
    if (existsSync(queuePath)) {
      const data = readFileSync(queuePath, 'utf-8');
      const parsed = JSON.parse(data);

      // Reconstruct Date objects
      return {
        messages: parsed.messages.map((m: any) => ({
          ...m,
          createdAt: new Date(m.createdAt),
          scheduledFor: m.scheduledFor ? new Date(m.scheduledFor) : undefined,
          lastAttemptAt: m.lastAttemptAt ? new Date(m.lastAttemptAt) : undefined,
        })),
        processed: parsed.processed || [],
        failed: parsed.failed || [],
      };
    }
  } catch (error) {
    // If queue is corrupted, start fresh
    console.error('Failed to load message queue, starting fresh:', error);
  }

  return {
    messages: [],
    processed: [],
    failed: [],
  };
}

/**
 * Save queue to disk
 */
function saveQueue(queuePath: string, queue: PersistedQueue): void {
  try {
    const dir = dirname(queuePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(queuePath, JSON.stringify(queue, null, 2), 'utf-8');
  } catch (error) {
    console.error('Failed to save message queue:', error);
  }
}

/**
 * Create message content hash for deduplication
 */
function getMessageHash(content: string, channel: MessageChannel): string {
  return `${channel}:${content}`;
}

// ============================================================================
// Main Implementation
// ============================================================================

/**
 * Create a MessageQueue instance
 */
export function createMessageQueue(config: MessageQueueConfig = {}): MessageQueue {
  const queuePath = config.queuePath || DEFAULT_QUEUE_PATH;
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  const deduplicationWindowMs = config.deduplicationWindowMs ?? DEFAULT_DEDUP_WINDOW_MS;

  // Load persisted queue
  let persistedQueue = loadQueue(queuePath);
  let messages = persistedQueue.messages;
  let processed = persistedQueue.processed;
  let failed = persistedQueue.failed;

  // Rate limiting tracker
  const rateLimitTracker: RateLimitTracker = {};

  // Deduplication cache
  const deduplicationCache = new Map<string, { id: string; timestamp: number }>();

  // Notification service
  const notificationService = config.onProcess
    ? null
    : createNotificationService();

  /**
   * Persist queue state
   */
  function persist(): void {
    saveQueue(queuePath, { messages, processed, failed });
  }

  /**
   * Clean up old entries from deduplication cache
   */
  function cleanDeduplicationCache(): void {
    const now = Date.now();
    for (const [hash, entry] of deduplicationCache.entries()) {
      if (now - entry.timestamp > deduplicationWindowMs) {
        deduplicationCache.delete(hash);
      }
    }
  }

  /**
   * Check if channel is rate limited
   */
  function isRateLimited(channel: MessageChannel): boolean {
    const limits = config.rateLimits?.[channel];
    if (!limits) return false;

    const tracker = rateLimitTracker[channel] || { timestamps: [] };
    const now = Date.now();

    // Clean old timestamps
    tracker.timestamps = tracker.timestamps.filter(t => now - t < 60000); // Keep last minute

    // Check per-minute limit
    if (limits.maxPerMinute && tracker.timestamps.length >= limits.maxPerMinute) {
      return true;
    }

    // Check per-hour limit
    if (limits.maxPerHour) {
      const hourAgo = now - 3600000;
      const countInLastHour = tracker.timestamps.filter(t => t > hourAgo).length;
      if (countInLastHour >= limits.maxPerHour) {
        return true;
      }
    }

    return false;
  }

  /**
   * Record message sent for rate limiting
   */
  function recordMessageSent(channel: MessageChannel): void {
    if (!rateLimitTracker[channel]) {
      rateLimitTracker[channel] = { timestamps: [] };
    }
    rateLimitTracker[channel].timestamps.push(Date.now());
  }

  /**
   * Check if message should be processed
   */
  function shouldProcessMessage(message: Message): boolean {
    // Check if scheduled for future
    if (message.scheduledFor && message.scheduledFor.getTime() > Date.now()) {
      return false;
    }

    // Check rate limits
    if (isRateLimited(message.channel)) {
      return false;
    }

    // Check quiet hours (unless critical)
    if (message.priority !== 'critical' && isInQuietHours(config.userPreferences?.quietHours)) {
      return false;
    }

    return true;
  }

  /**
   * Process a single message
   */
  async function processMessage(message: Message): Promise<boolean> {
    message.status = 'processing';
    message.lastAttemptAt = new Date();

    try {
      let success = false;

      if (config.onProcess) {
        // Use custom handler for testing
        success = await config.onProcess(message);
      } else if (message.channel === 'telegram') {
        // Telegram goes through push as fallback (MessageRouter handles real routing)
        if (notificationService) {
          await notificationService.notify(message.content, {
            channel: 'push',
            priority: message.priority,
          });
        }
        success = true;
      } else if (notificationService) {
        // Use NotificationService for standard channels
        await notificationService.notify(message.content, {
          channel: message.channel as NotificationChannel,
          priority: message.priority,
        });
        success = true;
      }

      if (success) {
        message.status = 'sent';
        recordMessageSent(message.channel);
        return true;
      } else {
        message.retries++;
        return false;
      }
    } catch (error) {
      console.error('Failed to process message:', error);
      message.retries++;
      return false;
    }
  }

  // ============================================================================
  // Public API
  // ============================================================================

  const queue: MessageQueue = {
    /**
     * Enqueue a message
     */
    enqueue(params) {
      const { content, channel, priority, scheduledFor } = params;

      // Check if channel is disabled
      if (config.userPreferences?.disabledChannels?.includes(channel)) {
        throw new Error(`Channel ${channel} is disabled in user preferences`);
      }

      // Check for duplicates
      cleanDeduplicationCache();
      const hash = getMessageHash(content, channel);
      const existing = deduplicationCache.get(hash);

      if (existing) {
        // Return existing message ID
        return existing.id;
      }

      // Create new message
      const message: Message = {
        id: generateMessageId(),
        content,
        channel,
        priority,
        scheduledFor,
        retries: 0,
        createdAt: new Date(),
        status: 'pending',
      };

      messages.push(message);
      deduplicationCache.set(hash, { id: message.id, timestamp: Date.now() });

      // Persist
      persist();

      return message.id;
    },

    /**
     * Process pending messages
     */
    async process() {
      // Sort by priority (highest first) then by creation time (oldest first)
      messages.sort((a, b) => {
        const priorityDiff = PRIORITY_WEIGHTS[b.priority] - PRIORITY_WEIGHTS[a.priority];
        if (priorityDiff !== 0) return priorityDiff;
        return a.createdAt.getTime() - b.createdAt.getTime();
      });

      const pendingMessages = messages.filter(m => m.status === 'pending');

      for (const message of pendingMessages) {
        // Re-check if message should be processed (rate limits may have changed)
        if (!shouldProcessMessage(message)) {
          continue;
        }

        let success = false;

        // Retry loop - attempt multiple times before giving up
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          if (attempt > 0) {
            // Wait for exponential backoff before retry
            const delay = getBackoffDelay(attempt - 1);
            await new Promise(resolve => setTimeout(resolve, delay));
          }

          success = await processMessage(message);

          if (success) {
            break; // Success, exit retry loop
          }
        }

        if (success) {
          // Move to processed
          messages = messages.filter(m => m.id !== message.id);
          processed.push(message);
        } else {
          // All retries failed, move to failed
          message.status = 'failed';
          messages = messages.filter(m => m.id !== message.id);
          failed.push(message);
        }

        persist();
      }
    },

    /**
     * Get queue status
     */
    getQueueStatus() {
      return {
        pending: messages.filter(m => m.status === 'pending').length,
        failed: failed.length,
        processed: processed.length,
      };
    },
  };

  return queue;
}

// ============================================================================
// Singleton Exports
// ============================================================================

let defaultQueue: MessageQueue | null = null;

function getDefaultQueue(): MessageQueue {
  if (!defaultQueue) {
    defaultQueue = createMessageQueue();
  }
  return defaultQueue;
}

/**
 * Enqueue a message using the default singleton queue
 */
export function enqueue(params: {
  content: string;
  channel: MessageChannel;
  priority: MessagePriority;
  scheduledFor?: Date;
}): string {
  return getDefaultQueue().enqueue(params);
}

/**
 * Process pending messages using the default singleton queue
 */
export async function process(): Promise<void> {
  return getDefaultQueue().process();
}

/**
 * Get queue status using the default singleton queue
 */
export function getQueueStatus(): QueueStatus {
  return getDefaultQueue().getQueueStatus();
}

// ============================================================================
// CLI
// ============================================================================

async function main(): Promise<void> {
  const args = (typeof process !== 'undefined' && process.argv ? process.argv : []).slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
MessageQueue - Outbound message queue for proactive notifications

Usage:
  bun run MessageQueue.ts --enqueue "Message" --channel voice --priority high
  bun run MessageQueue.ts --process
  bun run MessageQueue.ts --status

Options:
  --enqueue <message>    Enqueue a message
  --channel <channel>    Channel: voice, push, email, discord (default: voice)
  --priority <priority>  Priority: low, normal, high, critical (default: normal)
  --schedule <minutes>   Schedule for N minutes from now
  --process              Process pending messages
  --status               Show queue status
  --help, -h             Show this help
    `);
    return;
  }

  const queue = createMessageQueue();

  // Status command
  if (args.includes('--status')) {
    const status = queue.getQueueStatus();
    console.log('Queue Status:');
    console.log(`  Pending:   ${status.pending}`);
    console.log(`  Failed:    ${status.failed}`);
    console.log(`  Processed: ${status.processed}`);
    return;
  }

  // Process command
  if (args.includes('--process')) {
    console.log('Processing queue...');
    await queue.process();
    const status = queue.getQueueStatus();
    console.log(`Processed. Pending: ${status.pending}, Failed: ${status.failed}`);
    return;
  }

  // Enqueue command
  const enqueueIndex = args.indexOf('--enqueue');
  if (enqueueIndex !== -1 && args[enqueueIndex + 1]) {
    const content = args[enqueueIndex + 1];

    let channel: MessageChannel = 'voice';
    let priority: MessagePriority = 'normal';
    let scheduledFor: Date | undefined;

    const channelIndex = args.indexOf('--channel');
    if (channelIndex !== -1 && args[channelIndex + 1]) {
      channel = args[channelIndex + 1] as MessageChannel;
    }

    const priorityIndex = args.indexOf('--priority');
    if (priorityIndex !== -1 && args[priorityIndex + 1]) {
      priority = args[priorityIndex + 1] as MessagePriority;
    }

    const scheduleIndex = args.indexOf('--schedule');
    if (scheduleIndex !== -1 && args[scheduleIndex + 1]) {
      const minutes = parseInt(args[scheduleIndex + 1], 10);
      scheduledFor = new Date(Date.now() + minutes * 60000);
    }

    const messageId = queue.enqueue({ content, channel, priority, scheduledFor });
    console.log(`Message enqueued: ${messageId}`);
    console.log(`  Channel: ${channel}`);
    console.log(`  Priority: ${priority}`);
    if (scheduledFor) {
      console.log(`  Scheduled for: ${scheduledFor.toISOString()}`);
    }
    return;
  }

  console.error('Error: No valid command provided. Use --help for usage.');
  throw new Error('Invalid command or arguments');
}

// Run if executed directly
if (import.meta.main) {
  main().catch(console.error);
}
