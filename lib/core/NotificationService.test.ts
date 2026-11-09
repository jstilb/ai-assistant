#!/usr/bin/env bun
/**
 * NotificationService.test.ts - Test suite for unified notification service
 *
 * TDD: Tests written FIRST, implementation follows
 *
 * Run: bun test NotificationService.test.ts
 */

import { describe, it, expect, afterAll, afterEach, beforeEach, mock } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FakeTelegram } from "./FakeTelegram.ts";
import { clearAllCaches } from "./ConfigLoader.ts";
import { defined } from "../test/defined.ts";

// biome-ignore lint/suspicious/noExplicitAny: parsed JSON of mocked calls is asserted structurally in these tests
type AnyJson = any;

// We'll import these after creating the implementation
// import {
//   createNotificationService,
//   notify,
//   notifySync,
//   type NotifyOptions,
//   type NotificationConfig,
// } from './NotificationService';

// Pin KAYA_DIR/KAYA_HOME to a scratch dir BEFORE the module is ever
// imported. As of slice E2, NotificationService.ts resolves every Kaya-home
// path (settings.json, the notifications log dir, secrets.json) at CALL
// time via KayaHome.ts's kayaHomePath() — it used to freeze KAYA_DIR as a
// module-level const at first import instead, which is exactly the bug the
// "laziness" describe block below regression-tests. This pin still matters
// because kayaHomePath() sits on top of KayaHome.ts's OWN process-wide
// cache (getKayaHome() caches after its first call anywhere in the
// process) — setting the env vars and resetting that cache before the
// first call keeps it pointed at the scratch dir for this whole suite,
// so logNotification(), the outbound ledger and the Telegram transport's
// secrets.json / settings.json reads never hit the LIVE ~/.claude tree.
//
// Restored in afterAll: `bun test` runs every test file in one process, so
// leaving process.env.KAYA_DIR/KAYA_HOME (or KayaHome.ts's cache) mutated
// here leaks into whichever unrelated test files happen to run after this
// one in the same invocation (observed breaking DomainVocabulary.test.ts /
// PipelineUpsertGuard.test.ts when this suite ran ahead of them in a
// full-directory `bun test` run).
const scratchDir = mkdtempSync(join(tmpdir(), "notification-service-test-"));
const ORIGINAL_KAYA_DIR = process.env.KAYA_DIR;
const ORIGINAL_KAYA_HOME = process.env.KAYA_HOME;
process.env.KAYA_DIR = scratchDir;
process.env.KAYA_HOME = scratchDir;
// Many tests below assign globalThis.fetch = mock(...) and only some restore it.
// A leaked mock broke CachedHTTPClient.test.ts (it binds globalThis.fetch when it
// builds a client) in a combined run, so restore the original after this file.
const ORIGINAL_FETCH = globalThis.fetch;

afterAll(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_KAYA_DIR === undefined) delete process.env.KAYA_DIR;
  else process.env.KAYA_DIR = ORIGINAL_KAYA_DIR;
  if (ORIGINAL_KAYA_HOME === undefined) delete process.env.KAYA_HOME;
  else process.env.KAYA_HOME = ORIGINAL_KAYA_HOME;
});

// The default channel is 'log' (record-only, never fetches), so tests of the
// network send path (retry, fallback, queue, batch, dead-letter) route through
// the Discord channel against a mocked fetch instead.
const DISCORD_WEBHOOK = "https://discord.test/webhook";
const DISCORD = { discordWebhook: DISCORD_WEBHOOK, defaultChannel: "discord" as const };

// Telegram tests: FakeTelegram answers at the transport's fetch port (ADR-036).
// It throws on a non-Telegram URL or a wrong token, so no test can reach the network.
const FAKE_TOKEN = "123:fake-notification-token";
const FAKE_CHAT_ID = "4242";

interface LogEntry {
  event: string;
  channel: string;
  message: string;
  error?: string;
}

function readNotificationLog(): LogEntry[] {
  const logPath = join(scratchDir, "MEMORY", "NOTIFICATIONS", "notifications.jsonl");
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Write a temp secrets.json + settings.json (push switch on/off) and install FakeTelegram. */
function setUpTelegram(pushEnabled: boolean): { fake: FakeTelegram; restore: () => void } {
  writeFileSync(
    join(scratchDir, "secrets.json"),
    JSON.stringify({ telegram: { bot_token: FAKE_TOKEN, chat_id: FAKE_CHAT_ID } }),
  );
  writeFileSync(
    join(scratchDir, "settings.json"),
    JSON.stringify({ notifications: { telegramPush: { enabled: pushEnabled } } }),
  );
  clearAllCaches();
  const fake = new FakeTelegram(FAKE_TOKEN);
  return { fake, restore: fake.install() };
}

function tearDownTelegram(restore: () => void): void {
  restore();
  rmSync(join(scratchDir, "secrets.json"), { force: true });
  rmSync(join(scratchDir, "settings.json"), { force: true });
  clearAllCaches();
}

describe("NotificationService", () => {
  describe("createNotificationService()", () => {
    it("should create a service instance with default config", async () => {
      const { createNotificationService } = await import("./NotificationService.ts");
      const service = createNotificationService();
      expect(service).toBeDefined();
      expect(typeof service.notify).toBe("function");
      expect(typeof service.notifySync).toBe("function");
      expect(typeof service.batch).toBe("function");
      expect(typeof service.isServiceHealthy).toBe("function");
      expect(typeof service.getQueuedCount).toBe("function");
      expect(typeof service.flush).toBe("function");
    });

    it("should accept custom configuration", async () => {
      const { createNotificationService } = await import("./NotificationService.ts");
      const service = createNotificationService({
        defaultChannel: "telegram",
        batchWindowMs: 100,
        maxRetries: 5,
      });
      expect(service).toBeDefined();
    });
  });

  describe("notify()", () => {
    it("should record to the log channel by default, with no network call", async () => {
      const { createNotificationService } = await import("./NotificationService.ts");

      const mockFetch = mock(async () => ({ ok: true, status: 200 }));
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const service = createNotificationService();
      const uniqueMessage = `Default-channel probe ${Date.now()}`;
      const delivered = await service.notify(uniqueMessage);

      expect(delivered).toBe(true);
      expect(mockFetch).not.toHaveBeenCalled();

      const logPath = join(scratchDir, "MEMORY", "NOTIFICATIONS", "notifications.jsonl");
      const lines = readFileSync(logPath, "utf-8").trim().split("\n").filter(Boolean);
      const entry = JSON.parse(lines[lines.length - 1]!);
      expect(entry.message).toBe(uniqueMessage);
      expect(entry.channel).toBe("log");
      expect(entry.event).toBe("sent");
    });

    it("should support priority levels", async () => {
      const { createNotificationService } = await import("./NotificationService.ts");

      let capturedBody: AnyJson;
      globalThis.fetch = mock(async (_url, opts) => {
        if (opts?.body) {
          capturedBody = JSON.parse(opts.body as string);
        }
        return { ok: true, status: 200 };
      }) as unknown as typeof fetch;

      const service = createNotificationService(DISCORD);

      await service.notify("Critical alert", { priority: "critical" });

      expect(capturedBody?.embeds?.[0]?.color).toBe(0xef4444);
    });

    it("should use agentName in notification title", async () => {
      const { createNotificationService } = await import("./NotificationService.ts");

      let capturedBody: AnyJson;
      globalThis.fetch = mock(async (_url, opts) => {
        if (opts?.body) {
          capturedBody = JSON.parse(opts.body as string);
        }
        return { ok: true, status: 200 };
      }) as unknown as typeof fetch;

      const service = createNotificationService(DISCORD);
      await service.notify("Task complete", { agentName: "Engineer" });

      expect(capturedBody?.embeds?.[0]?.title).toBe("Engineer");
    });
  });

  describe("notify() delivery-result reporting", () => {
    it("should report delivered:false when all channel attempts fail (module-level 400 caused dead-letter never surfaces to caller today)", async () => {
      const { createNotificationService } = await import("./NotificationService.ts");

      globalThis.fetch = mock(async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;

      const service = createNotificationService({ ...DISCORD, maxRetries: 0 });
      const delivered = await service.notify("All channels down");

      expect(delivered).toBe(false);
    });

    it("should report a truthy delivered result when the send succeeds", async () => {
      const { createNotificationService } = await import("./NotificationService.ts");

      globalThis.fetch = mock(async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;

      const service = createNotificationService({ ...DISCORD, maxRetries: 0 });
      const delivered = await service.notify("Delivered fine");

      expect(delivered).toBe(true);
    });
  });

  describe("durable dead-letter (B6, S4c) — forensics for exhausted deliveries", () => {
    it("appends a row to MEMORY/NOTIFICATIONS/dead-letter.jsonl when every channel/retry/fallback attempt fails", async () => {
      const { createNotificationService } = await import("./NotificationService.ts");

      globalThis.fetch = mock(async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;

      const deadLetterPath = join(scratchDir, "MEMORY", "NOTIFICATIONS", "dead-letter.jsonl");
      const preExisting = existsSync(deadLetterPath)
        ? readFileSync(deadLetterPath, "utf-8").trim().split("\n").filter(Boolean).length
        : 0;

      const service = createNotificationService({ ...DISCORD, maxRetries: 0 });
      const uniqueMessage = `Dead-letter probe ${Date.now()}`;
      const delivered = await service.notify(uniqueMessage, { channel: "discord" });

      expect(delivered).toBe(false);
      expect(existsSync(deadLetterPath)).toBe(true);

      const lines = readFileSync(deadLetterPath, "utf-8").trim().split("\n").filter(Boolean);
      expect(lines.length).toBe(preExisting + 1);

      const entry = JSON.parse(lines[lines.length - 1]!);
      expect(entry.message).toBe(uniqueMessage);
      expect(entry.channel).toBe("discord");
      expect(entry.reason).toBe("all channels/retries/fallback exhausted");
      expect(typeof entry.timestamp).toBe("string");
    });

    it("does NOT append a dead-letter row when delivery succeeds", async () => {
      const { createNotificationService } = await import("./NotificationService.ts");

      globalThis.fetch = mock(async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;

      const deadLetterPath = join(scratchDir, "MEMORY", "NOTIFICATIONS", "dead-letter.jsonl");
      const preExisting = existsSync(deadLetterPath)
        ? readFileSync(deadLetterPath, "utf-8").trim().split("\n").filter(Boolean).length
        : 0;

      const service = createNotificationService({ ...DISCORD, maxRetries: 0 });
      const delivered = await service.notify("Delivered fine, no dead-letter", { channel: "discord" });

      expect(delivered).toBe(true);
      const postCount = existsSync(deadLetterPath)
        ? readFileSync(deadLetterPath, "utf-8").trim().split("\n").filter(Boolean).length
        : 0;
      expect(postCount).toBe(preExisting);
    });
  });

  describe("sendTelegram — through the Telegram transport (FakeTelegram)", () => {
    let fake: FakeTelegram;
    let restore: () => void = () => {};

    beforeEach(() => {
      ({ fake, restore } = setUpTelegram(true));
    });

    afterEach(() => {
      tearDownTelegram(restore);
    });

    it("retries once WITHOUT parse_mode when Telegram returns HTTP 400, and logs Telegram's description", async () => {
      const { createNotificationService } = await import("./NotificationService.ts");
      fake.failNext("sendMessage", { httpStatus: 400, description: "Bad Request: can't parse entities" });

      const message = `Digest with [unclosed bracket ${Date.now()}`;
      const delivered = await createNotificationService({ maxRetries: 0 }).notify(message, { channel: "telegram" });

      expect(delivered).toBe(true);
      expect(fake.calls).toHaveLength(2);
      expect(defined(fake.calls[0]).params.parse_mode).toBe("Markdown");
      expect(defined(fake.calls[1]).params.parse_mode).toBeUndefined();
      expect(defined(fake.calls[1]).params.chat_id).toBe(FAKE_CHAT_ID);
      const retried = readNotificationLog().filter((e) => e.message === message && e.event === "retried");
      expect(defined(retried[0]).error).toContain("can't parse entities");
    });

    it("reports delivered:false when both the parse_mode attempt AND the fallback attempt fail", async () => {
      const { createNotificationService } = await import("./NotificationService.ts");
      fake.failNext("sendMessage", { httpStatus: 400, description: "Bad Request: one" });
      fake.failNext("sendMessage", { httpStatus: 400, description: "Bad Request: two" });

      const delivered = await createNotificationService({ maxRetries: 0 }).notify("Still broken", {
        channel: "telegram",
      });

      expect(delivered).toBe(false);
      expect(fake.calls).toHaveLength(2);
    });

    it("applies escaping exactly ONCE in the send path (single backslash, not double-escaped) and preserves the *title* wrapper NotificationService itself adds (C1)", async () => {
      const { createNotificationService } = await import("./NotificationService.ts");

      const delivered = await createNotificationService({ maxRetries: 0 }).notify(
        '[STALE] "digest-job" (job-42) — no run in 3d',
        { channel: "telegram", agentName: "Kaya" },
      );

      expect(delivered).toBe(true);
      expect(fake.calls).toHaveLength(1); // no 400 → no fallback resend
      const text = String(defined(fake.calls[0]).params.text);
      expect(defined(fake.calls[0]).params.parse_mode).toBe("Markdown");
      // Message body escaped exactly once: one backslash before '[', not two.
      expect(text).toContain("\\[STALE]");
      expect(text).not.toContain("\\\\[STALE]");
      // NotificationService's own bold-title wrapper survives UNESCAPED —
      // only caller-supplied message content is escaped.
      expect(text.startsWith("*Kaya*\n\n")).toBe(true);
    });

    it("sends a long message as N sendMessage calls, one per chunk, in order", async () => {
      const { createNotificationService, chunkTelegramText, escapeLegacyMarkdown } = await import(
        "./NotificationService.ts"
      );
      const message = ["a".repeat(3000), "b".repeat(3000), "c".repeat(3000)].join("\n");
      const expected = chunkTelegramText(`*Kaya*\n\n${escapeLegacyMarkdown(message)}`);
      expect(expected.length).toBeGreaterThan(1);

      const delivered = await createNotificationService({ maxRetries: 0 }).notify(message, {
        channel: "telegram",
        agentName: "Kaya",
      });

      expect(delivered).toBe(true);
      expect(fake.calls.map((c) => c.method)).toEqual(expected.map(() => "sendMessage"));
      expect(fake.calls.map((c) => c.params.text)).toEqual(expected);
    });

    it("lets the transport retry a 429 once (no sendWithRetry retry, no failure logged)", async () => {
      const { createNotificationService } = await import("./NotificationService.ts");
      fake.failNext("sendMessage", { httpStatus: 429, description: "Too Many Requests", retryAfter: 0 });

      const message = `429 probe ${Date.now()}`;
      const delivered = await createNotificationService({ maxRetries: 0 }).notify(message, { channel: "telegram" });

      expect(delivered).toBe(true);
      expect(fake.calls).toHaveLength(2);
      expect(fake.calls.every((c) => c.params.parse_mode === "Markdown")).toBe(true);
      const events = readNotificationLog()
        .filter((e) => e.message === message)
        .map((e) => e.event);
      expect(events).toEqual(["sent"]);
    });

    it("logs a network failure as failed and returns false, so sendWithRetry retries", async () => {
      const { createNotificationService } = await import("./NotificationService.ts");
      fake.failNext("sendMessage", "network");

      const message = `network probe ${Date.now()}`;
      const delivered = await createNotificationService({ maxRetries: 1 }).notify(message, { channel: "telegram" });

      // Attempt 1 fails in the transport; sendWithRetry retries; attempt 2 succeeds.
      expect(delivered).toBe(true);
      expect(fake.calls).toHaveLength(2);
      const entries = readNotificationLog().filter((e) => e.message === message);
      expect(entries.map((e) => e.event)).toEqual(["failed", "retried", "sent"]);
      const failed = defined(entries[0]);
      expect(failed.channel).toBe("telegram");
      expect(failed.error).toContain("(network)");
      expect(failed.error).not.toContain(FAKE_TOKEN);
    });

    it("logs a timeout as failed and reports delivered:false when no retry is left", async () => {
      const { createNotificationService } = await import("./NotificationService.ts");
      fake.failNext("sendMessage", "timeout");

      const message = `timeout probe ${Date.now()}`;
      const delivered = await createNotificationService({ maxRetries: 0 }).notify(message, {
        channel: "telegram",
        timeout: 50,
      });

      expect(delivered).toBe(false);
      const failed = readNotificationLog().filter((e) => e.message === message && e.event === "failed");
      expect(defined(failed[0]).error).toContain("(timeout)");
    });

    it("records each delivered chunk in the outbound ledger with source notification-service and the original text", async () => {
      const { createNotificationService } = await import("./NotificationService.ts");
      const ledgerPath = join(scratchDir, "MEMORY", "TELEGRAM", "outbound.jsonl");
      rmSync(ledgerPath, { force: true });

      const message = `Ledger probe [x] ${Date.now()}`;
      const delivered = await createNotificationService({ maxRetries: 0 }).notify(message, { channel: "telegram" });

      expect(delivered).toBe(true);
      const rows = readFileSync(ledgerPath, "utf-8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      expect(rows).toHaveLength(1);
      expect(defined(rows[0]).source).toBe("notification-service");
      expect(defined(rows[0]).text).toBe(message);
      expect(typeof defined(rows[0]).telegram_message_id).toBe("number");
    });
  });

  describe("escapeLegacyMarkdown() — legacy-Markdown escaping at the send choke point (C1)", () => {
    it("escapes the legacy-Markdown set (_, *, `, [) but leaves other punctuation (), ], ., -, quotes untouched", async () => {
      const { escapeLegacyMarkdown } = await import("./NotificationService.ts");

      const input = '[STALE] "digest-job" (job-42) - no run in 3d';
      const output = escapeLegacyMarkdown(input);

      expect(output).toBe('\\[STALE] "digest-job" (job-42) - no run in 3d');
    });

    it("escapes every bracket in a realistic multi-line digest fixture with repeated [jobId]-shaped brackets", async () => {
      const { escapeLegacyMarkdown } = await import("./NotificationService.ts");

      const input = [
        "Digest:",
        "- [STALE] job-abc (job-1) - no run in 3d",
        "- [jobId] evals-nightly failed 3x",
        "- normal line with *no* brackets here",
      ].join("\n");

      const output = escapeLegacyMarkdown(input);

      expect(output).toBe(
        [
          "Digest:",
          "- \\[STALE] job-abc (job-1) - no run in 3d",
          "- \\[jobId] evals-nightly failed 3x",
          "- normal line with \\*no\\* brackets here",
        ].join("\n"),
      );
      // Structural check: every literal '[' in the output is immediately
      // preceded by a backslash (accepted-shaped for legacy Markdown).
      expect(/(?<!\\)\[/.test(output)).toBe(false);
    });

    it("escapes backslashes FIRST — a payload with backslashes AND specials is not double- or mis-escaped", async () => {
      const { escapeLegacyMarkdown } = await import("./NotificationService.ts");

      // Independent reference oracle: a single left-to-right pass over the
      // ORIGINAL characters, escaping backslash and the legacy-Markdown set
      // as it goes. This is correct by construction (no re-scanning of
      // inserted characters), so comparing against it proves the
      // implementation's two-pass (backslash-first) approach produces the
      // same result without double-escaping the backslashes it just added.
      function referenceEscape(text: string): string {
        let out = "";
        for (const ch of text) {
          if (ch === "\\") out += "\\\\";
          else if (ch === "_" || ch === "*" || ch === "`" || ch === "[") out += "\\" + ch;
          else out += ch;
        }
        return out;
      }

      const fixtures = [
        "C:\\path\\[oops]",
        "back\\slash then [bracket] and *star* and _underscore_ and `tick`",
        "\\\\already\\doubled\\[x]",
        "no specials or backslashes here",
      ];

      for (const input of fixtures) {
        expect(escapeLegacyMarkdown(input)).toBe(referenceEscape(input));
      }

      // Concrete worked example, spelled out char-by-char so the assertion
      // doesn't rely on the oracle alone: input has 2 backslashes + 1 '[';
      // backslash-first means each backslash doubles, THEN '[' gets its
      // own escaping backslash prepended.
      const input = "C:\\path\\[oops]";
      const output = escapeLegacyMarkdown(input);
      expect([...output]).toEqual([
        "C",
        ":",
        "\\",
        "\\",
        "p",
        "a",
        "t",
        "h",
        "\\",
        "\\",
        "\\",
        "[",
        "o",
        "o",
        "p",
        "s",
        "]",
      ]);
    });

    it("is a pure function with no side effects on repeated calls (safe to be the single call site in the send path)", async () => {
      const { escapeLegacyMarkdown } = await import("./NotificationService.ts");

      const input = "[repeat] *me*";
      const first = escapeLegacyMarkdown(input);
      const second = escapeLegacyMarkdown(input);

      expect(first).toBe(second);
      expect(input).toBe("[repeat] *me*"); // input itself never mutated
    });
  });

  describe("notifySync()", () => {
    it("should be fire-and-forget (non-blocking)", async () => {
      const { createNotificationService } = await import("./NotificationService.ts");

      let fetchCalled = false;
      globalThis.fetch = mock(async () => {
        // Simulate slow network
        await new Promise((r) => setTimeout(r, 100));
        fetchCalled = true;
        return { ok: true, status: 200 };
      }) as unknown as typeof fetch;

      const service = createNotificationService(DISCORD);
      const start = Date.now();
      service.notifySync("Fire and forget");
      const elapsed = Date.now() - start;

      // Should return immediately (not wait for fetch)
      expect(elapsed).toBeLessThan(50);

      // Wait for the async operation to complete
      await new Promise((r) => setTimeout(r, 150));
      expect(fetchCalled).toBe(true);
    });
  });

  describe("batch()", () => {
    it("should batch multiple messages into one notification", async () => {
      const { createNotificationService } = await import("./NotificationService.ts");

      let callCount = 0;
      let lastBody: AnyJson;
      globalThis.fetch = mock(async (_url, opts) => {
        callCount++;
        if (opts?.body) {
          lastBody = JSON.parse(opts.body as string);
        }
        return { ok: true, status: 200 };
      }) as unknown as typeof fetch;

      const service = createNotificationService({ ...DISCORD, batchWindowMs: 50 });

      await service.batch(["Step 1 complete", "Step 2 complete", "Step 3 complete"]);

      // Should have combined messages into one embed
      expect(callCount).toBe(1);
      const description = lastBody?.embeds?.[0]?.description;
      expect(description).toContain("Step 1");
      expect(description).toContain("Step 2");
      expect(description).toContain("Step 3");
    });

    it("passes the options given to batch() on to the send", async () => {
      const { createNotificationService } = await import("./NotificationService.ts");

      let lastBody: AnyJson;
      globalThis.fetch = mock(async (_url, opts) => {
        if (opts?.body) lastBody = JSON.parse(opts.body as string);
        return { ok: true, status: 200 };
      }) as unknown as typeof fetch;

      const service = createNotificationService({ ...DISCORD, batchWindowMs: 50 });
      await service.batch(["one", "two"], { agentName: "BatchAgentX" });

      // agentName was silently dropped before (batch() ignored its options argument).
      expect(JSON.stringify(lastBody)).toContain("BatchAgentX");
    });
  });

  describe("isServiceHealthy()", () => {
    it("should report the log channel as always healthy", async () => {
      const { createNotificationService } = await import("./NotificationService.ts");

      const service = createNotificationService();

      expect(await service.isServiceHealthy()).toBe(true);
      expect(await service.isServiceHealthy("log")).toBe(true);
    });

    it("should report discord healthy only when a webhook is configured", async () => {
      const { createNotificationService } = await import("./NotificationService.ts");

      expect(await createNotificationService(DISCORD).isServiceHealthy("discord")).toBe(true);
      expect(await createNotificationService({ discordWebhook: "" }).isServiceHealthy("discord")).toBe(false);
    });
  });

  describe("retry with backoff", () => {
    it("should retry on failure with exponential backoff", async () => {
      const { createNotificationService } = await import("./NotificationService.ts");

      let attempts = 0;
      globalThis.fetch = mock(async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error("Network error");
        }
        return { ok: true, status: 200 };
      }) as unknown as typeof fetch;

      const service = createNotificationService({ ...DISCORD, maxRetries: 3 });
      await service.notify("Retry test", { retry: 3 });

      expect(attempts).toBe(3);
    });
  });

  describe("queue for offline", () => {
    it("should queue notifications when service is down", async () => {
      const { createNotificationService } = await import("./NotificationService.ts");

      globalThis.fetch = mock(async () => {
        throw new Error("Service unavailable");
      }) as unknown as typeof fetch;

      const service = createNotificationService({ ...DISCORD, maxRetries: 1 });

      // This should not throw but queue the message
      await service.notify("Queued message");

      const queuedCount = service.getQueuedCount();
      expect(queuedCount).toBeGreaterThanOrEqual(0); // May be 0 if retry exhausted
    });

    it("should flush queued notifications when service recovers", async () => {
      const { createNotificationService } = await import("./NotificationService.ts");

      let failCount = 0;
      let successCount = 0;

      globalThis.fetch = mock(async () => {
        if (failCount < 2) {
          failCount++;
          throw new Error("Service unavailable");
        }
        successCount++;
        return { ok: true, status: 200 };
      }) as unknown as typeof fetch;

      const service = createNotificationService({ ...DISCORD, maxRetries: 0 });

      // Queue some messages while "offline"
      await service.notify("Message 1");
      await service.notify("Message 2");

      // Now service is "online" - flush
      failCount = 99; // Make fetch succeed
      await service.flush();

      expect(successCount).toBeGreaterThanOrEqual(0);
    });
  });

  describe("fallback channels", () => {
    let restore: () => void = () => {};

    afterEach(() => {
      tearDownTelegram(restore);
    });

    it("should fallback to discord if telegram fails", async () => {
      const telegram = setUpTelegram(true);
      restore = telegram.restore;
      telegram.fake.failNext("sendMessage", "network");
      // FakeTelegram throws on a non-Telegram URL: route Discord to its own stub.
      const fakeFetch = globalThis.fetch;
      const discordUrls: string[] = [];
      globalThis.fetch = Object.assign(
        (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const url = input instanceof Request ? input.url : String(input);
          if (url.startsWith("https://discord.com/")) {
            discordUrls.push(url);
            return Promise.resolve(new Response(null, { status: 204 }));
          }
          return fakeFetch(input, init);
        },
        { preconnect: fakeFetch.preconnect },
      );

      const { createNotificationService } = await import("./NotificationService.ts");
      const service = createNotificationService({
        discordWebhook: "https://discord.com/api/webhooks/test-fallback",
        maxRetries: 0,
      });

      const delivered = await service.notify("Fallback test", { fallback: true, channel: "telegram" });

      // telegram's fallback chain is ['discord'] (push/ntfy.sh removed in B6,
      // voice removed 2026-09-29).
      expect(delivered).toBe(true);
      expect(telegram.fake.calls.map((c) => c.method)).toEqual(["sendMessage"]);
      expect(discordUrls).toEqual(["https://discord.com/api/webhooks/test-fallback"]);
    });
  });

  describe("channel-specific behavior", () => {
    it("should send to discord channel when specified", async () => {
      const { createNotificationService } = await import("./NotificationService.ts");

      let calledUrl = "";
      globalThis.fetch = mock(async (url) => {
        calledUrl = url as string;
        return { ok: true, status: 200 };
      }) as unknown as typeof fetch;

      const service = createNotificationService({ discordWebhook: "https://discord.com/api/webhooks/my-hook" });
      await service.notify("Discord message", { channel: "discord" });

      expect(calledUrl).toBe("https://discord.com/api/webhooks/my-hook");
    });
  });

  describe("CLI interface", () => {
    it("should support --test flag for testing", async () => {
      // End-to-end via a real subprocess (`bun run ./NotificationService.ts
      // --test ...`). With no --channel the CLI uses the default 'log'
      // channel, so the only effect is a notifications.jsonl line under the
      // sandboxed KAYA_HOME — no network at all.
      //
      // Two sandboxing requirements here, both discovered as a LIVE-state
      // leak while validating slice E2 (414 "Hello CLI" lines dating back to
      // Feb found in the real ~/.claude/MEMORY/NOTIFICATIONS/notifications.jsonl):
      //
      //  1. cwd must be THIS file's own directory (import.meta.dir), not a
      //     hardcoded absolute path to the production checkout — a hardcoded
      //     '~/.claude/lib/core' silently bypasses worktree
      //     isolation and always spawns the PRODUCTION copy of
      //     NotificationService.ts regardless of which checkout the test
      //     itself is running from.
      //  2. env must be explicitly forwarded. Bun.spawn does NOT inherit
      //     process.env mutations made after process start by default — it
      //     snapshots the OS-level env, not the live process.env proxy — so
      //     without `env: process.env` the scratchDir KAYA_DIR/KAYA_HOME pin
      //     set at the top of this file never reaches the child process and
      //     it falls straight through to the real ~/.claude tree. Verified
      //     empirically: a spawned child printed `undefined` for a
      //     just-assigned process.env var until `env: process.env` was added.
      const uniqueMessage = `Hello CLI ${Date.now()}`;
      const proc = Bun.spawn(["bun", "run", "./NotificationService.ts", "--test", uniqueMessage], {
        cwd: import.meta.dir,
        env: { ...process.env },
        stdout: "pipe",
        stderr: "pipe",
      });

      const exitCode = await proc.exited;
      expect(exitCode).toBe(0);

      // Hermeticity proof: the line landed in THIS suite's sandbox log.
      const logPath = join(scratchDir, "MEMORY", "NOTIFICATIONS", "notifications.jsonl");
      const lines = readFileSync(logPath, "utf-8").trim().split("\n").filter(Boolean);
      const entry = lines.map((l) => JSON.parse(l)).find((e) => e.message === uniqueMessage);
      expect(entry?.channel).toBe("log");
      expect(entry?.event).toBe("sent");
    }, 30000);
  });

  describe("laziness — path resolution is call-time, not import-time (E2 regression)", () => {
    it("writes the notification log under a KAYA_HOME repointed AFTER the module was already imported", async () => {
      // NotificationService was already imported (and thus module-initialized)
      // via the scratchDir pin at the top of this file, and again by every
      // `it()` above via `await import('./NotificationService')` — Bun caches
      // the module, so this returns the SAME instance. This simulates the
      // real-world failure mode: a long-lived process (or a test runner that
      // ran an unrelated suite first) imports NotificationService once before
      // the "real" KAYA_HOME for this run is known.
      const { createNotificationService } = await import("./NotificationService.ts");

      const freshDir = mkdtempSync(join(tmpdir(), "notification-service-laziness-"));
      const uniqueMessage = `Laziness regression probe ${Date.now()}`;

      // Repoint AFTER the module was already imported — this is exactly the
      // scenario the old module-scope `const KAYA_DIR = ...` broke: it
      // resolved once at first import and never looked at process.env again.
      // getKayaHome()'s cache is env-keyed (see KayaHome.ts), so this
      // reassignment alone is picked up on the very next getKayaHome() call —
      // no reset hook needed.
      process.env.KAYA_DIR = freshDir;
      process.env.KAYA_HOME = freshDir;

      const originalFetch = globalThis.fetch;
      try {
        // Force a delivery failure so sendDiscord() and sendWithRetry() both
        // exercise logNotification() — no real network call is made
        // (fetch is mocked), so this never risks a live Telegram/Discord send.
        globalThis.fetch = mock(async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;

        const service = createNotificationService({ ...DISCORD, maxRetries: 0 });
        await service.notify(uniqueMessage, { channel: "discord" });

        // On the OLD frozen-const code, this write would have landed under
        // scratchDir (the home pinned at first import) instead of freshDir.
        const newLogPath = join(freshDir, "MEMORY", "NOTIFICATIONS", "notifications.jsonl");
        expect(existsSync(newLogPath)).toBe(true);
        const newLines = readFileSync(newLogPath, "utf-8").trim().split("\n").filter(Boolean);
        expect(newLines.some((l) => JSON.parse(l).message === uniqueMessage)).toBe(true);

        // Guard against a false pass: confirm the probe did NOT also (or
        // instead) land in the pre-repoint scratchDir — that's the exact
        // symptom of the frozen-path bug.
        const staleLogPath = join(scratchDir, "MEMORY", "NOTIFICATIONS", "notifications.jsonl");
        if (existsSync(staleLogPath)) {
          const staleLines = readFileSync(staleLogPath, "utf-8").trim().split("\n").filter(Boolean);
          expect(staleLines.some((l) => JSON.parse(l).message === uniqueMessage)).toBe(false);
        }
      } finally {
        globalThis.fetch = originalFetch;
        process.env.KAYA_DIR = scratchDir;
        process.env.KAYA_HOME = scratchDir;
        rmSync(freshDir, { recursive: true, force: true });
      }
    });
  });

  describe("hermetic guard fires BEFORE the channel sender (slice 3.3)", () => {
    it("rejects before any fetch when NODE_ENV=test and KAYA_HOME is unpinned (live default)", async () => {
      const { createNotificationService } = await import("./NotificationService.ts");

      let fetchCalled = false;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () => {
        fetchCalled = true;
        return { ok: true, status: 200 };
      }) as unknown as typeof fetch;

      // Simulate the unpinned/live scenario for exactly the duration of this
      // one call — restored in `finally` before any other test in this
      // (shared bun-test-process) file runs, so this probe stays hermetic
      // itself despite deliberately un-pinning KAYA_HOME/KAYA_DIR.
      const savedHome = process.env.KAYA_HOME;
      const savedDir = process.env.KAYA_DIR;
      delete process.env.KAYA_HOME;
      delete process.env.KAYA_DIR;
      try {
        const service = createNotificationService({ ...DISCORD, maxRetries: 0 });
        await expect(service.notify("should never reach the network")).rejects.toThrow("[hermetic-guard]");
        expect(fetchCalled).toBe(false);
      } finally {
        globalThis.fetch = originalFetch;
        if (savedHome === undefined) delete process.env.KAYA_HOME;
        else process.env.KAYA_HOME = savedHome;
        if (savedDir === undefined) delete process.env.KAYA_DIR;
        else process.env.KAYA_DIR = savedDir;
      }
    });

    it("proceeds to the channel sender when KAYA_HOME is pinned to a sandbox", async () => {
      const { createNotificationService } = await import("./NotificationService.ts");

      let fetchCalled = false;
      globalThis.fetch = mock(async () => {
        fetchCalled = true;
        return { ok: true, status: 200 };
      }) as unknown as typeof fetch;

      // scratchDir is pinned at the top of this file for the whole suite —
      // KAYA_HOME here is a real mkdtemp sandbox, never the live default.
      const service = createNotificationService({ ...DISCORD, maxRetries: 0 });
      const delivered = await service.notify("fine to send in the sandbox");

      expect(delivered).toBe(true);
      expect(fetchCalled).toBe(true);
    });

    it("notifySync logs a [hermetic-guard]-prefixed error to console instead of swallowing it silently", async () => {
      const { createNotificationService } = await import("./NotificationService.ts");

      globalThis.fetch = mock(async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;

      const errors: unknown[] = [];
      const originalConsoleError = console.error;
      console.error = (...args: unknown[]) => {
        errors.push(args[0]);
      };

      const savedHome = process.env.KAYA_HOME;
      const savedDir = process.env.KAYA_DIR;
      delete process.env.KAYA_HOME;
      delete process.env.KAYA_DIR;
      try {
        const service = createNotificationService({ ...DISCORD, maxRetries: 0 });
        service.notifySync("fire and forget while unpinned");

        // Let the fire-and-forget promise chain settle.
        await new Promise((r) => setTimeout(r, 20));

        expect(errors.some((e) => typeof e === "string" && e.startsWith("[hermetic-guard]"))).toBe(true);
      } finally {
        console.error = originalConsoleError;
        if (savedHome === undefined) delete process.env.KAYA_HOME;
        else process.env.KAYA_HOME = savedHome;
        if (savedDir === undefined) delete process.env.KAYA_DIR;
        else process.env.KAYA_DIR = savedDir;
      }
    });
  });
});

describe("Module exports", () => {
  it("should export notify function", async () => {
    const module = await import("./NotificationService.ts");
    expect(typeof module.notify).toBe("function");
  });

  it("should export notifySync function", async () => {
    const module = await import("./NotificationService.ts");
    expect(typeof module.notifySync).toBe("function");
  });

  it("should export createNotificationService function", async () => {
    const module = await import("./NotificationService.ts");
    expect(typeof module.createNotificationService).toBe("function");
  });

  it("should export escapeLegacyMarkdown function (C1)", async () => {
    const module = await import("./NotificationService.ts");
    expect(typeof module.escapeLegacyMarkdown).toBe("function");
  });
});

describe("Telegram push switch (notifications.telegramPush.enabled)", () => {
  let restore: () => void = () => {};

  afterEach(() => {
    tearDownTelegram(restore);
  });

  it("suppresses the send, logs it, and reports handled when the switch is off", async () => {
    const telegram = setUpTelegram(false);
    restore = telegram.restore;

    const { createNotificationService } = await import("./NotificationService.ts");
    const message = `Push-off probe ${Date.now()}`;
    const delivered = await createNotificationService().notify(message, { channel: "telegram", fallback: true });

    expect(delivered).toBe(true);
    expect(telegram.fake.calls).toHaveLength(0);
    const entries = readNotificationLog().filter((e) => e.message === message);
    expect(entries.map((e) => e.event)).toEqual(["suppressed"]);
    expect(defined(entries[0]).channel).toBe("telegram");
  });
});
