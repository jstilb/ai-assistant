/**
 * @deprecated Use SessionManager.ts instead. This module provides legacy Moltbot-style
 * JSONL persistence that has been superseded by the SessionManager gateway pipeline
 * (persistent sessions, auto-summarization, JSONL + metadata at MEMORY/TELEGRAM/sessions/).
 *
 * Retained for backward compatibility with the fallback path in handlers/text.ts.
 * Will be removed in a future cleanup pass.
 *
 * Telegram Memory Module - Persistent conversation context (LEGACY)
 *
 * Phase 1: Markdown-based persistence (Moltbot-style)
 * - Rolling context summary (always loaded)
 * - Daily JSONL conversation logs
 * - Simple key facts extraction
 *
 * Architecture:
 *   MEMORY/TELEGRAM/
 *   ├── context.md           # Rolling context summary
 *   ├── conversations/
 *   │   └── YYYY-MM-DD.jsonl # Daily message logs
 *   └── learnings.md         # Key facts (future phase)
 */

import { existsSync } from "fs";
import { mkdir, readFile, appendFile, writeFile } from "fs/promises";

const KAYA_HOME = process.env.HOME + "/.claude";
const TELEGRAM_MEMORY = `${KAYA_HOME}/MEMORY/TELEGRAM`;
const CONVERSATIONS_DIR = `${TELEGRAM_MEMORY}/conversations`;
const CONTEXT_FILE = `${TELEGRAM_MEMORY}/context.md`;

// Configuration
const MAX_CONTEXT_MESSAGES = 20; // How many recent messages to include
const MAX_CONTEXT_CHARS = 4000; // Limit context size for mobile efficiency

/** @deprecated Use SessionExchange from KayaMobileGateway instead. */
export interface ConversationEntry {
  timestamp: number;
  role: "user" | "assistant";
  content: string;
  source?: "text" | "voice";
}

/**
 * Ensure memory directories exist
 */
async function ensureDirectories(): Promise<void> {
  if (!existsSync(CONVERSATIONS_DIR)) {
    await mkdir(CONVERSATIONS_DIR, { recursive: true });
  }
}

/**
 * Get today's log file path
 */
function getTodayLogPath(): string {
  const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
  return `${CONVERSATIONS_DIR}/${today}.jsonl`;
}

/**
 * Append a message to today's conversation log
 * @deprecated Use SessionManager.recordExchange() instead.
 */
export async function logMessage(entry: ConversationEntry): Promise<void> {
  await ensureDirectories();
  const logPath = getTodayLogPath();
  const line = JSON.stringify(entry) + "\n";
  await appendFile(logPath, line);
}

/**
 * Log both user message and assistant response
 * @deprecated Use SessionManager.recordExchange() instead.
 */
export async function logExchange(
  userMessage: string,
  assistantResponse: string,
  source: "text" | "voice" = "text"
): Promise<void> {
  const timestamp = Date.now();

  await logMessage({
    timestamp,
    role: "user",
    content: userMessage,
    source,
  });

  await logMessage({
    timestamp: timestamp + 1, // Ensure ordering
    role: "assistant",
    content: assistantResponse,
  });
}

/**
 * Read recent messages from today's log
 */
async function readTodayMessages(): Promise<ConversationEntry[]> {
  const logPath = getTodayLogPath();

  if (!existsSync(logPath)) {
    return [];
  }

  try {
    const content = await readFile(logPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    return lines.map((line) => JSON.parse(line));
  } catch (error) {
    console.error("Error reading today's messages:", error);
    return [];
  }
}

/**
 * Read the rolling context summary
 */
async function readContextSummary(): Promise<string> {
  if (!existsSync(CONTEXT_FILE)) {
    return "";
  }

  try {
    return await readFile(CONTEXT_FILE, "utf-8");
  } catch (error) {
    console.error("Error reading context file:", error);
    return "";
  }
}

/**
 * Update the rolling context summary
 * Called periodically or when context needs refresh
 * @deprecated Use SessionManager summary system instead.
 */
export async function updateContextSummary(summary: string): Promise<void> {
  await ensureDirectories();
  await writeFile(CONTEXT_FILE, summary);
}

/**
 * Format messages for inclusion in system prompt
 */
function formatMessagesForContext(messages: ConversationEntry[]): string {
  if (messages.length === 0) return "";

  // Take last N messages
  const recent = messages.slice(-MAX_CONTEXT_MESSAGES);

  // Format as conversation
  const lines = recent.map((msg) => {
    const role = msg.role === "user" ? "User" : "Assistant";
    const time = new Date(msg.timestamp).toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });
    // Truncate long messages
    const content =
      msg.content.length > 200
        ? msg.content.substring(0, 200) + "..."
        : msg.content;
    return `[${time}] ${role}: ${content}`;
  });

  return lines.join("\n");
}

/**
 * Load full context for Claude prompt
 * Combines rolling summary + recent messages
 * @deprecated Use SessionManager.formatSessionContext() instead.
 */
export async function loadContext(): Promise<string> {
  const [contextSummary, todayMessages] = await Promise.all([
    readContextSummary(),
    readTodayMessages(),
  ]);

  const parts: string[] = [];

  // Add rolling context summary if exists
  if (contextSummary.trim()) {
    parts.push("## Conversation Context\n" + contextSummary);
  }

  // Add recent messages
  if (todayMessages.length > 0) {
    const formattedMessages = formatMessagesForContext(todayMessages);
    parts.push("## Recent Messages\n" + formattedMessages);
  }

  let context = parts.join("\n\n");

  // Enforce size limit
  if (context.length > MAX_CONTEXT_CHARS) {
    context = context.substring(context.length - MAX_CONTEXT_CHARS);
    // Find first newline to avoid cutting mid-message
    const firstNewline = context.indexOf("\n");
    if (firstNewline > 0) {
      context = "...\n" + context.substring(firstNewline + 1);
    }
  }

  return context;
}

/**
 * Check if we have any conversation history
 * @deprecated Use SessionManager.getSessionStats() instead.
 */
export async function hasHistory(): Promise<boolean> {
  const messages = await readTodayMessages();
  return messages.length > 0;
}

/**
 * Get stats about conversation history
 * @deprecated Use SessionManager.getSessionStats() instead.
 */
export async function getStats(): Promise<{
  todayMessages: number;
  hasContext: boolean;
}> {
  const [messages, contextSummary] = await Promise.all([
    readTodayMessages(),
    readContextSummary(),
  ]);

  return {
    todayMessages: messages.length,
    hasContext: contextSummary.trim().length > 0,
  };
}
