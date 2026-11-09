/**
 * Secrets.ts — the one reader and writer for `secrets.json`.
 *
 * It owns the file path, the parse, the error kinds, redaction and the
 * atomic read-modify-write.
 *
 * - Path: `<getKayaHome()>/secrets.json`, resolved on every call. A test
 *   points it at a temp dir with `process.env.KAYA_HOME`.
 * - Freshness: every call reads the file. There is no cache, so a rotated
 *   key applies on the next read.
 * - Names: `"a.b"` reads `doc.a.b`. A blank string (empty or whitespace-only) counts as missing; other values are returned unchanged (no trim).
 * - Missing is not broken. A missing file or key gives `null` from
 *   `optionalSecret` and a `file-missing`/`key-missing` error from the
 *   `require*` functions. An unreadable file, bad JSON or a value of the
 *   wrong type throws from every function.
 * - Redaction: an error message holds the kind, key name, path and hint. It
 *   never holds a value or the JSON engine's parse text (Bun's parse error
 *   echoes the bad token).
 * - Env: not read here. A caller that wants env first writes
 *   `process.env.X ?? optionalSecret("X")`.
 */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getKayaHome } from "./KayaHome.ts";

export type SecretErrorKind =
  | "file-missing"
  | "file-unreadable"
  | "file-malformed"
  | "key-missing"
  | "wrong-type"
  | "write-failed";

const DEFAULT_DETAIL: Record<SecretErrorKind, string> = {
  "file-missing": "the secrets file does not exist",
  "file-unreadable": "the secrets file cannot be read",
  "file-malformed": "the secrets file is not valid JSON",
  "key-missing": "the key is absent or blank",
  "wrong-type": "the value has the wrong type",
  "write-failed": "the secrets file write did not complete",
};

export class SecretError extends Error {
  readonly kind: SecretErrorKind;
  readonly key: string | null;
  readonly path: string;

  /** `detail` must never contain a secret value or engine error text. */
  constructor(kind: SecretErrorKind, path: string, key: string | null, hint?: string, detail?: string) {
    const where = key === null ? `file ${path}` : `key "${key}", file ${path}`;
    // The hint says how to add the secret, so it fits only the "missing" kinds; a broken file needs a different fix.
    const showHint = hint && (kind === "file-missing" || kind === "key-missing");
    super(`${kind}: ${detail ?? DEFAULT_DETAIL[kind]} (${where})${showHint ? `. ${hint}` : ""}`);
    this.name = "SecretError";
    this.kind = kind;
    this.key = key;
    this.path = path;
  }
}

/** The secrets file path. For help text; readers go through the functions below. */
export function secretsFilePath(): string {
  return join(getKayaHome(), "secrets.json");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  return Array.isArray(value) ? "array" : typeof value;
}

function errnoSuffix(err: unknown): string {
  const code = errnoCode(err);
  return code ? ` (${code})` : "";
}

/** The errno code (e.g. "EACCES") of `err`, or undefined. Any other `code` string is dropped, never echoed. */
function errnoCode(err: unknown): string | undefined {
  const code = err instanceof Error && "code" in err ? err.code : undefined;
  return typeof code === "string" && /^E[A-Z0-9]+$/.test(code) ? code : undefined;
}

/** The file operations of `writeSecretsAtomically`. Tests replace some of them. */
interface AtomicWriteIO {
  randomId(): string;
  open(path: string, flags: "wx", mode: number): number;
  write(fd: number, data: string): void;
  close(fd: number): void;
  rename(from: string, to: string): void;
  unlink(path: string): void;
}

const defaultIO: AtomicWriteIO = {
  randomId: randomUUID,
  open: openSync,
  write: writeFileSync,
  close: closeSync,
  rename: renameSync,
  unlink: unlinkSync,
};

/**
 * A failed atomic write. `code` is the first errno seen (if any). `leftoverTemp`
 * is the temp file path when its removal failed: that file holds the full document.
 * The message never holds a value or the underlying error text.
 */
class AtomicWriteError extends Error {
  readonly code: string | undefined;
  readonly leftoverTemp: string | null;

  constructor(code: string | undefined, leftoverTemp: string | null, cleanupFailed: boolean) {
    super(
      `${
        cleanupFailed
          ? `Could not save secrets; temporary file cleanup failed. Inspect the destination directory privately${
              leftoverTemp ? `: ${leftoverTemp}` : ""
            }`
          : "Could not save secrets; replacement did not complete."
      }${code ? ` (${code})` : ""}`,
    );
    this.name = "AtomicWriteError";
    this.code = code;
    this.leftoverTemp = leftoverTemp;
  }
}

/**
 * Replace the existing JSON file at `targetPath` with `doc`: write a temp file
 * beside it (exclusive create, mode 0600), then rename it over the target.
 * The target must exist. On failure the target is unchanged and the temp file
 * is removed; if the removal fails, the error names the temp path.
 * `overrides` is a test seam for the file operations.
 * Also used for files other than secrets.json (opencode `auth.json`).
 */
export function writeSecretsAtomically(
  targetPath: string,
  doc: Record<string, unknown>,
  overrides: Partial<AtomicWriteIO> = {},
): void {
  const io = { ...defaultIO, ...overrides };
  let tempPath: string | undefined;
  let fd: number | undefined;
  let ownsTemp = false;
  let failed = false;
  let code: string | undefined;
  let cleanupFailed = false;
  let leftoverTemp: string | null = null;
  try {
    if (!statSync(targetPath).isFile()) throw new Error("Expected existing file");
    const data = `${JSON.stringify(doc, null, 2)}\n`;
    tempPath = `${targetPath}.tmp-${io.randomId()}`;
    fd = io.open(tempPath, "wx", 0o600);
    ownsTemp = true;
    io.write(fd, data);
    io.close(fd);
    fd = undefined;
    io.rename(tempPath, targetPath);
    ownsTemp = false;
  } catch (err) {
    // Redaction: only the errno code is kept, never the error text.
    failed = true;
    code = errnoCode(err);
  } finally {
    if (fd !== undefined) {
      try {
        io.close(fd);
      } catch (err) {
        cleanupFailed = true;
        code ??= errnoCode(err);
      }
    }
    // Never remove a pre-existing file when exclusive creation fails.
    if (ownsTemp && tempPath !== undefined) {
      try {
        io.unlink(tempPath);
      } catch (err) {
        cleanupFailed = true;
        leftoverTemp = tempPath;
        code ??= errnoCode(err);
      }
    }
  }
  if (failed || cleanupFailed) throw new AtomicWriteError(code, leftoverTemp, cleanupFailed);
}

/** The parsed file, or null when it does not exist. Throws on any other failure. */
function readDoc(path: string, key: string | null, hint?: string): Record<string, unknown> | null {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return null;
    throw new SecretError("file-unreadable", path, key, hint, `the secrets file cannot be read${errnoSuffix(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Redaction: the engine message echoes the bad token, so it is not kept (not even as `cause`).
    throw new SecretError("file-malformed", path, key, hint);
  }
  if (!isPlainObject(parsed)) {
    throw new SecretError("file-malformed", path, key, hint, "the secrets file top level is not a JSON object");
  }
  return parsed;
}

type Found = { value: unknown } | { missing: "file-missing" | "key-missing" };

function find(path: string, name: string, hint?: string): Found {
  const doc = readDoc(path, name, hint);
  if (doc === null) return { missing: "file-missing" };
  let node: unknown = doc;
  for (const part of name.split(".")) {
    if (node === undefined) break;
    if (!isPlainObject(node)) {
      throw new SecretError(
        "wrong-type",
        path,
        name,
        hint,
        `a parent of the key is a ${typeName(node)}, expected an object`,
      );
    }
    node = Object.hasOwn(node, part) ? node[part] : undefined;
  }
  if (node === undefined || (typeof node === "string" && node.trim() === "")) return { missing: "key-missing" };
  return { value: node };
}

function asString(value: unknown, path: string, name: string, hint?: string): string {
  if (typeof value === "string") return value;
  throw new SecretError("wrong-type", path, name, hint, `the value is a ${typeName(value)}, expected a string`);
}

/** The string at `name`. Throws a SecretError for every failure, missing included. */
export function requireSecret(name: string, hint?: string): string {
  const path = secretsFilePath();
  const found = find(path, name, hint);
  if ("missing" in found) throw new SecretError(found.missing, path, name, hint);
  return asString(found.value, path, name, hint);
}

/** The string at `name`, or null when the file or the key is missing. Throws when the file is broken. */
export function optionalSecret(name: string): string | null {
  const path = secretsFilePath();
  const found = find(path, name);
  return "missing" in found ? null : asString(found.value, path, name);
}

/** The object or array at `name`. The caller validates its shape. */
export function requireSecretJson(name: string, hint?: string): unknown {
  const path = secretsFilePath();
  const found = find(path, name, hint);
  if ("missing" in found) throw new SecretError(found.missing, path, name, hint);
  if (typeof found.value === "object" && found.value !== null) return found.value;
  throw new SecretError(
    "wrong-type",
    path,
    name,
    hint,
    `the value is a ${typeName(found.value)}, expected an object or array`,
  );
}

/**
 * Read the file fresh, apply `mutate` to a deep copy, write the result
 * atomically (temp + rename, mode 0600). Refuses (throws, writes nothing)
 * when the file cannot be read or parsed. A missing file is created 0600.
 */
export function updateSecrets(mutate: (doc: Record<string, unknown>) => Record<string, unknown>): void {
  const path = secretsFilePath();
  const current = readDoc(path, null);
  const next: unknown = mutate(structuredClone(current ?? {}));
  if (!isPlainObject(next)) {
    throw new SecretError(
      "wrong-type",
      path,
      null,
      undefined,
      `the update result is a ${typeName(next)}, expected a plain object`,
    );
  }
  let created: { dev: number; ino: number } | null = null;
  try {
    if (current === null) {
      const fd = openSync(path, "wx", 0o600);
      try {
        const { dev, ino } = fstatSync(fd);
        created = { dev, ino };
      } finally {
        closeSync(fd);
      }
    }
    writeSecretsAtomically(path, next);
  } catch (err) {
    // Put back the "file-missing" state rather than leave an empty file that reads as malformed.
    // Delete only the empty file this call created: another writer may have renamed its file onto the path.
    const now = created === null ? undefined : statSync(path, { throwIfNoEntry: false });
    if (now && created && now.dev === created.dev && now.ino === created.ino && now.size === 0) rmSync(path);
    throw new SecretError(
      "write-failed",
      path,
      null,
      undefined,
      `the secrets file write did not complete${errnoSuffix(err)}${
        err instanceof AtomicWriteError && err.leftoverTemp !== null
          ? `; a temporary file may remain at ${err.leftoverTemp} and holds the full document, remove it`
          : ""
      }`,
    );
  }
}
