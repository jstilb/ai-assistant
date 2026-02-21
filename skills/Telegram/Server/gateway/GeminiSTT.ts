/**
 * GeminiSTT.ts - Shared Gemini Speech-to-Text utility
 *
 * Extracted from handlers/voice.ts for use by both Telegram and Relay gateways.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const KAYA_HOME = process.env.HOME + "/.claude";

/**
 * Transcribe audio using Gemini API.
 * Supports OGG, WAV, and other common audio formats.
 */
export async function transcribeAudio(
  audioBuffer: Buffer,
  mimeType: string = "audio/ogg"
): Promise<string> {
  const secretsPath = join(KAYA_HOME, "secrets.json");
  if (!existsSync(secretsPath)) {
    throw new Error("secrets.json not found");
  }

  const secrets = JSON.parse(readFileSync(secretsPath, "utf-8"));
  const apiKey = secrets.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY not found in secrets.json");
  }

  const base64Audio = audioBuffer.toString("base64");

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [
            {
              text: "Transcribe this audio message exactly. Return ONLY the transcription, no commentary or formatting. If the audio is unclear, do your best to transcribe what you can hear.",
            },
            {
              inline_data: {
                mime_type: mimeType,
                data: base64Audio,
              },
            },
          ],
        }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 1024,
        },
      }),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    console.error("[GeminiSTT] API error:", error);
    throw new Error(`Gemini API error: ${response.status}`);
  }

  const data = await response.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const transcription = data.candidates?.[0]?.content?.parts?.[0]?.text || "";

  if (!transcription) {
    throw new Error("Could not transcribe audio");
  }

  return transcription.trim();
}
