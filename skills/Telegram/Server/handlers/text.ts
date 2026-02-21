/**
 * Text message handler - processes text messages via Mobile Gateway
 *
 * Uses the full gateway pipeline:
 * 1. Persistent session management
 * 2. Context injection via ContextManager
 * 3. Claude CLI inference (subscription billing)
 * 4. Learning signal capture
 * 5. Optional TTS voice response
 *
 * Falls back to direct Claude CLI on gateway errors.
 */

import { spawn } from "child_process";
import { loadContext, logExchange } from "../memory";
import {
  getTimezone,
  type TelegramSettings,
} from "../../Tools/TelegramConfig";
import { processTextMessage } from "../gateway/TelegramGateway";
import { sanitizeInput } from "../gateway/Sanitizer";

/**
 * Build system prompt (fallback - used only when gateway fails)
 */
function buildSystemPrompt(
  settings: TelegramSettings,
  conversationContext: string,
  timezone: string
): string {
  const aiName = settings.daidentity?.name || "Kaya";
  const userName = settings.principal?.name || "the user";

  let prompt = `You are ${aiName}, a personal AI assistant communicating via Telegram.

Key context:
- You are talking to ${userName} via mobile Telegram
- Keep responses concise and mobile-friendly (under 500 chars when possible)
- Use Markdown formatting sparingly (Telegram supports basic markdown)
- Be helpful, warm, and efficient
- If ${userName} asks about complex tasks, acknowledge you'll handle them in the full Claude Code session
- You have memory of our conversation - use context when relevant but don't force references

Current time: ${new Date().toLocaleString("en-US", { timeZone: timezone })}`;

  if (conversationContext.trim()) {
    prompt += `\n\n--- CONVERSATION HISTORY ---\n${conversationContext}\n--- END HISTORY ---`;
  }

  prompt += `\n\nRespond naturally and helpfully to ${userName}'s message.`;

  return prompt;
}

/**
 * Call Claude CLI directly (fallback path)
 */
async function callClaudeDirect(
  message: string,
  settings: TelegramSettings,
  conversationContext: string,
  timezone: string
): Promise<string> {
  const systemPrompt = buildSystemPrompt(
    settings,
    conversationContext,
    timezone
  );

  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;

    const args = [
      "-p",
      "--model",
      "sonnet",
      "--tools",
      "",
      "--output-format",
      "text",
      "--setting-sources",
      "",
      "--system-prompt",
      systemPrompt,
      message,
    ];

    let stdout = "";
    let stderr = "";

    const proc = spawn("claude", args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    const timeoutId = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error("Claude CLI timeout after 30s"));
    }, 30000);

    proc.on("close", (code: number | null) => {
      clearTimeout(timeoutId);

      if (code !== 0) {
        console.error("Claude CLI stderr:", stderr);
        reject(new Error(`Claude CLI exited with code ${code}`));
        return;
      }

      const output = stdout.trim();
      if (!output) {
        reject(new Error("Empty response from Claude CLI"));
        return;
      }

      resolve(output);
    });

    proc.on("error", (err: Error) => {
      clearTimeout(timeoutId);
      reject(err);
    });
  });
}

/**
 * Handle incoming text message.
 *
 * Primary path: Full gateway pipeline (sessions, context, learning)
 * Fallback path: Direct Claude CLI (if gateway fails)
 */
export async function handleTextMessage(
  message: string,
  settings: TelegramSettings,
  source: "text" | "voice" = "text",
  chatId?: string,
  messageId?: string
): Promise<{ text: string; voiceAudio?: Buffer }> {
  // If we have chatId, use the full gateway pipeline
  if (chatId && messageId) {
    try {
      console.log("[TextHandler] Using gateway pipeline...");
      const result = await processTextMessage(
        sanitizeInput(message),
        chatId,
        messageId,
        settings
      );
      return { text: result.responseText, voiceAudio: result.voiceAudio };
    } catch (error) {
      console.error(
        "[TextHandler] Gateway failed, falling back to direct:",
        error
      );
    }
  }

  // Fallback: direct Claude CLI (backward compatible)
  try {
    console.log("[TextHandler] Using direct Claude CLI (fallback)...");
    const [conversationContext, timezone] = await Promise.all([
      loadContext(),
      getTimezone(),
    ]);

    const response = await callClaudeDirect(
      sanitizeInput(message),
      settings,
      conversationContext,
      timezone
    );

    // Log exchange for legacy memory system
    await logExchange(message, response, source);

    return { text: response };
  } catch (error) {
    console.error("[TextHandler] Error:", error);
    throw error;
  }
}
