#!/usr/bin/env bun
/**
 * GmailInboxBlock.ts - Gmail inbox summary for daily briefing
 *
 * Reads unread important emails via kaya-cli gmail search to extract:
 * - Unread important messages from the last 24 hours
 * - Count by sender, top subject lines
 */

import { join } from "path";
import type { BlockResult } from "./types.ts";

const KAYA_HOME = process.env.KAYA_DIR || join(process.env.HOME!, ".claude");
const KAYA_CLI = join(KAYA_HOME, "bin", "kaya-cli");

export type { BlockResult };

const DEFAULT_QUERY = "is:unread is:important newer_than:1d";
const DEFAULT_MAX_MESSAGES = 10;

interface GmailMessage {
  id?: string;
  from?: string;
  subject?: string;
  date?: string;
  snippet?: string;
}

interface SenderGroup {
  sender: string;
  count: number;
  subjects: string[];
}

export interface GmailInboxBlockConfig {
  query?: string;
  maxMessages?: number;
  settings?: {
    query?: string;
    maxMessages?: number;
    [key: string]: unknown;
  };
}

/**
 * Search Gmail via kaya-cli using Bun.spawn.
 * Returns parsed messages as GmailMessage[].
 */
async function searchGmail(query: string, maxMessages: number, timeoutMs = 15000): Promise<GmailMessage[]> {
  const proc = Bun.spawn(
    [KAYA_CLI, "gmail", "search", query, "--max", String(maxMessages), "--json"],
    {
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`Gmail search timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    var [stdout, stderr, exitCode] = await Promise.race([
      Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]),
      timeout,
    ]) as [string, string, number];
  } finally {
    clearTimeout(timer!);
  }

  if (exitCode !== 0) {
    throw new Error(`kaya-cli gmail search failed: ${stderr.trim() || `exit code ${exitCode}`}`);
  }

  const trimmed = stdout.trim();
  if (!trimmed) return [];

  // Try JSON parse
  if (trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed) as GmailMessage[];
    } catch {
      // Fall through
    }
  }

  // If JSON object — gog returns { threads: [...] } or { messages: [...] }
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as {
        messages?: GmailMessage[];
        threads?: Array<{ messages?: GmailMessage[]; snippet?: string; id?: string }> | null;
      };
      // Direct messages array
      if (parsed.messages?.length) return parsed.messages;
      // gog threads format — extract first message from each thread
      if (parsed.threads?.length) {
        return parsed.threads.map(t => t.messages?.[0] ?? {
          id: t.id,
          snippet: t.snippet,
        } as GmailMessage);
      }
      return [];
    } catch {
      // Fall through
    }
  }

  return [];
}

/**
 * Normalize a sender string to a display name.
 * "John Doe <john@example.com>" -> "John Doe"
 * "john@example.com" -> "john@example.com"
 */
function normalizeSender(from: string): string {
  const match = from.match(/^([^<]+)</);
  if (match) {
    return match[1].trim();
  }
  return from.trim();
}

/**
 * Group messages by sender, counting occurrences.
 */
function groupBySender(messages: GmailMessage[]): SenderGroup[] {
  const map = new Map<string, SenderGroup>();

  for (const msg of messages) {
    const sender = normalizeSender(msg.from ?? "Unknown");
    const subject = msg.subject ?? "(no subject)";

    if (!map.has(sender)) {
      map.set(sender, { sender, count: 0, subjects: [] });
    }

    const group = map.get(sender)!;
    group.count++;
    if (group.subjects.length < 3) {
      group.subjects.push(subject);
    }
  }

  return [...map.values()].sort((a, b) => b.count - a.count);
}

export async function execute(config: GmailInboxBlockConfig = {}): Promise<BlockResult> {
  // Support both top-level and nested settings
  const query = config.query ?? config.settings?.query ?? DEFAULT_QUERY;
  const maxMessages = config.maxMessages ?? (config.settings?.maxMessages as number | undefined) ?? DEFAULT_MAX_MESSAGES;

  try {
    const messages = await searchGmail(query, maxMessages);

    if (messages.length === 0) {
      return {
        blockName: "gmailInbox",
        success: true,
        data: { messages: [], senderGroups: [], totalCount: 0 },
        markdown: "## Gmail Inbox\n\nNo unread important messages.\n",
        summary: "Inbox clear",
      };
    }

    const senderGroups = groupBySender(messages);

    // Format markdown
    let markdown = `## Gmail Inbox\n\n`;
    markdown += `**${messages.length} unread important** message${messages.length !== 1 ? "s" : ""}\n\n`;

    // Top senders table
    if (senderGroups.length > 0) {
      markdown += `| Sender | Count | Subject(s) |\n`;
      markdown += `|--------|-------|------------|\n`;
      for (const group of senderGroups.slice(0, 5)) {
        const subjectList = group.subjects.slice(0, 2).join("; ");
        const moreCount = group.subjects.length > 2 ? ` +${group.subjects.length - 2}` : "";
        markdown += `| ${group.sender} | ${group.count} | ${subjectList}${moreCount} |\n`;
      }
      markdown += "\n";
    }

    const summary = `${messages.length} unread important email${messages.length !== 1 ? "s" : ""} from ${senderGroups.length} sender${senderGroups.length !== 1 ? "s" : ""}`;

    return {
      blockName: "gmailInbox",
      success: true,
      data: {
        messages: messages.slice(0, maxMessages),
        senderGroups,
        totalCount: messages.length,
        topSender: senderGroups[0] ?? null,
      },
      markdown,
      summary,
    };
  } catch (error) {
    return {
      blockName: "gmailInbox",
      success: false,
      data: {},
      markdown: "## Gmail Inbox\n\nFailed to load inbox data.\n",
      summary: "Gmail inbox unavailable",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// CLI entry point
if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes("--test") || args.includes("-t")) {
    const result = await execute({ query: DEFAULT_QUERY, maxMessages: DEFAULT_MAX_MESSAGES });
    console.log("=== Gmail Inbox Block Test ===\n");
    console.log("Success:", result.success);
    console.log("\nMarkdown:\n", result.markdown);
    console.log("\nSummary:", result.summary);
    if (result.error) console.log("\nError:", result.error);
    console.log("\nData:", JSON.stringify(result.data, null, 2));
  } else {
    console.log("Usage: bun GmailInboxBlock.ts --test");
  }
}
