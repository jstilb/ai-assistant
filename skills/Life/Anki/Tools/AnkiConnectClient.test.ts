/**
 * Tests for AnkiConnectClient — HTML→text rendering + AnkiConnect protocol.
 * All network I/O goes through an injected fetch, so no live Anki is required.
 */

import { describe, it, expect } from "bun:test";
import { AnkiConnectClient, htmlToPlainText, EASE_LABEL } from "./AnkiConnectClient.ts";

/** Build a fake fetch that records requests and returns canned bodies by action. */
function fakeFetch(
  handler: (action: string, params: Record<string, unknown>) => unknown,
  opts: { httpStatus?: number } = {},
): { fetchFn: typeof fetch; calls: Array<{ action: string; params: Record<string, unknown> }> } {
  const calls: Array<{ action: string; params: Record<string, unknown> }> = [];
  const fetchFn = (async (_url: string, init?: RequestInit) => {
    const parsed = JSON.parse(String(init?.body ?? "{}")) as {
      action: string;
      params: Record<string, unknown>;
    };
    calls.push({ action: parsed.action, params: parsed.params });
    const result = handler(parsed.action, parsed.params);
    return {
      ok: (opts.httpStatus ?? 200) < 400,
      status: opts.httpStatus ?? 200,
      json: async () => ({ result, error: null }),
    } as Response;
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe("htmlToPlainText", () => {
  it("strips tags and decodes entities", () => {
    expect(htmlToPlainText("What is <b>REST</b>?")).toBe("What is REST?");
    expect(htmlToPlainText("a &amp; b &lt;c&gt;")).toBe("a & b <c>");
  });

  it("keeps only the answer side after Anki's <hr id=answer> separator", () => {
    const back = "What is the capital of France?<hr id=answer>Paris";
    expect(htmlToPlainText(back)).toBe("Paris");
  });

  it("converts <br> and block ends to newlines and collapses blank lines", () => {
    expect(htmlToPlainText("line1<br>line2<br><br>line3")).toBe("line1\nline2\nline3");
    expect(htmlToPlainText("<p>a</p><p>b</p>")).toBe("a\nb");
  });

  it("drops style/script blocks", () => {
    expect(htmlToPlainText("<style>.x{color:red}</style>Hi")).toBe("Hi");
  });
});

describe("EASE_LABEL", () => {
  it("maps all four buttons", () => {
    expect(EASE_LABEL[1]).toBe("Again");
    expect(EASE_LABEL[2]).toBe("Hard");
    expect(EASE_LABEL[3]).toBe("Good");
    expect(EASE_LABEL[4]).toBe("Easy");
  });
});

describe("AnkiConnectClient.isAvailable", () => {
  it("returns true when version >= 6", async () => {
    const { fetchFn } = fakeFetch(() => 6);
    const client = new AnkiConnectClient({ fetchFn });
    expect(await client.isAvailable()).toBe(true);
  });

  it("returns false when the server is unreachable (never throws)", async () => {
    const fetchFn = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const client = new AnkiConnectClient({ fetchFn });
    expect(await client.isAvailable()).toBe(false);
  });

  it("returns false on an old AnkiConnect version", async () => {
    const { fetchFn } = fakeFetch(() => 4);
    const client = new AnkiConnectClient({ fetchFn });
    expect(await client.isAvailable()).toBe(false);
  });
});

describe("AnkiConnectClient.findDueCards", () => {
  it("scopes the query to a deck when given", async () => {
    const { fetchFn, calls } = fakeFetch((action) =>
      action === "findCards" ? [1, 2, 3] : null,
    );
    const client = new AnkiConnectClient({ fetchFn });
    const ids = await client.findDueCards("Japanese::N5");
    expect(ids).toEqual([1, 2, 3]);
    expect(calls[0].params.query).toBe('deck:"Japanese::N5" is:due');
  });

  it("uses a global due query with no deck", async () => {
    const { fetchFn, calls } = fakeFetch(() => [7]);
    const client = new AnkiConnectClient({ fetchFn });
    await client.findDueCards();
    expect(calls[0].params.query).toBe("is:due");
  });
});

describe("AnkiConnectClient.getReviewCards", () => {
  it("returns [] without calling the server for empty input", async () => {
    const { fetchFn, calls } = fakeFetch(() => []);
    const client = new AnkiConnectClient({ fetchFn });
    expect(await client.getReviewCards([])).toEqual([]);
    expect(calls.length).toBe(0);
  });

  it("renders question/answer to plain text and flattens fields", async () => {
    const { fetchFn } = fakeFetch((action) =>
      action === "cardsInfo"
        ? [
            {
              cardId: 42,
              deckName: "Geo",
              question: "Capital of <b>France</b>?",
              answer: "Capital of France?<hr id=answer>Paris",
              fields: {
                Front: { value: "Capital of <b>France</b>?", order: 0 },
                Back: { value: "Paris", order: 1 },
              },
            },
          ]
        : null,
    );
    const client = new AnkiConnectClient({ fetchFn });
    const cards = await client.getReviewCards([42]);
    expect(cards).toHaveLength(1);
    expect(cards[0].cardId).toBe(42);
    expect(cards[0].question).toBe("Capital of France?");
    expect(cards[0].answer).toBe("Paris");
    expect(cards[0].fields.Back).toBe("Paris");
  });
});

describe("AnkiConnectClient.answerCard", () => {
  it("sends a single {cardId, ease} answer and reports success", async () => {
    const { fetchFn, calls } = fakeFetch((action) =>
      action === "answerCards" ? [true] : null,
    );
    const client = new AnkiConnectClient({ fetchFn });
    const ok = await client.answerCard(42, 3);
    expect(ok).toBe(true);
    expect(calls[0].action).toBe("answerCards");
    expect(calls[0].params.answers).toEqual([{ cardId: 42, ease: 3 }]);
  });

  it("reports failure when the server returns [false]", async () => {
    const { fetchFn } = fakeFetch(() => [false]);
    const client = new AnkiConnectClient({ fetchFn });
    expect(await client.answerCard(42, 1)).toBe(false);
  });
});

describe("AnkiConnectClient.invoke error handling", () => {
  it("throws when AnkiConnect returns a non-null error", async () => {
    const fetchFn = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ result: null, error: "deck not found" }),
      }) as Response) as unknown as typeof fetch;
    const client = new AnkiConnectClient({ fetchFn });
    await expect(client.findDueCards("Nope")).rejects.toThrow(/deck not found/);
  });

  it("throws with a helpful hint on transport failure", async () => {
    const fetchFn = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    const client = new AnkiConnectClient({ fetchFn });
    await expect(client.findDueCards()).rejects.toThrow(/AnkiConnect add-on/);
  });

  it("throws on non-2xx HTTP status", async () => {
    const { fetchFn } = fakeFetch(() => null, { httpStatus: 500 });
    const client = new AnkiConnectClient({ fetchFn });
    await expect(client.findDueCards()).rejects.toThrow(/HTTP 500/);
  });
});
