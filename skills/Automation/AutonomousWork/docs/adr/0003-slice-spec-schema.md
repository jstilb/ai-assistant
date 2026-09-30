---
status: accepted
---

# Slice spec schema and live-verify contract

A Slice in the spec carries: a name, an **in-scope** list, a **deferred** list, the **ISC row IDs** it owns, and its live-verification declaration. Live verification is expressed via structured surface + Given/When/Then acceptance criteria:

- **Structured (only path):** a `surface` (`browser` | `cli` | `api` | `integration`). RuntimeVerifier routes by surface (`bunx playwright test` for browser, `bun test` otherwise). The producer emits ISC "Verify Method" columns (shell commands) — these are run by CommandRunner, not RuntimeVerifier's free-form path.

**S6 amendment:** The free-form `verify:` escape hatch described in the original draft is NOT built. The producer emits ISC Verify Method columns (already run by CommandRunner) and Given/When/Then acceptance per phase. The remaining verification gap for browser slices is the **visual Read gate** — captured by S6.

## S6: Browser visual screenshot→Read gate

For browser surfaces, deterministic Playwright tests prove the page loaded but cannot prove the UI looks correct (mirage UI: tests pass against a blank or placeholder render). S6 closes this gap:

1. **TestWriterPrompt.md** requires every browser `.spec.ts` to call `page.screenshot({ fullPage: true })` for each material state AND install `page.on('pageerror')` / `page.on('console')` error handlers that fail the test on errors (favicon-404 excepted).
2. **RuntimeVerifier BrowserStrategy** scans `AW_SHOT_DIR`, `<worktree>/test-results/`, and `<worktree>/playwright-screenshots/` after the Playwright run, collects `*.png` paths, returns them in `RuntimeVerificationResult.screenshots`.
3. **WorkOrchestrator.verifyPhase** threads `screenshots` through its result shape `{ phaseNumber, passed, evidence, screenshots }`.
4. **Orchestrate.md step 6a** requires the Executive to open each screenshot path with the Read tool and visually confirm the rendered UI matches the phase's Given/When/Then before calling mark-phase-done. A blank/mirage render or any console error is a gate FAIL.

This is the contract three systems share: the spec-pipeline authors Given/When/Then, `RuntimeVerifier.ts` executes and collects screenshots, and `Orchestrate.md` drives the Executive visual check.

## Consequences

- `RuntimeVerificationResult` gains a `screenshots: string[]` field (default `[]` for non-browser strategies).
- `verifyPhase` result gains `screenshots: string[]`.
- The free-form `verify:` command path is NOT built — ISC Verify Methods are already run by CommandRunner.
- `TestWriterPrompt.md` browser rules now mandate `page.screenshot()` + console-error capture.
