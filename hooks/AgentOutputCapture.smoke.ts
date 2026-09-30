#!/usr/bin/env bun
/**
 * AgentOutputCapture.smoke.ts — hermetic smoke test for S-25: proves the SubagentStop hook captures output for an `Agent`-named tool_use (Claude Code 2.1.263's renamed subagent tool) end-to-end, in a real subprocess spawn.
 * COST: none — no LLM call, no network; pure local subprocess + filesystem, safe to re-run.
 * RUN: bun hooks/AgentOutputCapture.smoke.ts
 */

import { execSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const HOOK_PATH = join(import.meta.dir, "AgentOutputCapture.hook.ts");
const RESULT_TEXT = "🗣️ Engineer: Smoke-test completion message for S-25.";

function main(): number {
  const kayaDir = mkdtempSync(join(tmpdir(), "agent-output-capture-smoke-"));
  try {
    // Production ~/.claude/hooks/ always exists; a bare mkdtemp sandbox
    // doesn't, and the hook's debug-log writer would ENOENT before doing
    // anything else (same reason the unit test pre-creates this).
    mkdirSync(join(kayaDir, "hooks"), { recursive: true });
    const transcriptPath = join(kayaDir, "transcript.jsonl");

    const toolUseId = "toolu_smoke_1";
    const assistantEntry = {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: toolUseId,
            name: "Agent", // S-25: the renamed subagent tool — this is the exact fix under test.
            input: { subagent_type: "engineer", description: "Smoke test task" },
          },
        ],
      },
    };
    const userEntry = {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: toolUseId, content: RESULT_TEXT }],
      },
    };
    writeFileSync(transcriptPath, JSON.stringify(assistantEntry) + "\n" + JSON.stringify(userEntry) + "\n");

    const stdinPayload = JSON.stringify({
      session_id: "smoke-test-session",
      transcript_path: transcriptPath,
      agent_id: "smokeagentid1",
    });
    const tmpInput = join(kayaDir, "in.json");
    const tmpStdout = join(kayaDir, "out.txt");
    const tmpStderr = join(kayaDir, "err.txt");
    writeFileSync(tmpInput, stdinPayload);

    let exitCode = 0;
    try {
      // Subprocess spawn (like the hook's own unit test harness and
      // SecurityValidator's test pattern) — this exercises the real
      // stdin-read / debug-log / capture path, not an in-process import.
      execSync(`cat ${tmpInput} | bun run ${HOOK_PATH} 1>${tmpStdout} 2>${tmpStderr}`, {
        timeout: 8000,
        env: {
          ...process.env,
          // Both names: the hook reads KAYA_DIR/KAYA_HOME via kayaPath().
          KAYA_DIR: kayaDir,
          KAYA_HOME: kayaDir,
          // UnifiedEventSink.emit() reads this separate env var and
          // defaults to the LIVE ~/.claude/MEMORY tree when unset.
          KAYA_MEMORY_ROOT: join(kayaDir, "MEMORY"),
        },
      });
    } catch (err: unknown) {
      exitCode = (err as { status?: number }).status ?? 1;
    }

    if (exitCode !== 0) {
      console.error(`FAIL: hook subprocess exited ${exitCode} (expected 0).`);
      if (existsSync(tmpStderr)) console.error(`stderr:\n${readFileSync(tmpStderr, "utf-8")}`);
      return 1;
    }

    const researchDir = join(kayaDir, "MEMORY", "RESEARCH");
    if (!existsSync(researchDir)) {
      console.error(`FAIL: no MEMORY/RESEARCH directory was created at all under ${kayaDir} — the hook captured nothing.`);
      return 1;
    }

    // Filenames are `<timestamp>_AGENT-<type>_<captureType>_<slug>.md`
    // (see captureAgentOutput() in AgentOutputCapture.hook.ts) — "AGENT-"
    // is a mid-name token, not a prefix.
    const matches: string[] = [];
    for (const yearMonth of readdirSync(researchDir)) {
      const dir = join(researchDir, yearMonth);
      for (const f of readdirSync(dir)) {
        if (f.includes("_AGENT-") && f.endsWith(".md")) matches.push(join(dir, f));
      }
    }

    if (matches.length !== 1) {
      console.error(
        `FAIL: expected exactly one MEMORY/RESEARCH/<YYYY-MM>/AGENT-*.md file, found ${matches.length}: [${matches.join(", ")}]`,
      );
      return 1;
    }

    const content = readFileSync(matches[0], "utf-8");
    if (!content.includes(RESULT_TEXT)) {
      console.error(`FAIL: ${matches[0]} was written but does not contain the fixture's result text.`);
      console.error(`  expected to find: ${RESULT_TEXT}`);
      return 1;
    }

    console.log(`PASS: SubagentStop hook captured the 'Agent'-named tool_use's result to ${matches[0]}.`);
    return 0;
  } finally {
    try {
      rmSync(kayaDir, { recursive: true, force: true });
    } catch {
      // intentionally silent: best-effort temp-dir cleanup; the verdict above already printed
    }
  }
}

process.exit(main());
