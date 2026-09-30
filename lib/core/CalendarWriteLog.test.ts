import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getKayaHome } from "./KayaHome.ts";
import { logCalendarWrite, defaultCalendarWriteLogPath } from "./CalendarWriteLog.ts";

// ============================================================================
// defaultCalendarWriteLogPath — resolves under getKayaHome(), honors override
// ============================================================================

describe("defaultCalendarWriteLogPath", () => {
  const originalKayaHome = process.env.KAYA_HOME;
  const originalKayaDir = process.env.KAYA_DIR;

  afterEach(() => {
    if (originalKayaHome !== undefined) process.env.KAYA_HOME = originalKayaHome;
    else delete process.env.KAYA_HOME;
    if (originalKayaDir !== undefined) process.env.KAYA_DIR = originalKayaDir;
    else delete process.env.KAYA_DIR;
  });

  it("resolves under <KAYA_HOME>/skills/Productivity/CalendarAssistant/Data/calendar-writes.jsonl", () => {
    expect(defaultCalendarWriteLogPath()).toBe(
      join(getKayaHome(), "skills/Productivity/CalendarAssistant/Data/calendar-writes.jsonl")
    );
  });

  it("honors a KAYA_HOME override — never hardcodes the live tree", () => {
    process.env.KAYA_HOME = "/tmp/alt-kaya-home-for-calendar-log-test";
    expect(defaultCalendarWriteLogPath()).toBe(
      "/tmp/alt-kaya-home-for-calendar-log-test/skills/Productivity/CalendarAssistant/Data/calendar-writes.jsonl"
    );
  });
});

// ============================================================================
// logCalendarWrite — one structured JSONL line per write, any calendar seam
// ============================================================================

describe("logCalendarWrite", () => {
  let dir: string;
  let logPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "calendar-write-log-test-"));
    logPath = join(dir, "nested", "calendar-writes.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the parent directory if missing", () => {
    expect(existsSync(logPath)).toBe(false);
    logCalendarWrite(
      { target: "primary", caller: "test.caller", title: "Test event", outcome: "success" },
      { logPath }
    );
    expect(existsSync(logPath)).toBe(true);
  });

  it("writes one JSON line containing timestamp, target, caller, title, outcome", () => {
    logCalendarWrite(
      { target: "Kaya Schedule", caller: "test.caller", title: "Test event", outcome: "success" },
      { logPath }
    );
    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.target).toBe("Kaya Schedule");
    expect(entry.caller).toBe("test.caller");
    expect(entry.title).toBe("Test event");
    expect(entry.outcome).toBe("success");
    expect(typeof entry.timestamp).toBe("string");
    expect(Number.isNaN(Date.parse(entry.timestamp))).toBe(false);
  });

  it("appends — does not truncate previous entries", () => {
    logCalendarWrite({ target: "primary", caller: "a", title: "one", outcome: "success" }, { logPath });
    logCalendarWrite({ target: "primary", caller: "b", title: "two", outcome: "error:AUTH_EXPIRED" }, { logPath });
    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).title).toBe("one");
    expect(JSON.parse(lines[1]).title).toBe("two");
    expect(JSON.parse(lines[1]).outcome).toBe("error:AUTH_EXPIRED");
  });

  it("records failed writes too — the seam is auditable regardless of outcome", () => {
    logCalendarWrite(
      { target: "primary", caller: "test.caller", title: "Failed event", outcome: "error:API_UNAVAILABLE" },
      { logPath }
    );
    const entry = JSON.parse(readFileSync(logPath, "utf-8").trim());
    expect(entry.outcome).toBe("error:API_UNAVAILABLE");
  });

  it("never throws when the path is unwritable (logging must not break the calendar write it records)", () => {
    const badPath = "/nonexistent-root-that-cannot-be-created-xyz/calendar-writes.jsonl";
    expect(() =>
      logCalendarWrite({ target: "primary", caller: "c", title: "t", outcome: "success" }, { logPath: badPath })
    ).not.toThrow();
  });
});
