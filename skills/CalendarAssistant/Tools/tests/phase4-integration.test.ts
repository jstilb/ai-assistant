/**
 * Phase 4 Integration Test Suite
 *
 * Tests the full flow: PreferenceStore -> AuditLogger -> RationaleGenerator
 * working together for a scheduling decision lifecycle.
 *
 * @module phase4-integration.test
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";

import { createPreferenceStore } from "../PreferenceStore";
import { createAuditLogger } from "../AuditLogger";
import {
  generateCreateRationale,
  generateOptimizationRationale,
  validateRationale,
} from "../RationaleGenerator";
import { IntentType } from "../types";
import type { ParsedIntent, GoalAlignment, SlotScore } from "../types";

const TEST_DIR = "/tmp/calendar-phase4-integration-test";

describe("Phase 4 Integration", () => {
  let prefStore: ReturnType<typeof createPreferenceStore>;
  let auditLogger: ReturnType<typeof createAuditLogger>;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });

    prefStore = createPreferenceStore({
      prefsPath: `${TEST_DIR}/preferences.json`,
      versionsDir: `${TEST_DIR}/versions`,
    });

    auditLogger = createAuditLogger({
      logPath: `${TEST_DIR}/audit.jsonl`,
      maxFileSizeMB: 10,
      retentionCount: 3,
    });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  // ============================================================================
  // Full Scheduling Decision Lifecycle
  // ============================================================================
  describe("scheduling decision lifecycle", () => {
    it("should flow: load prefs -> generate rationale -> audit log", async () => {
      // 1. Load user preferences
      const prefs = await prefStore.loadPreferences();
      expect(prefs.success).toBe(true);

      // 2. Generate rationale based on preferences
      const intent: ParsedIntent = {
        type: IntentType.Create,
        confidence: 0.92,
        entities: { title: "Deep Work: Project X", duration: 120 },
        rawInput: "schedule 2 hours for deep work on Project X",
      };

      const goalAlignments: GoalAlignment[] = [
        {
          goalId: "goal-q1",
          goalTitle: "Complete Project X",
          score: 92,
          matchedKeywords: ["project x", "deep work"],
        },
      ];

      const slotScore: SlotScore = {
        goalAlignment: 0.92,
        timeOfDayPreference: 0.88,
        breakCoverageImpact: 0.95,
        calendarDensity: 0.75,
        composite: 0.87,
      };

      const rationale = generateCreateRationale({
        intent,
        goalAlignments,
        slotScore,
        preferenceNotes: ["Morning slot selected for optimal focus time"],
      });

      expect(rationale.summary).toBeDefined();
      expect(rationale.summary.length).toBeGreaterThan(20);
      expect(validateRationale(rationale.summary)).toBe(true);
      expect(rationale.dimensions.length).toBeGreaterThanOrEqual(4);

      // 3. Log the decision to audit
      auditLogger.logAction({
        timestamp: new Date().toISOString(),
        actionType: "create",
        eventId: "evt-new-001",
        confidence: intent.confidence,
        rationalePreview: rationale.summary.slice(0, 100),
        outcome: "success",
        details: {
          title: "Deep Work: Project X",
          goalAlignment: 92,
          slotComposite: 0.87,
        },
      });

      // 4. Verify audit entry was created
      const auditEntries = auditLogger.readLog();
      expect(auditEntries).toHaveLength(1);
      expect(auditEntries[0].eventId).toBe("evt-new-001");
      expect(auditEntries[0].confidence).toBe(0.92);

      // 5. Verify PII was redacted in audit details (title in details is redacted)
      const rawLog = require("fs").readFileSync(`${TEST_DIR}/audit.jsonl`, "utf-8");
      const parsed = JSON.parse(rawLog.trim());
      // The title in details should be redacted
      expect(parsed.details.title).toMatch(/\[REDACTED:/);
      // The rationalePreview is a user-facing summary (not PII-filtered)
      expect(parsed.rationalePreview).toBeDefined();
    });
  });

  // ============================================================================
  // Override Detection -> Preference Update Flow
  // ============================================================================
  describe("override detection flow", () => {
    it("should detect repeated overrides and suggest preference update", async () => {
      // Simulate user repeatedly choosing afternoon over morning
      for (let i = 0; i < 5; i++) {
        const result = await prefStore.recordOverride(
          "preferred_time",
          "morning",
          "afternoon"
        );

        // Log each override to audit
        auditLogger.logAction({
          timestamp: new Date().toISOString(),
          actionType: "modify",
          confidence: 1.0,
          rationalePreview: `User override: preferred_time morning -> afternoon (${i + 1}/5)`,
          outcome: "success",
        });

        if (i === 4) {
          // 5th override should trigger suggestion
          expect(result.suggestion).toBeDefined();
          expect(result.suggestion).toContain("afternoon");
        }
      }

      // Verify all overrides are in audit log
      const auditEntries = auditLogger.queryLog({ actionType: "modify" });
      expect(auditEntries).toHaveLength(5);

      // Verify suggestion is in override suggestions
      const suggestions = await prefStore.getOverrideSuggestions();
      expect(suggestions.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ============================================================================
  // Preference Snapshot -> Restore Flow
  // ============================================================================
  describe("preference version management", () => {
    it("should snapshot, modify, and restore preferences", async () => {
      // Set initial preferences
      await prefStore.updatePreferences({
        workingHours: { start: "09:00", end: "17:00" },
        defaultEventDuration: 60,
      });

      // Snapshot before experiment
      const snapshotId = await prefStore.snapshotPreferences("Before focus time experiment");

      // Modify preferences for experiment
      await prefStore.updatePreferences({
        workingHours: { start: "07:00", end: "15:00" },
        defaultEventDuration: 90,
        preferredFocusTime: "morning",
      });

      // Generate rationale with new preferences
      const rationale = generateOptimizationRationale({
        suggestionCount: 2,
        goalAlignmentScore: 78,
        breakCoverage: 92,
        conflictCount: 0,
      });
      expect(validateRationale(rationale.summary)).toBe(true);

      // Experiment did not work, restore
      const restored = await prefStore.restorePreferences(snapshotId);
      expect(restored.success).toBe(true);
      if (restored.success) {
        expect(restored.data.workingHours.start).toBe("09:00");
        expect(restored.data.defaultEventDuration).toBe(60);
      }
    });
  });

  // ============================================================================
  // Audit Query with Multiple Action Types
  // ============================================================================
  describe("audit query across action types", () => {
    it("should track mixed action types and query correctly", () => {
      // Create a variety of audit entries
      const actions = [
        { actionType: "create", eventId: "e1", confidence: 0.95 },
        { actionType: "modify", eventId: "e1", confidence: 0.9 },
        { actionType: "delete", eventId: "e2", confidence: 0.88 },
        { actionType: "create", eventId: "e3", confidence: 0.92 },
        { actionType: "query", confidence: 1.0 },
        { actionType: "optimize", confidence: 0.8 },
      ];

      for (const a of actions) {
        auditLogger.logAction({
          timestamp: new Date().toISOString(),
          actionType: a.actionType,
          eventId: a.eventId,
          confidence: a.confidence,
          rationalePreview: `${a.actionType} action`,
          outcome: "success",
        } as any);
      }

      // Query creates only
      const creates = auditLogger.queryLog({ actionType: "create" });
      expect(creates).toHaveLength(2);

      // Get event trail for e1
      const e1Trail = auditLogger.getEventAuditTrail("e1");
      expect(e1Trail).toHaveLength(2); // create + modify

      // Get overall stats
      const stats = auditLogger.getAuditStats();
      expect(stats.totalActions).toBe(6);
      expect(stats.byType["create"]).toBe(2);
      expect(stats.avgConfidence).toBeGreaterThan(0.8);
    });
  });
});
