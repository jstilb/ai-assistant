#!/usr/bin/env bun
/**
 * VoiceReviewSession.ts — Interactive VOICE review mode for Anki.
 *
 * Kaya reads each due card's question aloud, listens to your spoken answer,
 * assesses it against the card's reference answer, speaks feedback, and marks
 * the card in Anki with the appropriate ease — a fully hands-free review loop.
 *
 * Pipeline per card:
 *   AnkiConnect (due card) --> TTS "Question: ..." --> STT (your spoken answer)
 *     --> AnkiAnswerAssessor (LLM grade + ease) --> AnkiConnect.answerCard(ease)
 *     --> TTS feedback
 *
 * Spoken control words (checked before grading):
 *   "repeat" / "say again"          -> re-read the current question
 *   "skip" / "next"                 -> move on, leave the card due (no grade)
 *   "stop" / "quit" / "end review"  -> end the session
 * Anything else is treated as your answer.
 *
 * Every seam (speak, listen, assess, anki) is injectable so the whole loop is
 * unit-testable without a mic, speakers, a live LLM, or a running Anki — the
 * default factories wire up the real desktop stack.
 */

import { spawnSync } from "child_process";
import { join } from "path";
import {
  AnkiConnectClient,
  EASE_LABEL,
  type AnkiEase,
  type ReviewCard,
} from "./AnkiConnectClient.ts";
import { assessAnswer, type Assessment } from "./AnkiAnswerAssessor.ts";
import { createAppendLog } from "../../../../lib/core/AppendLog.ts";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";

// ============================================
// SEAMS
// ============================================

/** Speak a line to the user (TTS). */
export type Speaker = (text: string) => Promise<void>;
/** Capture a spoken utterance and return the transcript (STT). */
export type Listener = () => Promise<string>;
/** Grade a spoken answer against the reference answer. */
export type Assessor = (input: {
  question: string;
  referenceAnswer: string;
  spokenAnswer: string;
}) => Promise<Assessment>;

/** The subset of AnkiConnect the session needs. */
export interface ReviewBackend {
  isAvailable(): Promise<boolean>;
  findDueCards(deck?: string): Promise<number[]>;
  getReviewCards(cardIds: number[]): Promise<ReviewCard[]>;
  answerCard(cardId: number, ease: AnkiEase): Promise<boolean>;
}

export interface VoiceReviewOptions {
  deck?: string;
  /** Max cards to review this session. Default 20. */
  limit?: number;
  speak?: Speaker;
  listen?: Listener;
  assess?: Assessor;
  backend?: ReviewBackend;
  /** Kaya home override (audit log location) for tests. */
  kayaHome?: string;
  /** Whisper model for STT. Default base.en. */
  whisperModel?: string;
}

export interface CardOutcome {
  cardId: number;
  question: string;
  spokenAnswer: string;
  verdict: Assessment["verdict"] | "skipped";
  ease?: AnkiEase;
  marked: boolean;
  degraded: boolean;
}

export interface VoiceReviewResult {
  available: boolean;
  reviewed: number;
  correct: number;
  partial: number;
  incorrect: number;
  skipped: number;
  outcomes: CardOutcome[];
  endedEarly: boolean;
  message: string;
}

type Command = "repeat" | "skip" | "stop" | "answer";

/** Classify a transcript as a control word or a real answer. */
export function classifyUtterance(raw: string): Command {
  const t = raw.trim().toLowerCase().replace(/[.!?,]+$/g, "");
  if (t === "repeat" || t === "say again" || t === "again please" || t === "repeat that") {
    return "repeat";
  }
  if (t === "skip" || t === "next" || t === "skip this" || t === "skip it") {
    return "skip";
  }
  if (
    t === "stop" ||
    t === "quit" ||
    t === "exit" ||
    t === "end" ||
    t === "end review" ||
    t === "stop review" ||
    t === "i'm done" ||
    t === "im done" ||
    t === "that's enough" ||
    t === "thats enough"
  ) {
    return "stop";
  }
  return "answer";
}

// ============================================
// DEFAULT SEAM FACTORIES (real desktop stack)
// ============================================

/**
 * TTS via a VoiceResponseGenerator.ts subprocess (generate + play, then exit).
 * Spawned rather than imported: VoiceResponseGenerator runs its CLI `main()` on
 * import (no `import.meta.main` guard), so a subprocess is both cleaner and
 * consistent with how STT is driven below.
 */
function defaultSpeaker(): Speaker {
  const vrg = join(
    getKayaHome(),
    "skills/Communication/VoiceInteraction/Tools/VoiceResponseGenerator.ts",
  );
  return async (text: string) => {
    const proc = spawnSync("bun", [vrg, "speak", text], {
      encoding: "utf-8",
      timeout: 90_000,
    });
    if (proc.status !== 0) {
      throw new Error(`TTS failed: ${proc.stderr ?? proc.error ?? "unknown"}`);
    }
  };
}

/** STT via a one-shot VoiceInput.ts subprocess (records until silence). */
function defaultListener(whisperModel: string): Listener {
  const voiceInput = join(getKayaHome(), "lib/core/VoiceInput.ts");
  return async () => {
    const proc = spawnSync(
      "bun",
      [voiceInput, "once", "--json", `--model=${whisperModel}`],
      { encoding: "utf-8", timeout: 130_000 },
    );
    if (proc.status !== 0) return "";
    const line = (proc.stdout ?? "")
      .trim()
      .split("\n")
      .reverse()
      .find((l) => l.trim().startsWith("{"));
    if (!line) return "";
    try {
      const parsed = JSON.parse(line) as { transcript?: string };
      return (parsed.transcript ?? "").trim();
    } catch {
      return "";
    }
  };
}

// ============================================
// AUDIT
// ============================================

function auditPath(kayaHome: string): string {
  return join(kayaHome, "MEMORY", "Life", "anki-voice-review.jsonl");
}

// ============================================
// SESSION
// ============================================

export async function runVoiceReview(
  options: VoiceReviewOptions = {},
): Promise<VoiceReviewResult> {
  const limit = options.limit ?? 20;
  const kayaHome = options.kayaHome ?? getKayaHome();
  const backend: ReviewBackend = options.backend ?? new AnkiConnectClient();
  const speak: Speaker = options.speak ?? defaultSpeaker();
  const listen: Listener =
    options.listen ?? defaultListener(options.whisperModel ?? "base.en");
  const assess: Assessor = options.assess ?? ((i) => assessAnswer(i));

  const result: VoiceReviewResult = {
    available: false,
    reviewed: 0,
    correct: 0,
    partial: 0,
    incorrect: 0,
    skipped: 0,
    outcomes: [],
    endedEarly: false,
    message: "",
  };

  // 1. Prerequisite: AnkiConnect reachable.
  if (!(await backend.isAvailable())) {
    result.message =
      "Anki isn't reachable. Start Anki and make sure the AnkiConnect add-on (code 2055492159) is installed, then try again.";
    await safeSpeak(speak, result.message);
    return result;
  }
  result.available = true;

  // 2. Gather due cards.
  const dueIds = await backend.findDueCards(options.deck);
  if (dueIds.length === 0) {
    result.message = options.deck
      ? `No cards are due in ${options.deck}. Nice work.`
      : "No cards are due right now. Nice work.";
    await safeSpeak(speak, result.message);
    return result;
  }

  const cards = await backend.getReviewCards(dueIds.slice(0, limit));
  const total = cards.length;
  await safeSpeak(
    speak,
    `You have ${dueIds.length} card${dueIds.length === 1 ? "" : "s"} due. Let's review ${total}. Say "skip" to pass, "repeat" to hear it again, or "stop" to end.`,
  );

  const log = safeLog(auditPath(kayaHome));
  const startedAt = new Date().toISOString();

  // 3. Review loop.
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    await safeSpeak(speak, `Question ${i + 1}. ${card.question}`);

    let spoken = "";
    let command: Command = "answer";

    // Inner loop handles "repeat" without consuming a card.
    for (;;) {
      spoken = await listen();
      command = classifyUtterance(spoken);
      if (command === "repeat") {
        await safeSpeak(speak, card.question);
        continue;
      }
      break;
    }

    if (command === "stop") {
      result.endedEarly = true;
      await safeSpeak(speak, "Ending the review here.");
      break;
    }

    if (command === "skip") {
      result.skipped++;
      result.outcomes.push({
        cardId: card.cardId,
        question: card.question,
        spokenAnswer: spoken,
        verdict: "skipped",
        marked: false,
        degraded: false,
      });
      await safeSpeak(speak, "Skipping.");
      log?.append({
        timestamp: new Date().toISOString(),
        cardId: card.cardId,
        deck: card.deckName,
        verdict: "skipped",
      });
      continue;
    }

    // Grade the spoken answer and mark the card.
    const assessment = await assess({
      question: card.question,
      referenceAnswer: card.answer,
      spokenAnswer: spoken,
    });

    let marked = false;
    try {
      marked = await backend.answerCard(card.cardId, assessment.ease);
    } catch {
      marked = false;
    }

    result.reviewed++;
    if (assessment.verdict === "correct") result.correct++;
    else if (assessment.verdict === "partial") result.partial++;
    else result.incorrect++;

    result.outcomes.push({
      cardId: card.cardId,
      question: card.question,
      spokenAnswer: spoken,
      verdict: assessment.verdict,
      ease: assessment.ease,
      marked,
      degraded: assessment.degraded,
    });

    const markNote = marked ? "" : " (couldn't record that in Anki)";
    await safeSpeak(speak, `${assessment.feedback} Marked ${EASE_LABEL[assessment.ease]}.${markNote}`);

    log?.append({
      timestamp: new Date().toISOString(),
      cardId: card.cardId,
      deck: card.deckName,
      verdict: assessment.verdict,
      ease: assessment.ease,
      marked,
      degraded: assessment.degraded,
    });
  }

  // 4. Wrap-up.
  result.message =
    `Review done. ${result.reviewed} reviewed — ` +
    `${result.correct} correct, ${result.partial} partial, ${result.incorrect} to revisit` +
    (result.skipped > 0 ? `, ${result.skipped} skipped` : "") +
    ".";
  await safeSpeak(speak, result.message);

  log?.append({
    timestamp: new Date().toISOString(),
    event: "session_summary",
    startedAt,
    deck: options.deck,
    reviewed: result.reviewed,
    correct: result.correct,
    partial: result.partial,
    incorrect: result.incorrect,
    skipped: result.skipped,
    endedEarly: result.endedEarly,
  });

  return result;
}

// ---- best-effort wrappers (a dead speaker/log must not abort the review) ----

async function safeSpeak(speak: Speaker, text: string): Promise<void> {
  try {
    await speak(text);
  } catch {
    // TTS failure is non-fatal — the loop continues silently.
  }
}

function safeLog(path: string): ReturnType<typeof createAppendLog> | null {
  try {
    return createAppendLog(path);
  } catch {
    return null;
  }
}

// ============================================
// CLI
// ============================================

if (import.meta.main) {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command !== "start") {
    console.error(
      'Usage: bun VoiceReviewSession.ts start [deck] [--limit=N] [--model=base.en]',
    );
    process.exit(1);
  }

  const positional = args.slice(1).filter((a) => !a.startsWith("--"));
  const deck = positional[0];
  const limitArg = args.find((a) => a.startsWith("--limit="));
  const modelArg = args.find((a) => a.startsWith("--model="));
  const limit = limitArg ? parseInt(limitArg.split("=")[1], 10) : undefined;
  const whisperModel = modelArg ? modelArg.split("=")[1] : undefined;

  const result = await runVoiceReview({
    deck,
    limit: Number.isFinite(limit) ? limit : undefined,
    whisperModel,
  });

  console.log(JSON.stringify(result, null, 2));
  process.exit(result.available ? 0 : 1);
}
