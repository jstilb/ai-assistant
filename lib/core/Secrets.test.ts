/**
 * Secrets.test.ts — the interface suite for lib/core/Secrets.ts.
 *
 * Every case goes through the public functions. The stand-in is a mkdtemp
 * dir set as process.env.KAYA_HOME; the real secrets.json is never touched.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  optionalSecret,
  requireSecret,
  requireSecretJson,
  SecretError,
  type SecretErrorKind,
  secretsFilePath,
  updateSecrets,
  writeSecretsAtomically,
} from "./Secrets.ts";

let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env.KAYA_HOME;
  home = mkdtempSync(join(tmpdir(), "secrets-test-"));
  process.env.KAYA_HOME = home;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.KAYA_HOME;
  else process.env.KAYA_HOME = savedHome;
  chmodSync(home, 0o700); // undo the read-only-dir cases before cleanup
  rmSync(home, { recursive: true, force: true });
});

const file = () => join(home, "secrets.json");
const write = (text: string) => writeFileSync(file(), text);
const writeJson = (doc: unknown) => write(JSON.stringify(doc));

/** Run `fn` and return the SecretError it throws. Any other outcome fails the test. */
function caught(fn: () => unknown): SecretError {
  try {
    fn();
  } catch (err) {
    if (err instanceof SecretError) return err;
    throw err;
  }
  throw new Error("expected a SecretError, but nothing was thrown");
}

function expectKind(fn: () => unknown, kind: SecretErrorKind): SecretError {
  const err = caught(fn);
  expect(err.kind).toBe(kind);
  expect(err.message).toStartWith(`${kind}:`);
  expect(err.path).toBe(file());
  return err;
}

// Root reads and writes files whatever their mode, so the permission cases cannot fail as root.
const isRoot = process.getuid?.() === 0;

describe("reads", () => {
  it("returns a present string from every reader", () => {
    writeJson({ K: "v" });
    expect(requireSecret("K")).toBe("v");
    expect(optionalSecret("K")).toBe("v");
  });

  it("reads a dot path from a nested object", () => {
    writeJson({ telegram: { bot_token: "t" } });
    expect(requireSecret("telegram.bot_token")).toBe("t");
    expect(optionalSecret("telegram.chat_id")).toBeNull();
    expect(optionalSecret("absent.bot_token")).toBeNull();
  });

  it("treats an empty string as missing", () => {
    writeJson({ K: "" });
    expect(optionalSecret("K")).toBeNull();
    expectKind(() => requireSecret("K"), "key-missing");
  });

  it("treats a whitespace-only string as missing and returns other values untrimmed", () => {
    writeJson({ K: "  \t\n ", PADDED: "  tok  " });
    expect(optionalSecret("K")).toBeNull();
    expectKind(() => requireSecret("K"), "key-missing");
    expect(requireSecret("PADDED")).toBe("  tok  ");
    expect(optionalSecret("PADDED")).toBe("  tok  ");
  });

  it("returns an object or array from requireSecretJson", () => {
    writeJson({ OBJ: { a: 1 }, ARR: ["x", "y"] });
    expect(requireSecretJson("OBJ")).toEqual({ a: 1 });
    expect(requireSecretJson("ARR")).toEqual(["x", "y"]);
  });

  it("puts the kind, key, path and hint in the message", () => {
    writeJson({ OTHER: "x" });
    const err = expectKind(() => requireSecret("K", "Fix: run setup-k"), "key-missing");
    expect(err.key).toBe("K");
    expect(err.name).toBe("SecretError");
    expect(err.message).toContain('"K"');
    expect(err.message).toContain(file());
    expect(err.message).toContain("Fix: run setup-k");
  });

  it("shows the hint only for the missing kinds, never for a broken file", () => {
    write('{"K": "SENTINEL-hint-0001",');
    const malformed = expectKind(() => requireSecret("K", "Fix: run setup-k"), "file-malformed");
    expect(malformed.message).not.toContain("Fix: run setup-k");
    expect(malformed.message).not.toContain("SENTINEL");

    writeJson({ OTHER: "x" });
    const missing = expectKind(() => requireSecret("K", "Fix: run setup-k"), "key-missing");
    expect(missing.message).toContain("Fix: run setup-k");
  });
});

describe("each SecretErrorKind", () => {
  it("file-missing: require* throw, optionalSecret returns null", () => {
    expect(existsSync(file())).toBe(false);
    expectKind(() => requireSecret("K"), "file-missing");
    expectKind(() => requireSecretJson("K"), "file-missing");
    expect(optionalSecret("K")).toBeNull();
  });

  it("key-missing: require* throw, optionalSecret returns null", () => {
    writeJson({ OTHER: "x" });
    expectKind(() => requireSecret("K"), "key-missing");
    expectKind(() => requireSecretJson("K"), "key-missing");
    expect(optionalSecret("K")).toBeNull();
  });

  it.skipIf(isRoot)("file-unreadable: every reader throws (skipped as root: root reads mode 000 files)", () => {
    writeJson({ K: "v" });
    chmodSync(file(), 0o000);
    expectKind(() => requireSecret("K"), "file-unreadable");
    expectKind(() => optionalSecret("K"), "file-unreadable");
  });

  it("file-malformed: bad JSON or a non-object top level throws from every reader", () => {
    write("{not json");
    expectKind(() => requireSecret("K"), "file-malformed");
    expectKind(() => optionalSecret("K"), "file-malformed");
    expectKind(() => requireSecretJson("K"), "file-malformed");
    writeJson(["K", "v"]);
    expectKind(() => optionalSecret("K"), "file-malformed");
  });

  it("wrong-type: a non-string for the string readers, a scalar for requireSecretJson", () => {
    writeJson({ NUM: 42, OBJ: { a: 1 }, STR: "s", PARENT: "s" });
    expectKind(() => requireSecret("NUM"), "wrong-type");
    expectKind(() => optionalSecret("OBJ"), "wrong-type");
    expectKind(() => requireSecretJson("STR"), "wrong-type");
    expectKind(() => optionalSecret("PARENT.child"), "wrong-type");
  });

  it.skipIf(isRoot)("write-failed: a read-only dir refuses the write (skipped as root)", () => {
    writeJson({ K: "v" });
    const before = readFileSync(file());
    chmodSync(home, 0o500);
    const err = expectKind(() => updateSecrets((doc) => ({ ...doc, K: "w" })), "write-failed");
    expect(err.key).toBeNull();
    expect(readFileSync(file()).equals(before)).toBe(true);
  });

  it.skipIf(isRoot)("write-failed: a missing file in a read-only dir is not created (skipped as root)", () => {
    chmodSync(home, 0o500);
    expectKind(() => updateSecrets((doc) => ({ ...doc, K: "w" })), "write-failed");
    expect(existsSync(file())).toBe(false);
  });
});

describe("optionalSecret", () => {
  it("returns null only for file-missing and key-missing", () => {
    expect(optionalSecret("K")).toBeNull();
    writeJson({ OTHER: "x" });
    expect(optionalSecret("K")).toBeNull();
    writeJson({ K: true });
    expectKind(() => optionalSecret("K"), "wrong-type");
    write("{");
    expectKind(() => optionalSecret("K"), "file-malformed");
  });
});

describe("redaction", () => {
  it("malformed file with sentinel sk_live_SENTINEL — message does not contain SENTINEL", () => {
    write('{"K": sk_live_SENTINEL}');
    for (const read of [() => requireSecret("K"), () => optionalSecret("K"), () => requireSecretJson("K")]) {
      const err = expectKind(read, "file-malformed");
      expect(err.message).toContain("not valid JSON");
      expect(err.message).not.toContain("SENTINEL");
      expect(String(err)).not.toContain("SENTINEL");
      expect(err.cause).toBeUndefined();
    }
  });

  it("wrong-type on a value that holds a sentinel — message does not contain SENTINEL", () => {
    writeJson({ OBJ: { token: "sk_live_SENTINEL" }, STR: "sk_live_SENTINEL", PARENT: "sk_live_SENTINEL" });
    const errs = [
      expectKind(() => requireSecret("OBJ"), "wrong-type"),
      expectKind(() => requireSecretJson("STR"), "wrong-type"),
      expectKind(() => optionalSecret("PARENT.child"), "wrong-type"),
    ];
    for (const err of errs) {
      expect(err.message).not.toContain("SENTINEL");
      expect(String(err)).not.toContain("SENTINEL");
    }
  });
});

describe("updateSecrets", () => {
  it("creates a missing file with mode 0600", () => {
    updateSecrets((doc) => ({ ...doc, K: "v" }));
    expect(statSync(file()).mode & 0o777).toBe(0o600);
    expect(requireSecret("K")).toBe("v");
  });

  it("preserves the other keys", () => {
    writeJson({ A: "1", B: { c: 2 } });
    updateSecrets((doc) => ({ ...doc, K: "v" }));
    expect(JSON.parse(readFileSync(file(), "utf-8"))).toEqual({ A: "1", B: { c: 2 }, K: "v" });
    expect(statSync(file()).mode & 0o777).toBe(0o600);
  });

  it("update on malformed file throws and leaves bytes identical", () => {
    write('{"K": sk_live_SENTINEL}');
    const before = readFileSync(file());
    let mutated = false;
    const err = expectKind(
      () =>
        updateSecrets((doc) => {
          mutated = true;
          return doc;
        }),
      "file-malformed",
    );
    expect(mutated).toBe(false);
    expect(String(err)).not.toContain("SENTINEL");
    expect(readFileSync(file()).equals(before)).toBe(true);
  });

  it("refuses a non-object result and writes nothing", () => {
    writeJson({ A: "1" });
    const before = readFileSync(file());
    // The cast is deliberate: the types forbid this result, and the case tests the runtime guard for untyped callers.
    const toArray = (() => ["x"]) as unknown as (doc: Record<string, unknown>) => Record<string, unknown>;
    expectKind(() => updateSecrets(toArray), "wrong-type");
    expect(readFileSync(file()).equals(before)).toBe(true);
  });

  it("a throwing mutate writes nothing and leaves bytes identical", () => {
    writeJson({ A: { b: "1" } });
    const before = readFileSync(file());
    expect(() =>
      updateSecrets((doc) => {
        doc.A = "changed";
        throw new Error("caller failure");
      }),
    ).toThrow("caller failure");
    expect(readFileSync(file()).equals(before)).toBe(true);
  });

  it("a failed write removes the empty file it created", () => {
    const unserialisable = {
      toJSON: () => {
        throw new Error("serialise failure");
      },
    };
    expectKind(() => updateSecrets((doc) => ({ ...doc, K: unserialisable })), "write-failed");
    expect(existsSync(file())).toBe(false);
  });

  it("a failed write never deletes a file another writer renamed onto the path", () => {
    const foreign = join(home, "foreign.json");
    writeFileSync(foreign, '{"F":"other writer"}');
    // Serialisation runs after the create: the race happens there, then the write fails.
    const raceThenFail = {
      toJSON: () => {
        renameSync(foreign, file());
        throw new Error("serialise failure");
      },
    };
    expectKind(() => updateSecrets((doc) => ({ ...doc, K: raceThenFail })), "write-failed");
    expect(readFileSync(file(), "utf-8")).toBe('{"F":"other writer"}');
  });

  it("makes a rotation visible on the next read", () => {
    writeJson({ K: "v1", A: "1" });
    expect(requireSecret("K")).toBe("v1");
    updateSecrets((doc) => ({ ...doc, K: "v2" }));
    expect(requireSecret("K")).toBe("v2");
    writeJson({ K: "v3", A: "1" });
    expect(optionalSecret("K")).toBe("v3");
  });
});

describe("secretsFilePath", () => {
  it("follows KAYA_HOME on every call", () => {
    expect(secretsFilePath()).toBe(join(home, "secrets.json"));
    const other = mkdtempSync(join(tmpdir(), "secrets-test-other-"));
    try {
      process.env.KAYA_HOME = other;
      expect(secretsFilePath()).toBe(join(other, "secrets.json"));
    } finally {
      process.env.KAYA_HOME = home;
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe("writeSecretsAtomically", () => {
  let atomicDir: string;
  let atomicPath: string;
  const original = '{"nested":{"token":"synthetic-original"}}\n';
  const payload = "synthetic-private-payload";

  beforeEach(() => {
    atomicDir = mkdtempSync(join(tmpdir(), "atomic-secrets-test-"));
    atomicPath = join(atomicDir, "secrets.json");
    writeFileSync(atomicPath, original, { mode: 0o600 });
  });
  afterEach(() => rmSync(atomicDir, { recursive: true, force: true }));

  it("creates exclusively at 0600 beside the original and preserves it until rename", () => {
    chmodSync(atomicPath, 0o644);
    writeSecretsAtomically(
      atomicPath,
      { nested: { token: payload } },
      {
        open(temp, flags, mode) {
          expect(dirname(temp)).toBe(atomicDir);
          expect(flags).toBe("wx");
          expect(mode).toBe(0o600);
          const fd = openSync(temp, flags, mode);
          expect(fstatSync(fd).mode & 0o777).toBe(0o600);
          return fd;
        },
        rename(temp, target) {
          expect(readFileSync(atomicPath, "utf8")).toBe(original);
          expect(readFileSync(temp, "utf8")).toContain(payload);
          renameSync(temp, target);
        },
      },
    );
    expect(statSync(atomicPath).mode & 0o777).toBe(0o600);
    expect(readdirSync(atomicDir)).toEqual(["secrets.json"]);
    expect(JSON.parse(readFileSync(atomicPath, "utf8"))).toEqual({ nested: { token: payload } });
  });

  it("refuses a colliding temp path without overwriting or removing it", () => {
    const collision = `${atomicPath}.tmp-collision`;
    writeFileSync(collision, "synthetic-unrelated-file");
    expect(() => writeSecretsAtomically(atomicPath, { token: payload }, { randomId: () => "collision" })).toThrow(
      "Could not save secrets",
    );
    expect(readFileSync(collision, "utf8")).toBe("synthetic-unrelated-file");
    expect(readFileSync(atomicPath, "utf8")).toBe(original);
    expect(readdirSync(atomicDir).sort()).toEqual(["secrets.json", "secrets.json.tmp-collision"]);
  });

  for (const phase of ["write", "rename"] as const) {
    it(`cleans up after ${phase} failure, preserves original, and redacts thrown payload`, () => {
      let closed = false;
      const fail = () => {
        throw new Error(payload);
      };
      const operation = () =>
        writeSecretsAtomically(
          atomicPath,
          { token: payload },
          {
            ...(phase === "write"
              ? {
                  write(fd: number) {
                    writeFileSync(fd, payload.slice(0, 8));
                    fail();
                  },
                }
              : { rename: fail }),
            close(fd) {
              closeSync(fd);
              closed = true;
            },
          },
        );
      expect(operation).toThrow("Could not save secrets; replacement did not complete.");
      expect(closed).toBe(true);
      expect(readFileSync(atomicPath, "utf8")).toBe(original);
      expect(readdirSync(atomicDir)).toEqual(["secrets.json"]);
    });
  }

  it("sanitizes serialization errors before creating a temporary file", () => {
    expect(() =>
      writeSecretsAtomically(atomicPath, {
        toJSON() {
          throw new Error(payload);
        },
      }),
    ).toThrow("Could not save secrets; replacement did not complete.");
    expect(readdirSync(atomicDir)).toEqual(["secrets.json"]);
    expect(readFileSync(atomicPath, "utf8")).toBe(original);
  });

  it("surfaces cleanup failure without exposing the underlying error", () => {
    expect(() =>
      writeSecretsAtomically(
        atomicPath,
        { token: payload },
        {
          randomId: () => "cleanup-failure",
          rename() {
            throw new Error(payload);
          },
          unlink() {
            throw new Error(payload);
          },
        },
      ),
    ).toThrow(
      `Could not save secrets; temporary file cleanup failed. Inspect the destination directory privately: ${atomicPath}.tmp-cleanup-failure`,
    );
    expect(readFileSync(atomicPath, "utf8")).toBe(original);
    expect(statSync(`${atomicPath}.tmp-cleanup-failure`).mode & 0o777).toBe(0o600);
  });

  it("keeps the errno code and names a left-over temp file, never the payload", () => {
    const eio = Object.assign(new Error(payload), { code: "EIO" });
    const nonErrno = Object.assign(new Error(payload), { code: payload });
    let message = "";
    try {
      writeSecretsAtomically(
        atomicPath,
        { token: payload },
        {
          randomId: () => "left",
          rename() {
            throw eio;
          },
          unlink() {
            throw nonErrno;
          },
        },
      );
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("(EIO)");
    expect(message).toContain(`${atomicPath}.tmp-left`);
    expect(message).not.toContain(payload);
  });
});

describe("updateSecrets write-failed detail", () => {
  it("keeps the errno code when the existing file cannot be replaced", () => {
    writeJson({ A: "1" });
    chmodSync(home, 0o500);
    let caught: unknown;
    try {
      updateSecrets((doc) => ({ ...doc, B: "synthetic-new-value" }));
    } catch (err) {
      caught = err;
    }
    chmodSync(home, 0o700);
    expect(caught).toBeInstanceOf(SecretError);
    if (!(caught instanceof SecretError)) return;
    expect(caught.kind).toBe("write-failed");
    expect(caught.message).toContain("(EACCES)");
    expect(caught.message).not.toContain("synthetic-new-value");
    expect(readdirSync(home)).toEqual(["secrets.json"]);
  });
});

describe("errno codes in messages", () => {
  it("drops a code that is not an errno", () => {
    let message = "";
    const tmp = mkdtempSync(join(tmpdir(), "errno-code-test-"));
    const target = join(tmp, "auth.json");
    writeFileSync(target, "{}\n");
    try {
      writeSecretsAtomically(
        target,
        { token: "synthetic-value" },
        {
          rename() {
            throw Object.assign(new Error("synthetic-value"), { code: "synthetic-value" });
          },
        },
      );
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    expect(message).toBe("Could not save secrets; replacement did not complete.");
  });
});
