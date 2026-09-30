/**
 * Dashboard.test.ts — buildPayload shape + handleRequest routing.
 *
 * Pure-DB tests. No HTTP server is started — handleRequest is called directly
 * with synthetic Request objects. Browser/visual QA happens separately via
 * the QATester subagent + browser-automation skill.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../Tools/Db.ts";
import { buildPayload, handleRequest, isRankableApp, readCeilingMin } from "../Tools/Dashboard.ts";
import { todayLocal } from "../Tools/Util.ts";

// The ceiling is read live from LifeOS/config/wig_status.json (fable-audit
// batch2 fix — this dashboard previously hardcoded the retired Q2 G37/270
// target). Compute it once here rather than hardcoding a number a future
// quarterly rollover would silently make wrong in this test too.
const CEILING_MIN = readCeilingMin();

const TMP = mkdtempSync(join(tmpdir(), "aw-dash-test-"));
const DB_PATH = join(TMP, "events.db");

let db: Db;

beforeAll(async () => {
  db = await Db.open(DB_PATH);
  await db.initSchema();
});

afterAll(() => {
  if (db) db.close();
  rmSync(TMP, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.run("DELETE FROM events");
  await db.run("DELETE FROM classifications");
  await db.run("DELETE FROM daily_metrics");
  await db.run("DELETE FROM sync_state");
});

async function insertEvent(row: { id: string; device: string; app: string | null; url?: string | null; ts: string; durationSec: number }) {
  await db.run(
    `INSERT OR REPLACE INTO events (id, device, bucket, watcher, app, title, url, audible, ts_start, duration_sec, raw_json)
     VALUES ($id, $device, 'b', 'test', $app, NULL, $url, NULL, $ts::TIMESTAMP, $dur, '{}')`,
    { id: row.id, device: row.device, app: row.app, url: row.url ?? null, ts: row.ts, dur: row.durationSec },
  );
}

// Use Util.todayLocal — production code anchors on CONFIG.localTimezone.
// A naive new Date().getDate() reads UTC under Bun's test runner (TZ
// undefined) and produces a different date than buildPayload reads, which
// is why this test used to flake between UTC midnight and PDT midnight.

test("buildPayload: empty DB → zero today, empty trend/devices/topApps", async () => {
  const p = await buildPayload(db);
  expect(p.today.tier1_minutes).toBe(0);
  expect(p.today.total_lowvalue_minutes).toBe(0);
  expect(p.today.delta_vs_ceiling).toBe(0 - CEILING_MIN);
  expect(p.trend_60d).toEqual([]);
  expect(p.per_device_today).toEqual([]);
  expect(p.top_apps_7d).toEqual([]);
  expect(p.devices.length).toBeGreaterThan(0); // CONFIG.devices always populated
  expect(p.devices.every(d => d.last_sync == null)).toBe(true);
});

test("buildPayload: daily_metrics row populates 'today'", async () => {
  const today = todayLocal();
  await db.run(
    `INSERT OR REPLACE INTO daily_metrics (date, tier1_minutes, tier2_lowvalue_minutes, total_lowvalue_minutes, rolling_4wk_avg, computed_at)
     VALUES ($d::DATE, 120, 80, 200, 150.5, NOW())`,
    { d: today },
  );
  const p = await buildPayload(db);
  expect(p.today.tier1_minutes).toBe(120);
  expect(p.today.tier2_lowvalue_minutes).toBe(80);
  expect(p.today.total_lowvalue_minutes).toBe(200);
  expect(p.today.delta_vs_ceiling).toBe(200 - CEILING_MIN);
  expect(p.today.rolling_4wk_avg).toBe(150.5);
});

test("buildPayload: per_device_today splits Tier-1 vs Tier-2-classified", async () => {
  const today = todayLocal();
  // 30 min Reddit on phone (Tier-1)
  await insertEvent({ id: "phone:r:1", device: "phone", app: "com.reddit.frontpage", ts: today + "T10:00:00", durationSec: 1800 });
  // 60 min YouTube on phone, classified low-value (Tier-2)
  await insertEvent({ id: "phone:yt:1", device: "phone", app: "com.google.android.youtube", ts: today + "T11:00:00", durationSec: 3600 });
  await db.run(
    `INSERT OR REPLACE INTO classifications (event_id, tier, classifier, is_low_value, reason, classified_at)
     VALUES ('phone:yt:1', 2, 'llm-sonnet', TRUE, 'drama', NOW())`,
  );
  // 10 min Reddit on mac (Tier-1)
  await insertEvent({ id: "mac:r:1", device: "mac", app: "Reddit", ts: today + "T09:00:00", durationSec: 600 });

  const p = await buildPayload(db);
  const phone = p.per_device_today.find(r => r.device === "phone")!;
  const mac = p.per_device_today.find(r => r.device === "mac")!;
  expect(phone.tier1_minutes).toBe(30);
  expect(phone.tier2_lowvalue_minutes).toBe(60);
  expect(mac.tier1_minutes).toBe(10);
  expect(mac.tier2_lowvalue_minutes).toBe(0);
});

test("buildPayload: top_apps_7d sorts by minutes desc, limit 10", async () => {
  const today = todayLocal();
  // Insert 12 distinct apps with varying durations
  for (let i = 0; i < 12; i++) {
    await insertEvent({
      id: `mac:a${i}:1`, device: "mac", app: `App${i}`,
      ts: today + "T08:00:00", durationSec: 60 * (i + 1),
    });
  }
  const p = await buildPayload(db);
  expect(p.top_apps_7d.length).toBe(10);
  expect(p.top_apps_7d[0].app).toBe("App11");
  expect(p.top_apps_7d[0].minutes).toBe(12); // 60*(11+1)/60
  // sorted descending
  for (let i = 0; i < p.top_apps_7d.length - 1; i++) {
    expect(p.top_apps_7d[i].minutes).toBeGreaterThanOrEqual(p.top_apps_7d[i + 1].minutes);
  }
});

// --- S1.11 top-apps filter: loginwindow / null app names excluded from ranking ---

describe("isRankableApp — filter predicate", () => {
  test("rejects null", () => {
    expect(isRankableApp(null)).toBe(false);
  });
  test("rejects undefined", () => {
    expect(isRankableApp(undefined)).toBe(false);
  });
  test("rejects empty string", () => {
    expect(isRankableApp("")).toBe(false);
  });
  test("rejects whitespace-only string", () => {
    expect(isRankableApp("   ")).toBe(false);
  });
  test("rejects loginwindow", () => {
    expect(isRankableApp("loginwindow")).toBe(false);
  });
  test("rejects loginwindow case-insensitively", () => {
    expect(isRankableApp("LoginWindow")).toBe(false);
  });
  test("rejects ScreenSaverEngine", () => {
    expect(isRankableApp("ScreenSaverEngine")).toBe(false);
  });
  test("accepts real apps", () => {
    expect(isRankableApp("Terminal")).toBe(true);
    expect(isRankableApp("Google Chrome")).toBe(true);
    expect(isRankableApp("com.reddit.frontpage")).toBe(true);
  });
  test("does not false-positive on substrings of excluded names", () => {
    // "err on the side of a SHORT list" — exact match only, not substring, so
    // a hypothetical real app that merely contains "login" isn't swept up.
    expect(isRankableApp("MyLoginWindowHelper")).toBe(true);
  });
});

test("buildPayload: top_apps_7d excludes loginwindow and null app names, promotes real apps", async () => {
  const today = todayLocal();
  // Dominant loginwindow (system/idle) — must be excluded from the ranking.
  await insertEvent({ id: "mac:login:1", device: "mac", app: "loginwindow", ts: today + "T06:00:00", durationSec: 200_000 });
  // Unclassified null-app events (e.g. aw-watcher-android-web-chrome) — excluded.
  await insertEvent({ id: "mac:null:1", device: "mac", app: null, ts: today + "T06:05:00", durationSec: 6_000 });
  // 11 real apps so the real top-10 is unambiguous once the two above are dropped.
  for (let i = 0; i < 11; i++) {
    await insertEvent({
      id: `mac:real${i}:1`, device: "mac", app: `RealApp${i}`,
      ts: today + "T07:00:00", durationSec: 60 * (i + 1),
    });
  }

  const p = await buildPayload(db);
  const apps = p.top_apps_7d.map(r => r.app);
  expect(apps).not.toContain("loginwindow");
  expect(apps).not.toContain("(null)");
  expect(p.top_apps_7d.length).toBe(10);
  // Highest-duration real app (RealApp10, 660s = 11min) now ranks #1.
  expect(p.top_apps_7d[0].app).toBe("RealApp10");
});

test("buildPayload: filtering top_apps_7d does not change today/trend totals (daily_metrics-driven, independent of events)", async () => {
  const today = todayLocal();
  await db.run(
    `INSERT OR REPLACE INTO daily_metrics (date, tier1_minutes, tier2_lowvalue_minutes, total_lowvalue_minutes, rolling_4wk_avg, computed_at)
     VALUES ($d::DATE, 55, 45, 100, 90.2, NOW())`,
    { d: today },
  );
  // Large loginwindow + null-app noise in `events` — must not perturb `today`,
  // since `today` is sourced entirely from daily_metrics, not from events.
  await insertEvent({ id: "mac:login:2", device: "mac", app: "loginwindow", ts: today + "T06:00:00", durationSec: 500_000 });
  await insertEvent({ id: "mac:null:2", device: "mac", app: null, ts: today + "T06:05:00", durationSec: 9_000 });

  const p = await buildPayload(db);
  expect(p.today.tier1_minutes).toBe(55);
  expect(p.today.tier2_lowvalue_minutes).toBe(45);
  expect(p.today.total_lowvalue_minutes).toBe(100);
  expect(p.today.rolling_4wk_avg).toBe(90.2);
});

test("handleRequest: GET / serves HTML", async () => {
  const res = await handleRequest(new Request("http://127.0.0.1:7745/"), db);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  const body = await res.text();
  expect(body).toContain("AppUsageTracker");
  expect(body).toContain("trendChart");
});

test("handleRequest: GET /health returns ok", async () => {
  const res = await handleRequest(new Request("http://127.0.0.1:7745/health"), db);
  expect(res.status).toBe(200);
  expect((await res.text()).trim()).toBe("ok");
});

test("handleRequest: GET /api/dashboard returns valid payload JSON (using injected Db)", async () => {
  const res = await handleRequest(new Request("http://127.0.0.1:7745/api/dashboard"), db);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("application/json");
  const body = await res.json();
  expect(body).toHaveProperty("generated_at");
  expect(body).toHaveProperty("today");
  expect(body).toHaveProperty("trend_60d");
  expect(body).toHaveProperty("per_device_today");
  expect(body).toHaveProperty("top_apps_7d");
  expect(body).toHaveProperty("devices");
});

test("handleRequest: unknown path returns 404", async () => {
  const res = await handleRequest(new Request("http://127.0.0.1:7745/nope"), db);
  expect(res.status).toBe(404);
});

// --- S1.12 vendored Chart.js: dashboard must not depend on a reachable CDN ---

describe("Chart.js is vendored locally (no runtime CDN dependency)", () => {
  test("GET /vendor/chart.umd.min.js serves the committed vendor file byte-for-byte", async () => {
    const res = await handleRequest(new Request("http://127.0.0.1:7745/vendor/chart.umd.min.js"), db);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    const body = await res.text();
    const onDisk = readFileSync(join(import.meta.dir, "..", "Tools", "vendor", "chart.umd.min.js"), "utf8");
    expect(body).toBe(onDisk);
    // Sanity: it's really the Chart.js UMD bundle, not an empty/placeholder file.
    expect(body).toContain("window.Chart");
    expect(body.length).toBeGreaterThan(100_000);
  });

  test("GET / HTML loads Chart.js from the local /vendor route, not an external CDN", async () => {
    const res = await handleRequest(new Request("http://127.0.0.1:7745/"), db);
    const body = await res.text();
    expect(body).not.toContain("cdn.jsdelivr.net");
    expect(body).not.toMatch(/https?:\/\//); // no external script/asset URLs at all
    expect(body).toContain('/vendor/chart.umd.min.js');
  });

  test("GET / HTML wraps chart construction separately from table rendering (decoupled failure banner present)", async () => {
    const res = await handleRequest(new Request("http://127.0.0.1:7745/"), db);
    const body = await res.text();
    expect(body).toContain('id="chart-warning"');
    expect(body).toContain("showChartWarning");
  });
});
