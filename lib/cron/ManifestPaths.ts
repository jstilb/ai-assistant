import { readFileSync, readdirSync } from "fs";
import { join } from "path";

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

export function readManifest(manifestDir: string, file: string, io: ManifestIO = realIO): ManifestFile | null {
  const path = join(manifestDir, file);
  const content = optional(() => io.readFile(path));
  return content === null ? null : { path, content };
}

export function listManifestFiles(manifestDir: string, io: ManifestIO = realIO): ManifestFile[] {
  const names = (optional(() => io.readDirectory(manifestDir)) ?? [])
    .filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"))
    .sort();
  return names.map((name) => {
    const file = readManifest(manifestDir, name, io);
    if (!file) throw new Error(`Cron manifest disappeared during scan: ${name}`);
    return file;
  });
}
