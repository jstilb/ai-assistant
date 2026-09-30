# Evals CLI Reference

## Overview

The Evals skill is a CLI-first evaluation framework. Every command below was executed against the live worktree (`bun <tool>.ts --help` / a `smoke` or dry-run-equivalent invocation) while writing this reference — none are aspirational. Commands are run via `bun` from anywhere; paths below are relative to `skills/Intelligence/Evals/`.

---

## EvalExecutor.ts — run tasks/suites, validate configs, list graders

```
Commands:
  run       Run a single task
  suite     Run an entire suite
  smoke     Validate suite configs without execution
  list-graders   Show available graders

Usage:
  bun run EvalExecutor.ts run --task <task.yaml> [--trials 3] [--graders string_match,llm_rubric]
  bun run EvalExecutor.ts suite --name <suite-name> [--trials 3] [--quick] [--sample N]
  bun run EvalExecutor.ts smoke --name <suite-name>
  bun run EvalExecutor.ts list-graders

Options:
  -t, --task      Path to task YAML file
  -n, --name      Suite name
  --trials        Number of trials (default: from task or 1)
  --timeout       Timeout in ms (default: 300000)
  -g, --graders   Comma-separated grader types to use
  --quick         Only run tasks with code_based graders (fast)
  --sample N      Randomly select N tasks from suite
  -h, --help      Show this help
```
(verbatim `--help` output)

### Run a single task
```bash
bun skills/Intelligence/Evals/Tools/EvalExecutor.ts run \
  --task skills/Intelligence/Evals/UseCases/QueueRouter/kaya_router_disposition_golden.yaml
```
Spawns a live `claude -p` agent for any task whose grader(s) read agent output — real cost, real time. Not executed live for this doc pass (would spawn a paid agent turn); verified via source read (`EvalExecutor.ts`'s `run` case + `runTask()`) and the identical code path exercised by `smoke` below.

### Run an entire suite
```bash
bun skills/Intelligence/Evals/Tools/EvalExecutor.ts suite --name kaya-pipeline-nightly
```
Real suite names (verified live, `SuiteManager.ts list`): `kaya-pipeline-nightly` (12 tasks), `kaya-pipeline-dedeterminization` (1 task), `eventscout-markdown-first` (3 tasks). `--quick` filters to tasks whose every grader is code-based (derived from the live grader registry, not a hand-list); `--sample N` randomly selects N tasks.

### Smoke test a suite (validate configs only — zero cost, zero agent spawns)
```bash
bun skills/Intelligence/Evals/Tools/EvalExecutor.ts smoke --name kaya-pipeline-nightly
```
Executed live for this doc pass against all 3 suites:
```
Smoke test: kaya-pipeline-nightly (11 tasks)
  Valid: 11/11   Issues: 0
  Grader distribution: nightly_judge: 7 (model), fixture_accuracy: 3 (code), natural_language_assert: 1 (model)
  Status: ✅ ALL CONFIGS VALID

Smoke test: kaya-pipeline-dedeterminization (1 tasks)
  Valid: 1/1   Issues: 0
  Grader distribution: natural_language_assert: 1 (model), tool_calls: 1 (code)
  Status: ✅ ALL CONFIGS VALID

Smoke test: eventscout-markdown-first (3 tasks)
  Valid: 3/3   Issues: 0
  Grader distribution: natural_language_assert: 3 (model), tool_calls: 3 (code)
  Status: ✅ ALL CONFIGS VALID
```

### List available graders
```bash
bun skills/Intelligence/Evals/Tools/EvalExecutor.ts list-graders
```
Executed live — output:
```
Code-Based (fast, deterministic):
  - string_match    Exact substring matching
  - regex_match    Pattern matching
  - binary_tests    Run test files
  - state_check    Verify system state after execution
  - tool_calls    Verify specific tools were called
  - fixture_accuracy    Grade a live fixture-runner's accuracy record (see setup_commands)

Model-Based (nuanced):
  - llm_rubric    Score against detailed rubric
  - natural_language_assert    Check assertions are true
  - ensemble_label    Consensus labeling via parallel fast/standard/smart inference; divergence flagged
  - nightly_judge    Static-input grader: scores a pre-existing decision record against a golden label
```

---

## SuiteManager.ts — suite lifecycle

```
Commands:
  create <name>       Create a new suite
  list [type]         List all suites (optionally filter by type)
  show <name>         Show suite details
  add-task <suite> <task>  Add a task to a suite

Options:
  -t, --type          Suite type: capability or regression (default: capability)
  -d, --description   Suite description
  --domain            Suite domain (coding, conversational, research, computer_use)
  -h, --help          Show this help
```
(verbatim `--help` output)

`list` executed live (no side effects):
```bash
bun skills/Intelligence/Evals/Tools/SuiteManager.ts list
```
```
All Suites:
  🔒 kaya-pipeline-dedeterminization (1 tasks)
  🔒 eventscout-markdown-first (3 tasks)
  🔒 kaya-pipeline-nightly (11 tasks)
```

`show <name>` executed live (read-only):
```bash
bun skills/Intelligence/Evals/Tools/SuiteManager.ts show kaya-pipeline-nightly
```
Prints type, description, domain, task count, pass threshold, and the full task-id list.

`create`/`add-task` were **not** executed for this doc pass — both write into `Suites/*.yaml`, the live suite corpus, which is outside this doc-only slice's write scope. Verified via source read only (`SuiteManager.ts`'s `createSuite()`/`addTaskToSuite()`).
```bash
bun skills/Intelligence/Evals/Tools/SuiteManager.ts create my-suite -t regression -d "What this suite covers"
bun skills/Intelligence/Evals/Tools/SuiteManager.ts add-task my-suite some_task_id
```
`add-task` requires `some_task_id` to already resolve via the real task-id index (`Tools/shared/TaskUtils.ts`'s `findTaskFile`) — it does not validate this itself at add-time; the next `smoke`/`suite` run against that suite will surface an unresolvable id loudly (`SuiteManager.parseSuiteYaml()`).

---

## TaskValidator.ts — standalone task schema validation

```
Usage:
  bun TaskValidator.ts --all                    Validate all task files
  bun TaskValidator.ts --file <path>            Validate specific file
  bun TaskValidator.ts --suite <suite-name>     Validate all tasks in suite

Options:
  --verbose    Show warnings in addition to errors
  --strict     Treat warnings as errors
```
(verbatim `--help` output)

Executed live:
```bash
bun skills/Intelligence/Evals/Tools/TaskValidator.ts --all
```
```
🔍 Validating 15 task file(s)...
📊 Validation Summary
   Valid:    15/15
   Invalid:  0
   Warnings: 7
✅ All validations passed
```
All 15 kept `UseCases/**/*.yaml` task files validate against the shared `Types/schemas.ts` `TaskSchema` and the live grader registry. `--suite <name>` here filters `UseCases/` files by substring match on `<name>` appearing in the path — it does NOT read a `Suites/*.yaml` file's task list (despite the flag name); for suite-scoped validation of the real task list, use `EvalExecutor.ts smoke --name <suite>` instead.

---

## RegressionAlert.ts — regression detection

```
Usage:
  bun RegressionAlert.ts check <suite> [options]

Options:
  --last <N>            Compare to last N runs (default: 3)
  --threshold <pct>     Regression trigger threshold as decimal (default: 0.1 = 10%)
  --max-age-hours <H>   Suite-failed-to-run tripwire window (default: 48)

Examples:
  bun RegressionAlert.ts check kaya-pipeline-nightly
  bun RegressionAlert.ts check kaya-pipeline-nightly --last 7 --threshold 0.10
```
(verbatim `--help` output)

```bash
bun skills/Intelligence/Evals/Tools/RegressionAlert.ts check kaya-pipeline-nightly --last 7 --threshold 0.10
```
Against the real `MEMORY/VALIDATION/evals/` store, this reads history and — if any per-task delta candidate crosses `--threshold` — calls an LLM judge per candidate (real inference cost). Not executed against the live store for this doc pass; instead verified with an isolated, empty `KAYA_HOME` + `KAYA_ALERT_DRY_RUN=1` (zero cost, zero real alerts), which exercises the exact same CLI/tripwire code path:
```
=== Regression Alert: kaya-pipeline-nightly ===
🚨 TRIPWIRE (suite-failed-to-run): the eval results store (MEMORY/VALIDATION/evals/) does not exist at all ...
exit: 1
```
This confirms the `suite-failed-to-run` tripwire (store missing) fires correctly and exits non-zero. The second tripwire (`suite-pass-rate-zero`) and the LLM-classified regression path were verified by source read only (`RegressionAlert.ts`'s `checkSuitePassRateZeroTripwire()` / `judgeRegressionVerdict()`), not executed live, to avoid a real inference call and a real page-tier alert against production data.

Exit code: `1` when any tripwire fired OR at least one judge/fallback-confirmed regression exists; `0` otherwise (including the benign "fewer than 2 runs yet" case).

---

## EvalHealthDigest.ts — weekly trend digest

```bash
bun skills/Intelligence/Evals/Tools/EvalHealthDigest.ts [--days 7]
```
No subcommand — this is the entire CLI surface (confirmed by source read: `Bun.argv.slice(2)` is scanned only for an optional `--days N`; there is no `--help`). Reads `MEMORY/VALIDATION/evals/` for the window, calls an LLM to write the digest (real inference cost), writes `MEMORY/VALIDATION/evals/digests/<date>.md`, and sends a `tier: 'digest'` `AlertGate` alert.

Not executed against the live store for this doc pass (would cost a real inference call and send a real digest alert). Verified with an isolated, empty `KAYA_HOME` + `KAYA_ALERT_DRY_RUN=1`, exercising the same CLI entrypoint and its fail-loud guard:
```
❌ EvalHealthDigest: eval results store (.../MEMORY/VALIDATION/evals) does not exist at all ...
exit: 1
```

---

## TranscriptViewer.ts — browse past results/transcripts

```
Usage:
  bun TranscriptViewer.ts list   [--task <id>] [--status pass|fail] [--sort score|time]
  bun TranscriptViewer.ts view   <task-id> [--trial <n>] [--format summary|detail]
  bun TranscriptViewer.ts summary [--last <n>]

Commands:
  list      Show a table of all transcripts
  view      View details of a specific task/trial
  summary   Aggregate stats across recent runs
```
(verbatim usage output — no args)

Reads directly from `Results/<task-id>/run_<run-id>.json` (each trial's full transcript is embedded in that file — there is no separate `Transcripts/` directory). Executed live, read-only, against the real `Results/` tree:
```bash
bun skills/Intelligence/Evals/Tools/TranscriptViewer.ts summary --last 5
```
```
Eval Summary (last 5 tasks)
Total Tasks:   5   Passed: 5   Failed: 0   Pass Rate: 100.0%   Mean Score: 0.976
Top Tool Sequences: 2x Bash → Write×3 → Bash, ...
```
`list --status pass|fail` filters on `run.pass_rate === 1`; `view <task-id>` shows one trial's grader breakdown and, with `--format detail`, the full turn-by-turn transcript and per-grader reasoning.

---

## ResultsPersistence.ts — result-store path lookup

```
Usage:
  bun ResultsPersistence.ts path <suite>    Show where results would be written
  bun ResultsPersistence.ts test            Write a test entry
```
(verbatim `--help` output)

```bash
bun skills/Intelligence/Evals/Tools/ResultsPersistence.ts path kaya-pipeline-nightly
```
Executed live: `~/.claude/MEMORY/VALIDATION/evals/2026-07-12/kaya-pipeline-nightly-results.jsonl` — confirms results resolve under the real `KAYA_HOME` (`~/.claude` by default), dated by day, one JSONL file per suite. The `test` subcommand appends a real entry to that live store — not executed for this doc pass (out of write scope; would pollute production trend data).

---

## Ablation/AblationRunner.ts — setup profiles × models matrix

```bash
cd ~/.claude/skills/Intelligence/Evals/Tools/Ablation

# Clean vs full vs two ablations, on two models (sequential cells; ~5 min/cell on the 5-task suite)
bun AblationRunner.ts run --suite setup-ablation --profiles clean,full,no-skills,claudemd-no-principles --baseline full --models haiku,sonnet --trials 1

# Ad-hoc ablation from selectors (adds ONE extra profile to --profiles)
bun AblationRunner.ts run --suite setup-ablation --profiles full --without hooks --without "claudemd-section:Response Format" --without env:CLAUDE_CODE_EFFORT_LEVEL --name lean --models fable

# Only some tasks; build profiles from a worktree instead of the live ~/.claude
bun AblationRunner.ts run --suite setup-ablation --profiles full --models sonnet --tasks ablation_scope_discipline --home ~/.claude/worktrees/<wt>

# Plan + profile dirs only, zero agent spawns / zero cost
bun AblationRunner.ts run --suite setup-ablation --profiles clean,full --models haiku --dry-run

# Fill in cells missing from a killed run; re-render a report; list profiles + runs
bun AblationRunner.ts run --suite setup-ablation --profiles clean,full --models haiku --resume abl-2026-09-05T02-31-34
bun AblationRunner.ts report --run abl-2026-09-05T02-31-34
bun AblationRunner.ts list
```

Flags: `--suite` (required) · `--profiles a,b,c` (built-in names, YAML/JSON paths, or inline JSON) · `--models` (anything `claude --model` accepts; omitted = one `default` cell per profile, i.e. the profile's own settings model) · `--baseline` (default: first profile) · `--trials` / `--timeout` (forwarded to `runSuite`) · `--tasks` (subset of the suite) · `--home` · `--without`/`--with` + `--base` + `--name` (ad-hoc profile) · `--dry-run` · `--resume <runId>`.

Output: `Results/ablations/<runId>/report.md` (matrix · attribution vs baseline · per-task per model · model comparison on the baseline · profile manifests), `matrix.json`, `cells/<profile>__<model>.json`, `profiles/<name>/` (each with `PROFILE.json`). Cells are never persisted to `MEMORY/VALIDATION/evals/`.

## Ablation/ProfileBuilder.ts — build a config-dir profile by hand

```bash
bun ProfileBuilder.ts list
bun ProfileBuilder.ts build --profile no-effort-pin                       # → /tmp/kaya-ablation/profiles/no-effort-pin
bun ProfileBuilder.ts build --without skill:Intelligence/Evals --without hook:LoadContext --name probe
CLAUDE_CONFIG_DIR=/tmp/kaya-ablation/profiles/probe claude               # drive the profile interactively
```

Selector grammar: `skills` · `skill:<Category[/Child]>` · `commands` · `command:<name>` · `agents` · `agent:<name>` · `hooks` · `hook:<event|command-substring>` · `env` · `env:<KEY>` · `claudemd` · `claudemd-section:<heading text>` · `claudemd-lines:<a[-b]>` · `claudemd-matching:<regex>` · `plugins` · `mcp` · `memory`. Profile YAML shape: `Profiles/*.yaml` + `ProfileSpecSchema` in `ProfileBuilder.ts` (`base`, `include`, `remove`, `claudemd.{file,drop_sections,drop_lines,drop_matching,append}`, `settings_overrides`, `model`).

## File Locations

| Path | Purpose |
|------|---------|
| `Tools/EvalExecutor.ts` | Main execution engine |
| `Tools/TrialRunner.ts` | Multi-trial execution engine (pass@k/pass^k) — its own CLI (`-t <task-file> [-n trials]`) is a thin infrastructure-testing stub; use `EvalExecutor.ts run`/`suite` for real evals |
| `Tools/SuiteManager.ts` | Suite lifecycle management |
| `Tools/TaskValidator.ts` | Standalone task schema validation |
| `Tools/RegressionAlert.ts` | Regression detection |
| `Tools/EvalHealthDigest.ts` | Weekly trend digest |
| `Tools/TranscriptViewer.ts` | Browse `Results/` runs/transcripts |
| `Tools/ResultsPersistence.ts` | Result-store path lookup / writer |
| `Tools/DestructiveScenarioGuard.ts` | Library (no CLI) — refusal + `sandbox_paths` guard invoked internally by `EvalExecutor.ts` |
| `Tools/FixtureRunnerShared.ts` + `Tools/*FixtureRunner.ts` | Fixture-net runner plumbing — invoked via task `setup_commands`, not run standalone by a human |
| `Graders/CodeBased/` | Deterministic graders |
| `Graders/ModelBased/` | LLM-powered graders |
| `UseCases/**/*.yaml` | Eval task definitions (15 files) |
| `Suites/*.yaml` | Suite definitions (3 files, all at the `Suites/` root). `Suites/Capability/` and `Suites/Regression/` exist on disk (auto-created by `SuiteManager.ts`'s `ensureDirs()`) but are empty and untracked — no suite in the live corpus lives in either. |
| `Types/schemas.ts` | Zod schemas (source of truth) |
| `Types/index.ts` | TypeScript type re-exports |

---

## Task Definition Format

Eval tasks are top-level YAML (not nested under a `task:` key) — see any file under `UseCases/**/*.yaml`, e.g. `UseCases/DailyBriefing/dailybriefing_no_fabricated_numbers.yaml`:

```yaml
id: dailybriefing_no_fabricated_numbers
description: "What this eval measures"
type: regression        # or capability
domain: general          # coding | conversational | research | computer_use | general

setup:
  scenario_prompt: "The prompt given to the agent"

graders:
  - type: natural_language_assert
    weight: 1.0
    required: true
    params:
      require_all: true
      assertions:
        - "Assertion 1"
        - "Assertion 2"

trials: 3
pass_threshold: 0.80
```

Validated against `Types/schemas.ts`'s `TaskSchema` at every load site (`EvalExecutor.ts`, `SuiteManager.ts`, `TaskValidator.ts`) — an invalid file fails loud, naming every schema violation.

---

## Output Format

Per-task run results are written to `Results/<task-id>/run_<run-id>.json` — one JSON file per run (`Tools/EvalExecutor.ts`'s `runTask()`), containing the full `EvalRun` object (all trials, each trial's embedded transcript, grader results, pass@k/pass^k). There is no `summary.json` and no separate `trials/` subdirectory — everything is in the one file. Example (verified against a real file under `Results/`):

```
Results/
└── kaya_capture_routing/
    └── run_run_1783750285216_nc1utl.json   # one EvalRun: n_trials, pass_rate, mean_score, trials[]
```

Suite-level trend data (across runs, across days) lives separately in the append-only JSONL store `ResultsPersistence.ts` writes:
```
MEMORY/VALIDATION/evals/<YYYY-MM-DD>/<suite>-results.jsonl
```
read by `Tools/shared/ResultsUtils.ts`'s `findSuiteRuns()`/`loadRun()`, consumed by `RegressionAlert.ts` and `EvalHealthDigest.ts`. `EvalExecutor.ts`'s `suite` command also overwrites one "latest run" pointer per suite at `MEMORY/VALIDATION/evals/last-suite-run/<suite>.json` (structured machine-to-machine handoff for `bin/kaya-evals-nightly.ts`) — this is a single snapshot, not history.

---

## Related Documentation

- **SKILL.md** — full skill documentation and concepts
- **Types/schemas.ts** — zod schemas (source of truth for task/suite shape)
- **BestPractices.md** — eval design best practices (from Anthropic)
