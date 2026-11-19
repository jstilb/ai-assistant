/**
 * TelegramTransport.test.ts — the interface suite for the Telegram transport (ADR-036).
 *
 * The one test file that knows URLs, encoding, 429, timeout and token scrubbing.
 * Every test runs against FakeTelegram (the test adapter at the fetch port) in a
 * temp KAYA_HOME with its own secrets.json and settings.json.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pinKayaHome, restoreKayaHome } from "../test/pinKayaHome.ts";
import { defined } from "../test/defined.ts";
import { FakeTelegram } from "./FakeTelegram.ts";
import {
  MAX_RETRY_AFTER_S,
  readTelegramCredentials,
  telegramCall,
  TelegramTransportError,
} from "./TelegramTransport.ts";

const TOKEN = "123456:FAKE-transport-test-token";
const CHAT_ID = "4242";

let home = "";
let fake = new FakeTelegram(TOKEN);
let restoreFetch: () => void = () => {};

function writeSecrets(telegram: Record<string, string>): void {
  writeFileSync(join(home, "secrets.json"), JSON.stringify({ telegram }));
}

function writePushSwitch(enabled: boolean): void {
  writeFileSync(join(home, "settings.json"), JSON.stringify({ notifications: { telegramPush: { enabled } } }));
}

async function captureError(promise: Promise<unknown>): Promise<TelegramTransportError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof TelegramTransportError) return err;
    throw err;
  }
  throw new Error("expected a TelegramTransportError, but the call resolved");
}

function expectNoToken(err: TelegramTransportError): void {
  expect(String(err) + JSON.stringify(err) + String(err.cause) + String(err.stack)).not.toContain(TOKEN);
}

beforeEach(() => {
  home = pinKayaHome("telegram-transport-test-");
  writeSecrets({ bot_token: TOKEN, chat_id: CHAT_ID });
  writePushSwitch(true);
  fake = new FakeTelegram(TOKEN);
  restoreFetch = fake.install();
});

afterEach(async () => {
  restoreFetch();
  await restoreKayaHome();
});

describe("invariant 1 — push switch", () => {
  it("suppresses a send* method before any credential read or fetch", async () => {
    writePushSwitch(false);
    writeFileSync(join(home, "secrets.json"), "{ not json"); // a credential read would throw

    const outcome = await telegramCall("sendMessage", { text: "hi" });

    expect(outcome).toEqual({ status: "suppressed" });
    expect(fake.calls).toHaveLength(0);
  });

  it("does not gate getUpdates", async () => {
    writePushSwitch(false);

    const outcome = await telegramCall("getUpdates", { limit: 10 });

    expect(outcome).toEqual({ status: "ok", result: [], messageId: null });
    expect(fake.calls.map((c) => c.method)).toEqual(["getUpdates"]);
  });
});

describe("invariant 2 — credentials", () => {
  it("turns a missing secrets file into a config error with the key path and the BotFather hint", async () => {
    rmSync(join(home, "secrets.json"));

    const err = await captureError(telegramCall("sendMessage", { text: "hi" }));

    expect(err.kind).toBe("config");
    expect(err.method).toBe("sendMessage");
    expect(err.message).toContain("telegram.bot_token");
    expect(err.message).toContain("@BotFather");
    expect(fake.calls).toHaveLength(0);
  });

  it("turns a malformed secrets file into a config error", async () => {
    writeFileSync(join(home, "secrets.json"), "{ not json");

    const err = await captureError(telegramCall("getUpdates"));

    expect(err.kind).toBe("config");
    expect(err.message).toContain("file-malformed");
  });

  it("needs a chat_id for send* (run get-chat-id) but not for getUpdates", async () => {
    writeSecrets({ bot_token: TOKEN });

    const err = await captureError(telegramCall("sendMessage", { text: "hi" }));
    expect(err.kind).toBe("config");
    expect(err.message).toContain("get-chat-id");
    expect(fake.calls).toHaveLength(0);

    expect((await telegramCall("getUpdates")).status).toBe("ok");
    expect(readTelegramCredentials()).toEqual({ botToken: TOKEN, chatId: null });
  });
});

describe("invariant 3 — Jm's chat only", () => {
  it("sends to the configured chat_id", async () => {
    const outcome = await telegramCall("sendMessage", { text: "hi" });

    expect(outcome.status).toBe("ok");
    expect(defined(fake.calls[0]).params.chat_id).toBe(CHAT_ID);
  });

  it("refuses a caller-supplied chat_id with a config error and sends nothing", async () => {
    const err = await captureError(telegramCall("sendMessage", { chat_id: "999", text: "hi" }));

    expect(err.kind).toBe("config");
    expect(fake.calls).toHaveLength(0);
  });
});

describe("invariant 4 — body encoding", () => {
  it("sends JSON when no param is a Blob, with objects kept as objects", async () => {
    const keyboard = { inline_keyboard: [[{ text: "OK", callback_data: "ok" }]] };

    await telegramCall("sendMessage", {
      text: "pick",
      parse_mode: "Markdown",
      reply_markup: keyboard,
      caption: undefined,
    });

    const call = defined(fake.calls[0]);
    expect(call.params).toEqual({ chat_id: CHAT_ID, text: "pick", parse_mode: "Markdown", reply_markup: keyboard });
    expect(call.files).toEqual({});
  });

  it("sends multipart when a param is a Blob: the file name, JSON-encoded objects, string scalars", async () => {
    const photo = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });

    const outcome = await telegramCall("sendPhoto", {
      photo,
      caption: "look",
      reply_markup: { remove_keyboard: true },
      disable_notification: true,
    });

    expect(outcome.status).toBe("ok");
    const call = defined(fake.calls[0]);
    expect(call.files).toEqual({ photo: "shot.png" });
    expect(call.params).toEqual({
      chat_id: CHAT_ID,
      photo: "shot.png",
      caption: "look",
      reply_markup: JSON.stringify({ remove_keyboard: true }),
      disable_notification: "true",
    });
  });
});

describe("invariant 5 — timeout", () => {
  it("fails one slow attempt with a timeout error", async () => {
    fake.failNext("sendMessage", "timeout");

    const err = await captureError(telegramCall("sendMessage", { text: "hi" }, { timeoutMs: 20 }));

    expect(err.kind).toBe("timeout");
    expect(err.method).toBe("sendMessage");
    expectNoToken(err);
  });
});

describe("invariant 6 — 429", () => {
  it("waits retry_after and retries once, rebuilding the multipart body", async () => {
    fake.failNext("sendVoice", { httpStatus: 429, description: "Too Many Requests", retryAfter: 0 });
    const voice = new File([new Uint8Array([9, 9])], "note.ogg", { type: "audio/ogg" });

    const outcome = await telegramCall("sendVoice", { voice });

    expect(outcome).toEqual({ status: "ok", result: expect.any(Object), messageId: 1 });
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls.map((c) => c.files)).toEqual([{ voice: "note.ogg" }, { voice: "note.ogg" }]);
  });

  it("returns rejected on a second 429", async () => {
    fake.failNext("sendMessage", { httpStatus: 429, description: "Too Many Requests", retryAfter: 0 });
    fake.failNext("sendMessage", { httpStatus: 429, description: "Too Many Requests again", retryAfter: 0 });

    const outcome = await telegramCall("sendMessage", { text: "hi" });

    expect(outcome).toEqual({ status: "rejected", httpStatus: 429, description: "Too Many Requests again" });
    expect(fake.calls).toHaveLength(2);
  });

  it("waits the default 5 s when the 429 carries no retry_after", async () => {
    const sleep = spyOn(Bun, "sleep").mockResolvedValue(undefined);
    try {
      fake.failNext("sendMessage", { httpStatus: 429, description: "Too Many Requests" });

      const outcome = await telegramCall("sendMessage", { text: "hi" });

      expect(outcome.status).toBe("ok");
      expect(sleep).toHaveBeenCalledTimes(1);
      expect(sleep).toHaveBeenCalledWith(5000);
      expect(fake.calls).toHaveLength(2);
    } finally {
      sleep.mockRestore();
    }
  });

  it("fails loud with rate-limited, without waiting or retrying, when retry_after is over the cap", async () => {
    const sleep = spyOn(Bun, "sleep").mockResolvedValue(undefined);
    try {
      fake.failNext("sendMessage", {
        httpStatus: 429,
        description: "Too Many Requests",
        retryAfter: MAX_RETRY_AFTER_S + 1,
      });

      const err = await captureError(telegramCall("sendMessage", { text: "hi" }));

      expect(err.kind).toBe("rate-limited");
      expect(err.message).toContain(`${MAX_RETRY_AFTER_S + 1} s`);
      expect(sleep).not.toHaveBeenCalled();
      expect(fake.calls).toHaveLength(1);
      expectNoToken(err);
    } finally {
      sleep.mockRestore();
    }
  });

  it("still waits a retry_after exactly at the cap", async () => {
    const sleep = spyOn(Bun, "sleep").mockResolvedValue(undefined);
    try {
      fake.failNext("sendMessage", {
        httpStatus: 429,
        description: "Too Many Requests",
        retryAfter: MAX_RETRY_AFTER_S,
      });

      expect((await telegramCall("sendMessage", { text: "hi" })).status).toBe("ok");
      expect(sleep).toHaveBeenCalledWith(MAX_RETRY_AFTER_S * 1000);
    } finally {
      sleep.mockRestore();
    }
  });

  it("returns rejected (no retry) on another ok:false status", async () => {
    fake.failNext("sendMessage", { httpStatus: 400, description: "Bad Request: can't parse entities" });

    const outcome = await telegramCall("sendMessage", { text: "*" });

    expect(outcome).toEqual({ status: "rejected", httpStatus: 400, description: "Bad Request: can't parse entities" });
    expect(fake.calls).toHaveLength(1);
  });
});

describe("invariant 7 — bad response", () => {
  it("fails a non-JSON body with a bad-response error that names the HTTP status", async () => {
    fake.failNext("sendMessage", "bad-response");

    const err = await captureError(telegramCall("sendMessage", { text: "hi" }));

    expect(err.kind).toBe("bad-response");
    expect(err.message).toContain("502");
  });

  it("counts a 2xx push with a non-JSON body as delivered — one call, no error (no double send)", async () => {
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      fake.failNext("sendMessage", { httpStatus: 200, rawBody: '{"ok":true,"result":{"message_id' });

      const outcome = await telegramCall("sendMessage", { text: "hi" });

      expect(outcome).toEqual({ status: "ok", result: undefined, messageId: null });
      expect(fake.calls).toHaveLength(1);
      expect(String(log.mock.calls[0]?.[0])).toContain("body is not JSON");
      expect(String(log.mock.calls[0]?.[0])).toContain("message_id");
    } finally {
      log.mockRestore();
    }
  });

  it("counts a 2xx push with JSON but no boolean ok as delivered", async () => {
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      fake.failNext("sendPhoto", { httpStatus: 200, rawBody: '{"ok":"yes"}' });
      const photo = new File([new Uint8Array([1])], "p.png", { type: "image/png" });

      const outcome = await telegramCall("sendPhoto", { photo });

      expect(outcome).toEqual({ status: "ok", result: undefined, messageId: null });
      expect(fake.calls).toHaveLength(1);
      expect(String(log.mock.calls[0]?.[0])).toContain('no boolean "ok"');
    } finally {
      log.mockRestore();
    }
  });

  it("fails a 2xx read (getUpdates) with no boolean ok as bad-response — there is no result to give", async () => {
    fake.failNext("getUpdates", { httpStatus: 200, rawBody: '{"result":[]}' });

    const err = await captureError(telegramCall("getUpdates"));

    expect(err.kind).toBe("bad-response");
    expect(err.message).toContain('no boolean "ok"');
  });

  it("returns rejected for a 4xx with a non-JSON body, so a lane's 400 plain resend still starts", async () => {
    fake.failNext("sendMessage", { httpStatus: 400, rawBody: "<html>400 Bad Request</html>" });

    const outcome = await telegramCall("sendMessage", { text: "*" });

    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") throw new Error("unreachable");
    expect(outcome.httpStatus).toBe(400);
    expect(outcome.description).toContain("body is not JSON");
    expect(fake.calls).toHaveLength(1);
  });

  it("keeps the token out of a logged 2xx body and a rejected 4xx body", async () => {
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      fake.failNext("sendMessage", { httpStatus: 200, rawBody: `oops bot${TOKEN}` });
      fake.failNext("sendMessage", { httpStatus: 403, rawBody: `denied bot${TOKEN}` });

      await telegramCall("sendMessage", { text: "a" });
      const rejected = await telegramCall("sendMessage", { text: "b" });

      expect(JSON.stringify(log.mock.calls)).not.toContain(TOKEN);
      expect(rejected.status).toBe("rejected");
      expect(JSON.stringify(rejected)).not.toContain(TOKEN);
    } finally {
      log.mockRestore();
    }
  });
});

describe("invariant 8 — no error carries the token", () => {
  it("network", async () => {
    fake.failNext("sendMessage", "network");

    const err = await captureError(telegramCall("sendMessage", { text: "hi" }));

    expect(err.kind).toBe("network");
    expect(err.cause).toBeUndefined();
    expectNoToken(err);
  });

  it("timeout", async () => {
    fake.failNext("getUpdates", "timeout");
    expectNoToken(await captureError(telegramCall("getUpdates", {}, { timeoutMs: 20 })));
  });

  it("bad-response", async () => {
    fake.failNext("sendMessage", "bad-response");
    expectNoToken(await captureError(telegramCall("sendMessage", { text: "hi" })));
  });

  it("rejected", async () => {
    fake.failNext("sendMessage", { httpStatus: 401, description: `Unauthorized for bot${TOKEN}` });

    const outcome = await telegramCall("sendMessage", { text: "hi" });

    expect(outcome.status).toBe("rejected");
    expect(JSON.stringify(outcome)).not.toContain(TOKEN);
  });
});

describe("messageId", () => {
  it("is result.message_id for a send and null when the result has none", async () => {
    const first = await telegramCall("sendMessage", { text: "one" });
    const second = await telegramCall("sendMessage", { text: "two" });
    const updates = await telegramCall("getUpdates");

    expect(first.status === "ok" ? first.messageId : "not ok").toBe(1);
    expect(second.status === "ok" ? second.messageId : "not ok").toBe(2);
    expect(updates.status === "ok" ? updates.messageId : "not ok").toBeNull();
  });
});
