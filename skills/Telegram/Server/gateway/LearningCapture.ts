/**
 * LearningCapture.ts - Mobile learning signal capture
 *
 * Detects and captures learning signals from mobile interactions:
 * - Explicit ratings ("8/10", "rate: 7", "great answer")
 * - Sentiment analysis (satisfaction, frustration, praise)
 * - Topic patterns and preferences
 *
 * All signals are tagged with source: "telegram" to distinguish
 * mobile interactions from desktop Claude Code sessions.
 *
 * Writes to: MEMORY/LEARNING/SIGNALS/ratings.jsonl
 */

import { existsSync, mkdirSync, appendFileSync } from "fs";
import { join } from "path";
import type { Exchange } from "./KayaMobileGateway";

const KAYA_HOME = process.env.HOME + "/.claude";
const SIGNALS_DIR = join(KAYA_HOME, "MEMORY", "LEARNING", "SIGNALS");
const RATINGS_FILE = join(SIGNALS_DIR, "ratings.jsonl");

interface RatingSignal {
  timestamp: string;
  rating: number;
  session_id: string;
  source: "telegram" | "implicit";
  sentiment_summary: string;
  confidence: number;
  platform: "telegram";
  message_type: string;
  profile?: string;
}

// ──────────────────────────────────────────────
// Rating Detection Patterns
// ──────────────────────────────────────────────

/**
 * Detect explicit numeric ratings in message text.
 * Patterns: "8/10", "rate: 7", "rating: 9", "score: 5"
 */
function detectExplicitRating(text: string): number | null {
  // Pattern: N/10
  const slashTenMatch = text.match(/\b(\d{1,2})\/10\b/);
  if (slashTenMatch) {
    const rating = parseInt(slashTenMatch[1], 10);
    if (rating >= 1 && rating <= 10) return rating;
  }

  // Pattern: rate/rating/score: N
  const labelMatch = text.match(/\b(?:rate|rating|score)\s*[:=]\s*(\d{1,2})\b/i);
  if (labelMatch) {
    const rating = parseInt(labelMatch[1], 10);
    if (rating >= 1 && rating <= 10) return rating;
  }

  return null;
}

/**
 * Detect sentiment-implied ratings from message text.
 * Returns a tuple of [rating, sentiment_summary, confidence].
 */
function detectSentimentRating(text: string): {
  rating: number;
  sentiment: string;
  confidence: number;
} | null {
  const lowerText = text.toLowerCase();

  // Very positive signals -> rating 8-9
  const veryPositive = [
    "perfect", "amazing", "excellent", "love it", "love this",
    "exactly what i needed", "brilliant", "outstanding", "incredible",
    "you nailed it", "spot on",
  ];
  for (const phrase of veryPositive) {
    if (lowerText.includes(phrase)) {
      return {
        rating: 9,
        sentiment: `Strong positive: "${phrase}" detected`,
        confidence: 0.85,
      };
    }
  }

  // Positive signals -> rating 7
  const positive = [
    "great", "good answer", "nice", "helpful", "thanks",
    "thank you", "well done", "good job", "appreciate",
    "that works", "that helps",
  ];
  for (const phrase of positive) {
    if (lowerText.includes(phrase)) {
      return {
        rating: 7,
        sentiment: `Positive: "${phrase}" detected`,
        confidence: 0.7,
      };
    }
  }

  // Negative signals -> rating 3
  const negative = [
    "wrong", "incorrect", "not what i asked", "that's not right",
    "no that's wrong", "try again", "redo", "not helpful",
    "useless", "terrible",
  ];
  for (const phrase of negative) {
    if (lowerText.includes(phrase)) {
      return {
        rating: 3,
        sentiment: `Negative: "${phrase}" detected`,
        confidence: 0.75,
      };
    }
  }

  // Frustrated signals -> rating 2
  const frustrated = [
    "i already told you", "i said", "listen",
    "pay attention", "read what i wrote", "that's not what i meant",
  ];
  for (const phrase of frustrated) {
    if (lowerText.includes(phrase)) {
      return {
        rating: 2,
        sentiment: `Frustrated: "${phrase}" detected`,
        confidence: 0.8,
      };
    }
  }

  return null;
}

/**
 * Ensure signals directory exists
 */
function ensureSignalsDir(): void {
  if (!existsSync(SIGNALS_DIR)) {
    mkdirSync(SIGNALS_DIR, { recursive: true });
  }
}

/**
 * Write a rating signal to the JSONL file
 */
function writeRatingSignal(signal: RatingSignal): void {
  ensureSignalsDir();
  appendFileSync(RATINGS_FILE, JSON.stringify(signal) + "\n");
}

/**
 * Capture learning signals from a completed exchange.
 *
 * Called after every exchange to detect:
 * 1. Explicit ratings (user says "8/10")
 * 2. Sentiment-implied ratings (user says "great answer")
 * 3. Default implicit rating (neutral exchange = 5)
 */
export async function captureLearning(exchange: Exchange): Promise<void> {
  const { message, response, session } = exchange;

  try {
    // Check for explicit rating first
    const explicitRating = detectExplicitRating(message.text);

    if (explicitRating !== null) {
      const signal: RatingSignal = {
        timestamp: new Date().toISOString(),
        rating: explicitRating,
        session_id: session.sessionId,
        source: "telegram",
        sentiment_summary: `Explicit rating: ${explicitRating}/10`,
        confidence: 0.95,
        platform: "telegram",
        message_type: message.type,
        profile: session.currentProfile,
      };

      writeRatingSignal(signal);
      console.log(
        `[LearningCapture] Explicit rating: ${explicitRating}/10 from telegram`
      );
      return;
    }

    // Check for sentiment-implied rating
    const sentimentResult = detectSentimentRating(message.text);

    if (sentimentResult) {
      const signal: RatingSignal = {
        timestamp: new Date().toISOString(),
        rating: sentimentResult.rating,
        session_id: session.sessionId,
        source: "implicit",
        sentiment_summary: sentimentResult.sentiment,
        confidence: sentimentResult.confidence,
        platform: "telegram",
        message_type: message.type,
        profile: session.currentProfile,
      };

      writeRatingSignal(signal);
      console.log(
        `[LearningCapture] Sentiment rating: ${sentimentResult.rating}/10 (${sentimentResult.sentiment})`
      );
      return;
    }

    // Default: record as neutral exchange (implicit 5)
    const signal: RatingSignal = {
      timestamp: new Date().toISOString(),
      rating: 5,
      session_id: session.sessionId,
      source: "implicit",
      sentiment_summary: "Neutral exchange, no sentiment detected",
      confidence: 0.5,
      platform: "telegram",
      message_type: message.type,
      profile: session.currentProfile,
    };

    writeRatingSignal(signal);
  } catch (error) {
    console.error("[LearningCapture] Failed to capture learning:", error);
  }
}

/**
 * Detect rating from a message text.
 * Exported for use by handlers that want to check without full capture.
 */
export function detectRating(text: string): {
  rating: number;
  source: "explicit" | "implicit";
  sentiment: string;
  confidence: number;
} | null {
  const explicit = detectExplicitRating(text);
  if (explicit !== null) {
    return {
      rating: explicit,
      source: "explicit",
      sentiment: `Explicit rating: ${explicit}/10`,
      confidence: 0.95,
    };
  }

  const sentiment = detectSentimentRating(text);
  if (sentiment) {
    return {
      rating: sentiment.rating,
      source: "implicit",
      sentiment: sentiment.sentiment,
      confidence: sentiment.confidence,
    };
  }

  return null;
}
