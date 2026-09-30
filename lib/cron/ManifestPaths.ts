import { readFileSync, readdirSync } from "fs";
import { dirname, join } from "path";

export interface ManifestFile {
  path: string;
  content: string;
}

export interface ManifestIO {
  readFile(path: string): string;
  readDirectory(path: string): string[];
}

const realIO: ManifestIO = {
  readFile: (path) => readFileSync(path, "utf8"),
  readDirectory: (path) => readdirSync(path),
};

function optional<T>(read: () => T): T | null {
  try {
    return read();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function legacyDir(manifestDir: string): string {
  return join(dirname(manifestDir), "jobs.disabled");
}

export function readManifest(manifestDir: string, file: string, io: ManifestIO = realIO): ManifestFile | null {
  const currentPath = join(manifestDir, file);
  const legacyPath = join(legacyDir(manifestDir), file);
  const current = optional(() => io.readFile(currentPath));
  const legacy = optional(() => io.readFile(legacyPath));
  if (current !== null && legacy !== null && current !== legacy) {
    throw new Error(`Divergent cron manifest in manifests/ and jobs.disabled/: ${file}`);
  }
  if (current !== null) return { path: currentPath, content: current };
  if (legacy !== null) return { path: legacyPath, content: legacy };
  const promoted = optional(() => io.readFile(currentPath));
  if (promoted !== null) return { path: currentPath, content: promoted };
  return null;
}

export function listManifestFiles(manifestDir: string, io: ManifestIO = realIO): ManifestFile[] {
  const names = new Set<string>();
  for (const dir of [manifestDir, legacyDir(manifestDir)]) {
    for (const name of optional(() => io.readDirectory(dir)) ?? []) {
      if (name.endsWith(".yaml") || name.endsWith(".yml")) names.add(name);
    }
  }
  for (const name of optional(() => io.readDirectory(manifestDir)) ?? []) {
    if (name.endsWith(".yaml") || name.endsWith(".yml")) names.add(name);
  }
  return [...names].sort().map((name) => {
    const file = readManifest(manifestDir, name, io);
    if (!file) throw new Error(`Cron manifest disappeared during scan: ${name}`);
    return file;
  });
}
