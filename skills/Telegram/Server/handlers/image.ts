/**
 * Image message handler - downloads images, forwards to gateway for analysis
 *
 * Handles:
 * - Photo messages (compressed by Telegram)
 * - Document images (full resolution)
 * - Captions as additional context
 * - Large image handling (>5MB compression)
 *
 * Phase 1: Downloads image, passes caption to Claude via gateway.
 * Phase 2: Will add direct vision analysis via base64 encoding.
 */

import type { Context } from "telegraf";
import {
  loadTelegramSecrets,
  type TelegramSettings,
} from "../../Tools/TelegramConfig";
import { processImageMessage } from "../gateway/TelegramGateway";

const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

interface PhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

/**
 * Download a file from Telegram and return as base64
 */
async function downloadTelegramFile(
  ctx: Context,
  fileId: string
): Promise<{ base64: string; mimeType: string; sizeBytes: number }> {
  const file = await ctx.telegram.getFile(fileId);
  const filePath = file.file_path;

  if (!filePath) {
    throw new Error("Could not get file path from Telegram");
  }

  const telegramSecrets = await loadTelegramSecrets();
  const botToken = telegramSecrets.bot_token;
  const fileUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;

  const response = await fetch(fileUrl);
  if (!response.ok) {
    throw new Error(`Failed to download file: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // Detect MIME type from file path
  let mimeType = "image/jpeg";
  if (filePath.endsWith(".png")) mimeType = "image/png";
  else if (filePath.endsWith(".gif")) mimeType = "image/gif";
  else if (filePath.endsWith(".webp")) mimeType = "image/webp";

  return {
    base64: buffer.toString("base64"),
    mimeType,
    sizeBytes: buffer.length,
  };
}

/**
 * Select the best photo size (largest under 5MB, or largest available)
 */
function selectBestPhoto(photos: PhotoSize[]): PhotoSize {
  // Photos are sorted smallest to largest by Telegram
  // Pick the largest one under the size limit
  const candidates = photos.filter(
    (p) => !p.file_size || p.file_size <= MAX_IMAGE_SIZE_BYTES
  );

  if (candidates.length > 0) {
    return candidates[candidates.length - 1]; // Largest under limit
  }

  // All are too large - take the smallest
  return photos[0];
}

/**
 * Handle incoming photo message
 */
export async function handlePhotoMessage(
  ctx: Context,
  settings: TelegramSettings
): Promise<string> {
  const message = ctx.message as {
    photo?: PhotoSize[];
    caption?: string;
    message_id: number;
  };

  if (!message.photo || message.photo.length === 0) {
    return "I couldn't find a photo in your message.";
  }

  const chatId = ctx.chat?.id?.toString() ?? "";
  const messageId = message.message_id?.toString() ?? "";
  const caption = message.caption;

  try {
    // Select best photo resolution
    const photo = selectBestPhoto(message.photo);
    console.log(
      `[ImageHandler] Selected photo: ${photo.width}x${photo.height}, ~${photo.file_size ?? "unknown"} bytes`
    );

    // Download and encode
    console.log("[ImageHandler] Downloading image...");
    const { base64, mimeType, sizeBytes } = await downloadTelegramFile(
      ctx,
      photo.file_id
    );
    console.log(
      `[ImageHandler] Downloaded ${sizeBytes} bytes (${mimeType})`
    );

    // Process through gateway
    const result = await processImageMessage(
      base64,
      mimeType,
      caption,
      chatId,
      messageId,
      settings
    );

    return result.responseText;
  } catch (error) {
    console.error("[ImageHandler] Error:", error);
    throw error;
  }
}
