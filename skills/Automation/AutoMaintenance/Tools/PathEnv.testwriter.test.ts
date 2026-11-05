/**
 * PathEnv - Test Suite (TestWriter)
 * ISC Coverage: P-02, P-03
 *
 * lib/core/PathEnv.ts exports getCorrectPath() and setupPath(); the older
 * PathEnv.resolveBun()/resolveClaude()/augmentPath() API this suite targeted no
 * longer exists, so the suite covers the current API.
 */

import { describe, it, expect } from "bun:test";
import { statSync } from "node:fs";
import { getCorrectPath, setupPath } from "../../../../lib/core/PathEnv.ts";

describe("PathEnv", () => {
  describe("getCorrectPath", () => {
    it("returns a non-empty colon-separated PATH", () => {
      const p = getCorrectPath();
      expect(typeof p).toBe("string");
      expect(p.length).toBeGreaterThan(0);
    });

    it("lists only directories that exist", () => {
      for (const dir of getCorrectPath().split(":")) {
        expect(statSync(dir).isDirectory()).toBe(true);
      }
    });

    it("lists only absolute paths", () => {
      for (const dir of getCorrectPath().split(":")) {
        expect(dir.startsWith("/")).toBe(true);
      }
    });
  });

  describe("setupPath", () => {
    it("sets process.env.PATH to getCorrectPath()", () => {
      const originalPath = process.env["PATH"];
      try {
        setupPath();
        expect(process.env["PATH"]).toBe(getCorrectPath());
      } finally {
        process.env["PATH"] = originalPath;
      }
    });
  });
});
