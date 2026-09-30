#!/usr/bin/env bun
/**
 * AgentSpawner.guardHooks.smoke.ts — LIVE smoke test (S-06, slice 3).
 *
 * Spawns ONE real `claude -p --model haiku` subprocess via spawnAgentSync()
 * with `guardHooks: true`, and proves the real SecurityValidator +
 * PromptInjectionDefender guard hooks (injected via `--settings`, see
 * AgentSpawner.ts's buildGuardHookSettings) actually loaded and executed
 * inside that live spawn — not just that the code compiles or a unit test's
 * fake spawnFn was satisfied.
 *
 * COST: one real haiku API call (a few cents, a few seconds). Safe to re-run.
 *
 * RUN: bun lib/core/AgentSpawner.guardHooks.smoke.ts
 *
 * WORKTREE NOTE (read before editing): this script's own process starts with
 * an ambient KAYA_DIR pointed at the LIVE tree ($HOME/.claude), not this
 * worktree (confirmed via `env | grep KAYA` in the authoring session — only
 * KAYA_DIR was set; KAYA_HOME, which would outrank it in
 * lib/core/KayaHome.ts's getKayaHome(), was unset). AgentSpawner's
 * buildGuardHookSettings() bakes `process.env.KAYA_DIR ?? ~/.claude` into the
 * hook `command` path AT SPAWN TIME, and buildHardenedClaudeEnv()'s
 * `{...process.env}` copy carries that same KAYA_DIR into the spawned
 * claude process's own env (and from there into the hook subprocesses IT
 * invokes). Left alone, this smoke test would silently exercise the LIVE
 * tree's hook files instead of THIS worktree's — including the new S-06
 * confirm-tier hard-block in hooks/lib/security-response.ts. So: WORKTREE_ROOT
 * below is this worktree's absolute path, and it overrides
 * `process.env.KAYA_DIR` before AgentSpawner.ts is imported. A plain
 * top-of-file assignment before a static `import` line would NOT guarantee
 * that ordering (ES module imports are hoisted ahead of top-level code), so
 * the override happens first and AgentSpawner.ts is imported dynamically
 * afterward.
 *
 * WHAT THIS PROVES, AND WHAT IT DOESN'T:
 *   - PROVES SecurityValidator's REAL PreToolUse Bash hook (this worktree's
 *     copy) executed inside the live spawn. The proof is a same-day increase
 *     in the "Bash" counter of MEMORY/SECURITY/<Y>/<M>/<D>-allow-tally.json
 *     (hooks/lib/allow-tally.ts, written only via SecurityValidator's
 *     `allowTool()` path — see hooks/SecurityValidator.hook.ts's
 *     `default: allowTool('Bash')` case in handleBash). Because this spawn
 *     always passes `--setting-sources ""` (AgentSpawner.ts), the ONLY way
 *     this counter can move at all is if the `--settings`-injected guard
 *     hooks actually ran — there is no other hook source available to the
 *     spawn (verified live: PROBES.md probe 0a).
 *   - Does NOT independently prove PromptInjectionDefender fired via a nonce
 *     match in its own append log. Read directly (PromptInjectionDefender
 *     .hook.ts's handleResult(), gated by `!result.clean ||
 *     loadConfig().global.log_clean_scans`) plus the real deployed config
 *     (KAYASECURITYSYSTEM/injection-config.yaml:13, `log_clean_scans:
 *     false`): a CLEAN scan of a benign `echo` — exactly what this smoke
 *     test runs — writes NO log line, by design. Forcing a match would mean
 *     either deviating from the specified benign command to trip a
 *     warn/block verdict, or flipping `log_clean_scans` in the SHARED
 *     production config (which would change logging for every other live
 *     agent) — both out of scope for a smoke test, so neither was attempted.
 *     Instead, the nonce is asserted present in the spawned session's own
 *     captured stdout — direct proof the Bash tool call round-tripped
 *     through PreToolUse without being blocked (a confirm/block-tier misfire
 *     against this benign command would suppress it from stdout entirely).
 *
 * If the allow-tally delta does not appear, DO NOT loosen this check to force
 * a pass — that means the guard hooks did not really fire and S-06 is not
 * actually closed. Report it.
 */

import { randomBytes } from "crypto";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const WORKTREE_ROOT = "~/.claude/.claude/worktrees/security-audit-exec-20260908";
process.env.KAYA_DIR = WORKTREE_ROOT;

/** Reads the "Bash" field out of an allow-tally JSON file; 0 if missing/absent/malformed. */
function readBashTally(path: string): number {
  if (!existsSync(path)) return 0;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (parsed === null || typeof parsed !== "object") return 0;
    // `in` narrows only that the key exists at runtime, not the static shape
    // of a bare `object` — the cast below is scoped to reading one unknown
    // field, immediately re-validated by the typeof check that follows.
    if (!("Bash" in parsed)) return 0;
    const bash = (parsed as { Bash?: unknown }).Bash;
    return typeof bash === "number" ? bash : 0;
  } catch {
    return 0;
  }
}

function allowTallyPath(kayaHome: string, date: Date): string {
  const year = date.getFullYear().toString();
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  // Mirrors hooks/lib/allow-tally.ts's getMemoryRoot()/getTallyPath() exactly
  // (KAYA_MEMORY_ROOT override first, else <kayaHome>/MEMORY).
  const memoryRoot = process.env.KAYA_MEMORY_ROOT ?? join(kayaHome, "MEMORY");
  return join(memoryRoot, "SECURITY", year, month, `${day}-allow-tally.json`);
}

async function main(): Promise<number> {
  const { spawnAgentSync } = await import("./AgentSpawner.ts");
  const { getKayaHome } = await import("./KayaHome.ts");

  // Re-resolved AFTER the KAYA_DIR override above — getKayaHome() self-heals
  // its internal cache whenever the env value it's keyed on changes (see
  // KayaHome.ts's doc comment), so this reflects the override even though
  // the module itself may already have been imported elsewhere.
  const kayaHome = getKayaHome();
  if (kayaHome !== WORKTREE_ROOT) {
    console.error(
      `FAIL: expected getKayaHome() to resolve to the worktree (${WORKTREE_ROOT}), got ${kayaHome} instead — ` +
        `KAYA_HOME may be set in the ambient env and outranking KAYA_DIR (see KayaHome.ts priority order).`,
    );
    return 1;
  }

  const nonce = randomBytes(8).toString("hex");
  const marker = `GUARD_SMOKE_${nonce}`;
  const prompt =
    `Run exactly this command via the Bash tool and nothing else: echo ${marker}\n` +
    `Then, as your ENTIRE final response, output only the exact stdout of that command — no other words.`;

  const tallyPath = allowTallyPath(kayaHome, new Date());
  const beforeBash = readBashTally(tallyPath);

  const result = spawnAgentSync({
    prompt,
    model: "haiku",
    allowedTools: "Bash",
    timeoutMs: 120000,
    skipRateLimitGate: true,
    guardHooks: true,
  });

  if (result.infraUnavailable || result.exitCode !== 0) {
    console.error(
      `FAIL: spawn itself failed (not a hook-firing verdict) — infraUnavailable=${result.infraUnavailable} ` +
        `exitCode=${result.exitCode} timedOut=${result.timedOut} infraReason=${result.infraReason ?? "n/a"}`,
    );
    console.error(`stderr (first 2000 chars): ${result.stderr.slice(0, 2000)}`);
    console.error(`stdout (first 2000 chars): ${result.stdout.slice(0, 2000)}`);
    return 2;
  }

  const afterBash = readBashTally(tallyPath);
  const nonceInStdout = result.stdout.includes(marker);
  const tallyIncreased = afterBash > beforeBash;

  if (!nonceInStdout || !tallyIncreased) {
    console.error("FAIL: guard hooks did not verifiably fire.");
    console.error(
      `  expected: marker "${marker}" present in the spawned session's stdout, AND the "Bash" count in ` +
        `${tallyPath} to increase (was ${beforeBash}).`,
    );
    console.error(`  observed: nonceInStdout=${nonceInStdout}, tally ${beforeBash} -> ${afterBash}`);
    console.error(`  stdout (first 2000 chars): ${result.stdout.slice(0, 2000)}`);
    return 1;
  }

  console.log(
    `PASS: guard hooks fired for real — marker "${marker}" seen in stdout, allow-tally Bash ${beforeBash} -> ${afterBash} (${tallyPath}).`,
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(`FAIL: smoke test threw: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exit(2);
  });
