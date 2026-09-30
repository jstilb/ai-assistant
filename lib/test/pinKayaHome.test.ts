/**
 * pinKayaHome.test.ts — unit tests for the shared KAYA_HOME-pinning harness
 * helper (F5). Careful: this file tests the pin/restore machinery itself, so
 * it manages env state manually and restores everything in finally blocks —
 * it must be a good citizen of the exact convention it implements.
 */
import { describe, it, expect } from "bun:test";
import { existsSync } from "fs";

import { pinKayaHome, restoreKayaHome } from "./pinKayaHome.ts";
import { getKayaHome } from "../core/KayaHome.ts";

describe("pinKayaHome / restoreKayaHome", () => {
  it("pins KAYA_HOME + KAYA_DIR to a fresh temp dir and getKayaHome() follows", async () => {
    const beforeHome = process.env.KAYA_HOME;
    const beforeDir = process.env.KAYA_DIR;
    try {
      const dir = pinKayaHome("pin-helper-test-");
      expect(existsSync(dir)).toBe(true);
      expect(process.env.KAYA_HOME).toBe(dir);
      expect(process.env.KAYA_DIR).toBe(dir);
      // The cache reset is the load-bearing part — getKayaHome() must
      // re-resolve to the pinned dir, not a stale memoized value.
      expect(getKayaHome()).toBe(dir);
    } finally {
      await restoreKayaHome();
    }
    expect(process.env.KAYA_HOME).toBe(beforeHome as string | undefined);
    expect(process.env.KAYA_DIR).toBe(beforeDir as string | undefined);
  });

  it("restore deletes the temp dir and re-resolves getKayaHome() off the restored env", async () => {
    const dir = pinKayaHome("pin-helper-test-");
    await restoreKayaHome();
    expect(existsSync(dir)).toBe(false);
    expect(getKayaHome()).not.toBe(dir);
  });

  it("restore deletes env vars that were unset before the pin", async () => {
    const savedHome = process.env.KAYA_HOME;
    const savedDir = process.env.KAYA_DIR;
    delete process.env.KAYA_HOME;
    delete process.env.KAYA_DIR;
    try {
      pinKayaHome("pin-helper-test-");
      expect(process.env.KAYA_HOME).toBeDefined();
      await restoreKayaHome();
      expect(process.env.KAYA_HOME).toBeUndefined();
      expect(process.env.KAYA_DIR).toBeUndefined();
    } finally {
      if (savedHome !== undefined) process.env.KAYA_HOME = savedHome;
      if (savedDir !== undefined) process.env.KAYA_DIR = savedDir;
      await restoreKayaHome(); // no-op safety if an expect above threw pre-restore
    }
  });

  it("double pin without restore throws (names the leaking dir)", async () => {
    const dir = pinKayaHome("pin-helper-test-");
    try {
      expect(() => pinKayaHome("pin-helper-test-")).toThrow(/already active/);
      expect(() => pinKayaHome("pin-helper-test-")).toThrow(dir);
    } finally {
      await restoreKayaHome();
    }
  });

  it("restore is a safe no-op when nothing is pinned", async () => {
    await restoreKayaHome();
    await restoreKayaHome();
  });
});
