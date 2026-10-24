import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { listManifestFiles, readManifest, type ManifestIO } from "./ManifestPaths.ts";

function missing(): Error & { code: string } {
  return Object.assign(new Error("no such file"), { code: "ENOENT" });
}

describe("manifest paths", () => {
  test("reads and lists yaml from manifests/ only", () => {
    const root = mkdtempSync(join(tmpdir(), "cron-manifests-"));
    const current = join(root, "manifests");
    const old = join(root, "jobs.disabled");
    try {
      mkdirSync(current);
      mkdirSync(old);
      expect(readManifest(current, "missing.yaml")).toBeNull();

      writeFileSync(join(current, "b.yaml"), "id: b\n");
      writeFileSync(join(current, "a.yml"), "id: a\n");
      writeFileSync(join(current, "README.md"), "# not a manifest\n");
      writeFileSync(join(old, "legacy.yaml"), "id: legacy\n");

      expect(readManifest(current, "b.yaml")).toEqual({ path: join(current, "b.yaml"), content: "id: b\n" });
      expect(readManifest(current, "legacy.yaml")).toBeNull();
      expect(listManifestFiles(current).map((f) => f.path)).toEqual([join(current, "a.yml"), join(current, "b.yaml")]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a missing manifests/ directory lists nothing", () => {
    expect(listManifestFiles(join(tmpdir(), "cron-manifests-absent-dir"))).toEqual([]);
  });

  test("throws when a listed manifest vanishes mid-scan; rethrows non-ENOENT errors", () => {
    const current = "/sandbox/manifests";
    const vanishing: ManifestIO = {
      readDirectory: () => ["job.yaml"],
      readFile: () => { throw missing(); },
    };
    expect(() => listManifestFiles(current, vanishing)).toThrow("Cron manifest disappeared during scan: job.yaml");

    const denied: ManifestIO = {
      readDirectory: () => ["job.yaml"],
      readFile: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); },
    };
    expect(() => readManifest(current, "job.yaml", denied)).toThrow("denied");
  });
});
