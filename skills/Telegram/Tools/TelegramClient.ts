#!/usr/bin/env bun
/**
 * TelegramClient.ts - Telegram Bot API client for Kaya notifications
 *
 * Commands:
 *   send <message>                 - Send text message
 *   send-voice <path>              - Send voice message (OGG)
 *   send-photo <path> [caption]    - Send image with optional caption
 *   send-document <path> [caption] - Send file with optional caption
 *   get-chat-id                    - Get your chat ID (message bot first)
 *
 * Usage:
 *   bun TelegramClient.ts send "Hello from Kaya!"
 *   bun TelegramClient.ts send-voice ./response.ogg
 *   bun TelegramClient.ts send-photo ./screenshot.png "Check this out"
 *   bun TelegramClient.ts get-chat-id
 */

import { loadTelegramSecrets } from "./TelegramConfig";
import { buildSendMessageParams } from "./TelegramFormatting";

interface TelegramResponse {
  ok: boolean;
  result?: any;
  description?: string;
}

async function apiCall(
  token: string,
  method: string,
  params: Record<string, any> = {}
): Promise<TelegramResponse> {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  return response.json();
}

async function sendMessage(message: string): Promise<void> {
  const config = await loadTelegramSecrets({ requireChatId: true });

  const result = await apiCall(
    config.bot_token,
    "sendMessage",
    buildSendMessageParams(config.chat_id, message)
  );

  if (result.ok) {
    console.log("Message sent successfully");
  } else {
    console.error("Failed to send message:", result.description);
    process.exit(1);
  }
}

async function sendPhoto(path: string, caption?: string): Promise<void> {
  const config = await loadTelegramSecrets({ requireChatId: true });

  const file = Bun.file(path);
  if (!(await file.exists())) {
    console.error(`File not found: ${path}`);
    process.exit(1);
  }

  const formData = new FormData();
  formData.append("chat_id", config.chat_id);
  formData.append("photo", file);
  if (caption) formData.append("caption", caption);

  const url = `https://api.telegram.org/bot${config.bot_token}/sendPhoto`;
  const response = await fetch(url, { method: "POST", body: formData });
  const result: TelegramResponse = await response.json();

  if (result.ok) {
    console.log("Photo sent successfully");
  } else {
    console.error("Failed to send photo:", result.description);
    process.exit(1);
  }
}

async function sendVoice(path: string): Promise<void> {
  const config = await loadTelegramSecrets({ requireChatId: true });

  const file = Bun.file(path);
  if (!(await file.exists())) {
    console.error(`File not found: ${path}`);
    process.exit(1);
  }

  const formData = new FormData();
  formData.append("chat_id", config.chat_id);
  formData.append("voice", file);

  const url = `https://api.telegram.org/bot${config.bot_token}/sendVoice`;
  const response = await fetch(url, { method: "POST", body: formData });
  const result: TelegramResponse = await response.json();

  if (result.ok) {
    console.log("Voice message sent successfully");
  } else {
    console.error("Failed to send voice message:", result.description);
    process.exit(1);
  }
}

/**
 * Send a voice message from a buffer (for programmatic use)
 */
export async function sendVoiceBuffer(
  audioBuffer: Buffer,
  chatId: string,
  botToken: string
): Promise<boolean> {
  const blob = new Blob([audioBuffer], { type: "audio/ogg" });

  const formData = new FormData();
  formData.append("chat_id", chatId);
  formData.append("voice", blob, "response.ogg");

  const url = `https://api.telegram.org/bot${botToken}/sendVoice`;
  const response = await fetch(url, { method: "POST", body: formData });
  const result: TelegramResponse = await response.json();

  return result.ok;
}

async function sendDocument(path: string, caption?: string): Promise<void> {
  const config = await loadTelegramSecrets({ requireChatId: true });

  const file = Bun.file(path);
  if (!(await file.exists())) {
    console.error(`File not found: ${path}`);
    process.exit(1);
  }

  const formData = new FormData();
  formData.append("chat_id", config.chat_id);
  formData.append("document", file);
  if (caption) formData.append("caption", caption);

  const url = `https://api.telegram.org/bot${config.bot_token}/sendDocument`;
  const response = await fetch(url, { method: "POST", body: formData });
  const result: TelegramResponse = await response.json();

  if (result.ok) {
    console.log("Document sent successfully");
  } else {
    console.error("Failed to send document:", result.description);
    process.exit(1);
  }
}

async function getChatId(): Promise<void> {
  const config = await loadTelegramSecrets();

  console.log("Fetching updates from Telegram...");
  console.log("(Make sure you've messaged your bot first!)");
  console.log();

  const result = await apiCall(config.bot_token, "getUpdates", { limit: 10 });

  if (!result.ok) {
    console.error("Failed to get updates:", result.description);
    process.exit(1);
  }

  if (!result.result || result.result.length === 0) {
    console.error("No messages found.");
    console.error("Please message your bot on Telegram first, then run this again.");
    process.exit(1);
  }

  const chatIds = new Set<string>();
  for (const update of result.result) {
    const chat = update.message?.chat;
    if (chat) {
      chatIds.add(chat.id);
      console.log(`Found chat:`);
      console.log(`  ID: ${chat.id}`);
      console.log(`  Type: ${chat.type}`);
      if (chat.first_name) console.log(`  Name: ${chat.first_name} ${chat.last_name || ""}`);
      if (chat.username) console.log(`  Username: @${chat.username}`);
      console.log();
    }
  }

  if (chatIds.size > 0) {
    const chatId = Array.from(chatIds)[0];
    console.log("Add this to your secrets.json:");
    console.log(`  "telegram": {`);
    console.log(`    "bot_token": "${config.bot_token}",`);
    console.log(`    "chat_id": "${chatId}"`);
    console.log(`  }`);
  }
}

function printUsage(): void {
  console.log("TelegramClient - Telegram Bot API client for Kaya");
  console.log();
  console.log("Usage:");
  console.log('  bun TelegramClient.ts send <message>                 - Send text message');
  console.log('  bun TelegramClient.ts send-voice <path>              - Send voice (OGG)');
  console.log('  bun TelegramClient.ts send-photo <path> [caption]    - Send image');
  console.log('  bun TelegramClient.ts send-document <path> [caption] - Send file');
  console.log('  bun TelegramClient.ts get-chat-id                    - Get your chat ID');
  console.log();
  console.log("Examples:");
  console.log('  bun TelegramClient.ts send "Hello from Kaya!"');
  console.log('  bun TelegramClient.ts send-voice ./response.ogg');
  console.log('  bun TelegramClient.ts send-photo ./screenshot.png "Screenshot"');
  console.log("  bun TelegramClient.ts get-chat-id");
}

// Main
const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case "send":
    if (!args[1]) {
      console.error("Error: Message required");
      console.error('Usage: bun TelegramClient.ts send "Your message"');
      process.exit(1);
    }
    await sendMessage(args.slice(1).join(" "));
    break;

  case "send-voice":
    if (!args[1]) {
      console.error("Error: Voice file path required");
      process.exit(1);
    }
    await sendVoice(args[1]);
    break;

  case "send-photo":
    if (!args[1]) {
      console.error("Error: Photo path required");
      process.exit(1);
    }
    await sendPhoto(args[1], args.slice(2).join(" ") || undefined);
    break;

  case "send-document":
    if (!args[1]) {
      console.error("Error: Document path required");
      process.exit(1);
    }
    await sendDocument(args[1], args.slice(2).join(" ") || undefined);
    break;

  case "get-chat-id":
    await getChatId();
    break;

  default:
    printUsage();
    if (command) {
      console.error(`\nUnknown command: ${command}`);
      process.exit(1);
    }
}
