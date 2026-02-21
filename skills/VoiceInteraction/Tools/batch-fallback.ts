#!/usr/bin/env bun
/**
 * @deprecated Use LocalTTSClient.ts instead.
 * Kept for rollback purposes until voice migration is confirmed stable (2+ weeks).
 * See: skills/VoiceInteraction/Tools/LocalTTSClient.ts
 *
 * batch-fallback.ts - Standard ElevenLabs REST API batch TTS
 *
 * Activated when streaming TTS fails or times out. Uses CachedHTTPClient
 * from VoiceCommon patterns for all HTTP calls (no raw fetch).
 *
 * This module is the reliability backstop: if WebSocket streaming cannot
 * deliver audio within the timeout window, batch mode guarantees the user
 * still hears a response.
 *
 * Usage (library):
 *   import { generateSpeechBatch } from "./batch-fallback.ts";
 *
 *   const audioBuffer = await generateSpeechBatch("Hello world");
 *   // audioBuffer is a Buffer containing MP3 audio
 *
 * @module batch-fallback
 * @version 1.0.0
 */

import { httpClient } from "../../CORE/Tools/CachedHTTPClient.ts";
import {
  getElevenLabsConfig,
  type ElevenLabsConfig,
} from "./VoiceCommon.ts";

// ============================================
// TYPES
// ============================================

/**
 * Result from batch TTS generation
 */
export interface BatchTTSResult {
  /** Audio data as Buffer */
  audio: Buffer;
  /** Size in bytes */
  size_bytes: number;
  /** Generation time in milliseconds */
  duration_ms: number;
  /** Output audio format */
  format: "mp3" | "ogg";
}

// ============================================
// INTERNAL HELPERS
// ============================================

/**
 * Build the ElevenLabs TTS request body.
 * Mirrors the pattern from VoiceResponseGenerator.
 */
function buildRequestBody(text: string, config: ElevenLabsConfig): string {
  return JSON.stringify({
    text,
    model_id: "eleven_turbo_v2_5",
    voice_settings: {
      stability: config.stability,
      similarity_boost: config.similarity_boost,
      style: config.style,
      use_speaker_boost: true,
    },
    ...(config.speed !== 1.0
      ? { generation_config: { speed: config.speed } }
      : {}),
  });
}

/**
 * Build common headers for ElevenLabs API calls.
 */
function buildHeaders(config: ElevenLabsConfig): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "xi-api-key": config.apiKey,
  };
}

/**
 * Validate that the ElevenLabs configuration has all required fields.
 * Throws descriptive errors if configuration is incomplete.
 */
function validateConfig(config: ElevenLabsConfig): void {
  if (!config.apiKey) {
    throw new Error(
      "ELEVENLABS_API_KEY not found in secrets.json. " +
      "Batch TTS requires a valid API key."
    );
  }
  if (!config.voiceId) {
    throw new Error(
      "Voice ID not configured in settings.json or secrets.json. " +
      "Batch TTS requires a voice ID."
    );
  }
}

// ============================================
// PUBLIC API
// ============================================

/**
 * Generate speech audio using the ElevenLabs batch REST API.
 *
 * Uses CachedHTTPClient for the HTTP call (no raw fetch).
 * This is the fallback path when streaming TTS fails or times out.
 *
 * @param text - The text to convert to speech
 * @param outputFormat - Audio format (default: mp3_44100_128)
 * @returns BatchTTSResult with audio Buffer and metadata
 * @throws Error if API key is missing, voice ID is missing, or API returns error
 */
export async function generateSpeechBatch(
  text: string,
  outputFormat: "mp3_44100_128" | "ogg_vorbis" = "mp3_44100_128"
): Promise<BatchTTSResult> {
  const config = getElevenLabsConfig();
  validateConfig(config);

  const startTime = Date.now();

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${config.voiceId}?output_format=${outputFormat}`;

  const response = await httpClient.fetch(url, {
    cache: "none",
    headers: buildHeaders(config),
    retry: 2,
    timeout: 30000,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `ElevenLabs batch TTS API error (${response.status}): ${errorBody}`
    );
  }

  const audioBuffer = Buffer.from(await response.arrayBuffer());
  const format = outputFormat === "ogg_vorbis" ? "ogg" : "mp3";

  return {
    audio: audioBuffer,
    size_bytes: audioBuffer.length,
    duration_ms: Date.now() - startTime,
    format,
  };
}

/**
 * Generate speech and return raw audio Buffer.
 * Simplified interface for the most common use case.
 *
 * @param text - Text to convert to speech
 * @returns Buffer containing MP3 audio
 */
export async function batchTTS(text: string): Promise<Buffer> {
  const result = await generateSpeechBatch(text);
  return result.audio;
}
