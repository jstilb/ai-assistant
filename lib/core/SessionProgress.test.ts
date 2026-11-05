#!/usr/bin/env bun
/**
 * SessionProgress.test.ts - Unit tests for SessionProgress
 *
 * Tests the session progress management including:
 * - All file I/O via StateManager (no raw JSON.parse/readFileSync)
 * - Progress file creation and persistence
 * - Source code verification for migration compliance
 */

import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { readNormalizedSource } from "../test/sourceText.ts";

describe("SessionProgress", () => {
  test("created progress is read by the session-start hook from State/progress", () => {
    const home = mkdtempSync(join(tmpdir(), "session-progress-path-"));
    try {
      mkdirSync(join(home, "MEMORY", "State"), { recursive: true });
      const env = { ...process.env, KAYA_HOME: home, KAYA_DIR: home, TERM: "dumb" };
      const create = spawnSync(
        "bun",
        [join(import.meta.dir, "SessionProgress.ts"), "create", "path-smoke", "verify path"],
        { env, encoding: "utf8" },
      );
      expect(create.status).toBe(0);
      expect(existsSync(join(home, "MEMORY", "State", "progress", "path-smoke-progress.json"))).toBe(true);
      expect(existsSync(join(home, "MEMORY", "progress", "path-smoke-progress.json"))).toBe(false);
      const hook = spawnSync("bun", [join(import.meta.dir, "..", "..", "hooks", "LoadContext.hook.ts")], {
        env,
        encoding: "utf8",
      });
      expect(hook.status).toBe(0);
      expect(hook.stdout).toContain("path-smoke");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  describe("migration compliance", () => {
    // Structural checks on comment-free, whitespace/quote-normalized source.
    const source = () => readNormalizedSource(join(import.meta.dir, "SessionProgress.ts"));

    test("no raw JSON.parse(readFileSync()) in SessionProgress.ts", () => {
      expect(source()).not.toMatch(/JSON\.parse\(readFileSync\(/);
    });

    test("readFileSync is not imported", () => {
      expect(source()).not.toMatch(/import[^;]*\breadFileSync\b[^;]*from/);
    });

    test("uses StateManager for persistence", () => {
      const src = source();
      expect(src).toContain("createStateManager");
      expect(src).toContain("manager.load()");
      expect(src).toContain("manager.save(");
    });

    test("list reads each progress file through StateManager and reports status", () => {
      const home = mkdtempSync(join(tmpdir(), "session-progress-list-"));
      try {
        mkdirSync(join(home, "MEMORY", "State"), { recursive: true });
        const env = { ...process.env, KAYA_HOME: home, KAYA_DIR: home, TERM: "dumb" };
        const run = (...args: string[]) =>
          spawnSync(process.execPath, [join(import.meta.dir, "SessionProgress.ts"), ...args], {
            env,
            encoding: "utf8",
          });
        expect(run("create", "alpha", "first goal").status).toBe(0);
        expect(run("create", "beta", "second goal").status).toBe(0);
        expect(run("work", "alpha", "did a thing").status).toBe(0);
        expect(run("next", "alpha", "step one").status).toBe(0);
        expect(run("complete", "beta").status).toBe(0);
        const list = run("list");
        expect(list.status).toBe(0);
        expect(list.stdout).toContain("[ACTIVE] alpha (active)");
        expect(list.stdout).toContain("Work items: 1");
        expect(list.stdout).toContain("Next: step one");
        expect(list.stdout).toContain("[DONE] beta (completed)");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    test("list names the project and the cause when a progress file cannot be loaded", () => {
      const home = mkdtempSync(join(tmpdir(), "session-progress-corrupt-"));
      try {
        const dir = join(home, "MEMORY", "State", "progress");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "broken-progress.json"), "{not json");
        const env = { ...process.env, KAYA_HOME: home, KAYA_DIR: home, TERM: "dumb" };
        const list = spawnSync(process.execPath, [join(import.meta.dir, "SessionProgress.ts"), "list"], {
          env,
          encoding: "utf8",
        });
        expect(list.status).toBe(0);
        expect(list.stdout).toContain("[ERROR] broken - failed to load");
        expect(list.stdout + list.stderr).toMatch(/broken.*(JSON|parse|Unexpected|property)/is);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  });
});
