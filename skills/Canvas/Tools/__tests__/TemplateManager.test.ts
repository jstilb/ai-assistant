#!/usr/bin/env bun
/**
 * TemplateManager Tests — Phase 5: Generative UI and Templates
 *
 * Tests template CRUD operations and intent-based matching.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import {
  createTemplateManager,
  TemplateConfigSchema,
  type TemplateConfig,
} from "../TemplateManager.ts";

const TEST_DIR = "/tmp/canvas-template-manager-test";
const BUILTIN_DIR = join(TEST_DIR, "builtin");
const USER_DIR = join(TEST_DIR, "user");

function cleanTestDir() {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
  mkdirSync(BUILTIN_DIR, { recursive: true });
  mkdirSync(USER_DIR, { recursive: true });
}

function writeBuiltinTemplate(template: TemplateConfig) {
  writeFileSync(
    join(BUILTIN_DIR, `${template.id}.json`),
    JSON.stringify(template, null, 2)
  );
}

const SAMPLE_TEMPLATE: TemplateConfig = {
  id: "morning-briefing",
  name: "Morning Briefing",
  description: "Daily overview with weather, calendar, tasks, and goals",
  version: "1.0.0",
  createdAt: "2026-02-15T00:00:00.000Z",
  updatedAt: "2026-02-15T00:00:00.000Z",
  tags: ["daily", "productivity", "overview"],
  layout: {
    columns: 2,
    gap: 16,
    containers: [
      {
        type: "briefing",
        position: { col: 0, row: 0 },
        title: "Weather",
      },
      {
        type: "table",
        position: { col: 1, row: 0 },
        title: "Calendar",
      },
      {
        type: "table",
        position: { col: 0, row: 1 },
        title: "Tasks",
      },
      {
        type: "markdown",
        position: { col: 1, row: 1 },
        title: "Goals",
      },
    ],
  },
};

const CODE_REVIEW_TEMPLATE: TemplateConfig = {
  id: "code-review",
  name: "Code Review",
  description: "Side-by-side diff viewer with code editor and terminal",
  version: "1.0.0",
  createdAt: "2026-02-15T00:00:00.000Z",
  updatedAt: "2026-02-15T00:00:00.000Z",
  tags: ["development", "code", "review"],
  layout: {
    columns: 2,
    gap: 16,
    containers: [
      {
        type: "diff",
        position: { col: 0, row: 0, colSpan: 2 },
        title: "Diff",
      },
      {
        type: "code",
        position: { col: 0, row: 1 },
        title: "Code",
      },
      {
        type: "terminal",
        position: { col: 1, row: 1 },
        title: "Terminal",
      },
    ],
  },
};

describe("TemplateManager", () => {
  beforeEach(() => {
    cleanTestDir();
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  describe("list", () => {
    test("returns empty array when no templates exist", () => {
      const manager = createTemplateManager({
        builtinDir: BUILTIN_DIR,
        userDir: USER_DIR,
      });
      const result = manager.list();
      expect(result).toEqual([]);
    });

    test("returns built-in templates", () => {
      writeBuiltinTemplate(SAMPLE_TEMPLATE);
      const manager = createTemplateManager({
        builtinDir: BUILTIN_DIR,
        userDir: USER_DIR,
      });
      const result = manager.list();
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("morning-briefing");
      expect(result[0].builtin).toBe(true);
      expect(result[0].containerCount).toBe(4);
    });

    test("filters by search term", () => {
      writeBuiltinTemplate(SAMPLE_TEMPLATE);
      writeBuiltinTemplate(CODE_REVIEW_TEMPLATE);
      const manager = createTemplateManager({
        builtinDir: BUILTIN_DIR,
        userDir: USER_DIR,
      });

      const result = manager.list("code");
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("code-review");
    });

    test("filters by tag", () => {
      writeBuiltinTemplate(SAMPLE_TEMPLATE);
      writeBuiltinTemplate(CODE_REVIEW_TEMPLATE);
      const manager = createTemplateManager({
        builtinDir: BUILTIN_DIR,
        userDir: USER_DIR,
      });

      const result = manager.list("productivity");
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("morning-briefing");
    });

    test("returns both built-in and user templates", async () => {
      writeBuiltinTemplate(SAMPLE_TEMPLATE);
      const manager = createTemplateManager({
        builtinDir: BUILTIN_DIR,
        userDir: USER_DIR,
      });

      await manager.save("my-layout", "Custom layout", {
        columns: 2,
        containers: [],
      });

      const result = manager.list();
      expect(result).toHaveLength(2);

      const builtins = result.filter((t) => t.builtin);
      const userTemplates = result.filter((t) => !t.builtin);
      expect(builtins).toHaveLength(1);
      expect(userTemplates).toHaveLength(1);
    });
  });

  describe("load", () => {
    test("loads template by ID", () => {
      writeBuiltinTemplate(SAMPLE_TEMPLATE);
      const manager = createTemplateManager({
        builtinDir: BUILTIN_DIR,
        userDir: USER_DIR,
      });

      const result = manager.load("morning-briefing");
      expect(result).not.toBeNull();
      expect(result!.id).toBe("morning-briefing");
      expect(result!.layout.columns).toBe(2);
      expect(result!.layout.containers).toHaveLength(4);
    });

    test("loads template by name (case-insensitive)", () => {
      writeBuiltinTemplate(SAMPLE_TEMPLATE);
      const manager = createTemplateManager({
        builtinDir: BUILTIN_DIR,
        userDir: USER_DIR,
      });

      const result = manager.load("Morning Briefing");
      expect(result).not.toBeNull();
      expect(result!.id).toBe("morning-briefing");
    });

    test("returns null for non-existent template", () => {
      const manager = createTemplateManager({
        builtinDir: BUILTIN_DIR,
        userDir: USER_DIR,
      });

      const result = manager.load("does-not-exist");
      expect(result).toBeNull();
    });
  });

  describe("save", () => {
    test("saves a new user template", async () => {
      const manager = createTemplateManager({
        builtinDir: BUILTIN_DIR,
        userDir: USER_DIR,
      });

      const id = await manager.save("sprint-review", "Sprint review layout", {
        columns: 2,
        containers: [
          { type: "markdown", position: { col: 0, row: 0 }, title: "Notes" },
        ],
      });

      expect(id).toBe("sprint-review");

      // Verify file was created
      const filePath = join(USER_DIR, "sprint-review.json");
      expect(existsSync(filePath)).toBe(true);

      // Verify content
      const saved = JSON.parse(readFileSync(filePath, "utf-8"));
      expect(saved.id).toBe("sprint-review");
      expect(saved.name).toBe("sprint-review");
      expect(saved.description).toBe("Sprint review layout");
    });

    test("converts spaces to hyphens in name", async () => {
      const manager = createTemplateManager({
        builtinDir: BUILTIN_DIR,
        userDir: USER_DIR,
      });

      const id = await manager.save(
        "My Sprint Review",
        "Review layout",
        { columns: 2, containers: [] }
      );

      expect(id).toBe("my-sprint-review");
    });

    test("saves with tags", async () => {
      const manager = createTemplateManager({
        builtinDir: BUILTIN_DIR,
        userDir: USER_DIR,
      });

      await manager.save(
        "tagged-layout",
        "Layout with tags",
        { columns: 2, containers: [] },
        ["work", "review"]
      );

      const loaded = manager.load("tagged-layout");
      expect(loaded).not.toBeNull();
      expect(loaded!.tags).toEqual(["work", "review"]);
    });

    test("overwrites existing user template", async () => {
      const manager = createTemplateManager({
        builtinDir: BUILTIN_DIR,
        userDir: USER_DIR,
      });

      await manager.save("my-layout", "Version 1", {
        columns: 2,
        containers: [],
      });

      await manager.save("my-layout", "Version 2", {
        columns: 3,
        containers: [],
      });

      const loaded = manager.load("my-layout");
      expect(loaded).not.toBeNull();
      expect(loaded!.description).toBe("Version 2");
      expect(loaded!.layout.columns).toBe(3);
    });

    test("rejects invalid layout", async () => {
      const manager = createTemplateManager({
        builtinDir: BUILTIN_DIR,
        userDir: USER_DIR,
      });

      await expect(
        manager.save("bad-layout", "Bad", {
          columns: 0, // Invalid: min 1
          containers: [],
        })
      ).rejects.toThrow();
    });
  });

  describe("delete", () => {
    test("deletes user template", async () => {
      const manager = createTemplateManager({
        builtinDir: BUILTIN_DIR,
        userDir: USER_DIR,
      });

      await manager.save("to-delete", "Will be deleted", {
        columns: 2,
        containers: [],
      });

      const deleted = manager.delete("to-delete");
      expect(deleted).toBe(true);

      const loaded = manager.load("to-delete");
      expect(loaded).toBeNull();
    });

    test("returns false for non-existent template", () => {
      const manager = createTemplateManager({
        builtinDir: BUILTIN_DIR,
        userDir: USER_DIR,
      });

      const deleted = manager.delete("non-existent");
      expect(deleted).toBe(false);
    });

    test("throws when deleting built-in template", () => {
      writeBuiltinTemplate(SAMPLE_TEMPLATE);
      const manager = createTemplateManager({
        builtinDir: BUILTIN_DIR,
        userDir: USER_DIR,
      });

      expect(() => manager.delete("morning-briefing")).toThrow(
        /Cannot delete built-in template/
      );
    });
  });

  describe("findBestTemplate", () => {
    test("matches by exact name", () => {
      writeBuiltinTemplate(SAMPLE_TEMPLATE);
      writeBuiltinTemplate(CODE_REVIEW_TEMPLATE);
      const manager = createTemplateManager({
        builtinDir: BUILTIN_DIR,
        userDir: USER_DIR,
      });

      const result = manager.findBestTemplate("Morning Briefing");
      expect(result).not.toBeNull();
      expect(result!.id).toBe("morning-briefing");
    });

    test("matches by partial name", () => {
      writeBuiltinTemplate(SAMPLE_TEMPLATE);
      writeBuiltinTemplate(CODE_REVIEW_TEMPLATE);
      const manager = createTemplateManager({
        builtinDir: BUILTIN_DIR,
        userDir: USER_DIR,
      });

      const result = manager.findBestTemplate("morning");
      expect(result).not.toBeNull();
      expect(result!.id).toBe("morning-briefing");
    });

    test("matches by tag", () => {
      writeBuiltinTemplate(SAMPLE_TEMPLATE);
      writeBuiltinTemplate(CODE_REVIEW_TEMPLATE);
      const manager = createTemplateManager({
        builtinDir: BUILTIN_DIR,
        userDir: USER_DIR,
      });

      const result = manager.findBestTemplate("development review");
      expect(result).not.toBeNull();
      expect(result!.id).toBe("code-review");
    });

    test("matches by description words", () => {
      writeBuiltinTemplate(SAMPLE_TEMPLATE);
      writeBuiltinTemplate(CODE_REVIEW_TEMPLATE);
      const manager = createTemplateManager({
        builtinDir: BUILTIN_DIR,
        userDir: USER_DIR,
      });

      const result = manager.findBestTemplate("diff viewer");
      expect(result).not.toBeNull();
      expect(result!.id).toBe("code-review");
    });

    test("returns null for empty intent", () => {
      writeBuiltinTemplate(SAMPLE_TEMPLATE);
      const manager = createTemplateManager({
        builtinDir: BUILTIN_DIR,
        userDir: USER_DIR,
      });

      const result = manager.findBestTemplate("");
      expect(result).toBeNull();
    });

    test("returns null when no templates match", () => {
      writeBuiltinTemplate(SAMPLE_TEMPLATE);
      const manager = createTemplateManager({
        builtinDir: BUILTIN_DIR,
        userDir: USER_DIR,
      });

      const result = manager.findBestTemplate("zzzznothing");
      expect(result).toBeNull();
    });
  });

  describe("schema validation", () => {
    test("validates a well-formed template config", () => {
      const result = TemplateConfigSchema.safeParse(SAMPLE_TEMPLATE);
      expect(result.success).toBe(true);
    });

    test("rejects template without required fields", () => {
      const result = TemplateConfigSchema.safeParse({
        id: "test",
        // missing name, description, version, etc.
      });
      expect(result.success).toBe(false);
    });

    test("skips corrupted JSON files", () => {
      // Write a corrupted file
      writeFileSync(join(BUILTIN_DIR, "corrupted.json"), "not json {{{");
      // Also write a valid template
      writeBuiltinTemplate(SAMPLE_TEMPLATE);

      const manager = createTemplateManager({
        builtinDir: BUILTIN_DIR,
        userDir: USER_DIR,
      });

      const result = manager.list();
      // Should only include the valid template, skipping corrupted
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("morning-briefing");
    });
  });
});
