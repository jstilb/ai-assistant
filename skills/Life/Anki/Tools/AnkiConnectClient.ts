#!/usr/bin/env bun
/**
 * AnkiConnectClient.ts — Programmatic Anki control via the AnkiConnect add-on.
 *
 * Why this exists (and not `apy`): `apy` is the right tool for *authoring* cards
 * (add / batch / sync), but its `review` command is a curses-style interactive
 * loop — there is no non-interactive way to fetch a due card's rendered fields
 * and answer it with a chosen ease. The interactive voice-review mode needs
 * exactly that, so it talks to the AnkiConnect HTTP API (localhost:8765), which
 * is the de-facto standard for programmatic Anki control.
 *
 * Prerequisite: the AnkiConnect add-on (code 2055492159) installed in Anki, and
 * Anki running. `isAvailable()` checks both in one round-trip.
 *
 * All network I/O goes through an injectable `fetch` so the client is unit-
 * testable without a live server (mirrors AnkiClient's `apyBin` injection seam).
 */

export interface AnkiConnectOptions {
  /** AnkiConnect endpoint. Default http://localhost:8765 */
  endpoint?: string;
  /** Injectable fetch for testing. Defaults to global fetch. */
  fetchFn?: typeof fetch;
  /** Per-request timeout in ms. Default 10000. */
  timeoutMs?: number;
}

/** A due card with its rendered, plain-text question and answer. */
export interface ReviewCard {
  cardId: number;
  deckName: string;
  /** Front side, HTML stripped to plain text (what gets read aloud). */
  question: string;
  /** Back side, HTML stripped to plain text (the reference answer). */
  answer: string;
  /** Raw field map (field name → value), HTML preserved. */
  fields: Record<string, string>;
}

/** Anki's four answer buttons. 1=Again, 2=Hard, 3=Good, 4=Easy. */
export type AnkiEase = 1 | 2 | 3 | 4;

export const EASE_LABEL: Record<AnkiEase, string> = {
  1: "Again",
  2: "Hard",
  3: "Good",
  4: "Easy",
};

interface AnkiConnectResponse<T> {
  result: T;
  error: string | null;
}

/** Shape of a single card as returned by AnkiConnect's `cardsInfo`. */
interface RawCardInfo {
  cardId: number;
  deckName: string;
  question: string;
  answer: string;
  fields: Record<string, { value: string; order: number }>;
}

/**
 * Convert AnkiConnect's HTML question/answer into speakable plain text.
 * Anki renders fields as HTML (with a `<hr id=answer>` separator on the back);
 * we drop tags/entities and collapse whitespace so TTS reads it cleanly.
 */
export function htmlToPlainText(html: string): string {
  return html
    // Anki's answer separator — keep the answer side only when present.
    .replace(/[\s\S]*<hr id=answer>/i, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join("\n")
    .trim();
}

export class AnkiConnectClient {
  private readonly endpoint: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: AnkiConnectOptions = {}) {
    this.endpoint = options.endpoint ?? "http://localhost:8765";
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10000;
  }

  /**
   * Low-level AnkiConnect invocation. Throws on transport error or when
   * AnkiConnect returns a non-null `error` field.
   */
  async invoke<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchFn(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, version: 6, params }),
        signal: controller.signal,
      });
    } catch (err) {
      throw new Error(
        `AnkiConnect request failed (${action}): ${String(err)}. ` +
          `Is Anki running with the AnkiConnect add-on (code 2055492159) installed?`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new Error(`AnkiConnect HTTP ${res.status} for action "${action}"`);
    }

    const body = (await res.json()) as AnkiConnectResponse<T>;
    if (body.error) {
      throw new Error(`AnkiConnect error for "${action}": ${body.error}`);
    }
    return body.result;
  }

  /**
   * True if Anki is running and AnkiConnect answers. Never throws — a down
   * server / missing add-on simply returns false so callers can guide the user.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const version = await this.invoke<number>("version");
      return typeof version === "number" && version >= 6;
    } catch {
      return false;
    }
  }

  /** Card IDs that are currently due, optionally scoped to a deck. */
  async findDueCards(deck?: string): Promise<number[]> {
    const query = deck ? `deck:"${deck}" is:due` : "is:due";
    return this.invoke<number[]>("findCards", { query });
  }

  /** Card IDs answered within the last `days` days (Anki search `rated:N`),
   *  optionally scoped to a deck. The AnkiConnect (Anki-open) leg of the
   *  knowledge-track review-activity signal — see SkillMastery.sweepReviewDue. */
  async findReviewedInLastDay(deck?: string, days = 1): Promise<number[]> {
    const query = deck ? `deck:"${deck}" rated:${days}` : `rated:${days}`;
    return this.invoke<number[]>("findCards", { query });
  }

  /**
   * Fetch rendered card info (plain-text question/answer + raw fields) for the
   * given card IDs, preserving order. AnkiConnect caps well past typical review
   * sizes; callers should slice to a session limit before calling.
   */
  async getReviewCards(cardIds: number[]): Promise<ReviewCard[]> {
    if (cardIds.length === 0) return [];
    const raw = await this.invoke<RawCardInfo[]>("cardsInfo", { cards: cardIds });
    return raw.map((c) => ({
      cardId: c.cardId,
      deckName: c.deckName,
      question: htmlToPlainText(c.question),
      answer: htmlToPlainText(c.answer),
      fields: Object.fromEntries(
        Object.entries(c.fields ?? {}).map(([k, v]) => [k, v.value]),
      ),
    }));
  }

  /**
   * Answer (grade) a single card with the given ease, advancing its schedule
   * exactly as pressing the button in Anki would. Uses `answerCards`, which
   * schedules without needing the reviewer GUI to be open on that card.
   */
  async answerCard(cardId: number, ease: AnkiEase): Promise<boolean> {
    const results = await this.invoke<boolean[]>("answerCards", {
      answers: [{ cardId, ease }],
    });
    return Array.isArray(results) ? results[0] === true : false;
  }
}

// ============================================
// CLI (diagnostics)
// ============================================

if (import.meta.main) {
  const args = process.argv.slice(2);
  const command = args[0];
  const client = new AnkiConnectClient();

  switch (command) {
    case "check": {
      const ok = await client.isAvailable();
      console.log(
        JSON.stringify(
          {
            available: ok,
            hint: ok
              ? undefined
              : "Start Anki and install the AnkiConnect add-on (code 2055492159).",
          },
          null,
          2,
        ),
      );
      process.exit(ok ? 0 : 1);
      break;
    }
    case "due": {
      const deck = args[1];
      const ids = await client.findDueCards(deck);
      const cards = await client.getReviewCards(ids.slice(0, 20));
      console.log(JSON.stringify({ dueCount: ids.length, sample: cards }, null, 2));
      break;
    }
    default:
      console.error("Usage: bun AnkiConnectClient.ts <check|due [deck]>");
      process.exit(1);
  }
}
