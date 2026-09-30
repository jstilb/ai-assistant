/**
 * Evidence.test.ts — Tests for gatherEvidence expectedExitCode support.
 *
 * Slice 6: verifies that ISC verification commands respect expectedExitCode
 * so negative assertions (grep returning exit 1 = no match found) are treated
 * as PASS rather than FAIL.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { gatherEvidence } from "./Evidence.ts";
import type { ItemReviewSummary } from "../../../Tools/SkepticalVerifier.ts";

let tmp: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "evidence-test-"));
  // File that contains "hello" but not "badpattern".
  writeFileSync(join(tmp, "good.txt"), "hello world\n");
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeSummary(overrides: Partial<ItemReviewSummary> = {}): ItemReviewSummary {
  return {
    itemId: "evidence-test-001",
    title: "Test item",
    description: "Test description",
    effort: "STANDARD",
    priority: "MEDIUM",
    iscRows: [],
    gitDiffStat: "",
    executionLogTail: [],
    iterationsUsed: 1,
    ...overrides,
  };
}

describe("gatherEvidence — expectedExitCode support", () => {
  it("negative assertion passes: grep exit 1 with expectedExitCode:1 is treated as PASS", () => {
    // "badpattern" is NOT in good.txt, so grep exits 1 — which is the desired outcome.
    const summary = makeSummary({
      workingDir: tmp,
      iscRows: [
        {
          id: 1,
          description: "File should NOT contain badpattern",
          status: "DONE",
          verification: {
            method: "grep-negative",
            command: `grep -q badpattern ${join(tmp, "good.txt")}`,
            expectedExitCode: 1,
          },
        },
      ],
    });

    const evidence = gatherEvidence(summary, {});

    expect(evidence.commands.length).toBe(1);
    expect(evidence.commands[0].exitCode).toBe(1);
    expect(evidence.commands[0].expectedExitCode).toBe(1);
    expect(evidence.commands[0].passed).toBe(true);
  });

  it("default behavior unchanged: command exits 0 with no expectedExitCode is PASS", () => {
    // "hello" IS in good.txt, so grep exits 0 — correct for a positive assertion.
    const summary = makeSummary({
      workingDir: tmp,
      iscRows: [
        {
          id: 2,
          description: "File should contain hello",
          status: "DONE",
          verification: {
            method: "grep-positive",
            command: `grep -q hello ${join(tmp, "good.txt")}`,
          },
        },
      ],
    });

    const evidence = gatherEvidence(summary, {});

    expect(evidence.commands.length).toBe(1);
    expect(evidence.commands[0].exitCode).toBe(0);
    expect(evidence.commands[0].expectedExitCode).toBeUndefined();
    expect(evidence.commands[0].passed).toBe(true);
  });

  it("wrong exit code on positive assertion: command exits 1 with no expectedExitCode is FAIL", () => {
    // "badpattern" is NOT in good.txt, so grep exits 1 — but we expected 0 (positive assertion).
    const summary = makeSummary({
      workingDir: tmp,
      iscRows: [
        {
          id: 3,
          description: "File should contain badpattern",
          status: "DONE",
          verification: {
            method: "grep-positive",
            command: `grep -q badpattern ${join(tmp, "good.txt")}`,
            expectedExitCode: 0,
          },
        },
      ],
    });

    const evidence = gatherEvidence(summary, {});

    expect(evidence.commands.length).toBe(1);
    expect(evidence.commands[0].exitCode).toBe(1);
    expect(evidence.commands[0].expectedExitCode).toBe(0);
    expect(evidence.commands[0].passed).toBe(false);
  });

  it("commandEvidence (Fix #4): shell-operator-blocked commands count as blocked, not executed", () => {
    // Both verify commands use shell operators (pipe, $()) — the gate blocks both,
    // so ZERO independent command evidence is gathered (the mq4kdqs0 scenario).
    const summary = makeSummary({
      workingDir: tmp,
      iscRows: [
        {
          id: 10,
          description: "report shows skip count",
          status: "DONE",
          verification: { method: "pipe", command: `cat ${join(tmp, "good.txt")} | grep hello` },
        },
        {
          id: 11,
          description: "json field present",
          status: "DONE",
          verification: { method: "subshell", command: `jq '.x' $(echo ${join(tmp, "good.txt")})` },
        },
      ],
    });

    const evidence = gatherEvidence(summary, {});

    expect(evidence.commandEvidence).toBeDefined();
    expect(evidence.commandEvidence!.declared).toBe(2);
    expect(evidence.commandEvidence!.executed).toBe(0);
    expect(evidence.commandEvidence!.blocked).toBe(2);
  });

  it("commandEvidence (Fix #4): a single-token-safe command counts as executed", () => {
    const summary = makeSummary({
      workingDir: tmp,
      iscRows: [
        {
          id: 12,
          description: "File should contain hello",
          status: "DONE",
          verification: { method: "grep-positive", command: `grep -q hello ${join(tmp, "good.txt")}` },
        },
      ],
    });

    const evidence = gatherEvidence(summary, {});

    expect(evidence.commandEvidence!.declared).toBe(1);
    expect(evidence.commandEvidence!.executed).toBe(1);
    expect(evidence.commandEvidence!.blocked).toBe(0);
  });

  it("wrong exit code on negative assertion: command exits 0 (pattern found) with expectedExitCode:1 is FAIL", () => {
    // "hello" IS in good.txt, so grep exits 0 — but we expected 1 (negative assertion: pattern should NOT be there).
    const summary = makeSummary({
      workingDir: tmp,
      iscRows: [
        {
          id: 4,
          description: "File should NOT contain hello",
          status: "DONE",
          verification: {
            method: "grep-negative",
            command: `grep -q hello ${join(tmp, "good.txt")}`,
            expectedExitCode: 1,
          },
        },
      ],
    });

    const evidence = gatherEvidence(summary, {});

    expect(evidence.commands.length).toBe(1);
    expect(evidence.commands[0].exitCode).toBe(0);
    expect(evidence.commands[0].expectedExitCode).toBe(1);
    expect(evidence.commands[0].passed).toBe(false);
  });
});
