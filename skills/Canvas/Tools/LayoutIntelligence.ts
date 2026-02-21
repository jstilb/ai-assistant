#!/usr/bin/env bun
/**
 * LayoutIntelligence — Phase 4: AI Orchestration
 *
 * Feedback learning system for Canvas layout preferences.
 * Stores user rearrangement preferences with confidence scoring,
 * reinforcement on repeated patterns, and 14-day half-life decay.
 *
 * Confidence Math:
 *   Initial:        0.3
 *   Reinforcement:  newConf = oldConf + (1 - oldConf) * 0.3
 *   Decay:          decayedConf = conf * 2^(-daysSinceReinforced / 14)
 *   Prune:          < 0.2 threshold
 *   Cap:            200 max preferences
 *
 * CLI:
 *   bun LayoutIntelligence.ts consult "dashboard"
 *   bun LayoutIntelligence.ts store <delta-json>
 *   bun LayoutIntelligence.ts list
 *
 * @module LayoutIntelligence
 * @version 1.0.0
 */

import { z } from "zod";
import { join } from "path";
import { createStateManager, type StateManager } from "../../CORE/Tools/StateManager.ts";

// ============================================================================
// Constants
// ============================================================================

const INITIAL_CONFIDENCE = 0.3;
const REINFORCEMENT_FACTOR = 0.3;
const HALF_LIFE_DAYS = 14;
const PRUNE_THRESHOLD = 0.2;
const MAX_PREFERENCES = 200;

const DEFAULT_PREFS_PATH = join(
  import.meta.dir,
  "..",
  "State",
  "layout-preferences.json"
);

// ============================================================================
// Schemas
// ============================================================================

export const LayoutPreferenceFieldSchema = z.enum(["position", "size", "type"]);

export const LayoutPreferenceSchema = z.object({
  id: z.string(),
  intentPattern: z.string(),
  containerType: z.string(),
  field: LayoutPreferenceFieldSchema,
  preferredValue: z.unknown(),
  confidence: z.number().min(0).max(1),
  reinforcements: z.number().int().min(0),
  lastReinforced: z.string(),
  created: z.string(),
});

export const LayoutPreferencesSchema = z.object({
  preferences: z.array(LayoutPreferenceSchema),
  lastUpdated: z.string(),
});

export type LayoutPreference = z.infer<typeof LayoutPreferenceSchema>;
export type LayoutPreferenceField = z.infer<typeof LayoutPreferenceFieldSchema>;
export type LayoutPreferences = z.infer<typeof LayoutPreferencesSchema>;

// ============================================================================
// LayoutDelta type (matches spec)
// ============================================================================

export interface LayoutDelta {
  containerId: string;
  field: "position" | "size" | "type" | "removed" | "added";
  from: unknown;
  to: unknown;
  timestamp: number;
}

// ============================================================================
// LayoutIntelligence interface
// ============================================================================

export interface LayoutIntelligence {
  /**
   * Consult preferences for a given intent pattern.
   * Returns matching preferences with decay-adjusted confidence.
   * Prunes preferences below the threshold.
   */
  consult(intentPattern: string): Promise<LayoutPreference[]>;

  /**
   * Store or reinforce a layout preference from a user rearrangement delta.
   */
  store(
    intentPattern: string,
    containerType: string,
    delta: LayoutDelta
  ): Promise<void>;

  /**
   * Get all preferences (unfiltered, raw confidence without decay).
   */
  getAllPreferences(): Promise<LayoutPreference[]>;

  /**
   * Test helper: set lastReinforced for a specific preference.
   * Used only in tests to simulate time passage.
   */
  _testSetLastReinforced(
    intentPattern: string,
    containerType: string,
    field: string,
    isoTimestamp: string
  ): Promise<void>;
}

// ============================================================================
// Confidence Math
// ============================================================================

function applyDecay(confidence: number, lastReinforced: string): number {
  const daysSince =
    (Date.now() - new Date(lastReinforced).getTime()) / (1000 * 60 * 60 * 24);
  if (daysSince <= 0) return confidence;
  return confidence * Math.pow(2, -daysSince / HALF_LIFE_DAYS);
}

function reinforce(currentConfidence: number): number {
  return currentConfidence + (1 - currentConfidence) * REINFORCEMENT_FACTOR;
}

function generatePrefId(
  intentPattern: string,
  containerType: string,
  field: string
): string {
  return `${intentPattern}:${containerType}:${field}`;
}

// ============================================================================
// Factory
// ============================================================================

export function createLayoutIntelligence(
  prefsPath: string = DEFAULT_PREFS_PATH
): LayoutIntelligence {
  const stateManager = createStateManager<LayoutPreferences>({
    path: prefsPath,
    schema: LayoutPreferencesSchema,
    defaults: {
      preferences: [],
      lastUpdated: new Date().toISOString(),
    },
  });

  return {
    async consult(intentPattern: string): Promise<LayoutPreference[]> {
      const state = await stateManager.load();

      // Filter by intent pattern
      const matching = state.preferences.filter(
        (p) => p.intentPattern === intentPattern
      );

      // Apply decay to confidence scores
      const withDecay = matching.map((p) => ({
        ...p,
        confidence: applyDecay(p.confidence, p.lastReinforced),
      }));

      // Separate: above threshold vs below
      const active = withDecay.filter((p) => p.confidence >= PRUNE_THRESHOLD);
      const pruneIds = new Set(
        withDecay
          .filter((p) => p.confidence < PRUNE_THRESHOLD)
          .map((p) => p.id)
      );

      // Prune stale preferences from state if any fell below threshold
      if (pruneIds.size > 0) {
        await stateManager.update((s) => ({
          ...s,
          preferences: s.preferences.filter((p) => !pruneIds.has(p.id)),
        }));
      }

      return active;
    },

    async store(
      intentPattern: string,
      containerType: string,
      delta: LayoutDelta
    ): Promise<void> {
      // Only store position, size, and type changes
      const validFields = new Set(["position", "size", "type"]);
      if (!validFields.has(delta.field)) return;

      const field = delta.field as LayoutPreferenceField;
      const prefId = generatePrefId(intentPattern, containerType, field);
      const now = new Date().toISOString();

      await stateManager.update((state) => {
        const existing = state.preferences.find((p) => p.id === prefId);

        if (existing) {
          // Reinforce existing preference
          const updatedPrefs = state.preferences.map((p) =>
            p.id === prefId
              ? {
                  ...p,
                  preferredValue: delta.to,
                  confidence: Math.min(1, reinforce(p.confidence)),
                  reinforcements: p.reinforcements + 1,
                  lastReinforced: now,
                }
              : p
          );
          return { ...state, preferences: updatedPrefs };
        }

        // Create new preference
        const newPref: LayoutPreference = {
          id: prefId,
          intentPattern,
          containerType,
          field,
          preferredValue: delta.to,
          confidence: INITIAL_CONFIDENCE,
          reinforcements: 1,
          lastReinforced: now,
          created: now,
        };

        let prefs = [...state.preferences, newPref];

        // Cap at MAX_PREFERENCES, removing lowest confidence
        if (prefs.length > MAX_PREFERENCES) {
          prefs.sort((a, b) => b.confidence - a.confidence);
          prefs = prefs.slice(0, MAX_PREFERENCES);
        }

        return { ...state, preferences: prefs };
      });
    },

    async getAllPreferences(): Promise<LayoutPreference[]> {
      const state = await stateManager.load();
      return state.preferences;
    },

    async _testSetLastReinforced(
      intentPattern: string,
      containerType: string,
      field: string,
      isoTimestamp: string
    ): Promise<void> {
      const prefId = generatePrefId(intentPattern, containerType, field);
      await stateManager.update((state) => ({
        ...state,
        preferences: state.preferences.map((p) =>
          p.id === prefId ? { ...p, lastReinforced: isoTimestamp } : p
        ),
      }));
    },
  };
}

// ============================================================================
// CLI Interface (Article II compliance)
// ============================================================================

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  const li = createLayoutIntelligence();

  async function main(): Promise<void> {
    switch (command) {
      case "consult": {
        const pattern = args[0];
        if (!pattern) {
          console.error("Usage: bun LayoutIntelligence.ts consult <intent-pattern>");
          process.exit(1);
        }
        const prefs = await li.consult(pattern);
        console.log(JSON.stringify(prefs, null, 2));
        break;
      }
      case "store": {
        const jsonStr = args[0];
        if (!jsonStr) {
          console.error(
            'Usage: bun LayoutIntelligence.ts store \'{"intentPattern":"dashboard","containerType":"weather","delta":{...}}\''
          );
          process.exit(1);
        }
        const parsed = JSON.parse(jsonStr) as {
          intentPattern: string;
          containerType: string;
          delta: LayoutDelta;
        };
        await li.store(parsed.intentPattern, parsed.containerType, parsed.delta);
        console.log("Preference stored successfully.");
        break;
      }
      case "list": {
        const all = await li.getAllPreferences();
        console.log(JSON.stringify(all, null, 2));
        break;
      }
      default:
        console.error(
          "Usage: bun LayoutIntelligence.ts <consult|store|list> [args]"
        );
        process.exit(1);
    }
  }

  main().catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
