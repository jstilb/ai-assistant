#!/usr/bin/env bun
/**
 * ============================================================================
 * NotificationService - Unified notification service for Kaya
 * ============================================================================
 *
 * PURPOSE:
 * Replaces 50+ scattered curl commands across 12+ skills with a single,
 * robust notification service supporting multiple channels, batching,
 * retry logic, health checks, and offline queuing.
 *
 * USAGE:
 *   // Simple fire-and-forget (most common)
 *   notifySync("Starting daily maintenance workflow");
 *
 *   // With options
 *   await notify("Completed security audit", {
 *     channel: 'voice',
 *     priority: 'high',
 *     voiceId: 'onwK4e9ZLuTAKqWW03F9'
 *   });
 *
 *   // Batch multiple messages
 *   await service.batch(["Step 1 complete", "Step 2 complete", "Step 3 complete"]);
 *
 *   // Custom instance
 *   const service = createNotificationService({
 *     voiceServerUrl: 'http://localhost:8888/notify',
 *     defaultChannel: 'voice',
 *     batchWindowMs: 100
 *   });
 *
 * CLI:
 *   bun run NotificationService.ts --test "Hello world"
 *   bun run NotificationService.ts --health
 *   bun run NotificationService.ts --channel push "Push notification"
 *
 * CHANNELS:
 *   - voice: Local ElevenLabs voice server (default)
 *   - push: ntfy.sh push notifications
 *   - discord: Discord webhook
 *   - email: Gmail MCP (future)
 *
 * ============================================================================
 */

import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ============================================================================
// Types
// ============================================================================

/**
 * Notification channel types
 */
export type NotificationChannel = 'voice' | 'push' | 'discord' | 'email' | 'telegram';

/**
 * Priority levels affecting routing and display
 */
export type NotificationPriority = 'low' | 'normal' | 'high' | 'critical';

/**
 * Options for individual notifications
 */
export interface NotifyOptions {
  /** Target channel (default: voice) */
  channel?: NotificationChannel;
  /** Priority level */
  priority?: NotificationPriority;
  /** Enable fallback to other channels on failure */
  fallback?: boolean;
  /** Number of retries (default: 3) */
  retry?: number;
  /** Timeout in milliseconds (default: 5000) */
  timeout?: number;
  /** ElevenLabs voice ID override */
  voiceId?: string;
  /** Agent name for title */
  agentName?: string;
  /** Voice prosody settings */
  voiceSettings?: VoiceProsody;
}

/**
 * Voice prosody configuration
 */
export interface VoiceProsody {
  stability?: number;
  similarity_boost?: number;
  style?: number;
  speed?: number;
  use_speaker_boost?: boolean;
  volume?: number;
}

/**
 * Service configuration
 */
export interface NotificationConfig {
  /** Voice server URL (default: http://localhost:8888/notify) */
  voiceServerUrl?: string;
  /** ntfy.sh topic for push notifications */
  ntfyTopic?: string;
  /** ntfy.sh server (default: ntfy.sh) */
  ntfyServer?: string;
  /** Discord webhook URL */
  discordWebhook?: string;
  /** Default channel (default: voice) */
  defaultChannel?: NotificationChannel;
  /** Batch window in ms (default: 50) */
  batchWindowMs?: number;
  /** Max retries (default: 3) */
  maxRetries?: number;
  /** Default voice ID */
  defaultVoiceId?: string;
  /** Default voice settings */
  defaultVoiceSettings?: VoiceProsody;
  /** Default agent name */
  defaultAgentName?: string;
}

/**
 * The notification service interface
 */
export interface NotificationService {
  /** Send notification with async/await */
  notify(message: string, options?: NotifyOptions): Promise<void>;
  /** Fire-and-forget notification (non-blocking) */
  notifySync(message: string, options?: NotifyOptions): void;
  /** Batch multiple messages into one notification */
  batch(messages: string[], options?: NotifyOptions): Promise<void>;
  /** Check if a channel is healthy */
  isServiceHealthy(channel?: NotificationChannel): Promise<boolean>;
  /** Get count of queued notifications */
  getQueuedCount(): number;
  /** Flush queued notifications */
  flush(): Promise<void>;
}

/**
 * Internal queue item
 */
interface QueueItem {
  message: string;
  options: NotifyOptions;
  timestamp: number;
  retries: number;
}

/**
 * Voice server payload
 */
interface VoicePayload {
  message: string;
  title?: string;
  voice_id?: string;
  voice_enabled?: boolean;
  priority?: string;
  voice_settings?: VoiceProsody;
}

// ============================================================================
// Helpers
// ============================================================================

const KAYA_DIR = process.env.KAYA_DIR || join(homedir(), '.claude');
const SETTINGS_PATH = join(KAYA_DIR, 'settings.json');
const LOG_DIR = join(KAYA_DIR, 'MEMORY', 'NOTIFICATIONS');

/**
 * Load settings from settings.json
 */
function loadSettings(): Record<string, any> {
  try {
    if (existsSync(SETTINGS_PATH)) {
      return JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
    }
  } catch {
    // Fail gracefully
  }
  return {};
}

/**
 * Get default config from settings.json
 */
function getDefaultConfig(): NotificationConfig {
  const settings = loadSettings();
  const daidentity = settings.daidentity || {};
  const notifications = settings.notifications || {};

  return {
    voiceServerUrl: 'http://localhost:8888/notify',
    ntfyTopic: notifications.ntfy?.topic || '',
    ntfyServer: notifications.ntfy?.server || 'ntfy.sh',
    discordWebhook: notifications.discord?.webhook || '',
    defaultChannel: 'voice',
    batchWindowMs: 50,
    maxRetries: 3,
    defaultVoiceId: daidentity.voiceId || '',
    defaultVoiceSettings: daidentity.voice,
    defaultAgentName: daidentity.name || 'Kaya',
  };
}

/**
 * Log notification event
 */
function logNotification(
  event: 'sent' | 'failed' | 'queued' | 'retried',
  channel: string,
  message: string,
  error?: string
): void {
  try {
    if (!existsSync(LOG_DIR)) {
      mkdirSync(LOG_DIR, { recursive: true });
    }

    const logEntry = {
      timestamp: new Date().toISOString(),
      event,
      channel,
      message: message.slice(0, 100), // Truncate for log
      error,
    };

    const logPath = join(LOG_DIR, 'notifications.jsonl');
    appendFileSync(logPath, JSON.stringify(logEntry) + '\n');
  } catch {
    // Silent fail - logging should never break notifications
  }
}

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calculate exponential backoff delay
 */
function getBackoffDelay(attempt: number, baseMs = 100): number {
  return Math.min(baseMs * Math.pow(2, attempt), 5000); // Cap at 5 seconds
}

// ============================================================================
// Channel Implementations
// ============================================================================

/**
 * Send to voice server
 */
async function sendVoice(
  message: string,
  config: NotificationConfig,
  options: NotifyOptions
): Promise<boolean> {
  const url = config.voiceServerUrl || 'http://localhost:8888/notify';

  const payload: VoicePayload = {
    message,
    voice_enabled: true,
    title: options.agentName || config.defaultAgentName || 'Kaya',
    voice_id: options.voiceId || config.defaultVoiceId || '',
    priority: options.priority || 'normal',
  };

  // Add voice settings if available
  if (options.voiceSettings || config.defaultVoiceSettings) {
    payload.voice_settings = options.voiceSettings || config.defaultVoiceSettings;
  }

  const timeout = options.timeout || 15000;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      logNotification('sent', 'voice', message);
      return true;
    } else {
      logNotification('failed', 'voice', message, `HTTP ${response.status}`);
      return false;
    }
  } catch (error) {
    clearTimeout(timeoutId);
    const errMsg = error instanceof Error ? error.message : String(error);
    logNotification('failed', 'voice', message, errMsg);
    return false;
  }
}

/**
 * Send to ntfy.sh
 */
async function sendPush(
  message: string,
  config: NotificationConfig,
  options: NotifyOptions
): Promise<boolean> {
  if (!config.ntfyTopic) {
    return false;
  }

  const server = config.ntfyServer || 'ntfy.sh';
  const url = `https://${server}/${config.ntfyTopic}`;

  const headers: Record<string, string> = {
    'Content-Type': 'text/plain',
  };

  if (options.agentName || config.defaultAgentName) {
    headers['Title'] = options.agentName || config.defaultAgentName || 'Kaya';
  }

  if (options.priority) {
    const priorityMap: Record<NotificationPriority, string> = {
      low: '2',
      normal: '3',
      high: '4',
      critical: '5',
    };
    headers['Priority'] = priorityMap[options.priority] || '3';
  }

  const timeout = options.timeout || 15000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: message,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      logNotification('sent', 'push', message);
      return true;
    } else {
      logNotification('failed', 'push', message, `HTTP ${response.status}`);
      return false;
    }
  } catch (error) {
    clearTimeout(timeoutId);
    const errMsg = error instanceof Error ? error.message : String(error);
    logNotification('failed', 'push', message, errMsg);
    return false;
  }
}

/**
 * Send to Discord webhook
 */
async function sendDiscord(
  message: string,
  config: NotificationConfig,
  options: NotifyOptions
): Promise<boolean> {
  if (!config.discordWebhook) {
    return false;
  }

  const colorMap: Record<NotificationPriority, number> = {
    low: 0x808080, // Gray
    normal: 0x3b82f6, // Blue
    high: 0xf59e0b, // Orange
    critical: 0xef4444, // Red
  };

  const payload = {
    embeds: [
      {
        title: options.agentName || config.defaultAgentName || 'Kaya',
        description: message,
        color: colorMap[options.priority || 'normal'],
        timestamp: new Date().toISOString(),
      },
    ],
  };

  const timeout = options.timeout || 15000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(config.discordWebhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      logNotification('sent', 'discord', message);
      return true;
    } else {
      logNotification('failed', 'discord', message, `HTTP ${response.status}`);
      return false;
    }
  } catch (error) {
    clearTimeout(timeoutId);
    const errMsg = error instanceof Error ? error.message : String(error);
    logNotification('failed', 'discord', message, errMsg);
    return false;
  }
}

/**
 * Send to email (placeholder - uses Gmail MCP)
 */
async function sendEmail(
  message: string,
  config: NotificationConfig,
  options: NotifyOptions
): Promise<boolean> {
  // Email channel requires Gmail MCP integration
  // For now, log and return false
  logNotification('failed', 'email', message, 'Email channel not implemented');
  return false;
}

/**
 * Send via Telegram Bot API
 */
async function sendTelegram(
  message: string,
  config: NotificationConfig,
  options: NotifyOptions
): Promise<boolean> {
  const secretsPath = join(KAYA_DIR, 'secrets.json');
  if (!existsSync(secretsPath)) {
    logNotification('failed', 'telegram', message, 'secrets.json not found');
    return false;
  }

  let secrets: Record<string, string>;
  try {
    secrets = JSON.parse(readFileSync(secretsPath, 'utf-8'));
  } catch {
    logNotification('failed', 'telegram', message, 'Failed to parse secrets.json');
    return false;
  }

  const botToken = secrets.TELEGRAM_BOT_TOKEN;
  const chatId = secrets.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) {
    logNotification('failed', 'telegram', message, 'TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing');
    return false;
  }

  const title = options.agentName || config.defaultAgentName || 'Kaya';
  const text = `*${title}*\n\n${message}`;

  const timeout = options.timeout || 15000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      logNotification('sent', 'telegram', message);
      return true;
    } else {
      logNotification('failed', 'telegram', message, `HTTP ${response.status}`);
      return false;
    }
  } catch (error) {
    clearTimeout(timeoutId);
    const errMsg = error instanceof Error ? error.message : String(error);
    logNotification('failed', 'telegram', message, errMsg);
    return false;
  }
}

// ============================================================================
// Main Service Implementation
// ============================================================================

/**
 * Create a notification service instance
 */
export function createNotificationService(customConfig?: NotificationConfig): NotificationService {
  const defaultConfig = getDefaultConfig();
  const config: NotificationConfig = { ...defaultConfig, ...customConfig };

  // Internal state
  const queue: QueueItem[] = [];
  let batchBuffer: string[] = [];
  let batchTimeout: ReturnType<typeof setTimeout> | null = null;
  let batchResolve: (() => void) | null = null;

  // Channel sender lookup
  const senders: Record<
    NotificationChannel,
    (message: string, config: NotificationConfig, options: NotifyOptions) => Promise<boolean>
  > = {
    voice: sendVoice,
    push: sendPush,
    discord: sendDiscord,
    email: sendEmail,
    telegram: sendTelegram,
  };

  // Fallback chain
  const fallbackChain: Record<NotificationChannel, NotificationChannel[]> = {
    voice: ['push', 'discord'],
    push: ['discord', 'voice'],
    discord: ['push', 'voice'],
    email: ['push', 'discord', 'voice'],
    telegram: ['push', 'voice', 'discord'],
  };

  /**
   * Send notification with retry and fallback logic
   */
  async function sendWithRetry(
    message: string,
    options: NotifyOptions,
    retryCount = 0
  ): Promise<boolean> {
    const channel = options.channel || config.defaultChannel || 'voice';
    const maxRetries = options.retry ?? config.maxRetries ?? 3;
    const sender = senders[channel];

    if (!sender) {
      logNotification('failed', channel, message, `Unknown channel: ${channel}`);
      return false;
    }

    // Attempt to send
    const success = await sender(message, config, options);

    if (success) {
      return true;
    }

    // Retry logic
    if (retryCount < maxRetries) {
      const delay = getBackoffDelay(retryCount);
      logNotification('retried', channel, message, `Attempt ${retryCount + 1}, delay ${delay}ms`);
      await sleep(delay);
      return sendWithRetry(message, options, retryCount + 1);
    }

    // Fallback logic
    if (options.fallback) {
      const fallbacks = fallbackChain[channel] || [];
      for (const fallbackChannel of fallbacks) {
        const fallbackSender = senders[fallbackChannel];
        if (fallbackSender) {
          const fallbackSuccess = await fallbackSender(message, config, options);
          if (fallbackSuccess) {
            return true;
          }
        }
      }
    }

    // Queue for later if all attempts failed
    queue.push({
      message,
      options,
      timestamp: Date.now(),
      retries: retryCount,
    });
    logNotification('queued', channel, message, 'All attempts failed');

    return false;
  }

  /**
   * Flush the batch buffer
   */
  function flushBatch(): void {
    if (batchBuffer.length === 0) return;

    const combined = batchBuffer.join('\n- ');
    const message = batchBuffer.length > 1 ? `- ${combined}` : batchBuffer[0];

    batchBuffer = [];
    if (batchTimeout) {
      clearTimeout(batchTimeout);
      batchTimeout = null;
    }

    sendWithRetry(message, {}).finally(() => {
      if (batchResolve) {
        batchResolve();
        batchResolve = null;
      }
    });
  }

  // The service object
  const service: NotificationService = {
    /**
     * Send notification (async)
     */
    async notify(message: string, options: NotifyOptions = {}): Promise<void> {
      await sendWithRetry(message, options);
    },

    /**
     * Fire-and-forget notification
     */
    notifySync(message: string, options: NotifyOptions = {}): void {
      // Don't await - fire and forget
      sendWithRetry(message, options).catch(() => {
        // Silent fail for sync
      });
    },

    /**
     * Batch multiple messages
     */
    async batch(messages: string[], options: NotifyOptions = {}): Promise<void> {
      return new Promise((resolve) => {
        batchBuffer.push(...messages);
        batchResolve = resolve;

        if (batchTimeout) {
          clearTimeout(batchTimeout);
        }

        batchTimeout = setTimeout(() => {
          flushBatch();
        }, config.batchWindowMs || 50);

        // If buffer is getting large, flush immediately
        if (batchBuffer.length >= 10) {
          flushBatch();
        }
      });
    },

    /**
     * Check service health
     */
    async isServiceHealthy(channel: NotificationChannel = 'voice'): Promise<boolean> {
      if (channel === 'voice') {
        try {
          const url = config.voiceServerUrl || 'http://localhost:8888/notify';
          // Use a simple HEAD or OPTIONS request to check health
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 2000);

          const response = await fetch(url.replace('/notify', '/health').replace('/health', ''), {
            method: 'HEAD',
            signal: controller.signal,
          }).catch(() =>
            // Try a GET if HEAD fails
            fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ message: '', voice_enabled: false }),
              signal: controller.signal,
            })
          );

          clearTimeout(timeoutId);
          return response?.ok || false;
        } catch {
          return false;
        }
      }

      if (channel === 'push') {
        return !!(config.ntfyTopic && config.ntfyServer);
      }

      if (channel === 'discord') {
        return !!config.discordWebhook;
      }

      return false;
    },

    /**
     * Get queued count
     */
    getQueuedCount(): number {
      return queue.length;
    },

    /**
     * Flush queued notifications
     */
    async flush(): Promise<void> {
      const toFlush = [...queue];
      queue.length = 0;

      for (const item of toFlush) {
        await sendWithRetry(item.message, item.options, item.retries);
      }
    },
  };

  return service;
}

// ============================================================================
// Singleton Exports
// ============================================================================

// Create a default singleton service
let defaultService: NotificationService | null = null;

function getDefaultService(): NotificationService {
  if (!defaultService) {
    defaultService = createNotificationService();
  }
  return defaultService;
}

/**
 * Send notification (async) using default service
 */
export async function notify(message: string, options?: NotifyOptions): Promise<void> {
  return getDefaultService().notify(message, options);
}

/**
 * Fire-and-forget notification using default service
 */
export function notifySync(message: string, options?: NotifyOptions): void {
  return getDefaultService().notifySync(message, options);
}

// ============================================================================
// CLI
// ============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
NotificationService - Unified notification service for Kaya

Usage:
  bun run NotificationService.ts --test "Message"     Send test notification
  bun run NotificationService.ts --health             Check service health
  bun run NotificationService.ts --channel voice "Message"
  bun run NotificationService.ts --channel push "Message"

Options:
  --test <message>       Send a test notification
  --health               Check if voice server is healthy
  --channel <channel>    Specify channel (voice, push, discord)
  --voice-id <id>        Override voice ID
  --agent <name>         Agent name for title
  --priority <level>     Priority (low, normal, high, critical)
  --help, -h             Show this help
    `);
    process.exit(0);
  }

  const service = createNotificationService();

  // Health check
  if (args.includes('--health')) {
    const voiceHealthy = await service.isServiceHealthy('voice');
    console.log(`Voice server: ${voiceHealthy ? 'HEALTHY' : 'DOWN'}`);

    const config = getDefaultConfig();
    if (config.ntfyTopic) {
      const pushHealthy = await service.isServiceHealthy('push');
      console.log(`Push (ntfy): ${pushHealthy ? 'CONFIGURED' : 'NOT CONFIGURED'}`);
    }

    process.exit(voiceHealthy ? 0 : 1);
  }

  // Parse options
  let channel: NotificationChannel = 'voice';
  let voiceId: string | undefined;
  let agentName: string | undefined;
  let priority: NotificationPriority = 'normal';
  let message = '';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--test' && args[i + 1]) {
      message = args[i + 1];
      i++;
    } else if (arg === '--channel' && args[i + 1]) {
      channel = args[i + 1] as NotificationChannel;
      i++;
    } else if (arg === '--voice-id' && args[i + 1]) {
      voiceId = args[i + 1];
      i++;
    } else if (arg === '--agent' && args[i + 1]) {
      agentName = args[i + 1];
      i++;
    } else if (arg === '--priority' && args[i + 1]) {
      priority = args[i + 1] as NotificationPriority;
      i++;
    } else if (!arg.startsWith('--')) {
      message = arg;
    }
  }

  if (!message) {
    console.error('Error: No message provided');
    process.exit(1);
  }

  try {
    await service.notify(message, {
      channel,
      voiceId,
      agentName,
      priority,
    });
    console.log(`Notification sent to ${channel}: "${message}"`);
    process.exit(0);
  } catch (error) {
    console.error('Failed to send notification:', error);
    process.exit(1);
  }
}

// Run if executed directly
if (import.meta.main) {
  main().catch(console.error);
}
