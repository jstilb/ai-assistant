import { describe, test, expect } from "bun:test";
import { isAllowedWritePath, ALLOWED_DIRS } from "../PathWhitelist.ts";

// ============================================
// ISC #2, #8: Path Whitelist Tests
// 10+ attack patterns
// ============================================

const SIM_DIR = `${process.env.HOME}/.claude/skills/Simulation`;

describe("PathWhitelist", () => {
  // --- Allowed paths ---

  test("allows writes to Sandboxes/", () => {
    expect(isAllowedWritePath(`${SIM_DIR}/Sandboxes/sim-abc123/file.txt`)).toBe(true);
  });

  test("allows writes to Reports/", () => {
    expect(isAllowedWritePath(`${SIM_DIR}/Reports/report.md`)).toBe(true);
  });

  test("allows writes to Transcripts/", () => {
    expect(isAllowedWritePath(`${SIM_DIR}/Transcripts/log.jsonl`)).toBe(true);
  });

  test("allows writes to Sandboxes directory itself", () => {
    expect(isAllowedWritePath(`${SIM_DIR}/Sandboxes`)).toBe(true);
  });

  // --- Attack patterns ---

  test("blocks writes to parent directory", () => {
    expect(isAllowedWritePath(`${SIM_DIR}/../CORE/settings.json`)).toBe(false);
  });

  test("blocks writes to root", () => {
    expect(isAllowedWritePath("/etc/passwd")).toBe(false);
  });

  test("blocks writes to home directory", () => {
    expect(isAllowedWritePath(`${process.env.HOME}/.bashrc`)).toBe(false);
  });

  test("blocks path traversal with double dots", () => {
    expect(isAllowedWritePath(`${SIM_DIR}/Sandboxes/../../CORE/SKILL.md`)).toBe(false);
  });

  test("blocks path traversal with encoded dots", () => {
    expect(isAllowedWritePath(`${SIM_DIR}/Sandboxes/%2e%2e/CORE/SKILL.md`)).toBe(false);
  });

  test("blocks writes to Kaya MEMORY", () => {
    expect(isAllowedWritePath(`${process.env.HOME}/.claude/MEMORY/sessions.json`)).toBe(false);
  });

  test("blocks writes to Tools directory itself", () => {
    expect(isAllowedWritePath(`${SIM_DIR}/Tools/malicious.ts`)).toBe(false);
  });

  test("blocks writes to state directory", () => {
    expect(isAllowedWritePath(`${SIM_DIR}/state/engine-state.json`)).toBe(false);
  });

  test("blocks symlink-like path to /tmp", () => {
    expect(isAllowedWritePath("/tmp/evil-script.sh")).toBe(false);
  });

  test("blocks null byte injection", () => {
    expect(isAllowedWritePath(`${SIM_DIR}/Sandboxes/file.txt\x00.sh`)).toBe(false);
  });

  test("blocks empty string", () => {
    expect(isAllowedWritePath("")).toBe(false);
  });

  test("blocks relative path without resolution", () => {
    expect(isAllowedWritePath("Sandboxes/file.txt")).toBe(false);
  });

  test("ALLOWED_DIRS contains exactly 3 directories", () => {
    expect(ALLOWED_DIRS).toEqual(["Sandboxes", "Reports", "Transcripts"]);
  });
});
