/**
 * ProactivePinger.telegram.test.ts — the Telegram leg of a ping goes through the
 * in-process transport (ADR-004 Lane 2 → ADR-036), never a TelegramClient
 * subprocess. FakeTelegram sits at the transport's fetch port, so these tests
 * see exactly what Telegram would receive, the push switch and the ledger.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pinKayaHome, restoreKayaHome } from "../../../../lib/test/pinKayaHome.ts";
import { defined } from "../../../../lib/test/defined.ts";
import { FakeTelegram } from "../../../../lib/core/FakeTelegram.ts";
import { findByMessageId } from "../../../../lib/core/TelegramOutboundLedger.ts";
import { deliverTelegramPing } from "./ProactivePinger.ts";

const TOKEN = "123456:FAKE-pinger-test-token";
const CHAT_ID = "4242";

let home = "";
let fake = new FakeTelegram(TOKEN);
let restoreFetch: () => void = () => {};

function writePushSwitch(enabled: boolean): void {
  writeFileSync(join(home, "settings.json"), JSON.stringify({ notifications: { telegramPush: { enabled } } }));
}

function writeOgg(): string {
  const path = join(home, "ping-test.ogg");
  writeFileSync(path, "OggS-fake-voice");
  return path;
}

beforeEach(() => {
  home = pinKayaHome("proactive-pinger-telegram-test-");
  writeFileSync(join(home, "secrets.json"), JSON.stringify({ telegram: { bot_token: TOKEN, chat_id: CHAT_ID } }));
  writePushSwitch(true);
  fake = new FakeTelegram(TOKEN);
  restoreFetch = fake.install();
});

afterEach(async () => {
  restoreFetch();
  await restoreKayaHome();
});

describe("ProactivePinger Telegram delivery (transport seam)", () => {
  it("sends the voice file as a document captioned Kaya, ledgers the spoken words, and deletes the file", async () => {
    const ogg = writeOgg();

    const result = await deliverTelegramPing("Meeting in 10 minutes", ogg);

    expect(fake.calls).toHaveLength(1);
    const call = defined(fake.calls[0]);
    expect(call.method).toBe("sendDocument");
    expect(call.files.document).toEndWith("/ping-test.ogg");
    expect(call.params.caption).toBe("Kaya");
    expect(result.sent).toBe(true);
    expect(result.channel).toBe("telegram");
    expect(existsSync(ogg)).toBe(false);

    const record = defined(findByMessageId(1));
    expect(record.source).toBe("proactive-pinger");
    expect(record.text).toBe("Meeting in 10 minutes");
  });

  it("falls back to a text message when voice generation failed", async () => {
    const result = await deliverTelegramPing("Meeting in 10 minutes", null);

    const call = defined(fake.calls[0]);
    expect(call.method).toBe("sendMessage");
    expect(call.params.text).toBe("Meeting in 10 minutes");
    expect(result.sent).toBe(true);
    expect(result.message).toBe("[text fallback] Meeting in 10 minutes");
  });

  it("reports sent:false when Telegram rejects the upload (not just a nonzero child), and still deletes the file", async () => {
    fake.failNext("sendDocument", { httpStatus: 400, description: "Bad Request: chat not found" });
    const ogg = writeOgg();

    const result = await deliverTelegramPing("hi", ogg);

    expect(result.sent).toBe(false);
    expect(existsSync(ogg)).toBe(false);
  });

  it("reports sent:false when the text fallback is rejected", async () => {
    fake.failNext("sendMessage", { httpStatus: 400, description: "Bad Request: chat not found" });

    const result = await deliverTelegramPing("hi", null);

    expect(result.sent).toBe(false);
  });

  it("sends nothing and reports sent:false when the push switch is off", async () => {
    writePushSwitch(false);

    const voice = await deliverTelegramPing("hi", writeOgg());
    const text = await deliverTelegramPing("hi", null);

    expect(fake.calls).toHaveLength(0);
    expect(voice.sent).toBe(false);
    expect(text.sent).toBe(false);
  });

  it("never spawns TelegramClient as a subprocess", () => {
    const source = readFileSync(join(import.meta.dir, "ProactivePinger.ts"), "utf-8");
    expect(source).not.toMatch(/spawn\w*\([^)]*TELEGRAM/);
    expect(source).not.toContain("TELEGRAM_CLIENT");
  });
});
