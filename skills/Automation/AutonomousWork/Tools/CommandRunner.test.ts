/**
 * CommandRunner.test.ts — Tests for CommandRunner command parsing and execution
 *
 * ISC coverage:
 *   S3a — EMFILE / ECONNRESET / ETIMEDOUT / ECONNREFUSED throw-sites set row.infraFault = true
 */

import { describe, it, expect, spyOn, afterEach } from "bun:test";
import { CommandRunner } from "./CommandRunner.ts";
import type { ISCRow } from "./WorkOrchestrator.ts";
import * as childProcess from "child_process";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRow(overrides: Partial<ISCRow> = {}): ISCRow {
  return {
    id: 1,
    description: "verify something",
    status: "PENDING",
    parallel: false,
    verification: {
      method: "command",
      command: "bun test foo.test.ts",
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// S3a: infraFault tagging at the throw-site in runVerificationCommand
// ---------------------------------------------------------------------------

describe("S3a: CommandRunner infraFault tagging at OS error throw-site", () => {
  afterEach(() => {
    // Restore any spies after each test
  });

  it("sets row.infraFault = true when execFileSync throws with EMFILE in message", () => {
    const runner = new CommandRunner();
    const row = makeRow();

    // Spy on execFileSync and make it throw an EMFILE error
    const spy = spyOn(childProcess, "execFileSync").mockImplementation(() => {
      const err = new Error("EMFILE: too many open files");
      throw err;
    });

    const result = runner.runVerificationCommand(row);
    // Returns null (deferred to Phase 2) — same as before
    expect(result).toBeNull();
    // NEW: infraFault must be set on the row
    expect(row.infraFault).toBe(true);

    spy.mockRestore();
  });

  it("sets row.infraFault = true when execFileSync throws with ECONNRESET in message", () => {
    const runner = new CommandRunner();
    const row = makeRow();

    const spy = spyOn(childProcess, "execFileSync").mockImplementation(() => {
      const err = new Error("read ECONNRESET");
      throw err;
    });

    const result = runner.runVerificationCommand(row);
    expect(result).toBeNull();
    expect(row.infraFault).toBe(true);

    spy.mockRestore();
  });

  it("sets row.infraFault = true when execFileSync throws with ETIMEDOUT in message", () => {
    const runner = new CommandRunner();
    const row = makeRow();

    const spy = spyOn(childProcess, "execFileSync").mockImplementation(() => {
      const err = new Error("connect ETIMEDOUT 1.2.3.4:80");
      throw err;
    });

    const result = runner.runVerificationCommand(row);
    expect(result).toBeNull();
    expect(row.infraFault).toBe(true);

    spy.mockRestore();
  });

  it("sets row.infraFault = true when execFileSync throws with ECONNREFUSED in message", () => {
    const runner = new CommandRunner();
    const row = makeRow();

    const spy = spyOn(childProcess, "execFileSync").mockImplementation(() => {
      const err = new Error("connect ECONNREFUSED 127.0.0.1:3000");
      throw err;
    });

    const result = runner.runVerificationCommand(row);
    expect(result).toBeNull();
    expect(row.infraFault).toBe(true);

    spy.mockRestore();
  });

  it("sets row.infraFault = true when execFileSync throws with ProcessFdQuotaExceeded in stderr", () => {
    const runner = new CommandRunner();
    const row = makeRow();

    const spy = spyOn(childProcess, "execFileSync").mockImplementation(() => {
      const err: Error & { stderr?: string } = new Error("spawn failed");
      err.stderr = "ProcessFdQuotaExceeded: fd quota exceeded";
      throw err;
    });

    const result = runner.runVerificationCommand(row);
    expect(result).toBeNull();
    expect(row.infraFault).toBe(true);

    spy.mockRestore();
  });

  it("does NOT set row.infraFault when execFileSync throws a normal non-zero exit", () => {
    const runner = new CommandRunner();
    const row = makeRow();

    const spy = spyOn(childProcess, "execFileSync").mockImplementation(() => {
      const err: Error & { stderr?: string; status?: number } = new Error("Command failed with exit code 1");
      err.status = 1;
      throw err;
    });

    runner.runVerificationCommand(row);
    // Normal test failure → no infraFault tag
    expect(row.infraFault).toBeUndefined();

    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// S3a: VerifierReport faultClass type acceptance
// ---------------------------------------------------------------------------

describe("S3a: VerifierReport.faultClass optional field", () => {
  it("accepts a VerifierReport literal without faultClass (field is optional)", () => {
    const report: import("./Types.ts").VerifierReport = {
      rows: [],
      summary: "ok",
      allPass: true,
    };
    expect(report.faultClass).toBeUndefined();
  });

  it("accepts a VerifierReport literal with faultClass set", () => {
    const report: import("./Types.ts").VerifierReport = {
      rows: [],
      summary: "infra failure",
      allPass: false,
      faultClass: "infrastructure",
    };
    expect(report.faultClass).toBe("infrastructure");
  });
});
