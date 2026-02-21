#!/usr/bin/env bun
/**
 * Logger - Structured JSON logging for CalendarAssistant
 *
 * Outputs structured JSON log entries with all required fields,
 * PII sanitization, log rotation, and correlation ID tracking.
 *
 * Usage:
 *   import { createLogger } from './Logger.ts';
 *   const logger = createLogger('CalendarOrchestrator');
 *   logger.info('Event created', { eventId: '123', action: 'create' });
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';

// ============================================================================
// Types
// ============================================================================

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  component: string;
  user_id: string;
  event_id?: string;
  action_type?: string;
  confidence_score?: number;
  rationale_summary?: string;
  correlation_id?: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface LoggerConfig {
  level: LogLevel;
  file: string;
  maxFileSizeMB: number;
  retentionDays: number;
  userId: string;
}

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  setCorrelationId(id: string): void;
  withComponent(name: string): Logger;
}

// ============================================================================
// Constants
// ============================================================================

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const DEFAULT_LOG_PATH = join(homedir(), '.claude', 'logs', 'calendar-assistant.log');

// ============================================================================
// PII Sanitization
// ============================================================================

function sanitizeValue(key: string, value: unknown): unknown {
  const piiKeys = ['title', 'summary', 'attendee', 'email', 'name', 'description'];
  if (typeof value === 'string' && piiKeys.some(k => key.toLowerCase().includes(k))) {
    return hashPII(value);
  }
  return value;
}

function hashPII(value: string): string {
  return `[REDACTED:${createHash('sha256').update(value).digest('hex').slice(0, 8)}]`;
}

function sanitizeData(data: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      sanitized[key] = sanitizeData(value as Record<string, unknown>);
    } else {
      sanitized[key] = sanitizeValue(key, value);
    }
  }
  return sanitized;
}

// ============================================================================
// Log Rotation
// ============================================================================

function rotateIfNeeded(filePath: string, maxSizeMB: number): void {
  if (!existsSync(filePath)) return;

  try {
    const stats = statSync(filePath);
    const sizeMB = stats.size / (1024 * 1024);

    if (sizeMB >= maxSizeMB) {
      const rotated = `${filePath}.1`;
      // Simple rotation: current → .1 (overwrite previous .1)
      renameSync(filePath, rotated);
    }
  } catch {
    // Rotation failure is non-fatal
  }
}

// ============================================================================
// Implementation
// ============================================================================

export function createLogger(component: string, config?: Partial<LoggerConfig>): Logger {
  const cfg: LoggerConfig = {
    level: (config?.level || process.env.LOG_LEVEL as LogLevel) || 'info',
    file: config?.file || DEFAULT_LOG_PATH,
    maxFileSizeMB: config?.maxFileSizeMB || 100,
    retentionDays: config?.retentionDays || 7,
    userId: config?.userId || 'jm',
  };

  // Resolve home dir
  const logPath = cfg.file.replace('~', homedir());
  let correlationId: string | undefined;

  function shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[cfg.level];
  }

  function writeLog(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (!shouldLog(level)) return;

    const dir = dirname(logPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Check rotation before writing
    rotateIfNeeded(logPath, cfg.maxFileSizeMB);

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      component,
      user_id: cfg.userId,
      message,
    };

    if (correlationId) entry.correlation_id = correlationId;

    // Extract known fields from data
    if (data) {
      if (data.event_id) entry.event_id = String(data.event_id);
      if (data.action_type) entry.action_type = String(data.action_type);
      if (data.confidence_score !== undefined) entry.confidence_score = Number(data.confidence_score);
      if (data.rationale_summary) entry.rationale_summary = String(data.rationale_summary);

      // Sanitize and attach remaining data
      const sanitized = sanitizeData(data);
      entry.data = sanitized;
    }

    appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf-8');
  }

  const logger: Logger = {
    debug: (msg, data) => writeLog('debug', msg, data),
    info: (msg, data) => writeLog('info', msg, data),
    warn: (msg, data) => writeLog('warn', msg, data),
    error: (msg, data) => writeLog('error', msg, data),

    setCorrelationId(id: string): void {
      correlationId = id;
    },

    withComponent(name: string): Logger {
      return createLogger(name, cfg);
    },
  };

  return logger;
}
