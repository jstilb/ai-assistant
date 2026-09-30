/**
 * PathEnv - Test Suite (TestWriter)
 * ISC Coverage: P-02, P-03
 */

import { describe, it, expect } from "bun:test";
import { existsSync } from "fs";
import { PathEnv } from "../../../../lib/core/PathEnv";

describe("PathEnv", () => {
  describe("resolveBun", () => {
    it("should resolve bun binary path", () => {
      // ISC P-02: PathEnv.ts resolves bun binary
      const bunPath = PathEnv.resolveBun();
      expect(bunPath).toBeDefined();
      expect(typeof bunPath).toBe("string");
      expect(bunPath.length).toBeGreaterThan(0);
      expect(existsSync(bunPath)).toBe(true);
    });

    it("should return absolute path", () => {
      const bunPath = PathEnv.resolveBun();
      expect(bunPath.startsWith("/")).toBe(true);
    });
  });

  describe("resolveClaude", () => {
    it("should resolve claude binary path", () => {
      // ISC P-03: PathEnv.ts resolves claude binary
      const claudePath = PathEnv.resolveClaude();
      expect(claudePath).toBeDefined();
      expect(typeof claudePath).toBe("string");
      expect(claudePath).toBe("/Users/[user]/.local/bin/claude");
    });

    it("should verify claude binary exists", () => {
      const claudePath = PathEnv.resolveClaude();
      expect(existsSync(claudePath)).toBe(true);
    });
  });

  describe("resolve", () => {
    it("should resolve generic binary from known paths", () => {
      const nodePath = PathEnv.resolve("node");
      expect(nodePath).toBeDefined();
      if (nodePath !== null) {
        expect(existsSync(nodePath)).toBe(true);
      }
    });

    it("should return null for nonexistent binary", () => {
      const fakePath = PathEnv.resolve("nonexistent-binary-xyz");
      expect(fakePath).toBeNull();
    });
  });

  describe("augmentPath", () => {
    it("should prepend known binary directories to PATH", () => {
      const originalPath = process.env.PATH;
      PathEnv.augmentPath();

      const newPath = process.env.PATH!;
      expect(newPath).toContain("/Users/[user]/.bun/bin");
      expect(newPath).toContain("/opt/homebrew/bin");
      expect(newPath).toContain("/Users/[user]/.local/bin");
      expect(newPath.startsWith("/Users/[user]/.bun/bin")).toBe(true);
    });

    it("should preserve existing PATH entries", () => {
      const originalPath = process.env.PATH;
      PathEnv.augmentPath();

      expect(process.env.PATH).toContain(originalPath);
    });
  });

  describe("integration", () => {
    it("should resolve bun after augmenting PATH", () => {
      PathEnv.augmentPath();
      const bunPath = PathEnv.resolveBun();

      expect(bunPath).toBeDefined();
      expect(existsSync(bunPath)).toBe(true);
    });
  });
});
