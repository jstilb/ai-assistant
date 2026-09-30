// Messages Parser — parses messages.csv and groups by conversation
import { readCsv } from "../utils/csv-reader.ts";
import { stripHtml } from "../utils/html-stripper.ts";
import { normalizeLinkedInUrl } from "../utils/url-normalizer.ts";
import { parseDate } from "../utils/date-parser.ts";
import type {
  MessageRow,
  ParsedMessage,
  ConversationData,
  Result,
} from "../types.ts";

// Jm's known LinkedIn URL slugs
const JM_URLS = new Set([
  "https://www.linkedin.com/in/john-stilb",
  "john-stilb",
]);

function isJmUrl(url: string): boolean {
  if (!url) return false;
  const normalized = normalizeLinkedInUrl(url);
  const slug = normalized.split("/in/").pop() ?? "";
  return JM_URLS.has(normalized) || slug === "john-stilb";
}

function parseRecipientUrls(recipientUrlField: string): string[] {
  if (!recipientUrlField || recipientUrlField.trim() === "") return [];
  // Recipient URLs can be comma-separated
  return recipientUrlField
    .split(",")
    .map((u) => u.trim())
    .filter((u) => u !== "")
    .map(normalizeLinkedInUrl)
    .filter((u) => u !== "");
}

export function parseMessages(
  csvPath: string
): Result<Map<string, ConversationData>> {
  const readResult = readCsv<MessageRow>(csvPath);
  if (!readResult.success) return readResult;

  const rows = readResult.data;
  const conversationMap = new Map<string, ConversationData>();
  const parsedMessages: ParsedMessage[] = [];

  for (const row of rows) {
    const convId = row["CONVERSATION ID"]?.trim() ?? "";
    if (!convId) continue;

    const senderUrl = row["SENDER PROFILE URL"]?.trim() ?? "";
    const fromJm = isJmUrl(senderUrl);
    const rawContent = row["CONTENT"] ?? "";
    const strippedContent = stripHtml(rawContent);
    const rawDate = row["DATE"] ?? "";
    const parsedDate = parseDate(rawDate);

    if (!parsedDate) {
      // Skip rows with unparseable dates
      continue;
    }

    const recipientUrls = parseRecipientUrls(
      row["RECIPIENT PROFILE URLS"] ?? ""
    );

    const msg: ParsedMessage = {
      conversationId: convId,
      conversationTitle: row["CONVERSATION TITLE"] ?? "",
      from: row["FROM"] ?? "",
      senderUrl: normalizeLinkedInUrl(senderUrl),
      to: row["TO"] ?? "",
      recipientUrls,
      date: parsedDate,
      content: strippedContent,
      isFromJm: fromJm,
    };

    parsedMessages.push(msg);
  }

  // Group by conversation ID
  for (const msg of parsedMessages) {
    const existing = conversationMap.get(msg.conversationId);

    if (!existing) {
      // Determine non-Jm participants
      const participants: string[] = [];
      if (!msg.isFromJm && msg.senderUrl) {
        const normalized = normalizeLinkedInUrl(msg.senderUrl);
        if (normalized && !isJmUrl(msg.senderUrl)) {
          participants.push(normalized);
        }
      }
      for (const rUrl of msg.recipientUrls) {
        if (!isJmUrl(rUrl) && rUrl) {
          if (!participants.includes(rUrl)) participants.push(rUrl);
        }
      }

      conversationMap.set(msg.conversationId, {
        conversationId: msg.conversationId,
        conversationTitle: msg.conversationTitle,
        messages: [msg],
        participants,
        messageCount: 1,
        jmMessageCount: msg.isFromJm ? 1 : 0,
        otherMessageCount: msg.isFromJm ? 0 : 1,
        bidirectional: false, // computed below
        latestDate: msg.date,
        earliestDate: msg.date,
        plainTextContent: msg.content,
      });
    } else {
      existing.messages.push(msg);
      existing.messageCount++;
      if (msg.isFromJm) {
        existing.jmMessageCount++;
      } else {
        existing.otherMessageCount++;
        // Add new participants
        if (msg.senderUrl && !isJmUrl(msg.senderUrl)) {
          const normalized = normalizeLinkedInUrl(msg.senderUrl);
          if (normalized && !existing.participants.includes(normalized)) {
            existing.participants.push(normalized);
          }
        }
      }
      // Add recipient URLs
      for (const rUrl of msg.recipientUrls) {
        if (!isJmUrl(rUrl) && rUrl && !existing.participants.includes(rUrl)) {
          existing.participants.push(rUrl);
        }
      }
      // Track date range
      if (msg.date > existing.latestDate) existing.latestDate = msg.date;
      if (msg.date < existing.earliestDate) existing.earliestDate = msg.date;
      // Accumulate content
      existing.plainTextContent += " " + msg.content;
    }
  }

  // Post-process: compute bidirectional flag
  for (const [, conv] of conversationMap) {
    conv.bidirectional = conv.jmMessageCount > 0 && conv.otherMessageCount > 0;
    // Sort messages by date ascending
    conv.messages.sort((a, b) => a.date.getTime() - b.date.getTime());
  }

  return { success: true, data: conversationMap };
}
