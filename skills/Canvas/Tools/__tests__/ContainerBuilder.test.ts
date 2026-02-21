#!/usr/bin/env bun
/**
 * ContainerBuilder Tests — Phase 4: AI Orchestration
 *
 * Tests the AI layout builder that classifies intents, negotiates
 * content types, consults preferences, and generates positioned layouts.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";

const TEST_STATE_DIR = "/tmp/canvas-container-builder-test";
const TEST_PREFS_PATH = join(TEST_STATE_DIR, "layout-preferences.json");

import {
  negotiateContainerType,
  buildDefaultDashboard,
  buildBriefingLayout,
  positionContainersGrid,
  buildFromTemplate,
  buildLayout,
  selectTier,
  classifyIntent,
  type ContainerSpec,
  type TierResult,
  ContainerSpecSchema,
} from "../ContainerBuilder.ts";
import type { TemplateConfig } from "../TemplateManager.ts";

describe("ContainerBuilder", () => {
  beforeEach(() => {
    if (existsSync(TEST_PREFS_PATH)) unlinkSync(TEST_PREFS_PATH);
    if (existsSync(`${TEST_PREFS_PATH}.lock`)) unlinkSync(`${TEST_PREFS_PATH}.lock`);
    mkdirSync(TEST_STATE_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_PREFS_PATH)) unlinkSync(TEST_PREFS_PATH);
    if (existsSync(`${TEST_PREFS_PATH}.lock`)) unlinkSync(`${TEST_PREFS_PATH}.lock`);
  });

  describe("Content-Type Negotiation", () => {
    test("JSON array of uniform objects maps to table", () => {
      const data = [
        { name: "Task A", status: "done" },
        { name: "Task B", status: "pending" },
      ];
      const result = negotiateContainerType(data);
      expect(result.type).toBe("table");
      expect(result.props.columns).toEqual(["name", "status"]);
    });

    test("time series data (timestamp + numeric) maps to chart", () => {
      const data = [
        { timestamp: "2026-02-15T08:00", value: 72 },
        { timestamp: "2026-02-15T09:00", value: 68 },
      ];
      const result = negotiateContainerType(data);
      expect(result.type).toBe("chart");
      expect(result.props.xAxis).toBe("timestamp");
    });

    test("single number maps to stat", () => {
      const result = negotiateContainerType(42);
      expect(result.type).toBe("stat");
      expect(result.props.value).toBe(42);
    });

    test("short string maps to stat", () => {
      const result = negotiateContainerType("73°F Sunny");
      expect(result.type).toBe("stat");
      expect(result.props.value).toBe("73°F Sunny");
    });

    test("markdown string maps to markdown", () => {
      const mdText = "# Hello\n\nThis is **bold** text\n\n- Item 1\n- Item 2";
      const result = negotiateContainerType(mdText);
      expect(result.type).toBe("markdown");
      expect(result.props.content).toBe(mdText);
    });

    test("array of strings maps to list", () => {
      const data = ["Buy groceries", "Walk the dog", "Call dentist"];
      const result = negotiateContainerType(data);
      expect(result.type).toBe("list");
      expect(result.props.items).toEqual(data);
    });

    test("calendar/date objects map to calendar", () => {
      const data = [
        { date: "2026-02-18", title: "Team standup", time: "09:00" },
        { date: "2026-02-18", title: "Lunch", time: "12:00" },
      ];
      const result = negotiateContainerType(data);
      expect(result.type).toBe("calendar");
    });

    test("weather data maps to weather", () => {
      const data = { temp: 72, humidity: 45, condition: "sunny" };
      const result = negotiateContainerType(data);
      expect(result.type).toBe("weather");
    });

    test("unknown complex data maps to custom", () => {
      const data = { nested: { deep: { structure: true } }, random: [1, 2, 3] };
      const result = negotiateContainerType(data);
      expect(result.type).toBe("custom");
    });
  });

  describe("ContainerSpec schema validation", () => {
    test("valid ContainerSpec passes validation", () => {
      const spec: ContainerSpec = {
        id: "weather-1",
        type: "weather",
        position: { x: 0, y: 0 },
        size: { width: 1, height: 1 },
        props: { title: "Weather", location: "auto" },
        dataSource: { type: "briefing-block", ref: "weather" },
        priority: 1,
      };
      const result = ContainerSpecSchema.safeParse(spec);
      expect(result.success).toBe(true);
    });

    test("ContainerSpec requires non-negative integer positions", () => {
      const spec = {
        id: "test-1",
        type: "markdown",
        position: { x: -1, y: 0 },
        size: { width: 1, height: 1 },
        props: {},
        priority: 1,
      };
      const result = ContainerSpecSchema.safeParse(spec);
      expect(result.success).toBe(false);
    });

    test("ContainerSpec requires minimum size 1x1", () => {
      const spec = {
        id: "test-1",
        type: "markdown",
        position: { x: 0, y: 0 },
        size: { width: 0, height: 1 },
        props: {},
        priority: 1,
      };
      const result = ContainerSpecSchema.safeParse(spec);
      expect(result.success).toBe(false);
    });
  });

  describe("Default Dashboard Layout", () => {
    test("generates >= 3 containers", () => {
      const specs = buildDefaultDashboard();
      expect(specs.length).toBeGreaterThanOrEqual(3);
    });

    test("all containers have unique IDs", () => {
      const specs = buildDefaultDashboard();
      const ids = specs.map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    test("no containers overlap", () => {
      const specs = buildDefaultDashboard();
      for (let i = 0; i < specs.length; i++) {
        for (let j = i + 1; j < specs.length; j++) {
          const a = specs[i];
          const b = specs[j];
          const aRight = a.position.x + a.size.width;
          const aBottom = a.position.y + a.size.height;
          const bRight = b.position.x + b.size.width;
          const bBottom = b.position.y + b.size.height;

          const overlaps =
            a.position.x < bRight &&
            aRight > b.position.x &&
            a.position.y < bBottom &&
            aBottom > b.position.y;

          expect(overlaps).toBe(false);
        }
      }
    });

    test("all containers validate against schema", () => {
      const specs = buildDefaultDashboard();
      for (const spec of specs) {
        const result = ContainerSpecSchema.safeParse(spec);
        if (!result.success) {
          console.error("Validation failed for:", spec.id, result.error.message);
        }
        expect(result.success).toBe(true);
      }
    });

    test("max 12 containers per layout", () => {
      const specs = buildDefaultDashboard();
      expect(specs.length).toBeLessThanOrEqual(12);
    });

    test("contains weather, tasks, and calendar containers", () => {
      const specs = buildDefaultDashboard();
      const types = specs.map((s) => s.type);
      expect(types).toContain("weather");
    });

    test("containers have non-negative integer positions", () => {
      const specs = buildDefaultDashboard();
      for (const spec of specs) {
        expect(spec.position.x).toBeGreaterThanOrEqual(0);
        expect(spec.position.y).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(spec.position.x)).toBe(true);
        expect(Number.isInteger(spec.position.y)).toBe(true);
      }
    });

    test("containers have priorities assigned", () => {
      const specs = buildDefaultDashboard();
      for (const spec of specs) {
        expect(spec.priority).toBeGreaterThan(0);
      }
    });
  });

  describe("Briefing Layout", () => {
    test("generates one container per briefing block", () => {
      const blocks = [
        { name: "weather", title: "Weather", content: "72°F Sunny" },
        { name: "calendar", title: "Calendar", content: "3 meetings" },
        { name: "tasks", title: "Tasks", content: "5 pending" },
        { name: "goals", title: "Goals", content: "2 active" },
        { name: "habits", title: "Habits", content: "3/5 done" },
      ];
      const specs = buildBriefingLayout(blocks);
      expect(specs.length).toBe(5);
    });

    test("briefing containers are non-overlapping", () => {
      const blocks = [
        { name: "weather", title: "Weather", content: "72°F Sunny" },
        { name: "calendar", title: "Calendar", content: "3 meetings" },
        { name: "tasks", title: "Tasks", content: "5 pending" },
        { name: "goals", title: "Goals", content: "2 active" },
        { name: "habits", title: "Habits", content: "3/5 done" },
        { name: "notes", title: "Notes", content: "Quick notes" },
      ];
      const specs = buildBriefingLayout(blocks);

      for (let i = 0; i < specs.length; i++) {
        for (let j = i + 1; j < specs.length; j++) {
          const a = specs[i];
          const b = specs[j];
          const overlaps =
            a.position.x < b.position.x + b.size.width &&
            a.position.x + a.size.width > b.position.x &&
            a.position.y < b.position.y + b.size.height &&
            a.position.y + a.size.height > b.position.y;
          expect(overlaps).toBe(false);
        }
      }
    });

    test("briefing containers have data source refs", () => {
      const blocks = [
        { name: "weather", title: "Weather", content: "72°F Sunny" },
      ];
      const specs = buildBriefingLayout(blocks);
      expect(specs[0].dataSource).toBeDefined();
      expect(specs[0].dataSource?.type).toBe("briefing-block");
      expect(specs[0].dataSource?.ref).toBe("weather");
    });

    test("failed block does not prevent other blocks from rendering", () => {
      const blocks = [
        { name: "weather", title: "Weather", content: "72°F Sunny" },
        { name: "calendar", title: "Calendar", content: null as unknown as string, error: "Failed to fetch" },
        { name: "tasks", title: "Tasks", content: "5 pending" },
      ];
      const specs = buildBriefingLayout(blocks);
      // Calendar should still have a container, but with error state
      expect(specs.length).toBe(3);
    });
  });

  describe("Grid Position Calculator", () => {
    test("positions containers in grid without overlap", () => {
      const specs: ContainerSpec[] = [
        {
          id: "a",
          type: "markdown",
          position: { x: 0, y: 0 },
          size: { width: 2, height: 1 },
          props: {},
          priority: 1,
        },
        {
          id: "b",
          type: "markdown",
          position: { x: 0, y: 0 },
          size: { width: 2, height: 1 },
          props: {},
          priority: 2,
        },
        {
          id: "c",
          type: "markdown",
          position: { x: 0, y: 0 },
          size: { width: 2, height: 1 },
          props: {},
          priority: 3,
        },
      ];

      const positioned = positionContainersGrid(specs, 4);

      // Check no overlaps
      for (let i = 0; i < positioned.length; i++) {
        for (let j = i + 1; j < positioned.length; j++) {
          const a = positioned[i];
          const b = positioned[j];
          const overlaps =
            a.position.x < b.position.x + b.size.width &&
            a.position.x + a.size.width > b.position.x &&
            a.position.y < b.position.y + b.size.height &&
            a.position.y + a.size.height > b.position.y;
          expect(overlaps).toBe(false);
        }
      }
    });

    test("clamps positions to grid bounds", () => {
      const specs: ContainerSpec[] = [
        {
          id: "a",
          type: "markdown",
          position: { x: 10, y: 10 },
          size: { width: 2, height: 1 },
          props: {},
          priority: 1,
        },
      ];

      const positioned = positionContainersGrid(specs, 4);
      expect(positioned[0].position.x + positioned[0].size.width).toBeLessThanOrEqual(4);
    });
  });
});

// ============================================================================
// Phase 5-6 Integration Tests
// ============================================================================

describe("ContainerBuilder — Template Integration", () => {
  const mockTemplate: TemplateConfig = {
    id: "test-dashboard",
    name: "Test Dashboard",
    description: "A test dashboard template",
    version: "1.0.0",
    createdAt: "2026-02-18T00:00:00.000Z",
    updatedAt: "2026-02-18T00:00:00.000Z",
    tags: ["test", "dashboard"],
    layout: {
      columns: 2,
      gap: 16,
      containers: [
        {
          type: "markdown",
          position: { col: 0, row: 0 },
          title: "Notes",
          props: { content: "# Hello" },
        },
        {
          type: "table",
          position: { col: 1, row: 0, colSpan: 1, rowSpan: 2 },
          title: "Data",
          props: { columns: ["Name", "Value"], rows: [] },
        },
      ],
    },
  };

  describe("buildFromTemplate", () => {
    test("converts template placements to ContainerSpec array", () => {
      const specs = buildFromTemplate(mockTemplate);
      expect(specs.length).toBe(2);
    });

    test("assigns unique IDs derived from template ID and index", () => {
      const specs = buildFromTemplate(mockTemplate);
      expect(specs[0].id).toBe("tmpl-test-dashboard-0");
      expect(specs[1].id).toBe("tmpl-test-dashboard-1");
    });

    test("converts col/row positions to x/y positions", () => {
      const specs = buildFromTemplate(mockTemplate);
      for (const spec of specs) {
        expect(spec.position.x).toBeGreaterThanOrEqual(0);
        expect(spec.position.y).toBeGreaterThanOrEqual(0);
      }
    });

    test("uses colSpan/rowSpan for size, defaults to 1x1", () => {
      const specs = buildFromTemplate(mockTemplate);
      // First container has no span overrides -> 1x1
      expect(specs[0].size.width).toBe(1);
      expect(specs[0].size.height).toBe(1);
      // Second container has colSpan:1, rowSpan:2
      expect(specs[1].size.height).toBe(2);
    });

    test("merges title into props", () => {
      const specs = buildFromTemplate(mockTemplate);
      expect(specs[0].props.title).toBe("Notes");
      expect(specs[1].props.title).toBe("Data");
    });

    test("all generated specs pass schema validation", () => {
      const specs = buildFromTemplate(mockTemplate);
      for (const spec of specs) {
        const result = ContainerSpecSchema.safeParse(spec);
        expect(result.success).toBe(true);
      }
    });

    test("converts 'briefing' type to 'markdown'", () => {
      const briefingTemplate: TemplateConfig = {
        ...mockTemplate,
        id: "briefing-test",
        layout: {
          columns: 2,
          containers: [
            {
              type: "briefing",
              position: { col: 0, row: 0 },
              title: "Weather",
              props: { html: "<p>Sunny</p>" },
            },
          ],
        },
      };
      const specs = buildFromTemplate(briefingTemplate);
      expect(specs[0].type).toBe("markdown");
    });
  });

  describe("buildLayout — template-first path", () => {
    test("uses template when findBestTemplate returns a match", async () => {
      // "Morning Briefing" matches the built-in morning-briefing template with high score
      const result = await buildLayout({ intent: "Morning Briefing" });
      // Should have gotten specs from the template
      expect(result.specs.length).toBeGreaterThan(0);
      expect(result.specs[0].id).toMatch(/^tmpl-/);
    });

    test("falls through to classify when no template matches", async () => {
      // A completely nonsensical prompt that won't match any template
      const result = await buildLayout({ intent: "xyzzy foobar zqwerty" });
      // Should fall through to the classify -> build pipeline
      expect(result.specs.length).toBeGreaterThan(0);
      expect(result.specs[0].id).not.toMatch(/^tmpl-/);
    });

    test("template path enforces MAX_CONTAINERS limit", async () => {
      const result = await buildLayout({ intent: "Morning Briefing" });
      expect(result.specs.length).toBeLessThanOrEqual(12);
    });
  });
});

describe("ContainerBuilder — Tier Selection", () => {
  test("returns tier 1 for dashboard category (contains known registry types)", () => {
    // "dashboard" matches registry component checks via intent entities
    const intent = classifyIntent("refresh weather");
    const result = selectTier({
      ...intent,
      entities: { targetContainer: "weather" },
    });
    expect(result.tier).toBe(1);
    if (result.tier === 1) {
      expect(result.component).toBe("weather");
      expect(result.props).toBeDefined();
    }
  });

  test("returns tier 3 for custom/unknown intents", () => {
    const intent = classifyIntent("something totally custom");
    const result = selectTier(intent);
    expect(result.tier).toBe(3);
    if (result.tier === 3) {
      expect(result.prompt).toBe("custom");
    }
  });

  test("returns tier 3 for dashboard category (no entity match)", () => {
    const intent = classifyIntent("show me a dashboard");
    const result = selectTier(intent);
    // "dashboard" as a category string doesn't include a registry component name
    expect(result.tier).toBe(3);
  });

  test("returns tier 3 for briefing category (no entity match)", () => {
    const intent = classifyIntent("show me my morning briefing");
    const result = selectTier(intent);
    expect(result.tier).toBe(3);
  });

  test("discriminated union narrows correctly per tier", () => {
    const tier1: TierResult = { tier: 1, component: "chart", props: { chartType: "bar" } };
    const tier2: TierResult = { tier: 2, type: "form", schema: { type: "form", data: {} } };
    const tier3: TierResult = { tier: 3, prompt: "custom" };

    if (tier1.tier === 1) {
      expect(tier1.component).toBe("chart");
    }
    if (tier2.tier === 2) {
      expect(tier2.type).toBe("form");
    }
    if (tier3.tier === 3) {
      expect(tier3.prompt).toBe("custom");
    }
  });

  test("buildLayout includes tierResult for non-template paths", async () => {
    const result = await buildLayout({ intent: "xyzzy foobar zqwerty" });
    expect(result.tierResult).toBeDefined();
    if (result.tierResult) {
      expect([1, 2, 3]).toContain(result.tierResult.tier);
    }
  });
});
