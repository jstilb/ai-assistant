/**
 * SessionManager.ts - Persistent session management for mobile gateway
 *
 * Replaces the 20-message rolling window with proper persistent sessions:
 * - JSONL storage at MEMORY/TELEGRAM/sessions/{session_id}.jsonl
 * - Auto-generated summaries at MEMORY/TELEGRAM/sessions/{session_id}-summary.md
 * - New session segment after 6+ hours idle
 * - Context overflow: summarize older messages (never drop)
 * - Max 200 exchanges before forced summarization
 * - Backward compatible with MEMORY/TELEGRAM/conversations/
 */

import { existsSync, mkdirSync } from "fs";
import { readFile, appendFile, writeFile, readdir } from "fs/promises";
import { join } from "path";
import { spawn } from "child_process";
import type { Session, SessionExchange } from "./KayaMobileGateway";

const KAYA_HOME = process.env.HOME + "/.claude";
const SESSIONS_DIR = `${KAYA_HOME}/MEMORY/TELEGRAM/sessions`;

// Configuration
const SESSION_IDLE_THRESHOLD_MS = 6 * 60 * 60 * 1000; // 6 hours
const MAX_RECENT_EXCHANGES = 30; // Keep last 30 in memory
const MAX_EXCHANGES_BEFORE_SUMMARY = 200;
const SUMMARY_BATCH_SIZE = 20; // Summarize 20 at a time

/**
 * Ensure sessions directory exists
 */
function ensureSessionsDir(): void {
  if (!existsSync(SESSIONS_DIR)) {
    mkdirSync(SESSIONS_DIR, { recursive: true });
  }
}

/**
 * Generate a session ID based on timestamp
 */
function generateSessionId(channelId: string): string {
  const now = new Date();
  const dateStr = now.toISOString().replace(/[:.]/g, "-").substring(0, 19);
  return `${channelId}-${dateStr}`;
}

/**
 * Get the session file path
 */
function getSessionPath(sessionId: string): string {
  return join(SESSIONS_DIR, `${sessionId}.jsonl`);
}

/**
 * Get the session summary path
 */
function getSummaryPath(sessionId: string): string {
  return join(SESSIONS_DIR, `${sessionId}-summary.md`);
}

/**
 * Get the session metadata path
 */
function getMetadataPath(sessionId: string): string {
  return join(SESSIONS_DIR, `${sessionId}-meta.json`);
}

/**
 * Find the most recent session for a channel
 */
async function findLatestSession(channelId: string): Promise<string | null> {
  ensureSessionsDir();

  try {
    const files = await readdir(SESSIONS_DIR);
    const sessionFiles = files
      .filter(
        (f) =>
          f.startsWith(channelId) && f.endsWith("-meta.json")
      )
      .sort()
      .reverse();

    if (sessionFiles.length === 0) return null;

    // Return session ID (strip -meta.json)
    return sessionFiles[0].replace("-meta.json", "");
  } catch {
    return null;
  }
}

/**
 * Read session metadata
 */
async function readSessionMetadata(sessionId: string): Promise<Session | null> {
  const metaPath = getMetadataPath(sessionId);
  if (!existsSync(metaPath)) return null;

  try {
    const content = await readFile(metaPath, "utf-8");
    return JSON.parse(content) as Session;
  } catch {
    return null;
  }
}

/**
 * Write session metadata
 */
async function writeSessionMetadata(session: Session): Promise<void> {
  ensureSessionsDir();
  const metaPath = getMetadataPath(session.sessionId);
  await writeFile(metaPath, JSON.stringify(session, null, 2));
}

/**
 * Read exchanges from session JSONL
 */
async function readExchanges(sessionId: string): Promise<SessionExchange[]> {
  const sessionPath = getSessionPath(sessionId);
  if (!existsSync(sessionPath)) return [];

  try {
    const content = await readFile(sessionPath, "utf-8");
    return content
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as SessionExchange);
  } catch {
    return [];
  }
}

/**
 * Append an exchange to session JSONL
 */
async function appendExchange(
  sessionId: string,
  exchange: SessionExchange
): Promise<void> {
  ensureSessionsDir();
  const sessionPath = getSessionPath(sessionId);
  await appendFile(sessionPath, JSON.stringify(exchange) + "\n");
}

/**
 * Read session summary
 */
async function readSummary(sessionId: string): Promise<string> {
  const summaryPath = getSummaryPath(sessionId);
  if (!existsSync(summaryPath)) return "";

  try {
    return await readFile(summaryPath, "utf-8");
  } catch {
    return "";
  }
}

/**
 * Write session summary
 */
async function writeSummary(
  sessionId: string,
  summary: string
): Promise<void> {
  ensureSessionsDir();
  const summaryPath = getSummaryPath(sessionId);
  await writeFile(summaryPath, summary);
}

/**
 * Generate summary of exchanges using Claude CLI
 */
async function generateSummary(
  exchanges: SessionExchange[],
  existingSummary: string
): Promise<string> {
  const exchangeText = exchanges
    .map((e) => `User: ${e.userText}\nAssistant: ${e.assistantText}`)
    .join("\n\n");

  const prompt = existingSummary
    ? `Update this conversation summary with the new exchanges below.\n\nExisting summary:\n${existingSummary}\n\nNew exchanges:\n${exchangeText}\n\nProvide a concise updated summary (max 500 words) capturing key topics, decisions, preferences, and context. Focus on what would be useful for continuing the conversation later.`
    : `Summarize this conversation concisely (max 500 words). Focus on key topics, decisions, user preferences, and context that would be useful for continuing the conversation later.\n\n${exchangeText}`;

  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;

    const args = [
      "-p",
      "--model",
      "haiku",
      "--tools",
      "",
      "--output-format",
      "text",
      "--setting-sources",
      "",
      prompt,
    ];

    let stdout = "";
    const proc = spawn("claude", args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    const timeoutId = setTimeout(() => {
      proc.kill("SIGTERM");
      resolve(existingSummary || "Summary generation timed out.");
    }, 15000);

    proc.on("close", (code: number | null) => {
      clearTimeout(timeoutId);
      if (code === 0 && stdout.trim()) {
        resolve(stdout.trim());
      } else {
        resolve(existingSummary || "Summary generation failed.");
      }
    });

    proc.on("error", () => {
      clearTimeout(timeoutId);
      resolve(existingSummary || "Summary generation failed.");
    });
  });
}

/**
 * Load or create a session for the given channel.
 *
 * Session continuity rules:
 * - If last activity was < 6 hours ago, continue existing session
 * - If last activity was >= 6 hours ago, create new session segment
 * - If no session exists, create new one
 */
export async function loadSession(channelId: string): Promise<Session> {
  ensureSessionsDir();

  const latestSessionId = await findLatestSession(channelId);

  if (latestSessionId) {
    const existingSession = await readSessionMetadata(latestSessionId);

    if (existingSession) {
      const lastActivity = new Date(existingSession.lastActivityAt).getTime();
      const timeSinceActivity = Date.now() - lastActivity;

      if (timeSinceActivity < SESSION_IDLE_THRESHOLD_MS) {
        // Continue existing session - load recent exchanges
        const allExchanges = await readExchanges(latestSessionId);
        existingSession.recentExchanges = allExchanges.slice(
          -MAX_RECENT_EXCHANGES
        );
        existingSession.summary = await readSummary(latestSessionId);
        return existingSession;
      }
    }
  }

  // Create new session
  const sessionId = generateSessionId(channelId);
  const now = new Date().toISOString();

  const session: Session = {
    sessionId,
    channelId,
    createdAt: now,
    lastActivityAt: now,
    exchangeCount: 0,
    summary: "",
    recentExchanges: [],
    currentProfile: "general",
    forceSummarized: false,
  };

  await writeSessionMetadata(session);
  return session;
}

/**
 * Save session state after an exchange.
 * Handles auto-summarization when exchange count exceeds threshold.
 */
export async function saveSession(session: Session): Promise<void> {
  ensureSessionsDir();

  // Save metadata
  await writeSessionMetadata(session);

  // Save summary if it exists
  if (session.summary) {
    await writeSummary(session.sessionId, session.summary);
  }
}

/**
 * Record an exchange in the session
 */
export async function recordExchange(
  session: Session,
  exchange: SessionExchange
): Promise<Session> {
  // Append to JSONL
  await appendExchange(session.sessionId, exchange);

  // Update session state
  session.exchangeCount += 1;
  session.lastActivityAt = exchange.timestamp;
  session.recentExchanges.push(exchange);

  // Trim recent exchanges to window size
  if (session.recentExchanges.length > MAX_RECENT_EXCHANGES) {
    session.recentExchanges = session.recentExchanges.slice(
      -MAX_RECENT_EXCHANGES
    );
  }

  // Check if we need to summarize
  if (
    session.exchangeCount > 0 &&
    session.exchangeCount % SUMMARY_BATCH_SIZE === 0
  ) {
    await triggerSummarization(session);
  }

  // Force summarization at max exchanges
  if (
    session.exchangeCount >= MAX_EXCHANGES_BEFORE_SUMMARY &&
    !session.forceSummarized
  ) {
    await triggerSummarization(session);
    session.forceSummarized = true;
  }

  await saveSession(session);
  return session;
}

/**
 * Trigger summarization of older exchanges
 */
async function triggerSummarization(session: Session): Promise<void> {
  try {
    const allExchanges = await readExchanges(session.sessionId);

    // Summarize everything except the most recent exchanges
    const exchangesToSummarize = allExchanges.slice(0, -MAX_RECENT_EXCHANGES);

    if (exchangesToSummarize.length === 0) return;

    console.log(
      `[SessionManager] Summarizing ${exchangesToSummarize.length} older exchanges...`
    );

    const newSummary = await generateSummary(
      exchangesToSummarize,
      session.summary
    );

    session.summary = newSummary;
    await writeSummary(session.sessionId, newSummary);

    console.log(`[SessionManager] Summary updated (${newSummary.length} chars)`);
  } catch (error) {
    console.error("[SessionManager] Summarization failed:", error);
  }
}

/**
 * Format session context for inclusion in system prompt.
 * Returns summary + recent exchanges formatted for Claude.
 */
export function formatSessionContext(session: Session): string {
  const parts: string[] = [];

  // Add summary of older context
  if (session.summary.trim()) {
    parts.push(`## Conversation Summary\n${session.summary}`);
  }

  // Add recent exchanges
  if (session.recentExchanges.length > 0) {
    const formatted = session.recentExchanges
      .map((e) => {
        const time = new Date(e.timestamp).toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: true,
        });
        const userContent =
          e.userText.length > 300
            ? e.userText.substring(0, 300) + "..."
            : e.userText;
        const assistantContent =
          e.assistantText.length > 300
            ? e.assistantText.substring(0, 300) + "..."
            : e.assistantText;
        return `[${time}] User: ${userContent}\n[${time}] Assistant: ${assistantContent}`;
      })
      .join("\n\n");

    parts.push(`## Recent Messages\n${formatted}`);
  }

  return parts.join("\n\n");
}

/**
 * Get session statistics
 */
export async function getSessionStats(channelId: string): Promise<{
  totalSessions: number;
  currentSessionExchanges: number;
  hasSummary: boolean;
}> {
  ensureSessionsDir();

  try {
    const files = await readdir(SESSIONS_DIR);
    const sessionCount = files.filter(
      (f) => f.startsWith(channelId) && f.endsWith("-meta.json")
    ).length;

    const latestSessionId = await findLatestSession(channelId);
    let currentExchanges = 0;
    let hasSummary = false;

    if (latestSessionId) {
      const meta = await readSessionMetadata(latestSessionId);
      currentExchanges = meta?.exchangeCount ?? 0;
      hasSummary = existsSync(getSummaryPath(latestSessionId));
    }

    return {
      totalSessions: sessionCount,
      currentSessionExchanges: currentExchanges,
      hasSummary,
    };
  } catch {
    return {
      totalSessions: 0,
      currentSessionExchanges: 0,
      hasSummary: false,
    };
  }
}
