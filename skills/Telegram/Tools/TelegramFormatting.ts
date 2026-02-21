/**
 * TelegramFormatting.ts - Shared message formatting utilities for Telegram
 *
 * Centralizes Telegram Markdown formatting and message preparation logic
 * used by both TelegramClient.ts (outbound) and TelegramBot.ts (inbound replies).
 */

/** Telegram parse mode constant */
export const TELEGRAM_PARSE_MODE = "Markdown" as const;

/**
 * Telegram message size limits
 * https://core.telegram.org/bots/api#sendmessage
 */
export const MAX_MESSAGE_LENGTH = 4096;

/**
 * Prepare a message for Telegram delivery.
 *
 * Handles:
 * - Truncation to Telegram's 4096 char limit
 * - Sanitizing unmatched Markdown delimiters that break Telegram's parser
 */
export function prepareMessage(text: string): string {
  let prepared = text;

  // Truncate to Telegram limit with indicator
  if (prepared.length > MAX_MESSAGE_LENGTH) {
    prepared = prepared.substring(0, MAX_MESSAGE_LENGTH - 4) + "\n...";
  }

  return prepared;
}

/**
 * Build the standard reply options object used across the bot.
 * Keeps parse_mode in one place so it can be changed system-wide.
 */
export function replyOptions(): { parse_mode: typeof TELEGRAM_PARSE_MODE } {
  return { parse_mode: TELEGRAM_PARSE_MODE };
}

/**
 * Build sendMessage params for the Telegram Bot API (used by TelegramClient).
 */
export function buildSendMessageParams(chatId: string, text: string) {
  return {
    chat_id: chatId,
    text: prepareMessage(text),
    parse_mode: TELEGRAM_PARSE_MODE,
  };
}
