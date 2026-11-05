import { afterEach, describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { join } from "node:path";
import { getCorrectPath, setupPath } from "./PathEnv.ts";

const originalPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = originalPath;
});

describe("getCorrectPath", () => {
  test("lists only directories that exist", () => {
    const parts = getCorrectPath().split(":");
    expect(parts.length).toBeGreaterThan(0);
    for (const dir of parts) {
      expect(statSync(dir).isDirectory()).toBe(true);
    }
  });

  test("has no duplicate entries and no empty segments", () => {
    const parts = getCorrectPath().split(":");
    expect(parts.every((p) => p.length > 0)).toBe(true);
    expect(new Set(parts).size).toBe(parts.length);
  });

  test("keeps the system directories after the user directories", () => {
    const parts = getCorrectPath().split(":");
    const sys = parts.indexOf("/usr/bin");
    expect(sys).toBeGreaterThanOrEqual(0);
    for (const userDir of parts.filter((p) => p.endsWith("/.bun/bin") || p.endsWith("/.local/bin"))) {
      expect(parts.indexOf(userDir)).toBeLessThan(sys);
    }
  });
});

describe("setupPath", () => {
  test("replaces process.env.PATH with the computed value", () => {
    process.env.PATH = "/nonexistent-only";
    setupPath();
    expect(process.env.PATH).toBe(getCorrectPath());
  });
});

describe("CLI", () => {
  test("prints one shell export line for the computed PATH", () => {
    const proc = Bun.spawnSync([process.execPath, join(import.meta.dir, "PathEnv.ts")]);
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toMatch(/^export PATH="[^"\n]+"\n$/);
  });
});
