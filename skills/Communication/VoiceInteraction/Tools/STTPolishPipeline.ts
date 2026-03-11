#!/usr/bin/env bun
/**
 * STTPolishPipeline.ts - STT output polish with self-learning capability
 *
 * Cleans up raw Whisper transcriptions using a fallback chain:
 *   1. Fine-tuned dictation model (dictation:latest via Ollama) -- best quality
 *   2. Base Ollama model (qwen2.5:1.5b) -- reliable fallback
 *   3. Claude API (cloud fallback when Ollama is unreachable)
 *   4. Raw text (passthrough, no polish)
 *
 * Validates polish quality via word overlap check to prevent hallucination.
 * Saves accepted raw/polished pairs to ~/.claude/data/pairs.jsonl for
 * nightly LoRA fine-tuning (Phase 6 training pipeline).
 *
 * Uses CachedHTTPClient for all HTTP calls per Kaya conventions.
 * Uses StateManager for stats persistence.
 *
 * Usage:
 *   bun STTPolishPipeline.ts polish "hello world how are you"
 *   bun STTPolishPipeline.ts stats
 *   bun STTPolishPipeline.ts enable
 *   bun STTPolishPipeline.ts disable
 */

import { z } from "zod";
import { createStateManager, type StateManager } from "../../../../lib/core/StateManager.ts";
import { httpClient } from "../../../../lib/core/CachedHTTPClient.ts";

// ============================================
// CONSTANTS
// ============================================

const OLLAMA_DEFAULT_HOST = "localhost";
const OLLAMA_DEFAULT_PORT = 11434;
const OLLAMA_BASE_MODEL = "qwen2.5:1.5b";
const OLLAMA_FINETUNED_MODEL = "dictation:latest";
const POLISH_TIMEOUT_MS = 10000;
const WORD_OVERLAP_THRESHOLD = 0.50;  // Reject if < 50% word overlap

/** Path to training pairs file */
const PAIRS_FILE = (process.env.HOME ?? "/Users/[user]") + "/.claude/data/pairs.jsonl";

/** State file for polish pipeline stats */
const POLISH_STATE_PATH = "/tmp/voice-interaction/polish-config.json";

// ============================================
// TYPES
// ============================================

export interface PolishResult {
  /** The polished text (or raw text if polish failed/rejected) */
  text: string;
  /** The original raw transcription */
  rawText: string;
  /** Whether polish was applied */
  polished: boolean;
  /** Which model performed the polish */
  model: string;
  /** Polish duration in ms */
  duration_ms: number;
  /** Word overlap percentage (0-100) */
  wordOverlap: number;
}

// ============================================
// STATE SCHEMA
// ============================================

const PolishConfigSchema = z.object({
  enabled: z.boolean(),
  ollamaHost: z.string(),
  ollamaPort: z.number(),
  baseModel: z.string(),
  finetunedModel: z.string(),
  timeoutMs: z.number(),
  wordOverlapThreshold: z.number(),
  pairsFilePath: z.string(),
  totalPolished: z.number(),
  totalFallbackToBase: z.number(),
  totalFallbackToClaude: z.number(),
  totalRejected: z.number(),
  totalRaw: z.number(),
  lastUpdated: z.string(),
});

type PolishConfig = z.infer<typeof PolishConfigSchema>;

// ============================================
// STATE MANAGER
// ============================================

let _polishConfigManager: StateManager<PolishConfig> | null = null;

function getPolishConfigManager(): StateManager<PolishConfig> {
  if (!_polishConfigManager) {
    _polishConfigManager = createStateManager({
      path: POLISH_STATE_PATH,
      schema: PolishConfigSchema,
      defaults: {
        enabled: true,
        ollamaHost: OLLAMA_DEFAULT_HOST,
        ollamaPort: OLLAMA_DEFAULT_PORT,
        baseModel: OLLAMA_BASE_MODEL,
        finetunedModel: OLLAMA_FINETUNED_MODEL,
        timeoutMs: POLISH_TIMEOUT_MS,
        wordOverlapThreshold: WORD_OVERLAP_THRESHOLD,
        pairsFilePath: PAIRS_FILE,
        totalPolished: 0,
        totalFallbackToBase: 0,
        totalFallbackToClaude: 0,
        totalRejected: 0,
        totalRaw: 0,
        lastUpdated: new Date().toISOString(),
      },
    });
  }
  return _polishConfigManager;
}

// ============================================
// POLISH PROMPT
// ============================================

const POLISH_PROMPT = `[TASK] Clean up speech-to-text output. Fix ONLY spelling, punctuation, and capitalization.
[RULES]
- Keep the same words. Do NOT rephrase, reword, or rewrite.
- Do NOT add commentary, explanations, or quotes around the text.
- Use straight apostrophes (') not curly ones.
- Output ONLY the corrected text. Nothing else.
[INPUT]
`;

// ============================================
// INTERNAL HELPERS
// ============================================

/**
 * Call Ollama for text polishing via CachedHTTPClient.
 */
async function polishViaOllama(
  model: string,
  text: string,
  config: PolishConfig
): Promise<string | null> {
  try {
    const response = await httpClient.fetch(
      `http://${config.ollamaHost}:${config.ollamaPort}/api/generate`,
      {
        cache: "none",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: model,
          prompt: POLISH_PROMPT + text,
          stream: false,
          options: { temperature: 0.1, num_predict: 512 },
        }),
        timeout: config.timeoutMs,
      }
    );

    if (!response.ok) return null;

    const data = await response.json() as { response?: string };
    const result = data?.response?.trim();

    if (!result) return null;

    // Normalize curly quotes to straight
    return result
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"');
  } catch {
    return null;
  }
}

/**
 * Call Claude API as cloud fallback for polishing.
 * Only used when Ollama is unreachable.
 */
async function polishViaClaude(text: string): Promise<string | null> {
  try {
    const { getSecret } = await import("./VoiceCommon.ts");
    const apiKey = getSecret("ANTHROPIC_API_KEY");

    const response = await httpClient.fetch(
      "https://api.anthropic.com/v1/messages",
      {
        cache: "none",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 512,
          messages: [{
            role: "user",
            content: POLISH_PROMPT + text,
          }],
        }),
        timeout: 10000,
      }
    );

    if (!response.ok) return null;

    const data = await response.json() as {
      content?: Array<{ text?: string }>;
    };
    const result = data?.content?.[0]?.text?.trim();

    if (!result) return null;

    return result
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"');
  } catch {
    return null;
  }
}

/**
 * Calculate word overlap between raw and polished text.
 * Returns percentage (0-100) of raw words present in polished text.
 * Guards against hallucinated polish that rewrites content.
 */
function calculateWordOverlap(raw: string, polished: string): number {
  const rawWords = new Set(
    raw.toLowerCase().replace(/[^a-z\s]/g, "").split(/\s+/).filter(Boolean)
  );
  const polishedWords = new Set(
    polished.toLowerCase().replace(/[^a-z\s]/g, "").split(/\s+/).filter(Boolean)
  );

  if (rawWords.size === 0) return 0;

  let common = 0;
  for (const word of rawWords) {
    if (polishedWords.has(word)) common++;
  }

  return Math.round((common / rawWords.size) * 100);
}

/**
 * Strip common model artifacts from polish output.
 */
function cleanPolishOutput(text: string): string {
  return text
    .replace(/^[Ss]ure[,!.] */g, "")
    .replace(/^[Hh]ere is[^:]*: */g, "")
    .replace(/^[Tt]he corrected[^:]*: */g, "")
    .replace(/^"/g, "")
    .replace(/"$/g, "")
    .trim();
}

/**
 * Save a raw/polished training pair to the pairs file.
 */
async function saveTrainingPair(
  raw: string,
  polished: string,
  model: string,
  audioSeconds?: number
): Promise<void> {
  const config = await getPolishConfigManager().load();
  const pair = JSON.stringify({
    timestamp: new Date().toISOString(),
    raw,
    polished,
    model,
    audio_seconds: audioSeconds ?? 0,
  });

  const { appendFileSync, mkdirSync, existsSync } = await import("fs");
  const { dirname } = await import("path");

  const dir = dirname(config.pairsFilePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  appendFileSync(config.pairsFilePath, pair + "\n");
}

// ============================================
// PUBLIC API
// ============================================

/**
 * Polish a raw STT transcription.
 *
 * Fallback chain: fine-tuned dictation model -> base Ollama -> Claude API -> raw text
 *
 * Validates polish quality via word overlap check. If the polished text diverges
 * too much from the original (hallucination), falls back to raw text.
 *
 * Saves raw/polished pairs for continuous model improvement via nightly training.
 *
 * @param rawText - Raw transcription from Whisper
 * @param audioSeconds - Duration of the original audio (for training metadata)
 * @returns PolishResult with polished text and metadata
 */
export async function polishTranscription(
  rawText: string,
  audioSeconds?: number
): Promise<PolishResult> {
  const manager = getPolishConfigManager();
  const config = await manager.load();

  if (!config.enabled || rawText.length < 10) {
    return {
      text: rawText,
      rawText,
      polished: false,
      model: "none",
      duration_ms: 0,
      wordOverlap: 100,
    };
  }

  const startTime = Date.now();
  let polished: string | null = null;
  let model = "none";

  // Try 1: Fine-tuned dictation model
  polished = await polishViaOllama(config.finetunedModel, rawText, config);
  if (polished) {
    model = config.finetunedModel;
  }

  // Try 2: Base Ollama model
  if (!polished) {
    polished = await polishViaOllama(config.baseModel, rawText, config);
    if (polished) {
      model = config.baseModel;
      await manager.update((c) => ({
        ...c,
        totalFallbackToBase: c.totalFallbackToBase + 1,
      }));
    }
  }

  // Try 3: Claude API (cloud fallback)
  if (!polished) {
    polished = await polishViaClaude(rawText);
    if (polished) {
      model = "claude-haiku-4-5";
      await manager.update((c) => ({
        ...c,
        totalFallbackToClaude: c.totalFallbackToClaude + 1,
      }));
    }
  }

  // If all polish attempts failed, return raw
  if (!polished) {
    await manager.update((c) => ({
      ...c,
      totalRaw: c.totalRaw + 1,
      lastUpdated: new Date().toISOString(),
    }));
    return {
      text: rawText,
      rawText,
      polished: false,
      model: "none",
      duration_ms: Date.now() - startTime,
      wordOverlap: 100,
    };
  }

  // Clean model artifacts
  polished = cleanPolishOutput(polished);

  // Validate word overlap
  const wordOverlap = calculateWordOverlap(rawText, polished);

  if (wordOverlap < config.wordOverlapThreshold * 100) {
    // Polish hallucinated -- reject and return raw
    await manager.update((c) => ({
      ...c,
      totalRejected: c.totalRejected + 1,
      lastUpdated: new Date().toISOString(),
    }));
    return {
      text: rawText,
      rawText,
      polished: false,
      model: "rejected:" + model,
      duration_ms: Date.now() - startTime,
      wordOverlap,
    };
  }

  // Polish accepted -- save training pair and return
  await saveTrainingPair(rawText, polished, model, audioSeconds);

  await manager.update((c) => ({
    ...c,
    totalPolished: c.totalPolished + 1,
    lastUpdated: new Date().toISOString(),
  }));

  return {
    text: polished,
    rawText,
    polished: true,
    model,
    duration_ms: Date.now() - startTime,
    wordOverlap,
  };
}

/**
 * Get polish pipeline statistics.
 */
export async function getPolishStats(): Promise<PolishConfig> {
  return getPolishConfigManager().load();
}

// Export internal helpers for testing
export { calculateWordOverlap, cleanPolishOutput };

// ============================================
// CLI INTERFACE
// ============================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case "polish": {
      const text = args.slice(1).join(" ");
      if (!text) {
        console.error("Usage: polish <text>");
        process.exit(1);
      }
      const result = await polishTranscription(text);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case "stats": {
      const stats = await getPolishStats();
      console.log(JSON.stringify(stats, null, 2));
      break;
    }

    case "enable": {
      const manager = getPolishConfigManager();
      await manager.update((c) => ({ ...c, enabled: true }));
      console.log(JSON.stringify({ enabled: true }));
      break;
    }

    case "disable": {
      const manager = getPolishConfigManager();
      await manager.update((c) => ({ ...c, enabled: false }));
      console.log(JSON.stringify({ enabled: false }));
      break;
    }

    default:
      console.log(`STTPolishPipeline - STT transcription polish with self-learning

Commands:
  polish <text>    Polish raw transcription text
  stats            Show pipeline statistics
  enable           Enable polish pipeline
  disable          Disable polish pipeline`);
      break;
  }
}

if (import.meta.main) {
  main().catch((err: Error) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}
