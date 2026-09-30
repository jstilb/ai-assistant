/**
 * Tests for VoiceReviewSession — the interactive voice-review loop.
 * Every seam (speak/listen/assess/backend) is mocked, so the full loop runs
 * without a mic, speakers, an LLM, or a live Anki.
 */

import { describe, it, expect } from "bun:test";
import { rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  runVoiceReview,
  classifyUtterance,
  type ReviewBackend,
  type Assessor,
  type Speaker,
  type Listener,
} from "./VoiceReviewSession.ts";
import type { ReviewCard, AnkiEase } from "./AnkiConnectClient.ts";
import type { Assessment } from "./AnkiAnswerAssessor.ts";

function card(id: number, q: string, a: string, deck = "Test"): ReviewCard {
  return { cardId: id, deckName: deck, question: q, answer: a, fields: {} };
}

/** Backend stub. Records answered (cardId, ease) pairs. */
class FakeBackend implements ReviewBackend {
  answered: Array<{ cardId: number; ease: AnkiEase }> = [];
  constructor(
    private readonly opts: {
      available?: boolean;
      due?: number[];
      cards?: ReviewCard[];
      answerFails?: boolean;
    } = {},
  ) {}
  async isAvailable(): Promise<boolean> {
    return this.opts.available ?? true;
  }
  async findDueCards(): Promise<number[]> {
    return this.opts.due ?? (this.opts.cards ?? []).map((c) => c.cardId);
  }
  async getReviewCards(ids: number[]): Promise<ReviewCard[]> {
    const all = this.opts.cards ?? [];
    return ids.map((id) => all.find((c) => c.cardId === id)).filter(Boolean) as ReviewCard[];
  }
  async answerCard(cardId: number, ease: AnkiEase): Promise<boolean> {
    if (this.opts.answerFails) return false;
    this.answered.push({ cardId, ease });
    return true;
  }
}

/** Assessor stub keyed by the spoken answer text. */
function fakeAssessor(map: Record<string, Assessment>): Assessor {
  return async ({ spokenAnswer }) =>
    map[spokenAnswer] ?? {
      verdict: "incorrect",
      ease: 1,
      feedback: "no",
      degraded: false,
    };
}

const correct = (fb = "Right."): Assessment => ({
  verdict: "correct",
  ease: 3,
  feedback: fb,
  degraded: false,
});

function collectSpeaker(): { speak: Speaker; lines: string[] } {
  const lines: string[] = [];
  return { speak: async (t) => void lines.push(t), lines };
}

/** Listener that returns queued transcripts in order. */
function scriptedListener(transcripts: string[]): Listener {
  let i = 0;
  return async () => transcripts[i++] ?? "stop";
}

const tmpHome = () => join(tmpdir(), `kaya-voice-review-test-${process.hrtime.bigint()}`);

describe("classifyUtterance", () => {
  it("recognizes control words with trailing punctuation and casing", () => {
    expect(classifyUtterance("Skip.")).toBe("skip");
    expect(classifyUtterance("REPEAT")).toBe("repeat");
    expect(classifyUtterance("say again")).toBe("repeat");
    expect(classifyUtterance("stop review")).toBe("stop");
    expect(classifyUtterance("that's enough")).toBe("stop");
  });
  it("treats substantive speech as an answer", () => {
    expect(classifyUtterance("the mitochondria")).toBe("answer");
    expect(classifyUtterance("I don't know")).toBe("answer");
  });
});

describe("runVoiceReview — prerequisites", () => {
  it("stops and explains when AnkiConnect is unavailable", async () => {
    const { speak, lines } = collectSpeaker();
    const r = await runVoiceReview({
      backend: new FakeBackend({ available: false }),
      speak,
      listen: scriptedListener([]),
      assess: fakeAssessor({}),
      kayaHome: tmpHome(),
    });
    expect(r.available).toBe(false);
    expect(r.reviewed).toBe(0);
    expect(lines.join(" ")).toMatch(/AnkiConnect add-on/);
  });

  it("reports when nothing is due", async () => {
    const { speak, lines } = collectSpeaker();
    const r = await runVoiceReview({
      backend: new FakeBackend({ due: [] }),
      speak,
      listen: scriptedListener([]),
      assess: fakeAssessor({}),
      kayaHome: tmpHome(),
    });
    expect(r.available).toBe(true);
    expect(r.reviewed).toBe(0);
    expect(lines.join(" ")).toMatch(/No cards are due/);
  });
});

describe("runVoiceReview — grading and marking", () => {
  it("reads each question, grades the answer, and marks the card with the assessed ease", async () => {
    const backend = new FakeBackend({
      cards: [card(1, "Q1?", "A1"), card(2, "Q2?", "A2")],
    });
    const { speak, lines } = collectSpeaker();
    const r = await runVoiceReview({
      backend,
      speak,
      listen: scriptedListener(["answer one", "answer two"]),
      assess: fakeAssessor({
        "answer one": correct("Nice."),
        "answer two": { verdict: "partial", ease: 2, feedback: "Half.", degraded: false },
      }),
      kayaHome: tmpHome(),
    });

    expect(r.reviewed).toBe(2);
    expect(r.correct).toBe(1);
    expect(r.partial).toBe(1);
    expect(backend.answered).toEqual([
      { cardId: 1, ease: 3 },
      { cardId: 2, ease: 2 },
    ]);
    // Both questions were read aloud.
    expect(lines.some((l) => l.includes("Q1?"))).toBe(true);
    expect(lines.some((l) => l.includes("Q2?"))).toBe(true);
    // Feedback + ease label spoken.
    expect(lines.some((l) => l.includes("Nice.") && l.includes("Good"))).toBe(true);
  });

  it("re-reads the question on 'repeat' without consuming the card", async () => {
    const backend = new FakeBackend({ cards: [card(1, "Capital of France?", "Paris")] });
    const { speak, lines } = collectSpeaker();
    const r = await runVoiceReview({
      backend,
      speak,
      listen: scriptedListener(["repeat", "paris"]),
      assess: fakeAssessor({ paris: correct() }),
      kayaHome: tmpHome(),
    });
    expect(r.reviewed).toBe(1);
    // Question text spoken at least twice (initial + repeat).
    const qCount = lines.filter((l) => l.includes("Capital of France?")).length;
    expect(qCount).toBeGreaterThanOrEqual(2);
    expect(backend.answered).toEqual([{ cardId: 1, ease: 3 }]);
  });

  it("skips a card without grading or marking it", async () => {
    const backend = new FakeBackend({ cards: [card(1, "Q1?", "A1"), card(2, "Q2?", "A2")] });
    const { speak } = collectSpeaker();
    const r = await runVoiceReview({
      backend,
      speak,
      listen: scriptedListener(["skip", "the answer"]),
      assess: fakeAssessor({ "the answer": correct() }),
      kayaHome: tmpHome(),
    });
    expect(r.skipped).toBe(1);
    expect(r.reviewed).toBe(1);
    expect(backend.answered).toEqual([{ cardId: 2, ease: 3 }]);
  });

  it("ends early on 'stop' and leaves remaining cards untouched", async () => {
    const backend = new FakeBackend({ cards: [card(1, "Q1?", "A1"), card(2, "Q2?", "A2")] });
    const { speak } = collectSpeaker();
    const r = await runVoiceReview({
      backend,
      speak,
      listen: scriptedListener(["stop"]),
      assess: fakeAssessor({}),
      kayaHome: tmpHome(),
    });
    expect(r.endedEarly).toBe(true);
    expect(r.reviewed).toBe(0);
    expect(backend.answered).toEqual([]);
  });

  it("respects the session limit", async () => {
    const cards = [card(1, "Q1?", "A1"), card(2, "Q2?", "A2"), card(3, "Q3?", "A3")];
    const backend = new FakeBackend({ cards });
    const { speak } = collectSpeaker();
    const r = await runVoiceReview({
      backend,
      speak,
      listen: scriptedListener(["a", "a"]),
      assess: fakeAssessor({ a: correct() }),
      limit: 2,
      kayaHome: tmpHome(),
    });
    expect(r.reviewed).toBe(2);
    expect(backend.answered.length).toBe(2);
  });

  it("records the outcome even when Anki fails to mark the card", async () => {
    const backend = new FakeBackend({ cards: [card(1, "Q1?", "A1")], answerFails: true });
    const { speak, lines } = collectSpeaker();
    const r = await runVoiceReview({
      backend,
      speak,
      listen: scriptedListener(["answer"]),
      assess: fakeAssessor({ answer: correct() }),
      kayaHome: tmpHome(),
    });
    expect(r.reviewed).toBe(1);
    expect(r.outcomes[0].marked).toBe(false);
    expect(lines.some((l) => l.includes("couldn't record"))).toBe(true);
  });
});

describe("runVoiceReview — resilience", () => {
  it("continues the loop when the speaker throws", async () => {
    const backend = new FakeBackend({ cards: [card(1, "Q1?", "A1")] });
    const throwingSpeak: Speaker = async () => {
      throw new Error("TTS down");
    };
    const r = await runVoiceReview({
      backend,
      speak: throwingSpeak,
      listen: scriptedListener(["answer"]),
      assess: fakeAssessor({ answer: correct() }),
      kayaHome: tmpHome(),
    });
    expect(r.reviewed).toBe(1);
    expect(backend.answered).toEqual([{ cardId: 1, ease: 3 }]);
  });

  it("writes an audit log with per-card entries and a session summary", async () => {
    const home = tmpHome();
    const backend = new FakeBackend({ cards: [card(1, "Q1?", "A1")] });
    const { speak } = collectSpeaker();
    await runVoiceReview({
      backend,
      speak,
      listen: scriptedListener(["answer"]),
      assess: fakeAssessor({ answer: correct() }),
      kayaHome: home,
    });
    const logPath = join(home, "MEMORY", "Life", "anki-voice-review.jsonl");
    expect(existsSync(logPath)).toBe(true);
    const content = readFileSync(logPath, "utf-8");
    expect(content).toContain('"cardId":1');
    expect(content).toContain("session_summary");
    rmSync(home, { recursive: true, force: true });
  });
});
