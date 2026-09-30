import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, closeSync, fstatSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { writeSecretsAtomically } from "./AtomicSecrets.ts";

let dir: string;
let path: string;
const original = '{"nested":{"token":"synthetic-original"}}\n';
const payload = "synthetic-private-payload";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atomic-secrets-test-"));
  path = join(dir, "secrets.json");
  writeFileSync(path, original, { mode: 0o600 });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("private atomic secrets persistence", () => {
  it("creates exclusively at 0600 beside the original and preserves it until rename", () => {
    chmodSync(path, 0o644);
    writeSecretsAtomically(path, { nested: { token: payload } }, {
      open(temp, flags, mode) {
        expect(dirname(temp)).toBe(dir);
        expect(flags).toBe("wx");
        expect(mode).toBe(0o600);
        const fd = openSync(temp, flags, mode);
        expect(fstatSync(fd).mode & 0o777).toBe(0o600);
        return fd;
      },
      rename(temp, target) {
        expect(readFileSync(path, "utf8")).toBe(original);
        expect(readFileSync(temp, "utf8")).toContain(payload);
        renameSync(temp, target);
      },
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["secrets.json"]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ nested: { token: payload } });
  });

  it("refuses a colliding temp path without overwriting or removing it", () => {
    const collision = `${path}.tmp-collision`;
    writeFileSync(collision, "synthetic-unrelated-file");
    expect(() => writeSecretsAtomically(path, { token: payload }, { randomId: () => "collision" })).toThrow("Could not save secrets");
    expect(readFileSync(collision, "utf8")).toBe("synthetic-unrelated-file");
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(readdirSync(dir).sort()).toEqual(["secrets.json", "secrets.json.tmp-collision"]);
  });

  for (const phase of ["write", "rename"] as const) {
    it(`cleans up after ${phase} failure, preserves original, and redacts thrown payload`, () => {
      let closed = false;
      const fail = () => { throw new Error(payload); };
      const operation = () => writeSecretsAtomically(path, { token: payload }, {
        ...(phase === "write" ? { write(fd: number) { writeFileSync(fd, payload.slice(0, 8)); fail(); } } : { rename: fail }),
        close(fd) { closeSync(fd); closed = true; },
      });
      expect(operation).toThrow("Could not save secrets; replacement did not complete.");
      expect(closed).toBe(true);
      expect(readFileSync(path, "utf8")).toBe(original);
      expect(readdirSync(dir)).toEqual(["secrets.json"]);
    });
  }

  it("sanitizes serialization errors before creating a temporary file", () => {
    expect(() => writeSecretsAtomically(path, { toJSON() { throw new Error(payload); } })).toThrow("Could not save secrets; replacement did not complete.");
    expect(readdirSync(dir)).toEqual(["secrets.json"]);
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("surfaces cleanup failure without exposing the underlying error", () => {
    expect(() => writeSecretsAtomically(path, { token: payload }, {
      randomId: () => "cleanup-failure",
      rename() { throw new Error(payload); },
      unlink() { throw new Error(payload); },
    })).toThrow("Could not save secrets; temporary file cleanup failed. Inspect the destination directory privately.");
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(statSync(`${path}.tmp-cleanup-failure`).mode & 0o777).toBe(0o600);
  });
});
