/**
 * calendar-api.test.ts — CalendarApi's bounded retry with a fake fetch:
 * reads retry on a dropped socket and on 429/5xx; a write never retries a
 * network error (the event may exist) and retries only 429.
 */

import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCalendarClient } from "../Tools/CalendarApi.ts";

// Writes log to a temp file, never to the shared calendar write log.
const LOG_DIR = mkdtempSync(join(tmpdir(), "es-calapi-"));
afterAll(() => rmSync(LOG_DIR, { recursive: true, force: true }));

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function client(responses: Array<Response | Error>) {
  const calls: Array<{ url: string; method: string }> = [];
  const waits: number[] = [];
  const c = createCalendarClient("primary", {
    writeLogPath: join(LOG_DIR, "calendar-writes.jsonl"),
    getToken: () => "test-token",
    sleep: async (ms) => {
      waits.push(ms);
    },
    fetch: async (url, init) => {
      calls.push({ url, method: init.method ?? "GET" });
      const next = responses.shift();
      if (!next) throw new Error("no more fake responses");
      if (next instanceof Error) throw next;
      return next;
    },
  });
  return { c, calls, waits };
}

const RANGE = { timeMin: "2026-11-14T08:00:00Z", timeMax: "2026-11-16T08:00:00Z" };

test("a read retries a dropped socket and then succeeds", async () => {
  const { c, calls, waits } = client([new Error("The socket connection was closed unexpectedly"), json({ items: [{ id: "a" }] })]);
  const out = await c.listEvents(RANGE);
  expect(out.map((e) => e.id)).toEqual(["a"]);
  expect(calls).toHaveLength(2);
  expect(waits).toEqual([1_000]);
});

test("a read retries 503 and 429, then gives up after 3 attempts with the real error", async () => {
  const { c, calls } = client([json({}, 503), json({}, 429), json({ error: "busy" }, 503)]);
  await expect(c.listEvents(RANGE)).rejects.toThrow(/HTTP 503/);
  expect(calls).toHaveLength(3);
});

test("a read does not retry a 404 or a 401", async () => {
  const { c, calls } = client([json({}, 404)]);
  expect(await c.getEvent("gone")).toBeNull();
  expect(calls).toHaveLength(1);
  const second = client([json({ error: "auth" }, 401)]);
  await expect(second.c.listEvents(RANGE)).rejects.toThrow(/HTTP 401/);
  expect(second.calls).toHaveLength(1);
});

test("a read that keeps dropping throws the network error after 3 attempts", async () => {
  const drop = () => new Error("The socket connection was closed unexpectedly");
  const { c, calls } = client([drop(), drop(), drop()]);
  await expect(c.listEvents(RANGE)).rejects.toThrow(/socket/);
  expect(calls).toHaveLength(3);
});

test("a write never retries a network error (the event may exist already)", async () => {
  const { c, calls } = client([new Error("The socket connection was closed unexpectedly")]);
  await expect(c.insertEvent({ summary: "EventScout hold: x", start: {}, end: {} })).rejects.toThrow(/socket/);
  expect(calls).toHaveLength(1);
});

test("a write retries 429 but not 503 or 500", async () => {
  const ok = client([json({}, 429), json({ id: "new-1", summary: "EventScout hold: x", start: {}, end: {} })]);
  const created = await ok.c.insertEvent({ summary: "EventScout hold: x", start: {}, end: {} });
  expect(created.id).toBe("new-1");
  expect(ok.calls.map((x) => x.method)).toEqual(["POST", "POST"]);
  const bad = client([json({ error: "x" }, 503)]);
  await expect(bad.c.insertEvent({ summary: "EventScout hold: y", start: {}, end: {} })).rejects.toThrow(/HTTP 503/);
  expect(bad.calls).toHaveLength(1);
});
