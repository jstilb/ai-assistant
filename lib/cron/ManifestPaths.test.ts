import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { listManifestFiles, readManifest, type ManifestIO } from "./ManifestPaths.ts";

function missing(): Error & { code: string } {
  return Object.assign(new Error("removed during cutover"), { code: "ENOENT" });
}

describe("manifest path cutover", () => {
  test("resolves each job across both directories and rejects divergent overlap", () => {
    const root = mkdtempSync(join(tmpdir(), "cron-manifests-"));
    const current = join(root, "manifests");
    const old = join(root, "jobs.disabled");
    try {
      mkdirSync(current);
      mkdirSync(old);
      expect(readManifest(current, "missing.yaml")).toBeNull();

      writeFileSync(join(old, "old.yaml"), "id: old\n");
      writeFileSync(join(current, "new.yaml"), "id: new\n");
      expect(readManifest(current, "old.yaml")).toEqual({ path: join(old, "old.yaml"), content: "id: old\n" });
      expect(readManifest(current, "new.yaml")).toEqual({ path: join(current, "new.yaml"), content: "id: new\n" });
      expect(listManifestFiles(current).map((f) => f.path)).toEqual([join(current, "new.yaml"), join(old, "old.yaml")]);

      writeFileSync(join(current, "old.yaml"), "id: old\n");
      expect(readManifest(current, "old.yaml")?.path).toBe(join(current, "old.yaml"));
      expect(listManifestFiles(current)).toHaveLength(2);

      writeFileSync(join(current, "old.yaml"), "id: different\n");
      expect(() => readManifest(current, "old.yaml")).toThrow("Divergent cron manifest");
      expect(() => listManifestFiles(current)).toThrow("Divergent cron manifest");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses the surviving content when either path disappears during a read", () => {
    const current = "/sandbox/manifests";
    const io: ManifestIO = {
      readDirectory: (dir) => dir === current ? ["job.yaml"] : [],
      readFile: (path) => {
        if (path === join(current, "job.yaml")) return "id: job\n";
        throw missing();
      },
    };
    expect(readManifest(current, "job.yaml", io)?.content).toBe("id: job\n");
    expect(listManifestFiles(current, io)).toHaveLength(1);

    const oldOnly: ManifestIO = {
      readDirectory: (dir) => dir === current ? [] : ["job.yaml"],
      readFile: (path) => {
        if (path.endsWith("jobs.disabled/job.yaml")) return "id: job\n";
        throw missing();
      },
    };
    expect(readManifest(current, "job.yaml", oldOnly)?.path).toContain("jobs.disabled");
  });

  test("retries the new copy when cutover occurs between reads and directory scans", () => {
    const current = "/sandbox/manifests";
    const oldPath = "/sandbox/jobs.disabled/job.yaml";
    const newPath = join(current, "job.yaml");
    const contents = new Map([[oldPath, "id: job\n"]]);
    let published = false;
    const readIO: ManifestIO = {
      readDirectory: () => [],
      readFile: (path) => {
        if (path === newPath && !published) {
          contents.set(newPath, contents.get(oldPath) ?? "");
          contents.delete(oldPath);
          published = true;
          throw missing();
        }
        const content = contents.get(path);
        if (content === undefined) throw missing();
        return content;
      },
    };
    expect(readManifest(current, "job.yaml", readIO)).toEqual({ path: newPath, content: "id: job\n" });

    contents.clear();
    contents.set(oldPath, "id: job\n");
    published = false;
    const scanIO: ManifestIO = {
      readDirectory: (path) => {
        if (path === current && !published) {
          contents.set(newPath, contents.get(oldPath) ?? "");
          contents.delete(oldPath);
          published = true;
          throw missing();
        }
        const names = [...contents.keys()].filter((file) => file.startsWith(`${path}/`)).map((file) => file.slice(path.length + 1));
        if (names.length === 0) throw missing();
        return names;
      },
      readFile: (path) => {
        const content = contents.get(path);
        if (content === undefined) throw missing();
        return content;
      },
    };
    expect(listManifestFiles(current, scanIO)).toEqual([{ path: newPath, content: "id: job\n" }]);
  });
});
