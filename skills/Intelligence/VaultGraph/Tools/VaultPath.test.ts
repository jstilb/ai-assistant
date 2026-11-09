import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretError } from "../../../../lib/core/Secrets.ts";
import { getVaultPath } from "./VaultPath.ts";

// Every case runs against a temp KAYA_HOME, never the live secrets file.
let home: string;
const saved = { KAYA_HOME: process.env.KAYA_HOME, OBSIDIAN_VAULT: process.env.OBSIDIAN_VAULT };

function restore(name: "KAYA_HOME" | "OBSIDIAN_VAULT"): void {
  const value = saved[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "vaultpath-test-"));
  process.env.KAYA_HOME = home;
  delete process.env.OBSIDIAN_VAULT;
});

afterEach(() => {
  restore("KAYA_HOME");
  restore("OBSIDIAN_VAULT");
  rmSync(home, { recursive: true, force: true });
});

describe("getVaultPath", () => {
  it("prefers OBSIDIAN_VAULT over secrets.json", () => {
    writeFileSync(join(home, "secrets.json"), JSON.stringify({ obsidian_vault: "/from/secrets" }));
    process.env.OBSIDIAN_VAULT = "/from/env";
    expect(getVaultPath()).toBe("/from/env");
  });

  it("reads obsidian_vault from secrets.json", () => {
    writeFileSync(join(home, "secrets.json"), JSON.stringify({ obsidian_vault: "/from/secrets" }));
    expect(getVaultPath()).toBe("/from/secrets");
  });

  it("throws 'not configured' when the file or the key is missing", () => {
    expect(() => getVaultPath()).toThrow("OBSIDIAN_VAULT not configured");
    writeFileSync(join(home, "secrets.json"), JSON.stringify({ other: "x" }));
    expect(() => getVaultPath()).toThrow("OBSIDIAN_VAULT not configured");
  });

  it("malformed secrets.json throws SecretError file-malformed without the file text", () => {
    writeFileSync(join(home, "secrets.json"), '{"obsidian_vault": "SENTINEL-vault-0001",');
    let caught: unknown;
    try {
      getVaultPath();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SecretError);
    if (!(caught instanceof SecretError)) throw new Error("expected SecretError");
    expect(caught.kind).toBe("file-malformed");
    expect(caught.message).not.toContain("SENTINEL");
  });
});
