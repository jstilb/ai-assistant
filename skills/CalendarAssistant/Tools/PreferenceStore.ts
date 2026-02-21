#!/usr/bin/env bun
/**
 * PreferenceStore.ts - User Preferences, Override Tracking & Versioning
 *
 * Phase 4: Enhanced with preference versioning (snapshot/restore),
 * explicit preference capture (working hours, protected blocks,
 * meeting duration defaults), and 5-override threshold prompting.
 *
 * Persists user preferences via StateManager. Tracks manual overrides
 * and when the same type of override occurs 5+ times, proactively asks
 * if the preference should be updated.
 *
 * @module PreferenceStore
 */

import { z } from "zod";
import { createStateManager } from "../../CORE/Tools/StateManager";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import type {
  UserPreferences,
  ProtectedBlock,
  OverrideRecord,
  BreakConfig,
  OptimizationWeights,
  Result,
  CalendarError,
} from "./types";
import { BreakFramework } from "./types";

const KAYA_DIR = process.env.KAYA_DIR || `${process.env.HOME}/.claude`;
const DEFAULT_PREFS_PATH = `${KAYA_DIR}/skills/CalendarAssistant/data/preferences.json`;
const DEFAULT_VERSIONS_DIR = `${KAYA_DIR}/skills/CalendarAssistant/data/versions`;

// ============================================
// SCHEMA
// ============================================

const ProtectedBlockSchema = z.object({
  label: z.string(),
  dayOfWeek: z.array(z.number()).optional(),
  start: z.string(),
  end: z.string(),
});

const BreakConfigSchema = z.object({
  framework: z.enum(["pomodoro", "52-17", "custom"]),
  workMinutes: z.number(),
  breakMinutes: z.number(),
  longBreakMinutes: z.number().optional(),
  longBreakInterval: z.number().optional(),
});

const OptimizationWeightsSchema = z.object({
  goalAlignment: z.number(),
  timeOfDayPreference: z.number(),
  breakCoverageImpact: z.number(),
  calendarDensity: z.number(),
});

const OverrideRecordSchema = z.object({
  type: z.string(),
  originalValue: z.string(),
  newValue: z.string(),
  timestamp: z.string(),
  count: z.number(),
});

const PreferencesSchema = z.object({
  workingHours: z.object({
    start: z.string(),
    end: z.string(),
  }),
  protectedBlocks: z.array(ProtectedBlockSchema),
  breakFramework: BreakConfigSchema,
  optimizationWeights: OptimizationWeightsSchema,
  preferredFocusTime: z.enum(["morning", "afternoon", "evening"]),
  defaultEventDuration: z.number(),
  bufferMinutesBetweenEvents: z.number(),
  overrides: z.array(OverrideRecordSchema),
  lastUpdated: z.string(),
});

// ============================================
// DEFAULT PREFERENCES
// ============================================

const DEFAULT_PREFERENCES: UserPreferences = {
  workingHours: { start: "09:00", end: "17:00" },
  protectedBlocks: [],
  breakFramework: {
    framework: BreakFramework.FiftyTwoSeventeen,
    workMinutes: 52,
    breakMinutes: 17,
  },
  optimizationWeights: {
    goalAlignment: 0.35,
    timeOfDayPreference: 0.25,
    breakCoverageImpact: 0.2,
    calendarDensity: 0.2,
  },
  preferredFocusTime: "morning",
  defaultEventDuration: 60,
  bufferMinutesBetweenEvents: 5,
  overrides: [],
  lastUpdated: new Date().toISOString(),
};

// ============================================
// OVERRIDE THRESHOLD
// ============================================

const OVERRIDE_THRESHOLD = 5;

// ============================================
// PREFERENCE HISTORY TYPES
// ============================================

interface PreferenceSnapshot {
  id: string;
  label: string;
  timestamp: string;
  preferences: UserPreferences;
}

interface PreferenceHistoryEntry {
  id: string;
  label: string;
  timestamp: string;
}

// ============================================
// FACTORY CONFIG
// ============================================

interface PreferenceStoreConfig {
  prefsPath?: string;
  versionsDir?: string;
}

// ============================================
// PREFERENCE STORE FACTORY
// ============================================

export function createPreferenceStore(config?: PreferenceStoreConfig) {
  const prefsPath = config?.prefsPath || DEFAULT_PREFS_PATH;
  const versionsDir = config?.versionsDir || DEFAULT_VERSIONS_DIR;

  const prefManager = createStateManager<UserPreferences>({
    path: prefsPath,
    schema: PreferencesSchema,
    defaults: DEFAULT_PREFERENCES,
    version: 1,
  });

  // Ensure versions directory exists
  function ensureVersionsDir(): void {
    if (!existsSync(versionsDir)) {
      mkdirSync(versionsDir, { recursive: true });
    }
  }

  // ============================================
  // OVERRIDE TRACKING
  // ============================================

  async function recordOverride(
    type: string,
    originalValue: string,
    newValue: string
  ): Promise<{ recorded: true; suggestion?: string }> {
    const prefs = await prefManager.load();
    const existing = prefs.overrides.find(
      (o) => o.type === type && o.newValue === newValue
    );

    if (existing) {
      existing.count += 1;
      existing.timestamp = new Date().toISOString();
    } else {
      prefs.overrides.push({
        type,
        originalValue,
        newValue,
        timestamp: new Date().toISOString(),
        count: 1,
      });
    }

    await prefManager.save(prefs);

    // Check if threshold reached
    const updatedOverride = prefs.overrides.find(
      (o) => o.type === type && o.newValue === newValue
    );

    if (updatedOverride && updatedOverride.count >= OVERRIDE_THRESHOLD) {
      return {
        recorded: true,
        suggestion: `You consistently prefer "${newValue}" over "${originalValue}" for ${type} (${updatedOverride.count} times). Should I update your default preference?`,
      };
    }

    return { recorded: true };
  }

  // ============================================
  // PUBLIC API
  // ============================================

  async function loadPreferences(): Promise<
    Result<UserPreferences, CalendarError>
  > {
    try {
      const prefs = await prefManager.load();
      return { success: true, data: prefs };
    } catch (err) {
      return {
        success: false,
        error: {
          code: "UNKNOWN",
          message: `Failed to load preferences: ${err instanceof Error ? err.message : String(err)}`,
          retryable: true,
        },
      };
    }
  }

  async function updatePreferences(
    updates: Partial<UserPreferences>
  ): Promise<Result<UserPreferences, CalendarError>> {
    try {
      const updated = await prefManager.update((prefs) => ({
        ...prefs,
        ...updates,
        lastUpdated: new Date().toISOString(),
      }));
      return { success: true, data: updated };
    } catch (err) {
      return {
        success: false,
        error: {
          code: "UNKNOWN",
          message: `Failed to update preferences: ${err instanceof Error ? err.message : String(err)}`,
          retryable: false,
        },
      };
    }
  }

  async function addProtectedBlock(
    block: ProtectedBlock
  ): Promise<Result<UserPreferences, CalendarError>> {
    try {
      const updated = await prefManager.update((prefs) => ({
        ...prefs,
        protectedBlocks: [...prefs.protectedBlocks, block],
      }));
      return { success: true, data: updated };
    } catch (err) {
      return {
        success: false,
        error: {
          code: "UNKNOWN",
          message: `Failed to add protected block: ${err instanceof Error ? err.message : String(err)}`,
          retryable: false,
        },
      };
    }
  }

  async function removeProtectedBlock(
    label: string
  ): Promise<Result<UserPreferences, CalendarError>> {
    try {
      const updated = await prefManager.update((prefs) => ({
        ...prefs,
        protectedBlocks: prefs.protectedBlocks.filter(
          (b) => b.label !== label
        ),
      }));
      return { success: true, data: updated };
    } catch (err) {
      return {
        success: false,
        error: {
          code: "UNKNOWN",
          message: `Failed to remove protected block: ${err instanceof Error ? err.message : String(err)}`,
          retryable: false,
        },
      };
    }
  }

  async function updateWeights(
    weights: OptimizationWeights
  ): Promise<Result<UserPreferences, CalendarError>> {
    const sum =
      weights.goalAlignment +
      weights.timeOfDayPreference +
      weights.breakCoverageImpact +
      weights.calendarDensity;

    const normalized: OptimizationWeights = {
      goalAlignment: weights.goalAlignment / sum,
      timeOfDayPreference: weights.timeOfDayPreference / sum,
      breakCoverageImpact: weights.breakCoverageImpact / sum,
      calendarDensity: weights.calendarDensity / sum,
    };

    return updatePreferences({ optimizationWeights: normalized });
  }

  async function setBreakFramework(
    config: BreakConfig
  ): Promise<Result<UserPreferences, CalendarError>> {
    return updatePreferences({ breakFramework: config });
  }

  async function getOverrideSuggestions(): Promise<string[]> {
    const prefs = await prefManager.load();
    return prefs.overrides
      .filter((o) => o.count >= OVERRIDE_THRESHOLD)
      .map(
        (o) =>
          `Update ${o.type}: "${o.originalValue}" -> "${o.newValue}" (overridden ${o.count} times)`
      );
  }

  async function clearOverrides(): Promise<void> {
    await prefManager.update((prefs) => ({
      ...prefs,
      overrides: [],
    }));
  }

  // ============================================
  // PREFERENCE VERSIONING
  // ============================================

  async function snapshotPreferences(label: string): Promise<string> {
    ensureVersionsDir();
    const prefs = await prefManager.load();
    const id = `snap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const snapshot: PreferenceSnapshot = {
      id,
      label,
      timestamp: new Date().toISOString(),
      preferences: prefs,
    };
    const snapshotPath = join(versionsDir, `${id}.json`);
    writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
    return id;
  }

  async function restorePreferences(
    snapshotId: string
  ): Promise<Result<UserPreferences, CalendarError>> {
    ensureVersionsDir();
    const snapshotPath = join(versionsDir, `${snapshotId}.json`);

    if (!existsSync(snapshotPath)) {
      return {
        success: false,
        error: {
          code: "UNKNOWN",
          message: `Snapshot not found: ${snapshotId}`,
          retryable: false,
        },
      };
    }

    try {
      const raw = readFileSync(snapshotPath, "utf-8");
      const snapshot: PreferenceSnapshot = JSON.parse(raw);
      await prefManager.save(snapshot.preferences);
      return { success: true, data: snapshot.preferences };
    } catch (err) {
      return {
        success: false,
        error: {
          code: "UNKNOWN",
          message: `Failed to restore snapshot: ${err instanceof Error ? err.message : String(err)}`,
          retryable: false,
        },
      };
    }
  }

  async function getPreferenceHistory(): Promise<PreferenceHistoryEntry[]> {
    ensureVersionsDir();
    const files = readdirSync(versionsDir).filter((f) =>
      f.endsWith(".json")
    );

    const history: PreferenceHistoryEntry[] = [];
    for (const file of files) {
      try {
        const raw = readFileSync(join(versionsDir, file), "utf-8");
        const snapshot: PreferenceSnapshot = JSON.parse(raw);
        history.push({
          id: snapshot.id,
          label: snapshot.label,
          timestamp: snapshot.timestamp,
        });
      } catch {
        // Skip corrupted snapshots
      }
    }

    // Sort by timestamp (chronological order)
    history.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    return history;
  }

  return {
    loadPreferences,
    updatePreferences,
    addProtectedBlock,
    removeProtectedBlock,
    updateWeights,
    setBreakFramework,
    recordOverride,
    getOverrideSuggestions,
    clearOverrides,
    snapshotPreferences,
    restorePreferences,
    getPreferenceHistory,
  };
}

// ============================================
// MODULE-LEVEL EXPORTS (backward compatibility)
// ============================================

const defaultStore = createPreferenceStore();

export const loadPreferences = defaultStore.loadPreferences;
export const updatePreferences = defaultStore.updatePreferences;
export const addProtectedBlock = defaultStore.addProtectedBlock;
export const removeProtectedBlock = defaultStore.removeProtectedBlock;
export const updateWeights = defaultStore.updateWeights;
export const setBreakFramework = defaultStore.setBreakFramework;
export const recordOverride = defaultStore.recordOverride;
export const getOverrideSuggestions = defaultStore.getOverrideSuggestions;
export const clearOverrides = defaultStore.clearOverrides;
export const snapshotPreferences = defaultStore.snapshotPreferences;
export const restorePreferences = defaultStore.restorePreferences;
export const getPreferenceHistory = defaultStore.getPreferenceHistory;

// CLI interface
if (import.meta.main) {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "show") {
    const result = await loadPreferences();
    console.log(JSON.stringify(result, null, 2));
  } else if (command === "suggestions") {
    const suggestions = await getOverrideSuggestions();
    if (suggestions.length > 0) {
      console.log("Override suggestions:");
      suggestions.forEach((s) => console.log(`  - ${s}`));
    } else {
      console.log("No override suggestions yet.");
    }
  } else if (command === "history") {
    const history = await getPreferenceHistory();
    if (history.length > 0) {
      console.log("Preference snapshots:");
      for (const entry of history) {
        console.log(`  [${entry.id}] ${entry.label} (${entry.timestamp})`);
      }
    } else {
      console.log("No snapshots yet.");
    }
  } else if (command === "snapshot") {
    const label = args.slice(1).join(" ") || "Manual snapshot";
    const id = await snapshotPreferences(label);
    console.log(`Snapshot created: ${id}`);
  } else if (command === "restore") {
    const snapshotId = args[1];
    if (!snapshotId) {
      console.error("Usage: PreferenceStore.ts restore <snapshot-id>");
      process.exit(1);
    }
    const result = await restorePreferences(snapshotId);
    if (result.success) {
      console.log("Preferences restored successfully.");
    } else {
      console.error(`Restore failed: ${result.error.message}`);
    }
  } else {
    console.log(`PreferenceStore - User Preference Management

Usage:
  bun run PreferenceStore.ts show            Show current preferences
  bun run PreferenceStore.ts suggestions     Show override suggestions
  bun run PreferenceStore.ts history         List preference snapshots
  bun run PreferenceStore.ts snapshot <lbl>  Create preference snapshot
  bun run PreferenceStore.ts restore <id>    Restore from snapshot
`);
  }
}
