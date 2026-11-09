/**
 * TelegramOutboundLedger.test.ts — hermetic tests for the Phase A1 outbound
 * ledger (record / lookup / recency window). KAYA_HOME is pinned to a mkdtemp
 * dir per test; no network, no live state.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordOutbound, findByMessageId, recentOutbound, isTelegramPushEnabled } from "./TelegramOutboundLedger.ts";
import { clearAllCaches } from "./ConfigLoader.ts";

let tempHome: string;
const savedKayaHome = process.env.KAYA_HOME;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "tg-outbound-ledger-test-"));
  process.env.KAYA_HOME = tempHome;
});

afterEach(() => {
  if (savedKayaHome === undefined) delete process.env.KAYA_HOME;
  else process.env.KAYA_HOME = savedKayaHome;
});

describe("recordOutbound", () => {
  it("appends a record readable by findByMessageId", () => {
    recordOutbound({ messageId: 42, source: "test-sender", text: "Task added: buy milk" });

    const found = findByMessageId(42);
    expect(found).not.toBeNull();
    expect(found!.telegram_message_id).toBe(42);
    expect(found!.source).toBe("test-sender");
    expect(found!.text).toBe("Task added: buy milk");
    expect(new Date(found!.timestamp).getTime()).not.toBeNaN();
  });

  it("writes to MEMORY/TELEGRAM/outbound.jsonl under KAYA_HOME", () => {
    recordOutbound({ messageId: 1, source: "s", text: "hello" });
    const path = join(tempHome, "MEMORY", "TELEGRAM", "outbound.jsonl");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf-8")).toContain('"telegram_message_id":1');
  });

  it("truncates very long texts", () => {
    recordOutbound({ messageId: 7, source: "s", text: "x".repeat(5000) });
    const found = findByMessageId(7);
    expect(found!.text.length).toBeLessThanOrEqual(1501); // 1500 + ellipsis
  });

  it("newest record wins on duplicate message_id", () => {
    recordOutbound({ messageId: 9, source: "old", text: "old text" });
    recordOutbound({ messageId: 9, source: "new", text: "new text" });
    expect(findByMessageId(9)!.source).toBe("new");
  });
});

describe("findByMessageId", () => {
  it("returns null when the ledger does not exist", () => {
    expect(findByMessageId(123)).toBeNull();
  });

  it("returns null for an unknown id", () => {
    recordOutbound({ messageId: 1, source: "s", text: "t" });
    expect(findByMessageId(999)).toBeNull();
  });
});

describe("recentOutbound", () => {
  it("returns entries within the window, newest first", () => {
    recordOutbound({ messageId: 1, source: "s", text: "first" });
    recordOutbound({ messageId: 2, source: "s", text: "second" });
    recordOutbound({ messageId: 3, source: "s", text: "third" });

    const recent = recentOutbound({ windowMs: 60_000, limit: 2 });
    expect(recent).toHaveLength(2);
    expect(recent[0]!.text).toBe("third");
    expect(recent[1]!.text).toBe("second");
  });

  it("excludes entries older than the window", () => {
    recordOutbound({ messageId: 1, source: "s", text: "old" });
    const recent = recentOutbound({ windowMs: 60_000, nowMs: Date.now() + 120_000 });
    expect(recent).toHaveLength(0);
  });

  it("returns empty when the ledger does not exist", () => {
    expect(recentOutbound()).toHaveLength(0);
  });
});

describe("hermetic guard", () => {
  it("refuses to write against the live home under NODE_ENV=test", () => {
    delete process.env.KAYA_HOME;
    delete process.env.KAYA_DIR;
    expect(() => recordOutbound({ messageId: 1, source: "s", text: "t" })).toThrow(/hermetic-guard/);
  });
});

describe("isTelegramPushEnabled", () => {
  beforeEach(() => clearAllCaches());
  afterEach(() => clearAllCaches());

  it("is enabled when settings.json is absent", () => {
    expect(isTelegramPushEnabled()).toBe(true);
  });

  it("is enabled when notifications.telegramPush is unset", () => {
    writeFileSync(
      join(tempHome, "settings.json"),
      JSON.stringify({ notifications: { quietHours: { enabled: true } } }),
    );
    expect(isTelegramPushEnabled()).toBe(true);
  });

  it("is disabled when notifications.telegramPush.enabled is false", () => {
    writeFileSync(
      join(tempHome, "settings.json"),
      JSON.stringify({ notifications: { telegramPush: { enabled: false } } }),
    );
    expect(isTelegramPushEnabled()).toBe(false);
  });
});
