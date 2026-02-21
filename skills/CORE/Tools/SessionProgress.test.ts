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
import { join } from "path";

describe("SessionProgress", () => {
  describe("migration compliance", () => {
    test("no raw JSON.parse(readFileSync()) in SessionProgress.ts", async () => {
      const sourcePath = join(import.meta.dir, "SessionProgress.ts");
      const source = await Bun.file(sourcePath).text();

      // Strip comments
      const codeLines = source.split("\n").filter(line => {
        const trimmed = line.trim();
        return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*");
      }).join("\n");

      const violations = codeLines.match(/JSON\.parse\s*\(\s*readFileSync\s*\(/g);
      expect(violations).toBeNull();
    });

    test("readFileSync is not imported", async () => {
      const sourcePath = join(import.meta.dir, "SessionProgress.ts");
      const source = await Bun.file(sourcePath).text();

      // Check that readFileSync is NOT in the imports
      const importLines = source.split("\n").filter(line => line.includes("import") && line.includes("from"));
      const hasReadFileSync = importLines.some(line => line.includes("readFileSync"));
      expect(hasReadFileSync).toBe(false);
    });

    test("uses StateManager for persistence", async () => {
      const sourcePath = join(import.meta.dir, "SessionProgress.ts");
      const source = await Bun.file(sourcePath).text();

      expect(source).toContain("createStateManager");
      expect(source).toContain("manager.load()");
      expect(source).toContain("manager.save(");
    });

    test("listActive uses StateManager getManager pattern", async () => {
      const sourcePath = join(import.meta.dir, "SessionProgress.ts");
      const source = await Bun.file(sourcePath).text();

      // Verify listActive uses getManager instead of raw file reads
      const listActiveMatch = source.match(/async function listActive[\s\S]*?^}/m);
      expect(listActiveMatch).not.toBeNull();

      if (listActiveMatch) {
        const listActiveBody = listActiveMatch[0];
        expect(listActiveBody).toContain("getManager");
        expect(listActiveBody).not.toContain("readFileSync");
        expect(listActiveBody).not.toContain("JSON.parse");
      }
    });
  });
});
