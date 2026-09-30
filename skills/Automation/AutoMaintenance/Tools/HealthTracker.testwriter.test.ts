/**
 * HealthTracker - Test Suite (TestWriter)
 * ISC Coverage: A-03, A-04, S-05
 *
 * Hermetic: HealthTracker.load()/save() go through HealthManager's
 * loadHealthState()/saveHealthState(), which is backed by a module-level
 * StateManager singleton resolved from getKayaHome() ONCE at first
 * construction. Without pinning KAYA_HOME + resetting that singleton
 * (_resetHealthManagerForTest(), previously unused — Track C slice 3.5 of
 * the alert-storm remediation plan), every test here wrote real
 * ~/.claude/MEMORY/AutoMaintenance/health-state.json. Mirrors the
 * pin-per-test + reset pattern already used in HealthManager.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, rmSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
import { HealthTracker, generateIssueKey, normalizeFindingText } from "./HealthTracker";
import { _resetHealthManagerForTest } from "./HealthManager";
import { defaultKayaHome } from "../../../../lib/core/KayaHome.ts";

// ============================================================================
// Regression guard: the real, unpinned health-state.json must be byte- and
// mtime-identical before and after this whole suite runs — the exact
// invariant a forgotten pin/reset would violate.
// ============================================================================

const LIVE_HEALTH_STATE_PATH = join(
  defaultKayaHome(),
  "MEMORY",
  "AutoMaintenance",
  "health-state.json"
);

function liveHealthStateSignature(): { mtimeMs: number; hash: string } | null {
  if (!existsSync(LIVE_HEALTH_STATE_PATH)) return null;
  return {
    mtimeMs: statSync(LIVE_HEALTH_STATE_PATH).mtimeMs,
    hash: createHash("sha256").update(readFileSync(LIVE_HEALTH_STATE_PATH)).digest("hex"),
  };
}

let liveSignatureBeforeSuite: ReturnType<typeof liveHealthStateSignature>;

beforeAll(() => {
  liveSignatureBeforeSuite = liveHealthStateSignature();
});

afterAll(() => {
  expect(liveHealthStateSignature()).toEqual(liveSignatureBeforeSuite);
});

describe("HealthTracker", () => {
  let testHome: string;
  let tracker: HealthTracker;

  beforeEach(async () => {
    testHome = join(tmpdir(), `health-tracker-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(testHome, "MEMORY", "AutoMaintenance"), { recursive: true });
    process.env.KAYA_HOME = testHome;
    _resetHealthManagerForTest();

    tracker = new HealthTracker();
    await tracker.load();
  });

  afterEach(() => {
    delete process.env.KAYA_HOME;
    if (existsSync(testHome)) rmSync(testHome, { recursive: true, force: true });
    // Reset singleton so the next test gets a fresh StateManager with the
    // next test's KAYA_HOME instead of inheriting this test's (deleted) dir.
    _resetHealthManagerForTest();
  });

  describe("issue persistence tracking", () => {
    it("should record first occurrence of an issue", () => {
      const key = "daily:integrity:broken_symlink_abc123";

      tracker.record(key, {
        lastSeen: new Date().toISOString(),
        type: "broken_symlink",
        finding: "bin/canvas-build points to nonexistent target",
        status: "monitoring"
      });

      const record = tracker.get(key);
      expect(record).toBeDefined();
      expect(record!.occurrences).toBe(1);
      expect(record!.status).toBe("monitoring");
    });

    it("should increment occurrences on repeated findings", () => {
      const key = "daily:integrity:broken_symlink_abc123";

      tracker.record(key, {
        lastSeen: new Date().toISOString(),
        type: "broken_symlink",
        finding: "bin/canvas-build points to nonexistent target",
        status: "monitoring"
      });

      tracker.record(key, {
        lastSeen: new Date().toISOString(),
        type: "broken_symlink",
        finding: "bin/canvas-build points to nonexistent target",
        status: "monitoring"
      });

      const record = tracker.get(key);
      expect(record!.occurrences).toBe(2);
    });
  });

  describe("severity classification", () => {
    it("should return INFO for first occurrence", () => {
      // ISC A-03: Same finding on day 3 triggers WARNING notification
      const key = "daily:integrity:test_finding";

      tracker.record(key, {
        lastSeen: new Date().toISOString(),
        type: "test_type",
        finding: "test finding",
        status: "monitoring"
      });

      expect(tracker.getSeverity(key)).toBe("INFO");
    });

    it("should return WARNING for 3rd occurrence", () => {
      const key = "daily:integrity:test_finding_2";

      // Record 3 occurrences
      for (let i = 0; i < 3; i++) {
        tracker.record(key, {
          lastSeen: new Date().toISOString(),
          type: "test_type",
          finding: "test finding",
          status: "monitoring"
        });
      }

      expect(tracker.getSeverity(key)).toBe("WARNING");
      expect(tracker.getOccurrences(key)).toBe(3);
    });

    it("should return CRITICAL for 7th occurrence", () => {
      // ISC A-04: Same finding on day 7 triggers CRITICAL re-alert
      const key = "daily:integrity:test_finding_3";

      // Record 7 occurrences
      for (let i = 0; i < 7; i++) {
        tracker.record(key, {
          lastSeen: new Date().toISOString(),
          type: "test_type",
          finding: "test finding",
          status: "monitoring"
        });
      }

      expect(tracker.getSeverity(key)).toBe("CRITICAL");
      expect(tracker.getOccurrences(key)).toBe(7);
    });
  });

  describe("resolution tracking", () => {
    it("should mark issue as resolved", () => {
      const key = "daily:integrity:resolved_issue";

      tracker.record(key, {
        lastSeen: new Date().toISOString(),
        type: "test_type",
        finding: "test finding",
        status: "monitoring"
      });

      tracker.markResolved(key);

      const record = tracker.get(key);
      expect(record!.status).toBe("auto-resolved");
    });
  });

  describe("persistence", () => {
    it("should save and load state", async () => {
      const key = "daily:integrity:persist_test";

      tracker.record(key, {
        lastSeen: new Date().toISOString(),
        type: "test_type",
        finding: "test finding",
        status: "monitoring"
      });

      await tracker.save();

      const newTracker = new HealthTracker();
      await newTracker.load();

      const record = newTracker.get(key);
      expect(record).toBeDefined();
      expect(record!.type).toBe("test_type");
    });
  });

  describe("generateIssueKey — numeric normalization (B5 S3b)", () => {
    it("produces the SAME key for the same finding class with a different count", () => {
      const keyA = generateIssueKey("daily", "integrity", "3600 modified files");
      const keyB = generateIssueKey("daily", "integrity", "42 modified files");
      expect(keyA).toBe(keyB);
    });

    it("produces the SAME key across different percentages", () => {
      const keyA = generateIssueKey("daily", "integrity", "disk_warning: 87% used");
      const keyB = generateIssueKey("daily", "integrity", "disk_warning: 91% used");
      expect(keyA).toBe(keyB);
    });

    it("produces the SAME key across different comma-grouped counts and dates", () => {
      const keyA = generateIssueKey("weekly-security", "secret-scan", "3,600 verified secrets found on 2026-07-20");
      const keyB = generateIssueKey("weekly-security", "secret-scan", "42 verified secrets found on 2026-07-21");
      expect(keyA).toBe(keyB);
    });

    it("produces a DIFFERENT key for a genuinely different finding class", () => {
      const keyA = generateIssueKey("daily", "integrity", "disk_warning: 87% used");
      const keyB = generateIssueKey("daily", "integrity", "git_dirty: 42 modified files");
      expect(keyA).not.toBe(keyB);
    });

    it("does not mangle alphanumeric identifiers (UUID fragments, version tags)", () => {
      const keyA = generateIssueKey("daily", "integrity", "broken_symlink: bin/canvas-build-v2");
      const keyB = generateIssueKey("daily", "integrity", "broken_symlink: bin/canvas-build-v3");
      // Different identifiers -> genuinely different findings -> different keys
      // (the digit in "v2"/"v3" must NOT be stripped, or these would collapse).
      expect(keyA).not.toBe(keyB);
    });

    it("normalizeFindingText collapses digit runs to a stable placeholder", () => {
      expect(normalizeFindingText("3600 modified files")).toBe("<N> modified files");
      expect(normalizeFindingText("disk_warning: 87% used")).toBe("disk_warning: <N>% used");
      expect(normalizeFindingText("2026-07-20")).toBe("<N>-<N>-<N>");
      expect(normalizeFindingText("bin/canvas-build-v2")).toBe("bin/canvas-build-v2"); // untouched
    });

    // Regression for the backtracking-artifact bug in the original
    // lookaround-based regex: a greedy digit run bounded by a lookahead
    // would backtrack to a SHORTER digit run whose immediate next character
    // wasn't a letter, even though that shorter run was still the middle of
    // one contiguous alphanumeric identifier — e.g. "148792d2" used to
    // become the mangled "<N>2d2" (only "14879" got replaced). The
    // whole-token replacer (PURE_NUMERIC_TOKEN test against an atomically
    // matched [A-Za-z0-9.,]+ token) can't produce a partial match at all.
    it("does not mangle mixed alphanumeric identifiers (backtracking-artifact regression)", () => {
      expect(normalizeFindingText("148792d2")).toBe("148792d2");
      expect(normalizeFindingText("148792d2-1ecc-4bf0")).toBe("148792d2-1ecc-4bf0");
      // A number glued directly to its unit (no space) is indistinguishable
      // from an identifier at the token level — intentionally left whole,
      // not a limitation (see normalizeFindingText's doc comment).
      expect(normalizeFindingText("512MB")).toBe("512MB");
    });

    it("still normalizes real numeric shapes after the backtracking fix", () => {
      expect(normalizeFindingText("3,600 files")).toBe("<N> files");
      expect(normalizeFindingText("87%")).toBe("<N>%");
      expect(normalizeFindingText("2026-07-20")).toBe("<N>-<N>-<N>");
    });

    // D1 item 6: a number sitting at the end of a sentence gets tokenized
    // WITH its trailing period ('.' is inside the tokenizer's character
    // class), so "3,600." is one token, not "3,600" + ".". PURE_NUMERIC_TOKEN
    // previously required a decimal point to be followed by digits, so a
    // BARE trailing period made the whole token fail and left the count
    // un-normalized.
    it("normalizes a thousands-grouped number with a bare trailing period (end-of-sentence)", () => {
      expect(normalizeFindingText("backup grew to 3,600.")).toBe("backup grew to <N>");
      // Two different counts, each with the same bare-trailing-period shape,
      // must collapse to the SAME normalized text (that's the whole point —
      // occurrences accumulate instead of minting a new key every day).
      expect(normalizeFindingText("backup grew to 3,600.")).toBe(normalizeFindingText("backup grew to 3,551."));
    });

    it("also normalizes a plain (non-comma-grouped) number with a bare trailing period", () => {
      expect(normalizeFindingText("retry count 42.")).toBe("retry count <N>");
    });

    it("does not let the trailing-period extension swallow a second decimal group (e.g. a version-like shape)", () => {
      // "3.6.7" has two dot-separated groups; the added trailing-period
      // allowance only accepts ONE bare dot, so this whole token still fails
      // PURE_NUMERIC_TOKEN and passes through untouched, same as any other
      // mixed identifier.
      expect(normalizeFindingText("version 3.6.7 deployed")).toBe("version 3.6.7 deployed");
    });

    it("occurrences accumulate across scans once the count-only diff no longer mints a new key", () => {
      const key1 = generateIssueKey("daily", "integrity", "3600 modified files");
      tracker.record(key1, { lastSeen: new Date().toISOString(), type: "git_dirty", finding: "3600 modified files", status: "monitoring" });

      const key2 = generateIssueKey("daily", "integrity", "3550 modified files");
      tracker.record(key2, { lastSeen: new Date().toISOString(), type: "git_dirty", finding: "3550 modified files", status: "monitoring" });

      const key3 = generateIssueKey("daily", "integrity", "12 modified files");
      tracker.record(key3, { lastSeen: new Date().toISOString(), type: "git_dirty", finding: "12 modified files", status: "monitoring" });

      expect(key1).toBe(key2);
      expect(key2).toBe(key3);
      expect(tracker.getOccurrences(key1)).toBe(3);
      expect(tracker.getSeverity(key1)).toBe("WARNING"); // 3x escalation now actually fires
    });
  });

  describe("resolveAbsent — auto-resolve lifecycle (B5 S3b)", () => {
    it("resolves a key that existed in prior state but is absent from the current scan", () => {
      const staleKey = generateIssueKey("daily", "integrity", "broken_symlink: bin/old-tool");
      tracker.record(staleKey, { lastSeen: new Date().toISOString(), type: "broken_symlink", finding: "broken_symlink: bin/old-tool", status: "monitoring" });

      // Current scan reproduced a DIFFERENT finding under the same workflow —
      // staleKey is not among currentKeys, so it should resolve.
      const currentKey = generateIssueKey("daily", "integrity", "broken_symlink: bin/new-tool");
      const resolved = tracker.resolveAbsent("daily", new Set([currentKey]));

      expect(resolved).toEqual([staleKey]);
      expect(tracker.get(staleKey)!.status).toBe("auto-resolved");
      expect(tracker.get(staleKey)!.resolvedAt).toBeDefined();
    });

    it("does NOT resolve a key that IS present in the current scan's findings", () => {
      const key = generateIssueKey("daily", "integrity", "broken_symlink: bin/still-broken");
      tracker.record(key, { lastSeen: new Date().toISOString(), type: "broken_symlink", finding: "broken_symlink: bin/still-broken", status: "monitoring" });

      const resolved = tracker.resolveAbsent("daily", new Set([key]));

      expect(resolved).toEqual([]);
      expect(tracker.get(key)!.status).toBe("monitoring");
    });

    it("does NOT touch keys belonging to a different workflow", () => {
      const dailyKey = generateIssueKey("daily", "integrity", "broken_symlink: bin/old-tool");
      tracker.record(dailyKey, { lastSeen: new Date().toISOString(), type: "broken_symlink", finding: "broken_symlink: bin/old-tool", status: "monitoring" });

      // A "weekly-security" scan completes with zero findings — must never
      // resolve a "daily" issue just because it ran.
      const resolved = tracker.resolveAbsent("weekly-security", new Set());

      expect(resolved).toEqual([]);
      expect(tracker.get(dailyKey)!.status).toBe("monitoring");
    });

    it("is idempotent — already auto-resolved keys are not re-stamped", () => {
      const key = generateIssueKey("daily", "integrity", "broken_symlink: bin/old-tool");
      tracker.record(key, { lastSeen: new Date().toISOString(), type: "broken_symlink", finding: "broken_symlink: bin/old-tool", status: "monitoring" });
      tracker.resolveAbsent("daily", new Set());
      const firstResolvedAt = tracker.get(key)!.resolvedAt;

      const resolvedAgain = tracker.resolveAbsent("daily", new Set());

      expect(resolvedAgain).toEqual([]);
      expect(tracker.get(key)!.resolvedAt).toBe(firstResolvedAt);
    });
  });

  describe("ISC trend calculation", () => {
    it("should calculate 7-day ISC pass rate", () => {
      // ISC S-05: ISC trend WARNING fires if 7-day pass rate < 80%
      const scores = [
        { date: "2026-03-21", pass: 8, total: 10 },
        { date: "2026-03-22", pass: 5, total: 10 },
        { date: "2026-03-23", pass: 6, total: 10 },
        { date: "2026-03-24", pass: 7, total: 10 },
        { date: "2026-03-25", pass: 5, total: 10 },
        { date: "2026-03-26", pass: 6, total: 10 },
        { date: "2026-03-27", pass: 8, total: 10 },
      ];

      const passRate = tracker.calculateISCPassRate(scores);

      expect(passRate).toBeDefined();
      expect(typeof passRate).toBe("number");
      expect(passRate).toBeLessThan(0.8); // Should be below 80%
    });
  });
});
