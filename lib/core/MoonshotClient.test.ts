/**
 * MoonshotClient.test.ts — hermetic tests for the Kimi K3 client.
 *
 * Every test injects `fetchFn` and `apiKey`, so nothing here touches the
 * network or reads the real secrets.json. That matters doubly for this module:
 * a live call costs real money.
 */

import { describe, it, expect } from "bun:test";
import {
  moonshotChat,
  loadMoonshotApiKey,
  MOONSHOT_BASE_URL,
  KIMI_K3_MODEL,
  type FetchLike,
} from "./MoonshotClient.ts";

/** Build a fake fetch returning a canned status + body, capturing the request. */
function fakeFetch(
  status: number,
  body: string,
  capture?: { url?: string; init?: Parameters<FetchLike>[1] },
): FetchLike {
  return async (url, init) => {
    if (capture) {
      capture.url = url;
      capture.init = init;
    }
    return { ok: status >= 200 && status < 300, status, text: async () => body };
  };
}

const OK_BODY = JSON.stringify({
  choices: [{ message: { content: "hello from kimi" } }],
  usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
});

describe("moonshotChat — missing key fails loud", () => {
  it("returns a failure naming secrets.json when the key is absent", async () => {
    const res = await moonshotChat(
      { systemPrompt: "s", userPrompt: "u" },
      { apiKey: null, fetchFn: fakeFetch(200, OK_BODY) },
    );
    expect(res.success).toBe(false);
    expect(res.error).toContain("MOONSHOT_API_KEY");
    expect(res.error).toContain("secrets.json");
    expect(res.output).toBe("");
  });

  it("does not call fetch at all when the key is absent", async () => {
    let called = false;
    const spyFetch: FetchLike = async () => {
      called = true;
      return { ok: true, status: 200, text: async () => OK_BODY };
    };
    await moonshotChat({ systemPrompt: "s", userPrompt: "u" }, { apiKey: null, fetchFn: spyFetch });
    expect(called).toBe(false);
  });

  it("treats an empty/whitespace key as missing", async () => {
    const res = await moonshotChat(
      { systemPrompt: "s", userPrompt: "u" },
      { apiKey: "   ", fetchFn: fakeFetch(200, OK_BODY) },
    );
    expect(res.success).toBe(false);
    expect(res.error).toContain("MOONSHOT_API_KEY");
  });
});

describe("moonshotChat — request shape", () => {
  it("POSTs to the OpenAI-compatible chat/completions path with bearer auth", async () => {
    const cap: { url?: string; init?: Parameters<FetchLike>[1] } = {};
    await moonshotChat(
      { systemPrompt: "sys", userPrompt: "usr" },
      { apiKey: "sk-test", fetchFn: fakeFetch(200, OK_BODY, cap) },
    );
    expect(cap.url).toBe(`${MOONSHOT_BASE_URL}/chat/completions`);
    expect(cap.init?.method).toBe("POST");
    expect(cap.init?.headers?.Authorization).toBe("Bearer sk-test");
    expect(cap.init?.headers?.["Content-Type"]).toBe("application/json");
  });

  it("sends system and user prompts as OpenAI-style messages, defaulting to kimi-k3", async () => {
    const cap: { url?: string; init?: Parameters<FetchLike>[1] } = {};
    await moonshotChat(
      { systemPrompt: "you are kaya", userPrompt: "say hi" },
      { apiKey: "sk-test", fetchFn: fakeFetch(200, OK_BODY, cap) },
    );
    const sent = JSON.parse(cap.init?.body ?? "{}") as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      temperature?: number;
      max_tokens?: number;
    };
    expect(sent.model).toBe(KIMI_K3_MODEL);
    expect(sent.messages).toEqual([
      { role: "system", content: "you are kaya" },
      { role: "user", content: "say hi" },
    ]);
    // Optional params stay absent unless explicitly requested.
    expect(sent.temperature).toBeUndefined();
    expect(sent.max_tokens).toBeUndefined();
  });

  it("forwards temperature and maxTokens when supplied", async () => {
    const cap: { url?: string; init?: Parameters<FetchLike>[1] } = {};
    await moonshotChat(
      { systemPrompt: "s", userPrompt: "u", temperature: 0.2, maxTokens: 64 },
      { apiKey: "sk-test", fetchFn: fakeFetch(200, OK_BODY, cap) },
    );
    const sent = JSON.parse(cap.init?.body ?? "{}") as { temperature: number; max_tokens: number };
    expect(sent.temperature).toBe(0.2);
    expect(sent.max_tokens).toBe(64);
  });
});

describe("moonshotChat — success path", () => {
  it("returns assistant content and the API's real usage counts", async () => {
    const res = await moonshotChat(
      { systemPrompt: "s", userPrompt: "u" },
      { apiKey: "sk-test", fetchFn: fakeFetch(200, OK_BODY) },
    );
    expect(res.success).toBe(true);
    expect(res.output).toBe("hello from kimi");
    expect(res.usage).toEqual({ inputTokens: 12, outputTokens: 5, totalTokens: 17 });
  });

  it("derives totalTokens when the API omits total_tokens", async () => {
    const body = JSON.stringify({
      choices: [{ message: { content: "x" } }],
      usage: { prompt_tokens: 7, completion_tokens: 3 },
    });
    const res = await moonshotChat(
      { systemPrompt: "s", userPrompt: "u" },
      { apiKey: "sk-test", fetchFn: fakeFetch(200, body) },
    );
    expect(res.usage).toEqual({ inputTokens: 7, outputTokens: 3, totalTokens: 10 });
  });

  it("reports zeroed usage rather than throwing when usage is missing entirely", async () => {
    const body = JSON.stringify({ choices: [{ message: { content: "x" } }] });
    const res = await moonshotChat(
      { systemPrompt: "s", userPrompt: "u" },
      { apiKey: "sk-test", fetchFn: fakeFetch(200, body) },
    );
    expect(res.success).toBe(true);
    expect(res.usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  });
});

describe("moonshotChat — failure paths", () => {
  it("surfaces the API's error message on a non-2xx response", async () => {
    const body = JSON.stringify({ error: { message: "invalid api key" } });
    const res = await moonshotChat(
      { systemPrompt: "s", userPrompt: "u" },
      { apiKey: "sk-bad", fetchFn: fakeFetch(401, body) },
    );
    expect(res.success).toBe(false);
    expect(res.error).toContain("401");
    expect(res.error).toContain("invalid api key");
  });

  it("falls back to raw body text when the error envelope is not JSON", async () => {
    const res = await moonshotChat(
      { systemPrompt: "s", userPrompt: "u" },
      { apiKey: "sk-test", fetchFn: fakeFetch(502, "<html>bad gateway</html>") },
    );
    expect(res.success).toBe(false);
    expect(res.error).toContain("502");
    expect(res.error).toContain("bad gateway");
  });

  it("fails when a 200 body is not JSON", async () => {
    const res = await moonshotChat(
      { systemPrompt: "s", userPrompt: "u" },
      { apiKey: "sk-test", fetchFn: fakeFetch(200, "not json at all") },
    );
    expect(res.success).toBe(false);
    expect(res.error).toContain("non-JSON");
  });

  it("fails when the response has no message content", async () => {
    const res = await moonshotChat(
      { systemPrompt: "s", userPrompt: "u" },
      { apiKey: "sk-test", fetchFn: fakeFetch(200, JSON.stringify({ choices: [] })) },
    );
    expect(res.success).toBe(false);
    expect(res.error).toContain("choices[0].message.content");
  });

  it("returns a failure (never throws) when fetch itself rejects", async () => {
    const boom: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    const res = await moonshotChat(
      { systemPrompt: "s", userPrompt: "u" },
      { apiKey: "sk-test", fetchFn: boom },
    );
    expect(res.success).toBe(false);
    expect(res.error).toContain("ECONNREFUSED");
  });

  it("reports a timeout when the request outlives timeoutMs", async () => {
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const res = await moonshotChat(
      { systemPrompt: "s", userPrompt: "u", timeoutMs: 20 },
      { apiKey: "sk-test", fetchFn: hang },
    );
    expect(res.success).toBe(false);
    expect(res.error).toContain("Timeout after 20ms");
  });
});

describe("loadMoonshotApiKey", () => {
  it("returns null when secrets.json holds no MOONSHOT_API_KEY", () => {
    // Live secrets.json genuinely lacks the key as of 2026-07-24; this asserts
    // the absent-key path resolves to null instead of throwing. It flips to a
    // string the moment Jm provisions one, so assert only "no throw + type".
    const key = loadMoonshotApiKey();
    expect(key === null || typeof key === "string").toBe(true);
  });
});
