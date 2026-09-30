#!/usr/bin/env bun
/**
 * AnkiAnswerAssessor.ts — Grade a spoken answer against a card's reference answer.
 *
 * The voice-review loop hands us the card's question, the reference answer (card
 * back), and the user's transcribed spoken answer. We ask the LLM to judge
 * correctness and map that to an Anki ease button (1 Again / 2 Hard / 3 Good /
 * 4 Easy), plus a short spoken feedback line Kaya reads back.
 *
 * Determinism note (per repo doctrine — see feedback_determinism_earns_its_place):
 * grading a free-form spoken answer is exactly the kind of fuzzy judgment that
 * belongs to the model, not a string comparator. We keep only a thin,
 * fail-loud-then-safe fallback: if inference fails we surface the reference
 * answer and default the ease to "Again" (1) so nothing is silently marked
 * known.
 */

import { inference, type InferenceOptions, type InferenceResult } from "../../../../lib/core/Inference.ts";
import type { AnkiEase } from "./AnkiConnectClient.ts";

export type Verdict = "correct" | "partial" | "incorrect";

export interface Assessment {
  verdict: Verdict;
  /** Anki ease button implied by the verdict. */
  ease: AnkiEase;
  /** One or two sentences Kaya speaks back to the user. */
  feedback: string;
  /** True when the model could not be reached and we fell back safely. */
  degraded: boolean;
}

export interface AssessInput {
  question: string;
  /** The card's reference answer (back side), plain text. */
  referenceAnswer: string;
  /** The user's transcribed spoken answer. */
  spokenAnswer: string;
}

/** Injectable inference fn for tests (defaults to the real one). */
export type InferenceFn = (opts: InferenceOptions) => Promise<InferenceResult>;

const SYSTEM_PROMPT = `You are Kaya, running a spoken flashcard review. Judge whether the user's SPOKEN answer matches the card's REFERENCE answer.

Grade generously for meaning, not wording: spoken answers are transcribed and will be paraphrased, out of order, or missing filler. Reward correct substance. Do not penalize phrasing, articles, or minor transcription noise.

Map your judgment to Anki's four buttons:
- "correct" + ease 4 (Easy): fully correct, confident, complete.
- "correct" + ease 3 (Good): correct in substance, maybe slightly incomplete or hesitant.
- "partial" + ease 2 (Hard): the gist is there but a key part is missing or muddled.
- "incorrect" + ease 1 (Again): wrong, empty, "I don't know", or unrelated.

Return ONLY minified JSON:
{"verdict":"correct|partial|incorrect","ease":1|2|3|4,"feedback":"<=2 sentences spoken to the user: confirm/correct them warmly and state the right answer if they missed it"}

Keep feedback short and speakable — no markdown, no lists.`;

/** Verdict→ease consistency guard: keep the pair coherent if the model drifts. */
function reconcile(verdict: Verdict, ease: number): AnkiEase {
  if (verdict === "incorrect") return 1;
  if (verdict === "partial") return 2;
  // correct → Good or Easy; trust the model between the two, default Good.
  return ease === 4 ? 4 : 3;
}

export async function assessAnswer(
  input: AssessInput,
  inferenceFn: InferenceFn = inference,
): Promise<Assessment> {
  const spoken = input.spokenAnswer.trim();

  // Empty / no-speech → unambiguously "Again"; skip the LLM round-trip.
  if (spoken.length === 0) {
    return {
      verdict: "incorrect",
      ease: 1,
      feedback: `I didn't catch an answer. The answer is: ${input.referenceAnswer}`,
      degraded: false,
    };
  }

  const userPrompt = [
    `QUESTION: ${input.question}`,
    `REFERENCE ANSWER: ${input.referenceAnswer}`,
    `USER'S SPOKEN ANSWER: ${spoken}`,
  ].join("\n");

  let result: InferenceResult;
  try {
    result = await inferenceFn({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      level: "standard",
      expectJson: true,
      timeout: 30_000,
      retries: 1,
      retryDelayMs: 2000,
    });
  } catch (err) {
    return degradedAssessment(input.referenceAnswer, String(err));
  }

  if (!result.success) {
    return degradedAssessment(input.referenceAnswer, result.error ?? "inference failed");
  }

  const parsed = parseAssessment(result);
  if (!parsed) {
    return degradedAssessment(input.referenceAnswer, "unparseable assessment output");
  }

  return {
    verdict: parsed.verdict,
    ease: reconcile(parsed.verdict, parsed.ease),
    feedback: parsed.feedback,
    degraded: false,
  };
}

interface RawAssessment {
  verdict: Verdict;
  ease: number;
  feedback: string;
}

function parseAssessment(result: InferenceResult): RawAssessment | null {
  const candidate = (result.parsed ?? tryParse(result.output)) as
    | Partial<RawAssessment>
    | undefined;
  if (!candidate || typeof candidate !== "object") return null;

  const verdict = candidate.verdict;
  if (verdict !== "correct" && verdict !== "partial" && verdict !== "incorrect") {
    return null;
  }
  const ease = typeof candidate.ease === "number" ? candidate.ease : 3;
  const feedback =
    typeof candidate.feedback === "string" && candidate.feedback.trim().length > 0
      ? candidate.feedback.trim()
      : "";
  return { verdict, ease, feedback };
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

/** Fail-loud-then-safe: don't silently mark a card known when grading breaks. */
function degradedAssessment(referenceAnswer: string, reason: string): Assessment {
  return {
    verdict: "incorrect",
    ease: 1,
    feedback: `I couldn't grade that one (${reason}), so I'll show it again. The answer is: ${referenceAnswer}`,
    degraded: true,
  };
}

// ============================================
// CLI (manual test)
// ============================================

if (import.meta.main) {
  const [question, referenceAnswer, spokenAnswer] = process.argv.slice(2);
  if (!question || !referenceAnswer || spokenAnswer === undefined) {
    console.error(
      'Usage: bun AnkiAnswerAssessor.ts "<question>" "<reference answer>" "<spoken answer>"',
    );
    process.exit(1);
  }
  const assessment = await assessAnswer({ question, referenceAnswer, spokenAnswer });
  console.log(JSON.stringify(assessment, null, 2));
}
