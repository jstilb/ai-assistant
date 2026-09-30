# lib/orchestrator/ — WorkOrchestrator.ts decomposition (S11)

<!--
CONCERN MAP — every method in WorkOrchestrator.ts, classified.
Categories: QueueLifecycle, Verification, WorktreeOps, CatastrophicGate,
PhaseBookkeeping, Reporting, or "composition-root stays" (glue/DI that has
to live in the class itself).

Legend: [x] = extracted in this pass, [ ] = not yet extracted.

Composition root (stays in WorkOrchestrator.ts — constructors, DI wiring,
test factory):
  - constructor (options-object + positional overloads)          ~252-330
  - static _createForTesting                                     333-355
  - loadISC (private) — orchestrator-internal `undefined`-as-empty
    wrapper around iscManager.load(); comment explicitly says
    external callers should use iscManager.load directly, so this
    is glue, not a standalone concern.                           1965-1970
  - getAllQueueItems — trivial one-line CLI delegation to
    this.queue.getAllItems().                                    1993

QueueLifecycle (init / next-batch / started / retry / complete / fail —
the item state machine and its surrounding bookkeeping):
  - readOrchestrationLearnings                                   366-406
  - init                                                         408-444
  - stopMonitoring                                               447-449
  - nextBatch                                                    458-469
  - started                                                      617-642
  - enqueueNextFollowOn                                          719-757
  - complete (private)                                           759-821
  - fail                                                         824-828
  - classifyFailure (private)                                    845-857
  - retry                                                        864-1007
  - syncCompletionToApprovedWork (private)                        1014-1016
  - _reconcileForTesting                                         1025-1027
  - reconcileApprovedWork (private)                               1029-1040
  - completeSync (private)                                       1046-1104
  - recoverOrphanedItems (delegates to OrphanRecovery.ts)         1976-1986
  - resumeBlocked                                                2004-2018

Verification (verify-phase / report-done / gates — the review pipeline,
its DI'd helpers, and the phase-level deterministic gate):
  - reportDone                                                   652-702
  - verify                                                       1110-1379
  - parseVerificationCommand (delegates to CommandRunner)         1660-1662
  - getGitDiffStat (delegates to VerifyContextResolver)           1664-1666
  - resolveVerifyContext (delegates to VerifyContextResolver)     1668-1670
  - resolveRowCwd (delegates to VerifyContextResolver)            1672-1674
  - classifyRowDisposition (private, delegates to iscManager)      1676-1678
  - mapPriority (private) — builds ItemReviewSummary.priority for
    verify()'s summary                                           1680-1687
  - resolveStaleReviewProxies (private)                          1696-1733
  - readSpecContent (private) — feeds verify()'s summary          1735-1756
  - verifyPhase (per-phase deterministic Gate 1)                  1809-1885

WorktreeOps (prepare / worktree mgmt):
  - prepare                                                      475-611
  - ensureFeatureBranch                                          1519-1562
  - resolveRepoRoot (private)                                    1575-1600
  - tryResolveGitRoot (private)                                  1603-1617
  - cleanupWorktree (private)                                    1623-1635

CatastrophicGate (command safety) — EXTRACTED THIS PASS:
  - [x] isCatastrophic                                           1502-1509 → lib/orchestrator/CatastrophicGate.ts
  - [x] isProtectedBranch                                        1511-1513 → lib/orchestrator/CatastrophicGate.ts

PhaseBookkeeping (mark-phase-done / format-isc-table / phase-row state):
  - annotateHumanGatedPhases (top-level exported fn, used by prepare)  157-163
  - formatISCTableForAgents                                      1762-1779
  - markRowsHumanRequired (private)                              1893-1905
  - markPhaseDone                                                1912-1923
  - getPhaseISC                                                  1929-1934
  - generatePhaseGitSummary                                      1939-1954

Reporting (status / output formatting) — EXTRACTED THIS PASS:
  - [x] status                                                   1385-1403 → lib/orchestrator/Reporting.ts (statusReport)
  - [x] report                                                   1409-1439 → lib/orchestrator/Reporting.ts (categorizeReport)
  - [x] reportMarkdown                                           1441-1496 → lib/orchestrator/Reporting.ts (reportMarkdown)
  - [x] generatePriorWorkSummary                                 1641-1656 → lib/orchestrator/Reporting.ts (generatePriorWorkSummary)
-->

## Modules

- **CatastrophicGate.ts** — `isCatastrophic(command)` / `isProtectedBranch(branch)`. Pure
  functions over the shared `CATASTROPHIC_PATTERNS` / `PROTECTED_BRANCHES` constants
  (re-exported from `../../VerificationUtils.ts`, which itself re-exports from
  `lib/core/CommandSafety.ts`). No DI needed — nothing but the command/branch string in.
- **Reporting.ts** — `statusReport(queue)`, `categorizeReport(queue)`, `reportMarkdown(report,
  loadISC)`, `generatePriorWorkSummary(ids, loadISC)`. Pure functions over an explicit
  `WorkQueue` and (where ISC rows are needed) an injected `loadISC` callback, matching the
  orchestrator's own private `loadISC` semantics (returns `undefined` for empty).

## Pass 2 recommendation

Next cleanest slice: **PhaseBookkeeping** (`formatISCTableForAgents`, `markPhaseDone`,
`getPhaseISC`, `generatePhaseGitSummary`, `markRowsHumanRequired`, `annotateHumanGatedPhases`).
All six operate on ISC rows / phase metadata via `iscManager` + `queue`, take an itemId and
have no other class-state dependency (no `this.verifier`, no `this.notificationDispatcher`) —
same DI shape as this pass's two modules. `verifyPhase` itself (Verification) also leans on
`commandRunner` + `iscManager` only, so it could ride along in the same slice if pass 2 wants
a bigger cut; `WorktreeOps` is the next slice after that (needs `queue` + `guard` +
`WorktreeManager` dynamic import — a bit more DI surface).

## S11 deviation note (2026-07-03)

`KAYA_TEST_SKIP_JUDGE` was slated for deletion (remediation plan S11) but is
KEPT: fresh reading shows the 2026-07-02 overhaul deliberately engineered it
as the Gate-3 injection channel across the REAL `bun WorkOrchestratorCLI.ts`
subprocess boundary that HeadlessWorkDriver.test.ts intentionally exercises
(agent spawns are already faked by construction; the CLI subprocess is the
system under test). Production never sets it; hygiene notes in both files
guard it. Removing it would mean an argv-parameterized, exit-free main() +
a rewrite of the 1,017L driver harness — cost exceeds the depth gained over
an already-hardened seam. Revisit only if the CLI boundary itself dissolves.
