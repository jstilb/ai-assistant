import { randomUUID } from "crypto";
import { closeSync, openSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";

export interface AtomicSecretsIO {
  randomId(): string;
  open(path: string, flags: "wx", mode: number): number;
  write(fd: number, data: string): void;
  close(fd: number): void;
  rename(from: string, to: string): void;
  unlink(path: string): void;
}

const defaultIO: AtomicSecretsIO = {
  randomId: randomUUID,
  open: openSync,
  write: writeFileSync,
  close: closeSync,
  rename: renameSync,
  unlink: unlinkSync,
};

export function writeSecretsAtomically(
  secretsPath: string,
  secrets: Record<string, unknown>,
  overrides: Partial<AtomicSecretsIO> = {},
): void {
  const io = { ...defaultIO, ...overrides };
  let tempPath: string | undefined;
  let fd: number | undefined;
  let ownsTemp = false;
  let failed = false;
  let cleanupFailed = false;
  try {
    if (!statSync(secretsPath).isFile()) throw new Error("Expected existing file");
    const data = JSON.stringify(secrets, null, 2) + "\n";
    tempPath = `${secretsPath}.tmp-${io.randomId()}`;
    fd = io.open(tempPath, "wx", 0o600);
    ownsTemp = true;
    io.write(fd, data);
    io.close(fd);
    fd = undefined;
    io.rename(tempPath, secretsPath);
    ownsTemp = false;
  } catch {
    failed = true;
  } finally {
    if (fd !== undefined) {
      try { io.close(fd); } catch { cleanupFailed = true; }
    }
    // Never remove a pre-existing file when exclusive creation fails.
    if (ownsTemp && tempPath !== undefined) {
      try { io.unlink(tempPath); } catch { cleanupFailed = true; }
    }
  }
  if (failed || cleanupFailed) {
    throw new Error(cleanupFailed
      ? "Could not save secrets; temporary file cleanup failed. Inspect the destination directory privately."
      : "Could not save secrets; replacement did not complete.");
  }
}
