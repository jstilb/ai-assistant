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

The Eval Lab (compare harnesses, models and setup pieces) moved on 2026-10-23 to `~/projects/eval-lab` (private GitHub `[user]/eval-lab`). Kaya keeps its own nightly evals and the setup-ablation tool.

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

## Graders, Fixture-Net Pattern

The code-based graders (6), the model-based graders (4) and the fixture-net pattern for live classifier baselines are in `references/GradersAndFixtureNet.md`. Read it when you choose a grader or build a baseline.

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

## Key Suites, Task Schema

The list of key suites and the task YAML schema are in `references/SuitesAndTaskSchema.md`. Read it when you add or edit a suite or a task.

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

## Weekly Eval-Health Digest & Regression Alerting, Setup Ablation

The weekly digest, regression alerting and the setup ablation (clean vs full vs component-ablated, across models) are in `references/DigestAndAblation.md`. For an ablation run, also read `Workflows/RunAblation.md`.

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
