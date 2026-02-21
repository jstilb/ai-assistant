/**
 * Voice message handler - transcribes voice via Gemini, responds via gateway
 *
 * Pipeline:
 * 1. Download OGG audio from Telegram
 * 2. Transcribe via Gemini API
 * 3. Process through gateway pipeline (session, context, Claude, learning)
 * 4. Optionally send TTS voice response back
 */

import type { Context } from "telegraf";
import { handleTextMessage } from "./text";
import {
  loadTelegramSecrets,
  type TelegramSettings,
} from "../../Tools/TelegramConfig";
import { sanitizeInput } from "../gateway/Sanitizer";
import { transcribeAudio } from "../gateway/GeminiSTT";

/**
 * Download file from Telegram
 */
async function downloadTelegramFile(
  ctx: Context,
  fileId: string
): Promise<Buffer> {
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

  return Buffer.from(await response.arrayBuffer());
}

/**
 * Handle incoming voice message.
 *
 * Returns both text response and optionally a voice audio buffer
 * for TTS playback in Telegram.
 */
export async function handleVoiceMessage(
  ctx: Context,
  settings: TelegramSettings,
  isAudio: boolean = false
): Promise<{ text: string; voiceAudio?: Buffer }> {
  try {
    const message = ctx.message as Record<string, unknown>;
    const fileId = isAudio
      ? (message.audio as Record<string, string>)?.file_id
      : (message.voice as Record<string, string>)?.file_id;

    if (!fileId) {
      return { text: "I couldn't find the audio file in your message." };
    }

    const chatId = ctx.chat?.id?.toString() ?? "";
    const messageId = (message.message_id as number)?.toString() ?? "";

    console.log(`[VoiceHandler] Downloading ${isAudio ? "audio" : "voice"} file...`);
    const audioBuffer = await downloadTelegramFile(ctx, fileId);
    console.log(`[VoiceHandler] Downloaded ${audioBuffer.length} bytes`);

    console.log("[VoiceHandler] Transcribing with Gemini...");
    const transcription = await transcribeAudio(audioBuffer);
    console.log(
      `[VoiceHandler] Transcription: "${transcription.substring(0, 50)}..."`
    );

    // Process through gateway pipeline
    console.log("[VoiceHandler] Processing through gateway...");
    const result = await handleTextMessage(
      sanitizeInput(transcription),
      settings,
      "voice",
      chatId,
      messageId
    );

    // Include transcription in response for transparency
    const userName = settings.principal?.name || "You";
    const fullText = `*${userName} said:* "${transcription}"\n\n${result.text}`;

    return {
      text: fullText,
      voiceAudio: result.voiceAudio,
    };
  } catch (error) {
    console.error("[VoiceHandler] Error:", error);
    throw error;
  }
}
