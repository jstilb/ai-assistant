/**
 * LiveVerifier.mode.test.ts — Slice 1: runLiveVerification engine routing.
 * Confirms the self-verify branch never spawns the (classifier-blocked) Explorer.
 */

import { test, expect, describe } from "bun:test";
import { runLiveVerification, type LiveVerifierInput, type ExplorerRunResult } from "./LiveVerifier.ts";

function baseInput(over: Partial<LiveVerifierInput> = {}): LiveVerifierInput {
  return {
    itemId: "item-mode",
    surface: "cli",
    effort: "STANDARD",
    workingDir: "/tmp/worktree",
    specExcerpt: "x",
    diffPaths: ["a.ts"],
    ...over,
  };
}

describe("runLiveVerification engine routing", () => {
  test("mode=self-verify routes to self-verify runner and NEVER calls the Explorer", async () => {
    let explorerCalled = false;
    const explorerSpy = (): ExplorerRunResult => {
      explorerCalled = true;
      return { success: true, stdout: "", stderr: "", exitCode: 0, timedOut: false };
    };
    let selfVerifyCalled = false;
    const res = await runLiveVerification(baseInput(), {
      mode: "self-verify",
      runExplorer: explorerSpy,
      runSelfVerifyImpl: async (input) => {
        selfVerifyCalled = true;
        return {
          surface: input.surface,
          effort: input.effort,
          verdict: "PASS",
          humanVerificationRequired: false,
          scenarios: [],
          scenariosRun: 1,
          scenariosPassed: 1,
          scenariosFailed: 0,
          edgeCasesExplored: 0,
          explorationTimeMs: 1,
          warnings: [],
          noEvidence: false,
          mode: "self-verify",
          environmentBlocked: false,
        };
      },
    });
    expect(selfVerifyCalled).toBe(true);
    expect(explorerCalled).toBe(false);
    expect(res.mode).toBe("self-verify");
    expect(res.verdict).toBe("PASS");
  });

  test("mode=explorer still uses the Explorer path", async () => {
    let explorerCalled = false;
    const res = await runLiveVerification(baseInput(), {
      mode: "explorer",
      writeTranscript: () => {},
      now: () => 1,
      runExplorer: (): ExplorerRunResult => {
        explorerCalled = true;
        return {
          success: true,
          stdout: '```json\n{"verdict":"PASS","scenarios":[{"id":"s1","kind":"happy","command":"bun run x","verdict":"PASS","exitCode":0}],"summary":"ok"}\n```',
          stderr: "",
          exitCode: 0,
          timedOut: false,
        };
      },
    });
    expect(explorerCalled).toBe(true);
    expect(res.mode).toBe("explorer");
    expect(res.verdict).toBe("PASS");
  });
});
