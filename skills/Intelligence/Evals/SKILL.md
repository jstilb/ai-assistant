---
name: Evals
description: Agent eval framework. USE WHEN eval, evaluate, test agent, benchmark, verify behavior, regression test, capability test. Code and model graders, transcript capture, pass@k metrics.
implements: Science
science_cycle_time: meso
Uses: []
Feeds Into: [AgentMetacognition]
---

# Evals - AI Agent Decision Evaluation Framework

Evaluates agent *decision quality* — not formatting, not single outputs. Every eval is linked to a documented production failure mode with a clear WHY.

---

## When to Activate

- "run evals", "test this agent", "evaluate", "benchmark", "regression test"
- Validate agent decision-making before deployment
- Create new evaluation tasks from failures

---

## Workflow Routing

| Trigger | Action |
|---------|--------|
| "run evals", "evaluate suite" | `Tools/EvalExecutor.ts suite --name <suite>` |
| "run single eval" | `Tools/EvalExecutor.ts run --task <task.yaml>` |
| "smoke test" (validate configs, no execution/no cost) | `Tools/EvalExecutor.ts smoke --name <suite>` |
| "manage suites" | `Tools/SuiteManager.ts list` / `show <name>` |
| "check for regressions" | `Tools/RegressionAlert.ts check <suite>` |
| "browse past results / transcripts" | `Tools/TranscriptViewer.ts list` / `view <task-id>` / `summary` |
| "compare clean vs our setup", "ablate CLAUDE.md/skills/hooks", "does the new model still need X", "A/B a config change" | `Tools/Ablation/AblationRunner.ts run --suite setup-ablation --profiles clean,full,... --models ...` (see "Setup Ablation" below) |
| "try a config profile by hand" | `Tools/Ablation/ProfileBuilder.ts build --profile <name>` → `CLAUDE_CONFIG_DIR=<dir> claude` |

---

## Core Concepts

| Concept | Description |
|---------|-------------|
| **Code-based graders** | Fast, deterministic — string/regex match, tool-call verification, test-suite pass/fail, filesystem state, fixture-runner accuracy |
| **Model-based graders** | Nuanced, LLM-powered — rubric scoring, assertion checking, ensemble labeling, static-record judging |
| **Capability eval** | `type: capability` — measures improvement potential; lower bar |
| **Regression eval** | `type: regression` — quality gate against backsliding; every task and every suite in the live corpus is pinned at `pass_threshold: 0.80` |
| **pass@k** | Trial-level: did at least one trial pass (`TrialRunner.calculatePassAtK`) |
| **pass^k** | Trial-level: fraction of trials that passed (`TrialRunner.calculatePassToK`) |
| **Suite-level pass** | A task "passes in a suite" only when `pass_rate === 1` — ALL of its (behavioral, non-infra-failed) trials cleared their own `pass_threshold` (`EvalExecutor.taskPassedInSuite()`, evals-rebuild slice B1) |

---

## Graders

Ten grader types are registered (`Graders/Base.ts`'s live registry — run `Tools/EvalExecutor.ts list-graders` to confirm at any time).

### Code-Based (6)
| Type | What it does |
|------|--------------|
| `string_match` | Exact substring matching |
| `regex_match` | Pattern matching |
| `binary_tests` | Runs a test command, checks exit code |
| `state_check` | Verifies filesystem/system state after execution |
| `tool_calls` | Verifies required/forbidden/sequenced tool calls |
| `fixture_accuracy` | Grades a JSON record a live fixture-runner already wrote (see "Fixture-Net Pattern" below) — never reads agent output |

### Model-Based (4)
| Type | What it does |
|------|--------------|
| `llm_rubric` | Scores a detailed rubric against transcript + tool results |
| `natural_language_assert` | Checks a list of plain-language assertions against agent output |
| `ensemble_label` | Consensus labeling via parallel fast/standard/smart inference calls; divergence is flagged, not averaged away |
| `nightly_judge` | Static-input grader: scores a **pre-existing** decision record (from a live system path — `autoinfo`, `spec-pipeline`, `work-queue`, `live-verification`) against a golden label. Never spawns a live agent turn. |

Judgment-style quality is graded by `natural_language_assert` (evals-rebuild slice B2, Jm's ruling R1 — no deterministic word-count/regex gate) — see `UseCases/DailyBriefing/dailybriefing_no_fabricated_numbers.yaml`. (The voice-line task was retired 2026-09-29 when CLAUDE.md's response format was removed.)

`nightly_judge`, `natural_language_assert`, and `llm_rubric` (plus `RegressionAlert.ts`'s and `EvalHealthDigest.ts`'s own judges) share one structured judge protocol (`Graders/JudgeProtocol.ts`, evals-rebuild slice B1): `expectJson: true` + zod validation on the response + an always-present `reasoning` field, fail loud on a malformed/unparseable judge reply — never a silent score-0 default. `ensemble_label` sits outside this migration — it predates `JudgeProtocol.ts` and is in fact the grader `JudgeProtocol.ts` was modeled on (per `JudgeProtocol.ts`'s own docblock: "mirrors the ONE grader that already did this right — EnsembleLabelGrader"); it calls `inference({expectJson: true})` directly with its own vote/abstention semantics, has no `reasoning` field on its consensus-pass path, and folds per-member inference failures into abstentions rather than failing loud (`Graders/ModelBased/EnsembleLabel.ts`).

---

## Fixture-Net Pattern (live classifier baselines)

Two tasks (`kaya_capture_routing`, `kaya_learning_capture`) baseline a real production classifier against a golden fixture set — proving an LLM judgment call is safe to replace a regex/heuristic gate BEFORE that gate is deleted (the determinism-remediation "let-the-model-speak" doctrine's S0 step).

The split that makes this cheap and honest:
- **The RUNNER makes the live call.** Each task's `setup_commands` shells out to a dedicated fixture-runner script (`Tools/CaptureRoutingFixtureRunner.ts`, `Tools/LearningCaptureFixtureRunner.ts` — CLI shape `--fixtures <path.jsonl> --out <path.json>`, sharing load/write plumbing via `Tools/FixtureRunnerShared.ts`). It reads a JSONL fixture file from `Data/golden/*-fixtures.jsonl`, calls the REAL production classifier (e.g. `Router.classify()`) or a real `inference()` call once per fixture, and writes a JSON summary (`{ accuracy, total, correct, results }`) to `MEMORY/EVALS/live-fixture-runs/<name>.json`.
- **The `fixture_accuracy` GRADER only reads the record.** `Graders/CodeBased/FixtureAccuracy.ts` reads `params.record_path` (the file the runner just wrote) — it never touches `context.output` or `context.transcript` (`readsOutput = false`). A missing file, malformed JSON, or `total === 0` all score 0/fail — there's no path to a trivial pass.

This is distinct from `nightly_judge`'s fully-static pattern (reads a pre-existing decision record from a live system path — no per-run classification happens at all). Fixture-net tasks are "live per run, but the live work is invisible to the grader"; `nightly_judge` tasks are "static every run."

Adding a 4th net: new runner script (reuse `FixtureRunnerShared.ts`) + new `Data/golden/*.jsonl` + new task YAML (`setup_commands` calls the runner, `fixture_accuracy` grader reads its `record_path`) + one line in the target suite's `tasks:` list.

---

## Live-Agent-Spawn Skip

`EvalExecutor.ts`'s `executeTask()` only spawns a live `claude -p` subprocess when at least one configured grader on the task actually needs to read `context.output`/`context.transcript` (`Graders/Base.ts`'s `anyGraderReadsOutput()`, checked per grader class's declared `readsOutput` — never a hand-maintained list of task IDs or grader types). Fixture-net and `nightly_judge` tasks — whose real work already happened in `setup_commands` or a prior system run — skip the agent spawn entirely and use a placeholder output, avoiding a wasted agent turn (evals-rebuild slice A1; the incident this fixed cost roughly $4.67 in wasted agent spend per nightly run before the fix — see `MEMORY/SkillAudits/evals-infra-audit-2026-07-09/fixtures.md`).

---

## Destructive-Scenario Guard

Before any `setup_commands` run or agent spawns, `Tools/DestructiveScenarioGuard.ts` scans the task's (possibly `sandbox_paths`-rewritten) `scenario_prompt` and `setup_commands` for a destructive verb (`rm -r`/`-rf`, `git reset --hard`, `git push --force`, `DROP TABLE`/`DATABASE`, `mkfs`, redirect-to-`/dev/`, `truncate`, "delete everything in") combined with a real absolute path that resolves outside the trial's sandbox. A match refuses the task before anything executes, landing as a real, countable trial failure — never laundered into an infra-failure exclusion. A task that legitimately needs to operate on a real path declares `setup.sandbox_paths` (a real-path → `'copy'` mapping); the executor materializes a sandbox copy first and rewrites literal occurrences of the real path in the prompt/commands to point at the copy, so the guard only ever sees the in-sandbox copy. See `Tools/DestructiveScenarioGuard.ts`'s module doc for the incident this guards against.

---

## Golden-Fixture-Before-Deletion Doctrine

Before a deterministic grader/rule is deleted in favor of pure LLM judgment, its replacement rubric must be proven against a frozen golden fixture set FIRST — never the reverse (never loosen a fixture's expected verdict to match a judge that got it wrong). Artifacts:
- `Data/golden/*.jsonl` — 9 frozen fixture sets (capture-routing, clarity-verdict, isc-extraction, isc-quality, judge-calibration-cases, learning-capture, research-verdict, router-disposition, verifier-accuracy).
- the `scripts/label-*.ts` scripts — re-runnable proof scripts (real inference calls, real money, run on demand — never a permanent `bun test` gate) that load a rubric/task YAML LIVE and check it against every fixture in the matching `Data/golden/*.jsonl` file before a predecessor grader is allowed to be deleted.

---

## Key Suites

Behavioral/security/honesty coverage was retired in evals-rebuild slice A3b (Jm's ruling R3) — three suites survive, 15 tasks total:

| Suite | Type | Tasks | Threshold | Focus |
|-------|------|-------|-----------|-------|
| `kaya-pipeline-nightly` | regression | 12 | 0.80 | Nightly sample of de-determinized pipeline decisions (router/clarity/research/ISC/verifier/judge) + 2 S0 fixture-net/LLM canaries (capture-routing, learning-capture) |
| `kaya-pipeline-dedeterminization` | regression | 1 | 0.80 | LLM judges replacing deleted regex/heuristic gates in the spec pipeline |
| `eventscout-markdown-first` | regression | 3 | 0.80 | Agent-resolved NL/classification judgments in EventScout's query/booking/age-gate pipeline |

Every task YAML in the corpus also sets its own `pass_threshold: 0.80` (verified: `grep -rn "^pass_threshold:" UseCases/` — all 15 agree with the 3 suite-level thresholds).

---

## Task Schema

```yaml
# WHY: [Production failure mode + incident count]
id: task_id_here
description: "What this eval measures"
type: regression  # or capability
domain: coding    # coding | conversational | research | computer_use | general
setup:
  scenario_prompt: "The prompt given to the agent"
  setup_commands:  # Optional: create fixture files, or run a live fixture-runner
    - "mkdir -p /tmp/fixture && echo 'content' > /tmp/fixture/file.ts"
  sandbox_paths:   # Optional escape hatch for the destructive-scenario guard
    "/real/path": copy
graders:
  - type: tool_calls
    weight: 0.50
    params:
      required: [{ tool: Bash }]
  - type: natural_language_assert
    weight: 0.50
    params:
      assertions: ["Agent provides evidence of verification"]
trials: 3
pass_threshold: 0.70
```

Validated at load time against one shared zod schema (`Types/schemas.ts`'s `TaskSchema`) — the single source of truth used by `EvalExecutor.loadTaskConfig`, `SuiteManager.loadSuite`, and `TaskValidator.validateTask`. An invalid task fails loud, naming the file and every schema violation — never a silent partial load.

---

## CLI Tools

| Tool | Purpose | Key Commands / Flags |
|------|---------|-----------------------|
| `EvalExecutor.ts` | Core execution engine — run tasks/suites, validate configs, list graders | `run --task <yaml>`, `suite --name <suite> [--quick] [--sample N]`, `smoke --name <suite>`, `list-graders` |
| `SuiteManager.ts` | Suite loading, listing, creation | `list [type]`, `show <name>`, `create <name> -d "..."`, `add-task <suite> <task>` |
| `TaskValidator.ts` | Standalone task YAML schema validation | `--all`, `--file <path>`, `--suite <name>` |
| `RegressionAlert.ts` | Delta-vs-baseline + tripwire regression detection, LLM-classified (real regression vs. noise vs. known-flake vs. environmental) | `check <suite> [--last N] [--threshold 0.10] [--max-age-hours 48]` |
| `EvalHealthDigest.ts` | Weekly LLM-written trend digest over `MEMORY/VALIDATION/evals/` | `[--days 7]` (no subcommand) |
| `TranscriptViewer.ts` | Browse/inspect past `Results/` runs and transcripts from the terminal | `list [--task <id>] [--status pass\|fail]`, `view <task-id> [--trial N] [--format summary\|detail]`, `summary [--last N]` |
| `ResultsPersistence.ts` | Show where suite results are/would be written | `path <suite>` |
| `Ablation/AblationRunner.ts` | Suite × profiles × models matrix with deltas vs a baseline profile | `run --suite <s> --profiles a,b [--models m1,m2] [--baseline a] [--trials N] [--tasks ids] [--home path] [--without <sel>]... [--dry-run] [--resume id]`, `report --run <id>`, `list` |
| `Ablation/ProfileBuilder.ts` | Build/list config-dir profiles for the runner or for hands-on use (`CLAUDE_CONFIG_DIR=<dir> claude`) | `build --profile <name\|path\|json> [--out dir] [--home path]`, `build --without <sel>... [--base full\|clean] [--name n]`, `list` |

Full flag reference: `CLIReference.md`.

---

## Weekly Eval-Health Digest & Regression Alerting

Two Kaya-owned tools read `MEMORY/VALIDATION/evals/` (the append-only JSONL store `ResultsPersistence.ts` writes every suite run):

- **`RegressionAlert.ts check <suite>`** — two deterministic tripwires (store missing entirely; every task in the current run scored 0 pass rate) page immediately. Below that, a cheap per-task delta-vs-rolling-baseline check flags candidates, and each candidate is classified by an LLM judge given the task's full recent history (real regression vs. a one-off blip vs. a known-flake oscillation vs. an environmental/fixture cause) — never a bare threshold. Run nightly via `bin/kaya-evals-nightly.ts`'s STEP 2.
- **`EvalHealthDigest.ts`** — weekly, LLM-written digest (trends, regressions, "silent-red streaks" — 2+ consecutive 0-pass-rate runs — anomalies, cost/wall-time) delivered through `AlertGate` at `tier: 'digest'`. Writes a dated copy to `MEMORY/VALIDATION/evals/digests/<date>.md`.

Both fail loud (throw / page-tier alert) rather than silently producing an empty or fabricated result when the store is missing or the judge call fails — see each tool's module doc for the specific named incidents this replaced.

---

## Setup Ablation — clean vs full vs component-ablated, across models

**WHY:** every eval above runs against the LIVE `~/.claude`, so "how much of a score is the model vs. our CLAUDE.md / skills / hooks?" — and "does that still hold on the next model?" — had no mechanism. `Tools/Ablation/` is that mechanism (2026-09-04; Fable 5.1 tuning-review rec #4 "pilot de-prescribing via Evals A/B" runs on it).

**Unit of comparison = a profile**: a materialized Claude Code config directory that `claude -p` boots from via `CLAUDE_CONFIG_DIR` (live-verified: settings.json, CLAUDE.md, `skills/*/SKILL.md`, `commands/`, `agents/`, `plugins/`, `.claude.json` are all read from there and symlinks are followed; `--bare` was rejected because it forces API-key auth — no subscription OAuth). Components, each includable/removable: `claudemd` (with section / line-range / regex surgery against the ORIGINAL line numbering), `skills` (category or `Category/Child`), `commands`, `agents`, `hooks` (by event name or command substring), `env` (settings env keys — e.g. the `CLAUDE_CODE_EFFORT_LEVEL` pin), `plugins`, `mcp`, `memory` (a snapshot COPY, never the live dir). `base: full` mirrors the source home and `remove:` subtracts; `base: clean` is vanilla Claude Code and `include:` adds back. Built-ins live in `Profiles/*.yaml` (`clean`, `full`, `no-claudemd`, `no-skills`, `no-hooks`, `no-agents`, `no-memory`, `no-effort-pin`, `claudemd-no-principles`, `claudemd-only`, `claudemd-and-skills`); ad-hoc ones come from `--without`/`--with` selectors (`skills`, `skill:Intelligence/Evals`, `hooks`, `hook:LoadContext`, `env:KEY`, `claudemd`, `claudemd-section:<heading>`, `claudemd-lines:10-30`, `claudemd-matching:<regex>`, `commands`, `command:<n>`, `agents`, `agent:<n>`, `plugins`, `mcp`, `memory`). A selector that matches nothing FAILS the build (a typo'd ablation that silently removes nothing is a false experiment). Every profile dir carries a `PROFILE.json` manifest of exactly what was kept/dropped.

**Runner** (`Tools/Ablation/AblationRunner.ts run`): profiles × models, sequential cells, each cell = the SAME suite through the real `runSuite()` with `env.CLAUDE_CONFIG_DIR`, `--model`, `--no-session-persistence`, and `persist:false` — ablation cells never feed `MEMORY/VALIDATION/evals/` (RegressionAlert / EvalHealthDigest baselines). Output: `Results/ablations/<runId>/{matrix.json, report.md, cells/*.json, profiles/*}`; the report is re-rendered after every cell (a killed run leaves a usable partial matrix; `--resume <runId>` fills the gaps). `--home <path>` builds profiles from another checkout (a worktree branch vs. main). `--dry-run` builds the profiles and prints the plan, zero spawns.

**Suite** `setup-ablation` (5 cheap tasks, `UseCases/SetupAblation/`, deterministic graders, ~$0.05/task on haiku): `ablation_identity` (CLAUDE.md loaded at all — `clean` MUST fail, `full` MUST pass; if both pass the profile is leaking the live config, if both fail the model ignores CLAUDE.md — either way the matrix is invalid), `ablation_capture_routing_awareness` (the Capture Routing section), `ablation_skill_awareness` (skills/ loaded), `ablation_scope_discipline` (Guiding Principles: one-line fix + tempting legacy line untouched), `ablation_fix_failing_test` (raw coding capability — the model axis). Any other suite whose tasks spawn a live agent works too (`kaya-pipeline-nightly`'s fixture-net tasks skip the spawn and therefore cannot ablate anything).

First live matrix (2026-09-04, haiku, 1 trial): clean 1/5 (identity ❌, routing ❌, skills ❌) vs full 3/5 — the discrimination the sanity-check task demands. Two defects surfaced and fixed on the way: `binary_tests` had NEVER been able to run a multi-word `test_command` (passed to `timeout` as one argv token — every grade 0), and JS regexes reject inline `(?i)` (use the grader's `flags` param).

Workflow: `Workflows/RunAblation.md`.

---

## Resource Index

| Resource | Purpose |
|----------|---------|
| `Tools/EvalExecutor.ts` | Main execution engine — runs tasks and suites, guards, live-spawn skip |
| `Tools/TrialRunner.ts` | Multi-trial execution engine, pass@k/pass^k, infra-failure classification (structured signals only, never agent output text) |
| `Tools/SuiteManager.ts` | Suite loading/listing/creation |
| `Tools/TaskValidator.ts` | Standalone task schema validation CLI |
| `Tools/DestructiveScenarioGuard.ts` | Refuses destructive scenario prompts unless sandboxed; `sandbox_paths` materialization |
| `Tools/FixtureRunnerShared.ts` + `Tools/{CaptureRouting,LearningCapture}FixtureRunner.ts` | Fixture-net runner plumbing + the 2 live-classifier runner scripts |
| `Tools/TranscriptCapture.ts` | Capture agent trajectories (embedded in `Results/<task>/run_<id>.json`, no separate transcript store) |
| `Tools/TranscriptViewer.ts` | CLI for browsing `Results/` runs and transcripts |
| `Tools/ResultsPersistence.ts` | Persist suite results to `MEMORY/VALIDATION/evals/` (append-only JSONL) |
| `Tools/shared/ResultsUtils.ts` | Read the persisted JSONL store — `findSuiteRuns`/`loadRun`, used by `RegressionAlert.ts`/`EvalHealthDigest.ts` |
| `Tools/shared/TaskUtils.ts` | The real task id → file path index (`findTaskFile`) — never a filename guess |
| `Tools/RegressionAlert.ts` | Tripwires + LLM-classified regression detection |
| `Tools/Ablation/ProfileBuilder.ts` | Materialize a Claude Code config dir (profile) from a spec — clean/full base, per-component include/remove, CLAUDE.md surgery; `PROFILE.json` manifest; `build`/`list` CLI |
| `Tools/Ablation/AblationRunner.ts` | Run a suite across profiles × models via `CLAUDE_CONFIG_DIR`; matrix/attribution/per-task report under `Results/ablations/<runId>/` |
| `Profiles/*.yaml` | Built-in profile specs (`clean`, `full`, `no-*`, `claudemd-*`) |
| `UseCases/SetupAblation/` + `Suites/setup-ablation.yaml` | The 5-task component-isolation probe suite |
| `Tools/EvalHealthDigest.ts` | Weekly trend digest |
| `Types/schemas.ts` | Single source of truth zod schemas (`TaskSchema`, `EvalSuiteSchema`, `GraderConfigSchema`) |
| `Types/index.ts` | Re-exports the above as TS types |
| `Graders/Base.ts` | Grader registry, `runGraders()`, `readsOutput`/category bucketing |
| `Graders/JudgeProtocol.ts` | Shared structured judge-response contract (expectJson + zod) |
| `Graders/CodeBased/` | Deterministic graders |
| `Graders/ModelBased/` | LLM-powered graders |
| `Data/golden/*.jsonl` | Frozen fixture sets for the golden-fixture-before-deletion doctrine |
| `Data/DomainPatterns.yaml` | Domain → default grader stack fallback. Only reachable for a task with an empty `graders:` list — `TaskSchema` requires `graders.length >= 1`, so this path is currently unreachable for the entire kept corpus; kept for a hypothetical future task type. |

---

## Principles

1. **Every eval has a WHY** — linked to a documented production failure
2. **Measure decisions, not formatting** — what the agent chose to do, not how it looks
3. **Graders see tool results** — LLM judges verify what the agent actually read/executed
4. **Thresholds reflect expectations** — the entire live corpus is regression-strict (0.80)
5. **No phantom tests** — coding evals use real fixtures, not roleplay
6. **Rigor before deletion** — a rule slated for deletion gets a golden-fixture-proven eval FIRST, never after

---

## Examples

**Example 1: Run a regression suite**
```
User: "Run the nightly pipeline evals"
-> bun Tools/EvalExecutor.ts suite --name kaya-pipeline-nightly
-> Runs all 11 tasks with their configured trial counts
-> Reports pass@k and pass^k per task
-> Suite passes only if every scored task hit pass_rate === 1 (no infra-only-failed task can flip it)
```

**Example 2: Validate configs without spending money**
```
User: "Smoke test the eventscout suite"
-> bun Tools/EvalExecutor.ts smoke --name eventscout-markdown-first
-> Validates every task's YAML against TaskSchema + the live grader registry
-> Zero agent spawns, zero inference calls
```

## Customization

- **Suites**: `Suites/*.yaml` — add/remove tasks, adjust thresholds
- **Tasks**: `UseCases/**/*.yaml` — one file per eval case
- **Domain patterns**: `Data/DomainPatterns.yaml` — see the Resource Index caveat above (currently unreachable fallback)
- **Integration**: `AgentMetacognition` ingests failure patterns (the prior `SkillAudit` integration described here was removed 2026-07-31 along with the SkillAudit skill — see `plans/audits/remediation/theme3-createskill-evalsplit-skillaudit.md`; it hadn't fired since SkillAudit went dormant 2026-03-27)
