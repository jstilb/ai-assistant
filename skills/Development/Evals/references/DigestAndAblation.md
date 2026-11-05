# Evals: weekly eval-health digest and setup ablation

Moved out of `SKILL.md`. Read it for the digest, regression alerting or an ablation run (see also `Workflows/RunAblation.md`).

## Weekly Eval-Health Digest & Regression Alerting

Two Kaya-owned tools read `MEMORY/VALIDATION/evals/` (the append-only JSONL store `ResultsPersistence.ts` writes every suite run):

- **`RegressionAlert.ts check <suite>`** — two deterministic tripwires (store missing entirely; every task in the current run scored 0 pass rate) page immediately. Below that, a cheap per-task delta-vs-rolling-baseline check flags candidates, and each candidate is classified by an LLM judge given the task's full recent history (real regression vs. a one-off blip vs. a known-flake oscillation vs. an environmental/fixture cause) — never a bare threshold. Run nightly via `bin/kaya-evals-nightly.ts`'s STEP 2.
- **`EvalHealthDigest.ts`** — weekly, LLM-written digest (trends, regressions, "silent-red streaks" — 2+ consecutive 0-pass-rate runs — anomalies, cost/wall-time) delivered through `AlertGate` at `tier: 'digest'`. Writes a dated copy to `MEMORY/VALIDATION/evals/digests/<date>.md`.

Both fail loud (throw / page-tier alert) rather than silently producing an empty or fabricated result when the store is missing or the judge call fails — see each tool's module doc for the specific named incidents this replaced.

---

## Setup Ablation — clean vs full vs component-ablated, across models

**WHY:** every eval above runs against the LIVE `~/.claude`, so "how much of a score is the model vs. our CLAUDE.md / skills / hooks?" — and "does that still hold on the next model?" — had no mechanism. `Tools/Ablation/` is that mechanism (2026-09-04; Fable 5.1 tuning-review rec #4 "pilot de-prescribing via Evals A/B" runs on it).

**Unit of comparison = a profile**: a materialized Claude Code config directory that `claude -p` boots from via `CLAUDE_CONFIG_DIR` (live-verified: settings.json, CLAUDE.md, `skills/*/SKILL.md`, `commands/`, `agents/`, `plugins/`, `.claude.json` are all read from there and symlinks are followed; `--bare` was rejected because it forces API-key auth — no subscription OAuth). Components, each includable/removable: `claudemd` (with section / line-range / regex surgery against the ORIGINAL line numbering), `skills` (category or `Category/Child`), `commands`, `agents`, `hooks` (by event name or command substring), `env` (settings env keys — e.g. the `CLAUDE_CODE_EFFORT_LEVEL` pin), `plugins`, `mcp`, `memory` (a snapshot COPY, never the live dir). `base: full` mirrors the source home and `remove:` subtracts; `base: clean` is vanilla Claude Code and `include:` adds back. Built-ins live in `Profiles/*.yaml` (`clean`, `full`, `no-claudemd`, `no-skills`, `no-hooks`, `no-agents`, `no-memory`, `no-effort-pin`, `claudemd-no-principles`, `claudemd-only`, `claudemd-and-skills`); ad-hoc ones come from `--without`/`--with` selectors (`skills`, `skill:Development/Evals`, `hooks`, `hook:LoadContext`, `env:KEY`, `claudemd`, `claudemd-section:<heading>`, `claudemd-lines:10-30`, `claudemd-matching:<regex>`, `commands`, `command:<n>`, `agents`, `agent:<n>`, `plugins`, `mcp`, `memory`). A selector that matches nothing FAILS the build (a typo'd ablation that silently removes nothing is a false experiment). Every profile dir carries a `PROFILE.json` manifest of exactly what was kept/dropped.

**Runner** (`Tools/Ablation/AblationRunner.ts run`): profiles × models, sequential cells, each cell = the SAME suite through the real `runSuite()` with `env.CLAUDE_CONFIG_DIR`, `--model`, `--no-session-persistence`, and `persist:false` — ablation cells never feed `MEMORY/VALIDATION/evals/` (RegressionAlert / EvalHealthDigest baselines). Output: `Results/ablations/<runId>/{matrix.json, report.md, cells/*.json}`; profile trees go OUTSIDE the repo to `~/.kaya/runtime/ablations/<runId>/profiles/` (`$KAYA_RUNTIME` overrides; path recorded as `profiles_dir` in matrix.json) because they are symlinks into the live home and `bun test` follows symlinks; the report is re-rendered after every cell (a killed run leaves a usable partial matrix; `--resume <runId>` fills the gaps). `--home <path>` builds profiles from another checkout (a worktree branch vs. main). `--dry-run` builds the profiles and prints the plan, zero spawns.

**Suite** `setup-ablation` (5 cheap tasks, `UseCases/SetupAblation/`, deterministic graders, ~$0.05/task on haiku): `ablation_identity` (CLAUDE.md loaded at all — `clean` MUST fail, `full` MUST pass; if both pass the profile is leaking the live config, if both fail the model ignores CLAUDE.md — either way the matrix is invalid), `ablation_capture_routing_awareness` (the Capture Routing section), `ablation_skill_awareness` (skills/ loaded), `ablation_scope_discipline` (Guiding Principles: one-line fix + tempting legacy line untouched), `ablation_fix_failing_test` (raw coding capability — the model axis). Any other suite whose tasks spawn a live agent works too (`kaya-pipeline-nightly`'s fixture-net tasks skip the spawn and therefore cannot ablate anything).

First live matrix (2026-09-04, haiku, 1 trial): clean 1/5 (identity ❌, routing ❌, skills ❌) vs full 3/5 — the discrimination the sanity-check task demands. Two defects surfaced and fixed on the way: `binary_tests` had NEVER been able to run a multi-word `test_command` (passed to `timeout` as one argv token — every grade 0), and JS regexes reject inline `(?i)` (use the grader's `flags` param).

Workflow: `Workflows/RunAblation.md`.

---
