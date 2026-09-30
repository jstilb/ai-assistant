/**
 * Notification Service
 * Multi-channel notification system for Kaya infrastructure
 *
 * Channels:
 * - ntfy.sh: Mobile push notifications
 * - Discord: Team/server notifications (optional)
 * - Desktop: Native macOS notifications
 *
 * Design principles:
 * - Async, non-blocking (fire-and-forget)
 * - Fail gracefully (never block hook execution)
 * - Priority-based routing
 * - Conservative defaults (avoid notification fatigue)
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getIdentity } from './identity';
import { sendAlert, type AlertTier } from '../../lib/core/AlertGate.ts';
import { getKayaHome } from '../../lib/core/KayaHome.ts';

// ============================================================================
// Types
// ============================================================================

export type NotificationPriority = 'min' | 'low' | 'default' | 'high' | 'urgent';

export type NotificationEvent =
  | 'taskComplete'      // Normal task completion
  | 'longTask'          // Task that took >5 minutes
  | 'backgroundAgent'   // Background agent completed
  | 'error'             // Error occurred
  | 'security';         // Security alert

export interface NotificationOptions {
  title?: string;
  priority?: NotificationPriority;
  tags?: string[];        // ntfy emoji tags like 'robot', 'white_check_mark'
  click?: string;         // URL to open on click
  actions?: Array<{       // ntfy action buttons
    action: 'view' | 'http';
    label: string;
    url: string;
  }>;
}

export interface NotificationConfig {
  discord: {
    enabled: boolean;
    webhook: string;
  };
  thresholds: {
    longTaskMinutes: number;
  };
  routing: {
    // 'desktop' and 'sms' are inert (S5): their handlers were deleted as
    // dead code (zero callers, no settings.json config selected them).
    // Left in the type/union rather than removed so a stale settings.json
    // routing override referencing them fails safe (no-op) instead of
    // needing a schema migration. 'ntfy' is no longer a literal ntfy.sh
    // fetch — it now routes through AlertGate (see notify() below).
    [key in NotificationEvent]: ('ntfy' | 'discord' | 'desktop' | 'sms')[];
  };
}

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_CONFIG: NotificationConfig = {
  discord: {
    enabled: false,
    webhook: ''
  },
  thresholds: {
    longTaskMinutes: 5
  },
  routing: {
    taskComplete: [],                    // Voice only (existing behavior)
    longTask: ['ntfy'],                  // Push for long tasks
    backgroundAgent: ['ntfy'],           // Push for background completions
    error: ['ntfy', 'discord'],          // Multiple channels for errors
    security: ['ntfy', 'discord', 'sms'] // All channels for security
  }
};

/**
 * Expand ${VAR} patterns in a string using environment variables
 */
function expandEnvVars(content: string): string {
  return content.replace(/\$\{(\w+)\}/g, (_, key) => process.env[key] || '');
}

/**
 * Load notification config from settings.json
 */
export function getNotificationConfig(): NotificationConfig {
  try {
    const kayaDir = getKayaHome();
    const settingsPath = join(kayaDir, 'settings.json');

    if (existsSync(settingsPath)) {
      const rawContent = readFileSync(settingsPath, 'utf-8');
      const expandedContent = expandEnvVars(rawContent);
      const settings = JSON.parse(expandedContent);
      if (settings.notifications) {
        return {
          ...DEFAULT_CONFIG,
          ...settings.notifications,
          discord: { ...DEFAULT_CONFIG.discord, ...settings.notifications?.discord },
          thresholds: { ...DEFAULT_CONFIG.thresholds, ...settings.notifications?.thresholds },
          routing: { ...DEFAULT_CONFIG.routing, ...settings.notifications?.routing }
        };
      }
    }
  } catch (error) {
    // Fail gracefully, use defaults
    console.error('Failed to load notification config:', error);
  }

  return DEFAULT_CONFIG;
}

// ============================================================================
// Session Timing
// ============================================================================

const SESSION_START_FILE = '/tmp/pai-session-start.txt';

/**
 * Record session start time (call from SessionStart hook)
 */
export function recordSessionStart(): void {
  try {
    writeFileSync(SESSION_START_FILE, Date.now().toString());
  } catch (error) {
    // Fail gracefully
    console.error(`[notifications] recordSessionStart write failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Get session duration in minutes
 */
export function getSessionDurationMinutes(): number {
  try {
    if (existsSync(SESSION_START_FILE)) {
      const startTime = parseInt(readFileSync(SESSION_START_FILE, 'utf-8'));
      const duration = (Date.now() - startTime) / 1000 / 60; // minutes
      return duration;
    }
  } catch (error) {
    // Fail gracefully
    console.error(`[notifications] getSessionDurationMinutes read failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return 0;
}

/**
 * Determine if current task is "long running" based on threshold
 */
export function isLongRunningTask(): boolean {
  const config = getNotificationConfig();
  const duration = getSessionDurationMinutes();
  return duration >= config.thresholds.longTaskMinutes;
}

// ============================================================================
// Channel Implementations
// ============================================================================

/**
 * Send notification to Discord webhook
 */
export async function sendDiscord(
  message: string,
  options: {
    title?: string;
    description?: string;
    color?: number;       // Embed color (decimal)
    fields?: Array<{ name: string; value: string; inline?: boolean }>;
  } = {}
): Promise<boolean> {
  const config = getNotificationConfig();

  if (!config.discord.enabled || !config.discord.webhook) {
    return false;
  }

  try {
    const payload: any = {};

    if (options.title || options.description || options.fields) {
      // Use embed for rich messages
      payload.embeds = [{
        title: options.title,
        description: options.description || message,
        color: options.color || 0x7289da, // Discord blurple
        fields: options.fields,
        timestamp: new Date().toISOString()
      }];
    } else {
      // Simple text message
      payload.content = message;
    }

    const response = await fetch(config.discord.webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    return response.ok;
  } catch (error) {
    console.error('Discord send failed:', error);
    return false;
  }
}

// ============================================================================
// Smart Router
// ============================================================================

/**
 * Maps each NotificationEvent to the AlertGate key used for its push-tier
 * traffic. taskComplete/longTask share a key (same logical stream, just
 * duration-escalated); 'security' is unreachable in production today (no
 * `notify('security', ...)` caller exists — security blocks route through
 * the dedicated hooks/lib/security-alerts.ts module instead) but is listed
 * for type exhaustiveness.
 */
const ALERT_KEY_BY_EVENT: Record<NotificationEvent, string> = {
  taskComplete: 'task-complete',
  longTask: 'task-complete',
  backgroundAgent: 'background-agent',
  error: 'hook-error',
  security: 'hook-security',
};

/** Short, non-cryptographic content fingerprint for AlertGate dedup. */
function shortHash(content: string): string {
  return typeof Bun !== 'undefined' && Bun.hash
    ? Bun.hash(content).toString(16)
    : String(content.length);
}

/**
 * Send notification through appropriate channels based on event type
 * This is the main entry point for notifications
 */
export async function notify(
  event: NotificationEvent,
  message: string,
  options: NotificationOptions = {}
): Promise<void> {
  const config = getNotificationConfig();
  const channels = config.routing[event] || [];

  // Fire all notifications in parallel, don't wait for completion
  const promises: Promise<boolean>[] = [];

  for (const channel of channels) {
    switch (channel) {
      case 'ntfy': {
        // S5: routed through AlertGate instead of a raw, unthrottled ntfy.sh
        // fetch (sendPush, deleted). Only 'error' events at 'urgent' priority
        // page immediately; everything else is digested — see ADR-004.
        const resolvedPriority = options.priority || getDefaultPriority(event);
        const tier: AlertTier = event === 'error' && resolvedPriority === 'urgent' ? 'page' : 'digest';
        sendAlert(message, {
          key: ALERT_KEY_BY_EVENT[event],
          tier,
          fingerprint: shortHash(message),
        });
        promises.push(Promise.resolve(true));
        break;
      }

      case 'discord':
        promises.push(sendDiscord(message, {
          title: options.title || getDefaultTitle(event),
          color: getDiscordColor(event)
        }));
        break;

      // 'desktop' and 'sms': handlers deleted in S5 (zero callers — see
      // NotificationConfig.routing comment above). Selecting them in
      // settings.json config now silently no-ops instead of notifying.
    }
  }

  // Fire and forget - don't await
  Promise.all(promises).catch(() => {
    // Silently ignore failures
  });
}

/**
 * Convenience function for task completion with duration check
 */
export async function notifyTaskComplete(message: string, options: NotificationOptions = {}): Promise<void> {
  const event: NotificationEvent = isLongRunningTask() ? 'longTask' : 'taskComplete';
  await notify(event, message, options);
}

/**
 * Convenience function for background agent completion
 */
export async function notifyBackgroundAgent(
  agentType: string,
  message: string,
  options: NotificationOptions = {}
): Promise<void> {
  await notify('backgroundAgent', message, {
    title: `${agentType} Agent Complete`,
    tags: ['robot', 'white_check_mark'],
    ...options
  });
}

/**
 * Convenience function for error notifications
 */
export async function notifyError(message: string, options: NotificationOptions = {}): Promise<void> {
  await notify('error', message, {
    priority: 'high',
    tags: ['warning', 'x'],
    ...options
  });
}

// ============================================================================
// Helpers
// ============================================================================

function getDefaultTitle(event: NotificationEvent): string {
  const DA_NAME = getIdentity().name;
  const titles: Record<NotificationEvent, string> = {
    taskComplete: DA_NAME,
    longTask: `${DA_NAME} - Task Complete`,
    backgroundAgent: `${DA_NAME} - Agent Complete`,
    error: `${DA_NAME} - Error`,
    security: `${DA_NAME} - Security Alert`
  };
  return titles[event];
}

function getDefaultPriority(event: NotificationEvent): NotificationPriority {
  const priorities: Record<NotificationEvent, NotificationPriority> = {
    taskComplete: 'default',
    longTask: 'default',
    backgroundAgent: 'default',
    error: 'high',
    security: 'urgent'
  };
  return priorities[event];
}

function getDiscordColor(event: NotificationEvent): number {
  const colors: Record<NotificationEvent, number> = {
    taskComplete: 0x57f287,   // Green
    longTask: 0x57f287,       // Green
    backgroundAgent: 0x5865f2, // Blurple
    error: 0xed4245,          // Red
    security: 0xfee75c        // Yellow
  };
  return colors[event];
}
