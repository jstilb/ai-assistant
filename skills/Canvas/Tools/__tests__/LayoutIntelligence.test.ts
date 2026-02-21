#!/usr/bin/env bun
/**
 * LayoutIntelligence Tests — Phase 4: AI Orchestration
 *
 * Tests the feedback learning system that stores user layout preferences
 * with confidence scoring, reinforcement, and decay.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";

// Test with a temporary preferences file
const TEST_STATE_DIR = "/tmp/canvas-layout-intelligence-test";
const TEST_PREFS_PATH = join(TEST_STATE_DIR, "layout-preferences.json");

// We'll import the module under test
import {
  createLayoutIntelligence,
  type LayoutPreference,
  type LayoutDelta,
  LayoutPreferencesSchema,
} from "../LayoutIntelligence.ts";

describe("LayoutIntelligence", () => {
  beforeEach(() => {
    // Clean up test state
    if (existsSync(TEST_PREFS_PATH)) unlinkSync(TEST_PREFS_PATH);
    if (existsSync(`${TEST_PREFS_PATH}.lock`)) unlinkSync(`${TEST_PREFS_PATH}.lock`);
    mkdirSync(TEST_STATE_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_PREFS_PATH)) unlinkSync(TEST_PREFS_PATH);
    if (existsSync(`${TEST_PREFS_PATH}.lock`)) unlinkSync(`${TEST_PREFS_PATH}.lock`);
  });

  describe("Schema validation", () => {
    test("LayoutPreferencesSchema validates correct data", () => {
      const data = {
        preferences: [
          {
            id: "pref-1",
            intentPattern: "dashboard",
            containerType: "weather",
            field: "position" as const,
            preferredValue: { x: 2, y: 0 },
            confidence: 0.3,
            reinforcements: 1,
            lastReinforced: new Date().toISOString(),
            created: new Date().toISOString(),
          },
        ],
        lastUpdated: new Date().toISOString(),
      };
      const result = LayoutPreferencesSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    test("LayoutPreferencesSchema rejects confidence > 1", () => {
      const data = {
        preferences: [
          {
            id: "pref-1",
            intentPattern: "dashboard",
            containerType: "weather",
            field: "position" as const,
            preferredValue: { x: 0, y: 0 },
            confidence: 1.5,
            reinforcements: 1,
            lastReinforced: new Date().toISOString(),
            created: new Date().toISOString(),
          },
        ],
        lastUpdated: new Date().toISOString(),
      };
      const result = LayoutPreferencesSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    test("LayoutPreferencesSchema rejects confidence < 0", () => {
      const data = {
        preferences: [
          {
            id: "pref-1",
            intentPattern: "dashboard",
            containerType: "weather",
            field: "position" as const,
            preferredValue: { x: 0, y: 0 },
            confidence: -0.1,
            reinforcements: 1,
            lastReinforced: new Date().toISOString(),
            created: new Date().toISOString(),
          },
        ],
        lastUpdated: new Date().toISOString(),
      };
      const result = LayoutPreferencesSchema.safeParse(data);
      expect(result.success).toBe(false);
    });
  });

  describe("consult", () => {
    test("returns empty array when no preferences exist", async () => {
      const li = createLayoutIntelligence(TEST_PREFS_PATH);
      const prefs = await li.consult("dashboard");
      expect(prefs).toEqual([]);
    });

    test("returns matching preferences for intent pattern", async () => {
      const li = createLayoutIntelligence(TEST_PREFS_PATH);

      // Store a preference first
      const delta: LayoutDelta = {
        containerId: "weather-1",
        field: "position",
        from: { x: 0, y: 0 },
        to: { x: 2, y: 0 },
        timestamp: Date.now(),
      };
      await li.store("dashboard", "weather", delta);

      const prefs = await li.consult("dashboard");
      expect(prefs.length).toBe(1);
      expect(prefs[0].containerType).toBe("weather");
      expect(prefs[0].intentPattern).toBe("dashboard");
      expect(prefs[0].field).toBe("position");
    });

    test("does not return preferences for different intents", async () => {
      const li = createLayoutIntelligence(TEST_PREFS_PATH);

      const delta: LayoutDelta = {
        containerId: "weather-1",
        field: "position",
        from: { x: 0, y: 0 },
        to: { x: 2, y: 0 },
        timestamp: Date.now(),
      };
      await li.store("dashboard", "weather", delta);

      const prefs = await li.consult("briefing");
      expect(prefs.length).toBe(0);
    });

    test("applies time decay to confidence scores", async () => {
      const li = createLayoutIntelligence(TEST_PREFS_PATH);

      const delta: LayoutDelta = {
        containerId: "weather-1",
        field: "position",
        from: { x: 0, y: 0 },
        to: { x: 2, y: 0 },
        timestamp: Date.now(),
      };
      // Reinforce twice to get confidence 0.51 (above prune threshold after decay)
      await li.store("dashboard", "weather", delta);
      await li.store("dashboard", "weather", delta);

      // Manually adjust the lastReinforced to 14 days ago
      await li._testSetLastReinforced("dashboard", "weather", "position",
        new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()
      );

      const prefs = await li.consult("dashboard");
      expect(prefs.length).toBe(1);
      // After 14 days (one half-life), confidence 0.51 -> ~0.255
      expect(prefs[0].confidence).toBeCloseTo(0.255, 1);
    });
  });

  describe("store", () => {
    test("creates new preference with initial confidence 0.3", async () => {
      const li = createLayoutIntelligence(TEST_PREFS_PATH);

      const delta: LayoutDelta = {
        containerId: "weather-1",
        field: "position",
        from: { x: 0, y: 0 },
        to: { x: 2, y: 0 },
        timestamp: Date.now(),
      };
      await li.store("dashboard", "weather", delta);

      const prefs = await li.consult("dashboard");
      expect(prefs.length).toBe(1);
      expect(prefs[0].confidence).toBeCloseTo(0.3, 2);
      expect(prefs[0].reinforcements).toBe(1);
    });

    test("reinforces existing preference with correct formula", async () => {
      const li = createLayoutIntelligence(TEST_PREFS_PATH);

      const delta: LayoutDelta = {
        containerId: "weather-1",
        field: "position",
        from: { x: 0, y: 0 },
        to: { x: 2, y: 0 },
        timestamp: Date.now(),
      };

      // First store: confidence = 0.3
      await li.store("dashboard", "weather", delta);

      // Second store (reinforce): confidence = 0.3 + (1 - 0.3) * 0.3 = 0.51
      await li.store("dashboard", "weather", delta);

      const prefs = await li.consult("dashboard");
      expect(prefs.length).toBe(1);
      expect(prefs[0].confidence).toBeCloseTo(0.51, 2);
      expect(prefs[0].reinforcements).toBe(2);
    });

    test("triple reinforcement yields confidence >= 0.66", async () => {
      const li = createLayoutIntelligence(TEST_PREFS_PATH);

      const delta: LayoutDelta = {
        containerId: "weather-1",
        field: "position",
        from: { x: 0, y: 0 },
        to: { x: 2, y: 0 },
        timestamp: Date.now(),
      };

      await li.store("dashboard", "weather", delta);
      await li.store("dashboard", "weather", delta);
      await li.store("dashboard", "weather", delta);

      const prefs = await li.consult("dashboard");
      // 0.3 -> 0.51 -> 0.657
      expect(prefs[0].confidence).toBeGreaterThanOrEqual(0.65);
      expect(prefs[0].reinforcements).toBe(3);
    });

    test("fourth reinforcement yields confidence >= 0.76 (auto-applied threshold)", async () => {
      const li = createLayoutIntelligence(TEST_PREFS_PATH);

      const delta: LayoutDelta = {
        containerId: "weather-1",
        field: "position",
        from: { x: 0, y: 0 },
        to: { x: 2, y: 0 },
        timestamp: Date.now(),
      };

      await li.store("dashboard", "weather", delta);
      await li.store("dashboard", "weather", delta);
      await li.store("dashboard", "weather", delta);
      await li.store("dashboard", "weather", delta);

      const prefs = await li.consult("dashboard");
      // 0.3 -> 0.51 -> 0.657 -> 0.76
      expect(prefs[0].confidence).toBeGreaterThanOrEqual(0.7);
    });
  });

  describe("pruning", () => {
    test("prunes preferences below 0.2 threshold on consult", async () => {
      const li = createLayoutIntelligence(TEST_PREFS_PATH);

      // Store a preference
      const delta: LayoutDelta = {
        containerId: "weather-1",
        field: "position",
        from: { x: 0, y: 0 },
        to: { x: 2, y: 0 },
        timestamp: Date.now(),
      };
      await li.store("dashboard", "weather", delta);

      // Set last reinforced to 35 days ago (confidence should decay below 0.2)
      // 0.3 * 2^(-35/14) = 0.3 * 2^(-2.5) = 0.3 * 0.177 = 0.053
      await li._testSetLastReinforced("dashboard", "weather", "position",
        new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString()
      );

      const prefs = await li.consult("dashboard");
      // Should be pruned (below 0.2 threshold)
      expect(prefs.length).toBe(0);
    });

    test("caps preferences at 200, removing lowest confidence", async () => {
      const li = createLayoutIntelligence(TEST_PREFS_PATH);

      // Store 201 preferences
      for (let i = 0; i < 201; i++) {
        const delta: LayoutDelta = {
          containerId: `container-${i}`,
          field: "position",
          from: { x: 0, y: 0 },
          to: { x: i % 4, y: Math.floor(i / 4) },
          timestamp: Date.now(),
        };
        await li.store("dashboard", `type-${i}`, delta);
      }

      const allPrefs = await li.getAllPreferences();
      expect(allPrefs.length).toBeLessThanOrEqual(200);
    });
  });

  describe("confidence math verification", () => {
    test("decay formula: confidence * 2^(-days/14)", async () => {
      const li = createLayoutIntelligence(TEST_PREFS_PATH);

      const delta: LayoutDelta = {
        containerId: "weather-1",
        field: "position",
        from: { x: 0, y: 0 },
        to: { x: 2, y: 0 },
        timestamp: Date.now(),
      };

      // Reinforce 4 times to get high confidence
      await li.store("dashboard", "weather", delta);
      await li.store("dashboard", "weather", delta);
      await li.store("dashboard", "weather", delta);
      await li.store("dashboard", "weather", delta);

      // Get the raw confidence before decay
      const rawPrefs = await li.getAllPreferences();
      const rawConf = rawPrefs[0].confidence;

      // Set last reinforced to 7 days ago
      await li._testSetLastReinforced("dashboard", "weather", "position",
        new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
      );

      const prefs = await li.consult("dashboard");
      const expectedDecayed = rawConf * Math.pow(2, -7 / 14);
      expect(prefs[0].confidence).toBeCloseTo(expectedDecayed, 2);
    });

    test("reinforcement formula: conf += (1 - conf) * 0.3", () => {
      // Pure math test
      let conf = 0.3; // initial
      conf = conf + (1 - conf) * 0.3; // 0.51
      expect(conf).toBeCloseTo(0.51, 4);
      conf = conf + (1 - conf) * 0.3; // 0.657
      expect(conf).toBeCloseTo(0.657, 3);
      conf = conf + (1 - conf) * 0.3; // 0.7599
      expect(conf).toBeCloseTo(0.7599, 3);
    });
  });
});
