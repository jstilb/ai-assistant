/**
 * TelegramGateway.ts - Telegram implementation of KayaMobileGateway
 *
 * The central orchestrator for the Telegram mobile interface.
 * Implements the full message pipeline:
 *
 * 1. Receive message (text/voice/image) -> normalize to MobileMessage
 * 2. Load persistent session -> inject Kaya context
 * 3. Forward to `claude -p` with full context (subscription billing)
 * 4. Capture learning signals from the exchange
 * 5. Optionally generate TTS voice response
 * 6. Reply via Telegram
 *
 * Rate limiting: 60 messages/hour, 10 images/hour
 * Safety: authorized chat_id only, no destructive commands, no secret exposure
 */

import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type {
  MobileMessage,
  MobileResponse,
  ContextPayload,
  Exchange,
  Session,
  RateLimitState,
  RateLimitConfig,
  SessionExchange,
  KayaMobileGateway,
  ProcessedMedia,
  Notification,
} from "./KayaMobileGateway";
import {
  loadSession,
  saveSession,
  recordExchange,
  formatSessionContext,
} from "./SessionManager";
import { injectContext as injectContextFn, injectSimpleContext } from "./ContextInjector";
import { captureLearning as captureLearningFn } from "./LearningCapture";
import { generateVoiceResponse, extractVoiceLine } from "./VoiceResponder";
import { prepareMessage, MAX_MESSAGE_LENGTH } from "../../Tools/TelegramFormatting";
import type { TelegramSettings } from "../../Tools/TelegramConfig";
import { getTimezone } from "../../Tools/TelegramConfig";

const KAYA_HOME = process.env.HOME + "/.claude";

// ──────────────────────────────────────────────
// Rate Limiter
// ──────────────────────────────────────────────

const rateLimitState: RateLimitState = {
  messageTimestamps: [],
  imageTimestamps: [],
};

const RATE_LIMITS: RateLimitConfig = {
  messagesPerHour: 60,
  imagesPerHour: 10,
  windowMs: 60 * 60 * 1000,
};

function checkRateLimit(type: "message" | "image"): boolean {
  const now = Date.now();
  const windowStart = now - RATE_LIMITS.windowMs;

  if (type === "message") {
    rateLimitState.messageTimestamps = rateLimitState.messageTimestamps.filter(
      (t) => t > windowStart
    );
    if (rateLimitState.messageTimestamps.length >= RATE_LIMITS.messagesPerHour) {
      return false;
    }
    rateLimitState.messageTimestamps.push(now);
    return true;
  }

  rateLimitState.imageTimestamps = rateLimitState.imageTimestamps.filter(
    (t) => t > windowStart
  );
  if (rateLimitState.imageTimestamps.length >= RATE_LIMITS.imagesPerHour) {
    return false;
  }
  rateLimitState.imageTimestamps.push(now);
  return true;
}

// ──────────────────────────────────────────────
// Claude CLI Integration
// ──────────────────────────────────────────────

/**
 * Call Claude CLI with system prompt and message.
 * Uses subscription billing (no API key).
 */
async function callClaude(
  message: string,
  systemPrompt: string,
  model: string = "sonnet"
): Promise<{ text: string; latencyMs: number }> {
  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;

    const args = [
      "-p",
      "--model",
      model,
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
      reject(new Error("Claude CLI timeout after 45s"));
    }, 45000);

    proc.on("close", (code: number | null) => {
      clearTimeout(timeoutId);
      const latencyMs = Date.now() - startTime;

      if (code !== 0) {
        console.error("[TelegramGateway] Claude CLI stderr:", stderr);
        reject(new Error(`Claude CLI exited with code ${code}`));
        return;
      }

      const output = stdout.trim();
      if (!output) {
        reject(new Error("Empty response from Claude CLI"));
        return;
      }

      resolve({ text: output, latencyMs });
    });

    proc.on("error", (err: Error) => {
      clearTimeout(timeoutId);
      reject(err);
    });
  });
}

// ──────────────────────────────────────────────
// Gateway Pipeline Functions
// ──────────────────────────────────────────────

/**
 * Process a text message through the full gateway pipeline.
 *
 * Returns the response text to send back to Telegram.
 * Handles: session loading, context injection, Claude inference,
 * learning capture, and session persistence.
 */
export async function processTextMessage(
  messageText: string,
  chatId: string,
  messageId: string,
  settings: TelegramSettings
): Promise<{ responseText: string; voiceAudio?: Buffer }> {
  // Rate limit check
  if (!checkRateLimit("message")) {
    return {
      responseText:
        "Rate limit reached (60 messages/hour). Please wait a bit.",
    };
  }

  const startTime = Date.now();

  // Step 1: Normalize to MobileMessage
  const message: MobileMessage = {
    messageId: messageId.toString(),
    channelId: chatId,
    timestamp: new Date().toISOString(),
    type: "text",
    text: messageText,
    platform: "telegram",
  };

  // Step 2: Load session
  console.log("[TelegramGateway] Loading session...");
  const session = await loadSession(chatId);
  console.log(
    `[TelegramGateway] Session ${session.sessionId} (${session.exchangeCount} exchanges)`
  );

  // Step 3: Inject context
  console.log("[TelegramGateway] Injecting context...");
  const timezone = await getTimezone();
  let contextPayload: ContextPayload;

  try {
    contextPayload = await injectContextFn(message, session, settings, timezone);
    console.log(
      `[TelegramGateway] Context: profile=${contextPayload.profile}, confidence=${contextPayload.confidence.toFixed(2)}`
    );
  } catch (error) {
    console.error(
      "[TelegramGateway] Context injection failed, using simple context:",
      error
    );
    contextPayload = injectSimpleContext(session, settings, timezone);
  }

  // Update session profile
  session.currentProfile = contextPayload.profile;

  // Step 4: Call Claude
  console.log("[TelegramGateway] Calling Claude CLI...");
  const claudeResult = await callClaude(
    messageText,
    contextPayload.systemPrompt
  );
  console.log(
    `[TelegramGateway] Response: ${claudeResult.text.length} chars in ${claudeResult.latencyMs}ms`
  );

  // Step 5: Build response
  const voiceLine = extractVoiceLine(claudeResult.text);
  const response: MobileResponse = {
    text: claudeResult.text,
    voiceLine,
    truncated: claudeResult.text.length > MAX_MESSAGE_LENGTH,
    metadata: {
      model: "sonnet",
      latencyMs: claudeResult.latencyMs,
      sessionId: session.sessionId,
      profile: contextPayload.profile,
    },
  };

  // Step 6: Record exchange in session
  const exchange: SessionExchange = {
    timestamp: new Date().toISOString(),
    userText: messageText,
    assistantText: claudeResult.text,
    voiceLine,
    source: "text",
    profile: contextPayload.profile,
  };
  await recordExchange(session, exchange);

  // Step 7: Capture learning (non-blocking)
  const fullExchange: Exchange = {
    message,
    response,
    session,
  };
  captureLearningFn(fullExchange).catch((err) =>
    console.error("[TelegramGateway] Learning capture failed:", err)
  );

  // Step 8: Generate voice response (non-blocking, best-effort)
  let voiceAudio: Buffer | undefined;
  try {
    const voiceStart = Date.now();
    console.log("[TelegramGateway] Starting voice generation...");
    const voiceResult = await generateVoiceResponse(claudeResult.text);
    const voiceElapsed = Date.now() - voiceStart;
    if (voiceResult.success && voiceResult.audioBuffer) {
      voiceAudio = voiceResult.audioBuffer;
      console.log(`[TelegramGateway] Voice generated via ${voiceResult.engine} in ${voiceElapsed}ms (${voiceResult.audioBuffer.length} bytes)`);
    } else {
      console.log(`[TelegramGateway] Voice generation returned no audio in ${voiceElapsed}ms: ${voiceResult.error || "unknown reason"}`);
    }
  } catch (error) {
    console.error("[TelegramGateway] Voice generation failed with exception:", error instanceof Error ? error.message : String(error));
  }

  return {
    responseText: claudeResult.text,
    voiceAudio,
  };
}

/**
 * Process a voice message through the gateway pipeline.
 * Voice messages are transcribed first, then processed as text.
 */
export async function processVoiceMessage(
  transcription: string,
  chatId: string,
  messageId: string,
  settings: TelegramSettings
): Promise<{ responseText: string; voiceAudio?: Buffer }> {
  // Rate limit check
  if (!checkRateLimit("message")) {
    return {
      responseText:
        "Rate limit reached (60 messages/hour). Please wait a bit.",
    };
  }

  // Process through the same pipeline as text, but with voice source
  const message: MobileMessage = {
    messageId: messageId.toString(),
    channelId: chatId,
    timestamp: new Date().toISOString(),
    type: "voice",
    text: transcription,
    transcription,
    platform: "telegram",
  };

  const session = await loadSession(chatId);
  const timezone = await getTimezone();

  let contextPayload: ContextPayload;
  try {
    contextPayload = await injectContextFn(message, session, settings, timezone);
  } catch {
    contextPayload = injectSimpleContext(session, settings, timezone);
  }

  session.currentProfile = contextPayload.profile;

  const claudeResult = await callClaude(
    transcription,
    contextPayload.systemPrompt
  );

  const voiceLine = extractVoiceLine(claudeResult.text);

  const exchange: SessionExchange = {
    timestamp: new Date().toISOString(),
    userText: transcription,
    assistantText: claudeResult.text,
    voiceLine,
    source: "voice",
    profile: contextPayload.profile,
  };
  await recordExchange(session, exchange);

  // Learning capture (non-blocking)
  const response: MobileResponse = {
    text: claudeResult.text,
    voiceLine,
    truncated: claudeResult.text.length > MAX_MESSAGE_LENGTH,
    metadata: {
      model: "sonnet",
      latencyMs: claudeResult.latencyMs,
      sessionId: session.sessionId,
      profile: contextPayload.profile,
    },
  };

  captureLearningFn({
    message,
    response,
    session,
  }).catch((err) =>
    console.error("[TelegramGateway] Learning capture failed:", err)
  );

  // Voice response
  let voiceAudio: Buffer | undefined;
  try {
    const voiceResult = await generateVoiceResponse(claudeResult.text);
    if (voiceResult.success && voiceResult.audioBuffer) {
      voiceAudio = voiceResult.audioBuffer;
    }
  } catch {
    // Voice is best-effort
  }

  return { responseText: claudeResult.text, voiceAudio };
}

/**
 * Analyze an image using Gemini Vision API.
 * Returns a concise description of the image contents.
 */
async function analyzeImageWithGemini(
  imageBase64: string,
  mimeType: string,
  caption?: string
): Promise<string> {
  const secrets = await Bun.file(`${KAYA_HOME}/secrets.json`).json();
  const apiKey = secrets.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY not found in secrets.json");
  }

  let prompt = "Describe this image concisely for a mobile chat assistant. Focus on the most important visual elements.";
  if (caption) {
    prompt += ` The user's caption was: '${caption}'`;
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: prompt,
              },
              {
                inline_data: {
                  mime_type: mimeType,
                  data: imageBase64,
                },
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 1024,
        },
      }),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    console.error("[TelegramGateway] Gemini Vision API error:", error);
    throw new Error(`Gemini Vision API error: ${response.status}`);
  }

  const data = await response.json();
  const description = data.candidates?.[0]?.content?.parts?.[0]?.text || "";

  if (!description) {
    throw new Error("Could not analyze image");
  }

  return description.trim();
}

/**
 * Process an image message through the gateway pipeline.
 * Downloads image, encodes to base64, sends to Claude for vision analysis.
 */
export async function processImageMessage(
  imageBase64: string,
  mimeType: string,
  caption: string | undefined,
  chatId: string,
  messageId: string,
  settings: TelegramSettings
): Promise<{ responseText: string; voiceAudio?: Buffer }> {
  // Rate limit check for both message and image
  if (!checkRateLimit("message") || !checkRateLimit("image")) {
    return {
      responseText:
        "Rate limit reached. Please wait before sending more images.",
    };
  }

  const userPrompt = caption || "What do you see in this image?";

  const message: MobileMessage = {
    messageId: messageId.toString(),
    channelId: chatId,
    timestamp: new Date().toISOString(),
    type: "image",
    text: userPrompt,
    imageData: imageBase64,
    imageCaption: caption,
    mimeType,
    platform: "telegram",
  };

  const session = await loadSession(chatId);
  const timezone = await getTimezone();

  let contextPayload: ContextPayload;
  try {
    contextPayload = await injectContextFn(message, session, settings, timezone);
  } catch {
    contextPayload = injectSimpleContext(session, settings, timezone);
  }

  session.currentProfile = contextPayload.profile;

  // Analyze image with Gemini Vision, then pass description to Claude for Kaya-style response
  let claudePrompt: string;
  try {
    const visionDescription = await analyzeImageWithGemini(imageBase64, mimeType, caption);
    console.log(`[TelegramGateway] Vision analysis: ${visionDescription.substring(0, 80)}...`);
    claudePrompt = `The user sent an image. Vision analysis: "${visionDescription}"${caption ? ` User caption: "${caption}"` : ""}. Respond helpfully based on what's in the image.`;
  } catch (error) {
    console.error("[TelegramGateway] Gemini Vision failed:", error);
    claudePrompt = `The user sent an image that could not be analyzed${caption ? ` with caption: "${caption}"` : ""}. Acknowledge the image and respond based on any context available.`;
  }

  const claudeResult = await callClaude(
    claudePrompt,
    contextPayload.systemPrompt
  );

  const voiceLine = extractVoiceLine(claudeResult.text);

  const exchange: SessionExchange = {
    timestamp: new Date().toISOString(),
    userText: `[Image]${caption ? ` ${caption}` : ""}`,
    assistantText: claudeResult.text,
    voiceLine,
    source: "image",
    profile: contextPayload.profile,
  };
  await recordExchange(session, exchange);

  return { responseText: claudeResult.text };
}

/**
 * Split a long response into Telegram-compatible chunks.
 * Tries to split at paragraph boundaries.
 */
export function splitResponse(text: string): string[] {
  if (text.length <= MAX_MESSAGE_LENGTH) {
    return [prepareMessage(text)];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_MESSAGE_LENGTH) {
      chunks.push(prepareMessage(remaining));
      break;
    }

    // Try to split at paragraph boundary
    let splitPoint = remaining.lastIndexOf("\n\n", MAX_MESSAGE_LENGTH - 20);
    if (splitPoint < MAX_MESSAGE_LENGTH / 2) {
      // No good paragraph break, try newline
      splitPoint = remaining.lastIndexOf("\n", MAX_MESSAGE_LENGTH - 20);
    }
    if (splitPoint < MAX_MESSAGE_LENGTH / 2) {
      // No good newline, try sentence
      splitPoint = remaining.lastIndexOf(". ", MAX_MESSAGE_LENGTH - 20);
      if (splitPoint > 0) splitPoint += 1; // Include the period
    }
    if (splitPoint < MAX_MESSAGE_LENGTH / 2) {
      // Hard split
      splitPoint = MAX_MESSAGE_LENGTH - 20;
    }

    chunks.push(prepareMessage(remaining.substring(0, splitPoint)));
    remaining = remaining.substring(splitPoint).trimStart();
  }

  return chunks;
}

/**
 * Get gateway status for /status command enhancement
 */
export function getGatewayStatus(): {
  messagesThisHour: number;
  imagesThisHour: number;
  rateLimitRemaining: {
    messages: number;
    images: number;
  };
} {
  const now = Date.now();
  const windowStart = now - RATE_LIMITS.windowMs;

  const messagesThisHour = rateLimitState.messageTimestamps.filter(
    (t) => t > windowStart
  ).length;
  const imagesThisHour = rateLimitState.imageTimestamps.filter(
    (t) => t > windowStart
  ).length;

  return {
    messagesThisHour,
    imagesThisHour,
    rateLimitRemaining: {
      messages: RATE_LIMITS.messagesPerHour - messagesThisHour,
      images: RATE_LIMITS.imagesPerHour - imagesThisHour,
    },
  };
}

// ──────────────────────────────────────────────
// TelegramGatewayImpl - KayaMobileGateway interface
// ──────────────────────────────────────────────

/**
 * Class-based implementation of KayaMobileGateway for Telegram.
 * Delegates to the standalone functions above for backward compatibility.
 */
export class TelegramGatewayImpl implements KayaMobileGateway {
  private settings: TelegramSettings;

  constructor(settings: TelegramSettings) {
    this.settings = settings;
  }

  async receiveMessage(raw: unknown): Promise<MobileMessage> {
    const msg = raw as {
      messageId: string;
      channelId: string;
      type: string;
      text: string;
      transcription?: string;
      imageData?: string;
      imageCaption?: string;
      mimeType?: string;
    };
    return {
      messageId: msg.messageId,
      channelId: msg.channelId,
      timestamp: new Date().toISOString(),
      type: (msg.type as MobileMessage["type"]) || "text",
      text: msg.text || "",
      transcription: msg.transcription,
      imageData: msg.imageData,
      imageCaption: msg.imageCaption,
      mimeType: msg.mimeType,
      platform: "telegram",
    };
  }

  async sendResponse(channelId: string, response: MobileResponse): Promise<void> {
    const chunks = splitResponse(response.text);
    for (const chunk of chunks) {
      console.log(`[TelegramGatewayImpl] Sending chunk (${chunk.length} chars) to ${channelId}`);
    }
  }

  async handleMedia(message: MobileMessage): Promise<ProcessedMedia> {
    if (message.type === "image" && message.imageData && message.mimeType) {
      try {
        const description = await analyzeImageWithGemini(
          message.imageData,
          message.mimeType,
          message.imageCaption
        );
        return {
          text: description,
          type: "image_analysis",
          confidence: 0.85,
          originalSizeBytes: Math.ceil((message.imageData.length * 3) / 4),
        };
      } catch {
        return {
          text: "Image could not be analyzed",
          type: "image_analysis",
          confidence: 0,
          originalSizeBytes: 0,
        };
      }
    }

    return {
      text: message.transcription || message.text,
      type: message.type === "voice" ? "voice_transcription" : "audio_transcription",
      confidence: 0.9,
      originalSizeBytes: 0,
    };
  }

  async injectContext(message: MobileMessage, session: Session): Promise<ContextPayload> {
    const timezone = await getTimezone();
    try {
      return await injectContextFn(message, session, this.settings, timezone);
    } catch {
      return injectSimpleContext(session, this.settings, timezone);
    }
  }

  async captureLearning(exchange: Exchange): Promise<void> {
    await captureLearningFn(exchange);
  }

  async loadSession(channelId: string): Promise<Session> {
    return loadSession(channelId);
  }

  async saveSession(session: Session): Promise<void> {
    return saveSession(session);
  }

  async summarizeSession(session: Session): Promise<string> {
    return session.summary || "";
  }

  async notify(notification: Notification): Promise<void> {
    // Load bot token and chat_id from secrets.json
    const secretsPath = join(KAYA_HOME, "secrets.json");
    if (!existsSync(secretsPath)) {
      console.error("[TelegramGateway] Cannot notify: secrets.json not found");
      return;
    }
    const secrets = JSON.parse(readFileSync(secretsPath, "utf-8"));
    const botToken = secrets.TELEGRAM_BOT_TOKEN;
    const chatId = secrets.TELEGRAM_CHAT_ID;
    if (!botToken || !chatId) {
      console.error("[TelegramGateway] Cannot notify: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing");
      return;
    }

    // Format notification message
    const priorityEmoji = { low: "\u2139\uFE0F", normal: "\uD83D\uDCCB", high: "\uD83D\uDD14" }[notification.priority] || "\uD83D\uDCCB";
    const text = `${priorityEmoji} *${notification.title}*\n\n${notification.body}`;

    // Send via Telegram Bot API
    try {
      const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: "Markdown",
        }),
      });
      if (!response.ok) {
        console.error(`[TelegramGateway] Telegram API error: ${response.status}`);
      }
    } catch (error) {
      console.error("[TelegramGateway] Failed to send notification:", error);
    }

    // Generate voice if voiceLine present (best-effort)
    if (notification.voiceLine) {
      try {
        const voiceResult = await generateVoiceResponse(notification.voiceLine);
        if (voiceResult.success && voiceResult.audioBuffer) {
          console.log(`[TelegramGateway] Notification voice generated via ${voiceResult.engine}`);
        }
      } catch {
        // Voice is best-effort for notifications
      }
    }
  }
}

/**
 * Factory function to create a TelegramGateway instance.
 */
export function createTelegramGateway(settings: TelegramSettings): KayaMobileGateway {
  return new TelegramGatewayImpl(settings);
}
