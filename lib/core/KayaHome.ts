/**
 * KayaHome — Single source of truth for the Kaya installation directory.
 *
 * Priority order:
 *   1. KAYA_HOME env var (new canonical name)
 *   2. KAYA_DIR env var (legacy compat — settings.json uses ${KAYA_DIR})
 *   3. join(homedir(), '.claude')
 *
 * Note: The env var checked is `KAYA_DIR` (matching settings.json `${KAYA_DIR}`)
 * but the function is named `getKayaHome()` for clarity.
 *
 * Usage:
 *   import { getKayaHome, kayaHomePath } from 'lib/core/KayaHome.ts';
 *   const home = getKayaHome();
 *   const settings = kayaHomePath('settings.json');
 */

import { homedir } from 'os';
import { join } from 'path';
import { existsSync } from 'fs';

interface KayaHomeCacheEntry {
  /** The KAYA_HOME||KAYA_DIR value that produced `home` — undefined when neither was set. */
  envHome: string | undefined;
  home: string;
}

let _cache: KayaHomeCacheEntry | null = null;

/**
 * Returns the Kaya home directory.
 *
 * Cached, but keyed on the env pair that produced the cached value — not
 * just "has this been called before". Every call re-reads
 * process.env.KAYA_HOME/KAYA_DIR and, if that resolved value differs from
 * whatever produced the cached result (including an undefined-to-set or
 * set-to-undefined transition), re-resolves rather than returning the stale
 * value. This means a test that does `process.env.KAYA_HOME = tmpdir` takes
 * effect on the very next getKayaHome() call with no manual cache reset
 * needed — author-discipline (remembering to call a reset hook) was the
 * root cause of repeated hermeticity leaks. Still avoids re-joining/
 * re-expanding on every call when the env hasn't actually changed.
 */
export function getKayaHome(): string {
  const envHome = process.env.KAYA_HOME || process.env.KAYA_DIR;
  if (_cache && _cache.envHome === envHome) return _cache.home;
  const home = envHome ? expandPath(envHome) : defaultKayaHome();
  _cache = { envHome, home };
  return home;
}

/**
 * Returns the KAYA_HOME value used when NO env override is present — i.e.
 * the production repo root. Uncached (unlike getKayaHome()) so callers can
 * safely invoke it per-call, including from tests that mutate process.env
 * mid-run.
 *
 * Exported so other modules can detect "KAYA_HOME is pointing at the repo
 * root" without hardcoding the path or duplicating join(homedir(), '.claude').
 * PipelineDB.ts's defaultPipelineDbPath() uses this to ignore a repo-root
 * KAYA_HOME: every Kaya launchd cron plist sets KAYA_HOME=<repo root> purely
 * so tools can find the repo, not to relocate the out-of-repo runtime store
 * (see runtimeDir() above). Before that fix, the collision silently routed
 * the whole cron fleet onto a 0-item decoy pipeline.db under
 * <repo root>/.kaya/runtime/ instead of the canonical ~/.kaya/runtime/
 * (decoy-db incident, 2026-07-02).
 */
export function defaultKayaHome(): string {
  return join(homedir(), '.claude');
}

/**
 * Returns an absolute path joined under getKayaHome().
 */
export function kayaHomePath(...segments: string[]): string {
  return join(getKayaHome(), ...segments);
}

/**
 * Shared knowledge-graph store directory.
 *
 * Resolution (compat shim during migration):
 *   1. KAYA_GRAPH_DIR env var (explicit override / tests)
 *   2. ~/.kaya/graph — the shared, out-of-repo store (once migrated)
 *   3. <kayaHome>/MEMORY/GRAPH — legacy in-repo location (until migration)
 *
 * Out-of-repo so no branch checkout/reset/discard can touch graph learnings,
 * and so every concurrent worktree session + cron shares one live graph.
 */
export function getSharedGraphDir(): string {
  const env = process.env.KAYA_GRAPH_DIR;
  if (env) return expandPath(env);
  const shared = join(homedir(), '.kaya', 'graph');
  if (existsSync(shared)) return shared;
  return join(getKayaHome(), 'MEMORY', 'GRAPH');
}

/**
 * Shared runtime state directory for high-churn ephemeral subtrees.
 *
 * Resolution (compat shim during migration):
 *   1. KAYA_RUNTIME env var (explicit override / tests)
 *   2. ~/.kaya/runtime — the shared, out-of-repo store (once migrated)
 *   3. <kayaHome>/MEMORY — legacy in-repo location (until migration)
 *
 * Out-of-repo so no branch checkout/reset/discard can touch runtime state,
 * and so every concurrent worktree session + cron shares one live store.
 * High-churn subtrees (MONITORING, QUEUES, NOTIFICATIONS, EVAL_SIGNALS)
 * are symlinked from <kayaHome>/MEMORY/<sub> → runtimeDir()/<sub>.
 */
export function runtimeDir(): string {
  const env = process.env.KAYA_RUNTIME;
  if (env) return expandPath(env);
  const shared = join(homedir(), '.kaya', 'runtime');
  if (existsSync(shared)) return shared;
  return join(getKayaHome(), 'MEMORY');
}

/**
 * Returns the auto-memory directory used when NO KAYA_MEMORY_DIR override is
 * present — i.e. the shared, out-of-repo, live store at ~/.kaya/memory.
 * Uncached (unlike getAutoMemoryDir()) so callers/tests can invoke it safely
 * per-call, mirroring defaultKayaHome()'s contract.
 */
export function defaultAutoMemoryDir(): string {
  return join(homedir(), '.kaya', 'memory');
}

/**
 * Auto-memory directory: Jm's cross-session `.md` fact files (a DIFFERENT
 * store from getKayaHome()/MEMORY — that tree is Kaya's internal runtime
 * memory; this one is the user-facing auto-memory Claude Code loads into
 * every session, configured via settings.json `autoMemoryDirectory`).
 *
 * Resolution:
 *   1. KAYA_MEMORY_DIR env var (explicit override / tests — same variable
 *      bin/migrate-memory-to-shared.sh already reads for its DEST default)
 *   2. ~/.kaya/memory — the shared, out-of-repo store
 *
 * Out-of-repo for the same reason as runtimeDir()/getSharedGraphDir(): no
 * branch checkout/reset/discard can touch it, and every concurrent worktree
 * session shares the one live store. This directory is its own private git
 * repository (Context Integrity Program slice E1) used purely as a local
 * undo net for automated consolidation (slice E2) — never pushed anywhere.
 */
export function getAutoMemoryDir(): string {
  const env = process.env.KAYA_MEMORY_DIR;
  if (env) return expandPath(env);
  return defaultAutoMemoryDir();
}

/**
 * Write-time hermeticity tripwire for auto-memory consolidation. Mirrors
 * assertNotLiveHomeUnderTest()'s contract, but takes the directory actually
 * about to be written (`memoryDirInUse`) rather than re-resolving
 * getAutoMemoryDir() itself — callers that accept a DI'd `memoryDir` option
 * (see AutoMemoryConsolidator.ts's ConsolidateOptions) already target a
 * caller-controlled sandbox regardless of KAYA_MEMORY_DIR/NODE_ENV, and
 * re-resolving from env here would false-positive-throw on exactly those
 * correctly-hermetic tests (the same distinction KayaHome.ts already draws
 * between assertNotLiveHomeUnderTest and assertNotLiveDefaultUnderTest —
 * see that function's doc comment). Fires only under `bun test`
 * (NODE_ENV=test) AND only when the directory actually in use resolves to
 * the live default. A consolidation pass rewrites Jm's real memory files in
 * place — a test that forgets to sandbox this directory must fail loudly
 * before it touches a single real file, not silently rewrite live auto-memory.
 */
export function assertNotLiveAutoMemoryDirUnderTest(component: string, memoryDirInUse: string): void {
  if (process.env.NODE_ENV === 'test' && memoryDirInUse === defaultAutoMemoryDir()) {
    throw new Error(
      `[hermetic-guard] ${component} attempted a write against the LIVE auto-memory directory ` +
      `(${defaultAutoMemoryDir()}) while NODE_ENV=test. Pin KAYA_MEMORY_DIR (or pass an explicit ` +
      `memoryDir option) to a mkdtemp dir in this test. This guard prevents tests from rewriting ` +
      `Jm's real memory files.`
    );
  }
}

/**
 * Expand shell variables in a path: $HOME, ${HOME}, ~
 */
export function expandPath(path: string): string {
  const home = homedir();
  return path
    .replace(/^\$HOME(?=\/|$)/, home)
    .replace(/^\$\{HOME\}(?=\/|$)/, home)
    .replace(/^~(?=\/|$)/, home);
}

/**
 * Write-time hermeticity tripwire.
 *
 * Call at the start of every write choke point that touches the Kaya home
 * (FailureLog.recordFailure, NotificationService.logNotification,
 * AlertGate's state/spool writes, ...). Throws when running under
 * `bun test` (NODE_ENV=test — confirmed set by the bun test runner) AND
 * getKayaHome() resolves to the live production default, i.e. nothing in
 * this test pinned KAYA_HOME/KAYA_DIR to a sandbox. No launchd plist,
 * crontab line, or settings.json sets NODE_ENV, so this can never
 * false-positive in production — it only ever fires inside `bun test`.
 *
 * This replaces author-discipline hermeticity (every test file remembering
 * to pin KAYA_HOME + reset the cache + flush async bridges) with a runtime
 * guard: a test that forgets to pin now fails LOUDLY the moment it hits a
 * real write, instead of silently corrupting live MEMORY/ state.
 */
export function assertNotLiveHomeUnderTest(component: string): void {
  if (process.env.NODE_ENV === 'test' && getKayaHome() === defaultKayaHome()) {
    throw new Error(
      `[hermetic-guard] ${component} attempted a write against the LIVE Kaya home ` +
      `(${defaultKayaHome()}) while NODE_ENV=test. Pin KAYA_HOME to a mkdtemp dir in this test ` +
      `(see structured-falcon §69 hermetic invariant). This guard prevents tests from corrupting live state.`
    );
  }
}

/**
 * Write-time hermeticity tripwire for the OTHER exemption class:
 * modules that hardcode `defaultKayaHome()` for a specific ledger path and
 * deliberately IGNORE KAYA_HOME/KAYA_DIR altogether (see AlertManager.ts:33-34
 * — "homedir-only original (ignored KAYA_HOME env); defaultKayaHome()
 * preserves real-home"). assertNotLiveHomeUnderTest() above is the WRONG
 * guard for this class: its condition is
 * `getKayaHome() === defaultKayaHome()`, so a test/script that pins
 * KAYA_HOME to a scratch dir makes that comparison false and DISABLES the
 * guard — but for a module hardcoded to defaultKayaHome(), the write still
 * lands on the live production path no matter what KAYA_HOME is pinned to.
 * This is exactly how the 2026-07-20 incident got through AlertManager's
 * ledger write: ad-hoc verify scripts drove AlertManager.evaluate() outside
 * `bun test` (so NODE_ENV=test was never set — Gap A) and, separately, even
 * a script that HAD pinned KAYA_HOME to a scratch dir would have defeated
 * the getKayaHome()===defaultKayaHome() half of the check too (Gap B) —
 * 20 synthetic rows landed in the live alerts.jsonl either way.
 *
 * Fixes both gaps:
 *   - Fires under NODE_ENV=test (same as assertNotLiveHomeUnderTest() — the
 *     ordinary `bun test` case).
 *   - ALSO fires whenever KAYA_VERIFY_SESSION is set to any non-empty value
 *     — the sanctioned marker manual/agent verification runs (see
 *     VerifyHarness.ts) are expected to set, so an ad-hoc script that drives
 *     this module class outside `bun test` (never setting NODE_ENV=test)
 *     still gets caught as long as it sets this marker; a script that sets
 *     NEITHER is exactly last resort — see VerifyHarness.ts, the sanctioned
 *     way to exercise this module class against a scratch dir instead of
 *     invoking it ad hoc.
 *   - Deliberately contains NO `getKayaHome() === defaultKayaHome()` (or any
 *     other env-pinning) comparison — for this module class, env-pinning
 *     must never be able to disable the guard, since the write target
 *     ignores env pinning in the first place.
 *
 * Call this ONLY on the branch that is actually about to touch
 * defaultKayaHome() — i.e. after checking for a caller-supplied DI override
 * path, exactly like assertNotLiveHomeUnderTest()'s callers do (see
 * AlertGate.spool()/saveState(), AlertManager.appendAlertEntry()). A DI
 * override already targets a caller-controlled sandbox regardless of
 * KAYA_HOME/NODE_ENV/KAYA_VERIFY_SESSION, so guarding that branch too would
 * only produce false-positive throws in otherwise-correct hermetic tests.
 */
export function assertNotLiveDefaultUnderTest(component: string): void {
  if (process.env.NODE_ENV === 'test' || !!process.env.KAYA_VERIFY_SESSION) {
    throw new Error(
      `[hermetic-guard] ${component} attempted a write against the LIVE Kaya home ` +
      `(${defaultKayaHome()}), which this module hardcodes regardless of KAYA_HOME/KAYA_DIR ` +
      `(a documented exemption — see AlertManager.ts's module-level comment). Pinning KAYA_HOME ` +
      `will NOT bypass this guard for this module class, because the write target ignores it. ` +
      `Use a caller-supplied scratch-dir DI override instead (e.g. AlertManagerOptions.alertsLogPath), ` +
      `or VerifyHarness.ts for manual/agent verification. This guard prevents tests and ad-hoc ` +
      `verify scripts from corrupting live state (2026-07-20 incident).`
    );
  }
}
