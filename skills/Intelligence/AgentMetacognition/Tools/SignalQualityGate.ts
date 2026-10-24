#!/usr/bin/env bun
/**
 * SignalQualityGate — Classifies incoming signals as real/noise
 *
 * A signal qualifies if:
 *   - source === "explicit" (any value) — deterministic pass
 *   - source === "implicit" AND rating <= 3 (frustration) — deterministic pass
 *   - source === "implicit" AND rating >= 8 (strong satisfaction) — deterministic pass
 *   - source === "implicit" AND rating 4-7 — LLM classifies sentiment_summary
 *     as 'correction' | 'praise' | 'neutral'; 'neutral' is rejected
 *
 * Returns the qualified signal, or null for noise.
 *
 * Usage:
 *   bun SignalQualityGate.ts --test-fixtures
 */

import { inference as defaultInference } from "../../../../lib/core/Inference.ts";
import type { InferenceOptions, InferenceResult } from "../../../../lib/core/Inference.ts";
import { z } from "zod";

export type InferenceFn = (opts: InferenceOptions) => Promise<InferenceResult>;

export interface RawSignal {
  rating: number;
  source: "explicit" | "implicit";
  sentiment_summary: string;
  session_id: string;
  timestamp: string;
  [key: string]: unknown;
}

export type QualifiedSignal = RawSignal;

// --- Zod schema for mid-band LLM classification ---
const SignalClassificationSchema = z.object({
  category: z.enum(["correction", "praise", "neutral"]),
  reasoning: z.string(),
});

// --- Deterministic fallback (old keyword logic) ---

const CORRECTION_KEYWORDS: readonly string[] = [
  "corrected", "correction", "corrects", "wrong", "mistake", "error",
  "fix", "fixed", "redo", "retry", "incorrect", "bad", "worse",
];

const PRAISE_KEYWORDS: readonly string[] = [
  "praised", "praise", "great", "excellent", "perfect", "love",
  "loved", "amazing", "awesome", "well done", "nice", "quick", "helpful",
];

const NEUTRAL_PATTERNS: readonly RegExp[] = [
  /neutral command/i, /no sentiment/i, /direct task/i, /baseline capture/i,
];

function _classifySignalFallback(summary: string): "correction" | "praise" | "neutral" {
  const lower = summary.toLowerCase();
  if (NEUTRAL_PATTERNS.some((re) => re.test(summary))) return "neutral";
  if (CORRECTION_KEYWORDS.some((kw) => lower.includes(kw))) return "correction";
  if (PRAISE_KEYWORDS.some((kw) => lower.includes(kw))) return "praise";
  return "neutral";
}

export const SignalQualityGate = {
  /**
   * Evaluate a signal and return it if it qualifies, or null if it is noise.
   * Mid-band (implicit, rating 4-7) uses LLM inference to classify sentiment.
   */
  async evaluate(
    signal: RawSignal,
    inferenceFn: InferenceFn = defaultInference,
  ): Promise<QualifiedSignal | null> {
    // Explicit user ratings always qualify regardless of value
    if (signal.source === "explicit") {
      return signal as QualifiedSignal;
    }

    // Implicit signals below the neutral band qualify (frustration)
    if (signal.rating <= 3) {
      return signal as QualifiedSignal;
    }

    // Implicit signals above the neutral band qualify (strong satisfaction)
    if (signal.rating >= 8) {
      return signal as QualifiedSignal;
    }

    // Mid-band (implicit, rating 4-7): classify via LLM inference
    const summary = signal.sentiment_summary ?? "";
    let category: "correction" | "praise" | "neutral";

    try {
      const result = await inferenceFn({
        systemPrompt: "Classify the sentiment of this user interaction summary. Return JSON.",
        userPrompt: `Sentiment summary: "${summary}"\n\nClassify as: "correction" (user corrected/fixed something, expressed frustration), "praise" (user expressed satisfaction/approval), or "neutral" (routine interaction, no clear sentiment).`,
        level: "standard",
        expectJson: true,
      });

      if (result.success && result.parsed) {
        const parsed = SignalClassificationSchema.safeParse(result.parsed);
        if (parsed.success) {
          category = parsed.data.category;
        } else {
          category = _classifySignalFallback(summary);
        }
      } else {
        category = _classifySignalFallback(summary);
      }
    } catch {
      category = _classifySignalFallback(summary);
    }

    return category === "neutral" ? null : (signal as QualifiedSignal);
  },
};

// ============================================================================
// CLI test fixture runner (--test-fixtures flag)
// ============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--test-fixtures")) {
    runTestFixtures().catch(console.error);
  }
}

async function runTestFixtures(): Promise<void> {
  const fixtures: Array<{ label: string; signal: RawSignal; expectNull: boolean }> = [
    // ISC-1: should reject
    {
      label: "[REJECT] implicit rating=5, 'Neutral command, no sentiment'",
      signal: {
        rating: 5,
        source: "implicit",
        sentiment_summary: "Neutral command, no sentiment",
        session_id: "s1",
        timestamp: new Date().toISOString(),
      },
      expectNull: true,
    },
    {
      label: "[REJECT] implicit rating=5, 'no sentiment' summary",
      signal: {
        rating: 5,
        source: "implicit",
        sentiment_summary: "Direct task, no sentiment detected",
        session_id: "s2",
        timestamp: new Date().toISOString(),
      },
      expectNull: true,
    },
    {
      label: "[REJECT] implicit rating=5, 'Direct task' summary",
      signal: {
        rating: 5,
        source: "implicit",
        sentiment_summary: "Direct task command execution",
        session_id: "s3",
        timestamp: new Date().toISOString(),
      },
      expectNull: true,
    },
    // ISC-2: should pass
    {
      label: "[PASS] explicit rating=5",
      signal: {
        rating: 5,
        source: "explicit",
        sentiment_summary: "User rated explicitly",
        session_id: "s4",
        timestamp: new Date().toISOString(),
      },
      expectNull: false,
    },
    {
      label: "[PASS] implicit frustration rating=3",
      signal: {
        rating: 3,
        source: "implicit",
        sentiment_summary: "Task failed repeatedly",
        session_id: "s5",
        timestamp: new Date().toISOString(),
      },
      expectNull: false,
    },
    {
      label: "[PASS] implicit satisfaction rating=9",
      signal: {
        rating: 9,
        source: "implicit",
        sentiment_summary: "Great response",
        session_id: "s6",
        timestamp: new Date().toISOString(),
      },
      expectNull: false,
    },
    {
      label: "[PASS] implicit rating=5 with correction keyword",
      signal: {
        rating: 5,
        source: "implicit",
        sentiment_summary: "User corrected the output format",
        session_id: "s7",
        timestamp: new Date().toISOString(),
      },
      expectNull: false,
    },
    {
      label: "[PASS] implicit rating=5 with praise keyword",
      signal: {
        rating: 5,
        source: "implicit",
        sentiment_summary: "User praised the quick resolution",
        session_id: "s8",
        timestamp: new Date().toISOString(),
      },
      expectNull: false,
    },
  ];

  let passed = 0;
  let failed = 0;

  for (const { label, signal, expectNull } of fixtures) {
    const result = await SignalQualityGate.evaluate(signal);
    const gotNull = result === null;
    const ok = gotNull === expectNull;
    if (ok) {
      console.log(`  PASS ${label}`);
      passed++;
    } else {
      console.error(`  FAIL ${label} — expected ${expectNull ? "null" : "signal"}, got ${gotNull ? "null" : "signal"}`);
      failed++;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
