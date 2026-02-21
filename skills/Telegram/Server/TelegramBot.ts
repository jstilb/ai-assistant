#!/usr/bin/env bun
/**
 * TelegramBot.ts - Kaya Mobile Gateway (Telegram)
 *
 * Features:
 * - Persistent multi-day sessions with summarization
 * - Full Kaya context injection via ContextManager
 * - Text, voice, and image message handling
 * - Learning signal capture from mobile interactions
 * - Voice response scaffolding (TTS)
 * - Rate limiting and safety guardrails
 * - Long polling (no public URL needed)
 *
 * Usage:
 *   bun TelegramBot.ts                    - Start bot
 *   ./bin/telegram-bot start              - Start via CLI wrapper
 *   ./bin/telegram-bot stop               - Stop bot
 *   ./bin/telegram-bot status             - Check status
 */

import { Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import { handleTextMessage } from "./handlers/text";
import { handleVoiceMessage } from "./handlers/voice";
import { handlePhotoMessage } from "./handlers/image";
import {
  loadTelegramSecrets,
  loadTelegramSettings,
} from "../Tools/TelegramConfig";
import { replyOptions } from "../Tools/TelegramFormatting";
import { sendVoiceBuffer } from "../Tools/TelegramClient";
import { splitResponse, getGatewayStatus } from "./gateway/TelegramGateway";
import { getSessionStats } from "./gateway/SessionManager";
import { sanitizeOutput } from "./gateway/Sanitizer";

// Bun makes Error.message readonly, which crashes Telegraf's redactToken().
// Monkey-patch before any Telegraf API calls to prevent fatal TypeError.
const origRedactToken = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const client = require("telegraf/lib/core/network/client");
    return null; // module loaded but we patch at the prototype level below
  } catch {
    return null;
  }
})();

// Catch the specific "Attempted to assign to readonly property" crash
process.on("uncaughtException", (err) => {
  if (
    err instanceof TypeError &&
    err.message.includes("Attempted to assign to readonly property")
  ) {
    // Swallow the Telegraf redactToken crash — the bot continues via KeepAlive
    console.warn("[Bot] Caught Telegraf redactToken readonly error (Bun compat), continuing...");
    return;
  }
  console.error("Fatal uncaught exception:", err);
  process.exit(1);
});

async function main() {
  console.log("Starting Kaya Mobile Gateway (Telegram)...");

  const config = await loadTelegramSecrets({ requireChatId: true });
  const settings = await loadTelegramSettings();

  const bot = new Telegraf(config.bot_token);

  // Global error handler — prevents unhandled rejections from crashing the bot
  bot.catch((err: unknown) => {
    console.error("[Bot] Caught error:", err);
  });

  // Security: Only respond to authorized chat
  const authorizedChatId = config.chat_id;

  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id?.toString();
    if (chatId !== authorizedChatId) {
      console.log(`Unauthorized message from chat ${chatId}`);
      return;
    }
    return next();
  });

  // Handle text messages (full gateway pipeline)
  // NOTE: Must skip commands (start with /) so bot.command() handlers below can fire
  bot.on(message("text"), async (ctx, next) => {
    const userMessage = ctx.message.text;

    // Let bot.command() handlers handle slash commands
    if (userMessage.startsWith("/")) {
      return next();
    }

    const chatId = ctx.chat.id.toString();
    const messageId = ctx.message.message_id.toString();

    console.log(`Received text: "${userMessage.substring(0, 50)}..."`);

    try {
      const result = await handleTextMessage(
        userMessage,
        settings,
        "text",
        chatId,
        messageId
      );

      // Split long responses for Telegram
      const chunks = splitResponse(result.text);
      for (const chunk of chunks) {
        await ctx.reply(sanitizeOutput(chunk), replyOptions());
      }

      // Send voice response if available
      if (result.voiceAudio) {
        try {
          await sendVoiceBuffer(
            result.voiceAudio,
            chatId,
            config.bot_token
          );
          console.log("Sent voice response");
        } catch (voiceError) {
          console.error("Failed to send voice:", voiceError);
        }
      }

      console.log("Replied to text message");
    } catch (error) {
      console.error("Error handling text:", error);
      await ctx.reply("Sorry, I encountered an error processing your message.");
    }
  });

  // Handle voice messages
  bot.on(message("voice"), async (ctx) => {
    console.log("Received voice message");

    try {
      await ctx.sendChatAction("typing");

      const result = await handleVoiceMessage(ctx, settings);

      // Split long responses
      const chunks = splitResponse(result.text);
      for (const chunk of chunks) {
        await ctx.reply(sanitizeOutput(chunk), replyOptions());
      }

      // Send voice response if available
      if (result.voiceAudio) {
        try {
          await sendVoiceBuffer(
            result.voiceAudio,
            ctx.chat.id.toString(),
            config.bot_token
          );
        } catch {
          // Voice is best-effort
        }
      }

      console.log("Replied to voice message");
    } catch (error) {
      console.error("Error handling voice:", error);
      await ctx.reply("Sorry, I couldn't process your voice message.");
    }
  });

  // Handle audio files
  bot.on(message("audio"), async (ctx) => {
    console.log("Received audio file");

    try {
      await ctx.sendChatAction("typing");
      const result = await handleVoiceMessage(ctx, settings, true);

      const chunks = splitResponse(result.text);
      for (const chunk of chunks) {
        await ctx.reply(sanitizeOutput(chunk), replyOptions());
      }

      console.log("Replied to audio message");
    } catch (error) {
      console.error("Error handling audio:", error);
      await ctx.reply("Sorry, I couldn't process your audio file.");
    }
  });

  // Handle photo messages (NEW: image support)
  bot.on(message("photo"), async (ctx) => {
    console.log("Received photo");

    try {
      await ctx.sendChatAction("typing");
      const response = await handlePhotoMessage(ctx, settings);

      const chunks = splitResponse(response);
      for (const chunk of chunks) {
        await ctx.reply(sanitizeOutput(chunk), replyOptions());
      }

      console.log("Replied to photo message");
    } catch (error) {
      console.error("Error handling photo:", error);
      await ctx.reply("Sorry, I couldn't process your image.");
    }
  });

  // Start command
  bot.command("start", async (ctx) => {
    const name = settings.daidentity?.name || "Kaya";
    await ctx.reply(
      `Hi ${settings.principal?.name || "there"}! I'm ${name}, your AI assistant.\n\n` +
        `Send me a message, voice note, or image and I'll respond.\n\n` +
        `I now have persistent memory across our conversations.`
    );
  });

  // Help command
  bot.command("help", async (ctx) => {
    await ctx.reply(
      `*Available Commands*\n\n` +
        `/start - Welcome message\n` +
        `/help - Show this help\n` +
        `/status - Bot status and session info\n` +
        `/session - Current session details\n` +
        `/voice - Open real-time voice chat\n\n` +
        `You can send text, voice, or images!`,
      replyOptions()
    );
  });

  // Status command (enhanced with gateway info)
  bot.command("status", async (ctx) => {
    const uptime = process.uptime();
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);

    const gatewayStatus = getGatewayStatus();
    const chatId = ctx.chat?.id?.toString() ?? "";
    const sessionStats = await getSessionStats(chatId);

    await ctx.reply(
      `*Bot Status*\n\n` +
        `Online\n` +
        `Uptime: ${hours}h ${minutes}m ${seconds}s\n` +
        `Model: Claude (Sonnet)\n` +
        `STT: Gemini\n` +
        `Gateway: Active\n\n` +
        `*Session*\n` +
        `Sessions: ${sessionStats.totalSessions}\n` +
        `Current exchanges: ${sessionStats.currentSessionExchanges}\n` +
        `Has summary: ${sessionStats.hasSummary ? "Yes" : "No"}\n\n` +
        `*Rate Limits*\n` +
        `Messages: ${gatewayStatus.rateLimitRemaining.messages}/60 remaining\n` +
        `Images: ${gatewayStatus.rateLimitRemaining.images}/10 remaining`,
      replyOptions()
    );
  });

  // Session command (new)
  bot.command("session", async (ctx) => {
    const chatId = ctx.chat?.id?.toString() ?? "";
    const sessionStats = await getSessionStats(chatId);

    await ctx.reply(
      `*Session Info*\n\n` +
        `Total sessions: ${sessionStats.totalSessions}\n` +
        `Current session exchanges: ${sessionStats.currentSessionExchanges}\n` +
        `Summary available: ${sessionStats.hasSummary ? "Yes" : "No"}\n\n` +
        `_Sessions auto-segment after 6h idle. History is never lost._`,
      replyOptions()
    );
  });

  // Voice Mini App command — opens the real-time voice UI
  // Mini App URL: use env var or default to Cloudflare Tunnel public URL
  const voiceServerUrl = process.env.VOICE_SERVER_URL || "https://voice.kayaai.dev";
  bot.command("voice", async (ctx) => {
    await ctx.reply(
      "Start a real-time voice conversation with Kaya:",
      {
        reply_markup: {
          inline_keyboard: [[
            {
              text: "Voice Chat",
              web_app: { url: voiceServerUrl },
            },
          ]],
        },
      }
    );
  });
  console.log(`Voice command registered (URL: ${voiceServerUrl})`);

  // Register LucidTasks commands (/tasks, /next, /done, /add) if available
  try {
    const { registerTaskCommands } = await import("./handlers/tasks");
    registerTaskCommands(bot);
    console.log("LucidTasks commands registered");
  } catch {
    console.log("LucidTasks commands not available (tasks handler missing)");
  }

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.log("\nShutting down bot...");
    bot.stop("SIGINT");
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    console.log("\nShutting down bot...");
    bot.stop("SIGTERM");
    process.exit(0);
  });

  // Start polling
  console.log(`Bot started for chat ${authorizedChatId}`);
  console.log(`Principal: ${settings.principal?.name || "Unknown"}`);
  console.log(`AI: ${settings.daidentity?.name || "Kaya"}`);
  console.log(`Gateway: Active (sessions, context, learning)`);
  console.log(`Listening for messages...`);

  await bot.launch();
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
