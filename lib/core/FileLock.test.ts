import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileLock } from "./FileLock.ts";

const dirs: string[] = [];
const lockPath = () => {
  const d = mkdtempSync(join(tmpdir(), "filelock-"));
  dirs.push(d);
  return join(d, "x.lock");
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("FileLock", () => {
  test("acquire creates the lock file, release removes it", async () => {
    const p = lockPath();
    const lock = new FileLock(p, 500);
    await lock.acquire();
    expect(existsSync(p)).toBe(true);
    await lock.release();
    expect(existsSync(p)).toBe(false);
  });

  test("a held lock times out with the labelled error", async () => {
    const p = lockPath();
    const holder = new FileLock(p, 1000);
    await holder.acquire();
    await expect(new FileLock(p, 50, "Integrator lock").acquire()).rejects.toThrow(
      "Integrator lock acquisition timeout after 50ms",
    );
    await holder.release();
  });

  test("a stale lock (older than 2x timeout) is broken", async () => {
    const p = lockPath();
    writeFileSync(p, String(Date.now() - 10_000));
    const lock = new FileLock(p, 100);
    await lock.acquire();
    await lock.release();
    expect(existsSync(p)).toBe(false);
  });
});
