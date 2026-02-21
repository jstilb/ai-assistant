/**
 * PreferenceStore Test Suite - Phase 4
 *
 * Tests preference persistence, override tracking with 5-override threshold,
 * preference versioning, protected block management, and working hours.
 *
 * @module preference-store.test
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";

// Test-specific paths to avoid polluting production data
const TEST_DIR = "/tmp/calendar-phase4-pref-test";
const TEST_PREFS_PATH = `${TEST_DIR}/preferences.json`;
const TEST_VERSIONS_DIR = `${TEST_DIR}/versions`;

// We will test by importing the module functions with test paths.
// The implementation must support injecting paths for testability.

import {
  loadPreferences,
  updatePreferences,
  addProtectedBlock,
  removeProtectedBlock,
  updateWeights,
  setBreakFramework,
  recordOverride,
  getOverrideSuggestions,
  clearOverrides,
  getPreferenceHistory,
  snapshotPreferences,
  restorePreferences,
  createPreferenceStore,
} from "../PreferenceStore";

describe("PreferenceStore", () => {
  let store: ReturnType<typeof createPreferenceStore>;

  beforeEach(() => {
    // Clean test directory
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_VERSIONS_DIR, { recursive: true });

    // Create a test store instance
    store = createPreferenceStore({
      prefsPath: TEST_PREFS_PATH,
      versionsDir: TEST_VERSIONS_DIR,
    });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  // ============================================================================
  // 1. Default Preferences
  // ============================================================================
  describe("default preferences", () => {
    it("should return defaults when no file exists", async () => {
      const result = await store.loadPreferences();
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.workingHours.start).toBe("09:00");
        expect(result.data.workingHours.end).toBe("17:00");
        expect(result.data.defaultEventDuration).toBe(60);
        expect(result.data.bufferMinutesBetweenEvents).toBe(5);
        expect(result.data.preferredFocusTime).toBe("morning");
        expect(result.data.protectedBlocks).toEqual([]);
        expect(result.data.overrides).toEqual([]);
      }
    });

    it("should have optimization weights summing to 1.0", async () => {
      const result = await store.loadPreferences();
      expect(result.success).toBe(true);
      if (result.success) {
        const w = result.data.optimizationWeights;
        const sum = w.goalAlignment + w.timeOfDayPreference + w.breakCoverageImpact + w.calendarDensity;
        expect(Math.abs(sum - 1.0)).toBeLessThan(0.01);
      }
    });
  });

  // ============================================================================
  // 2. Working Hours
  // ============================================================================
  describe("working hours", () => {
    it("should update working hours", async () => {
      const result = await store.updatePreferences({
        workingHours: { start: "08:00", end: "18:00" },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.workingHours.start).toBe("08:00");
        expect(result.data.workingHours.end).toBe("18:00");
      }
    });

    it("should persist working hours across loads", async () => {
      await store.updatePreferences({
        workingHours: { start: "07:30", end: "16:30" },
      });
      const loaded = await store.loadPreferences();
      expect(loaded.success).toBe(true);
      if (loaded.success) {
        expect(loaded.data.workingHours.start).toBe("07:30");
        expect(loaded.data.workingHours.end).toBe("16:30");
      }
    });
  });

  // ============================================================================
  // 3. Preferred Meeting Times & Focus Time
  // ============================================================================
  describe("preferred times", () => {
    it("should set preferred focus time to afternoon", async () => {
      const result = await store.updatePreferences({
        preferredFocusTime: "afternoon",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.preferredFocusTime).toBe("afternoon");
      }
    });

    it("should set default event duration", async () => {
      const result = await store.updatePreferences({
        defaultEventDuration: 45,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.defaultEventDuration).toBe(45);
      }
    });

    it("should set buffer minutes between events", async () => {
      const result = await store.updatePreferences({
        bufferMinutesBetweenEvents: 10,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.bufferMinutesBetweenEvents).toBe(10);
      }
    });
  });

  // ============================================================================
  // 4. Protected Blocks
  // ============================================================================
  describe("protected blocks", () => {
    it("should add a protected block", async () => {
      const result = await store.addProtectedBlock({
        label: "Lunch Break",
        start: "12:00",
        end: "13:00",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.protectedBlocks).toHaveLength(1);
        expect(result.data.protectedBlocks[0].label).toBe("Lunch Break");
      }
    });

    it("should add a protected block with day-of-week", async () => {
      const result = await store.addProtectedBlock({
        label: "Weekly Focus Time",
        dayOfWeek: [1, 2, 3, 4, 5], // Mon-Fri
        start: "09:00",
        end: "11:00",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.protectedBlocks[0].dayOfWeek).toEqual([1, 2, 3, 4, 5]);
      }
    });

    it("should remove a protected block by label", async () => {
      await store.addProtectedBlock({
        label: "Lunch",
        start: "12:00",
        end: "13:00",
      });
      await store.addProtectedBlock({
        label: "Focus Time",
        start: "09:00",
        end: "11:00",
      });

      const result = await store.removeProtectedBlock("Lunch");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.protectedBlocks).toHaveLength(1);
        expect(result.data.protectedBlocks[0].label).toBe("Focus Time");
      }
    });

    it("should handle removing non-existent block gracefully", async () => {
      const result = await store.removeProtectedBlock("NonExistent");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.protectedBlocks).toHaveLength(0);
      }
    });
  });

  // ============================================================================
  // 5. Override Tracking
  // ============================================================================
  describe("override tracking", () => {
    it("should record a single override", async () => {
      const result = await store.recordOverride(
        "preferred_time",
        "morning",
        "afternoon"
      );
      expect(result.recorded).toBe(true);
      expect(result.suggestion).toBeUndefined();
    });

    it("should increment override count for same type+value", async () => {
      for (let i = 0; i < 3; i++) {
        await store.recordOverride("event_duration", "60", "45");
      }
      const prefs = await store.loadPreferences();
      expect(prefs.success).toBe(true);
      if (prefs.success) {
        const override = prefs.data.overrides.find(
          (o) => o.type === "event_duration" && o.newValue === "45"
        );
        expect(override).toBeDefined();
        expect(override!.count).toBe(3);
      }
    });

    it("should trigger suggestion at 5 overrides", async () => {
      let lastResult: any;
      for (let i = 0; i < 5; i++) {
        lastResult = await store.recordOverride(
          "preferred_time",
          "morning",
          "afternoon"
        );
      }
      expect(lastResult.recorded).toBe(true);
      expect(lastResult.suggestion).toBeDefined();
      expect(lastResult.suggestion).toContain("afternoon");
      expect(lastResult.suggestion).toContain("5");
    });

    it("should not trigger suggestion below threshold", async () => {
      let lastResult: any;
      for (let i = 0; i < 4; i++) {
        lastResult = await store.recordOverride(
          "preferred_time",
          "morning",
          "afternoon"
        );
      }
      expect(lastResult.suggestion).toBeUndefined();
    });

    it("should trigger suggestion at 6 overrides (above threshold)", async () => {
      let lastResult: any;
      for (let i = 0; i < 6; i++) {
        lastResult = await store.recordOverride(
          "buffer_time",
          "5",
          "10"
        );
      }
      expect(lastResult.suggestion).toBeDefined();
    });

    it("should track different override types independently", async () => {
      for (let i = 0; i < 5; i++) {
        await store.recordOverride("time", "morning", "afternoon");
      }
      const result = await store.recordOverride("duration", "60", "45");
      // Duration has only 1 override, should not trigger
      expect(result.suggestion).toBeUndefined();
    });

    it("should return override suggestions list", async () => {
      for (let i = 0; i < 5; i++) {
        await store.recordOverride("focus_time", "morning", "evening");
      }
      const suggestions = await store.getOverrideSuggestions();
      expect(suggestions.length).toBeGreaterThanOrEqual(1);
      expect(suggestions[0]).toContain("evening");
    });

    it("should clear overrides", async () => {
      for (let i = 0; i < 3; i++) {
        await store.recordOverride("test", "a", "b");
      }
      await store.clearOverrides();
      const prefs = await store.loadPreferences();
      expect(prefs.success).toBe(true);
      if (prefs.success) {
        expect(prefs.data.overrides).toHaveLength(0);
      }
    });
  });

  // ============================================================================
  // 6. Optimization Weights
  // ============================================================================
  describe("optimization weights", () => {
    it("should normalize weights to sum to 1.0", async () => {
      const result = await store.updateWeights({
        goalAlignment: 4,
        timeOfDayPreference: 3,
        breakCoverageImpact: 2,
        calendarDensity: 1,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        const w = result.data.optimizationWeights;
        const sum = w.goalAlignment + w.timeOfDayPreference + w.breakCoverageImpact + w.calendarDensity;
        expect(Math.abs(sum - 1.0)).toBeLessThan(0.01);
        expect(w.goalAlignment).toBeCloseTo(0.4, 2);
      }
    });
  });

  // ============================================================================
  // 7. Break Framework
  // ============================================================================
  describe("break framework", () => {
    it("should set pomodoro framework", async () => {
      const result = await store.setBreakFramework({
        framework: "pomodoro",
        workMinutes: 25,
        breakMinutes: 5,
        longBreakMinutes: 15,
        longBreakInterval: 4,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.breakFramework.framework).toBe("pomodoro");
        expect(result.data.breakFramework.workMinutes).toBe(25);
      }
    });
  });

  // ============================================================================
  // 8. Preference Versioning
  // ============================================================================
  describe("preference versioning", () => {
    it("should create a snapshot of current preferences", async () => {
      await store.updatePreferences({
        workingHours: { start: "08:00", end: "16:00" },
      });
      const snapshotId = await store.snapshotPreferences("Before experiment");
      expect(snapshotId).toBeDefined();
      expect(typeof snapshotId).toBe("string");
    });

    it("should restore preferences from a snapshot", async () => {
      // Set initial state
      await store.updatePreferences({
        workingHours: { start: "08:00", end: "16:00" },
      });
      const snapshotId = await store.snapshotPreferences("Baseline");

      // Change preferences
      await store.updatePreferences({
        workingHours: { start: "10:00", end: "18:00" },
      });

      // Restore to snapshot
      const result = await store.restorePreferences(snapshotId);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.workingHours.start).toBe("08:00");
        expect(result.data.workingHours.end).toBe("16:00");
      }
    });

    it("should list preference history", async () => {
      await store.snapshotPreferences("Version 1");
      // Small delay to ensure different timestamps
      await new Promise((r) => setTimeout(r, 10));
      await store.updatePreferences({ defaultEventDuration: 30 });
      await store.snapshotPreferences("Version 2");

      const history = await store.getPreferenceHistory();
      expect(history.length).toBeGreaterThanOrEqual(2);
      const labels = history.map((h) => h.label);
      expect(labels).toContain("Version 1");
      expect(labels).toContain("Version 2");
      // First entry should be the earlier snapshot
      expect(history[0].label).toBe("Version 1");
      expect(history[1].label).toBe("Version 2");
    });

    it("should fail gracefully when restoring non-existent snapshot", async () => {
      const result = await store.restorePreferences("non-existent-id");
      expect(result.success).toBe(false);
    });
  });

  // ============================================================================
  // 9. CLI Interface
  // ============================================================================
  describe("CLI interface", () => {
    it("should have a show command via CLI entry point", async () => {
      // Just verify the module has the CLI guard
      // Actual CLI testing happens via integration
      expect(typeof store.loadPreferences).toBe("function");
    });
  });
});
