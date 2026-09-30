# RunAblation Workflow

Answer "how much of this behavior is OUR setup vs. the model?" — compare a clean Claude Code against the full Kaya setup, ablate individual components (CLAUDE.md sections/lines, skills, hooks, env pins, agents, memory), and re-run the same matrix when a new model ships.

## Prerequisites

- A suite whose tasks spawn a live agent (`Suites/setup-ablation.yaml` is built for this; fixture-net / `nightly_judge` tasks skip the spawn and cannot ablate anything).
- Headless auth works: `buildHardenedClaudeEnv()` injects `CLAUDE_CODE_OAUTH_TOKEN` from `secrets.json` — profiles carry no credentials.
- Run from any cwd; paths below assume `~/.claude/skills/Intelligence/Evals/Tools/Ablation`.

## Execution

### Step 1: Pick or define the profiles

```bash
bun ProfileBuilder.ts list            # built-ins: clean, full, no-claudemd, no-skills, no-hooks, no-agents,
                                      #   no-memory, no-effort-pin, claudemd-no-principles,
                                      #   claudemd-only, claudemd-and-skills
```

Need something else? Either add `Profiles/<name>.yaml`:

```yaml
name: lean
description: "Full setup minus hooks, the Response Format block, and the effort pin"
base: full                    # full = mirror everything then `remove`; clean = nothing then `include`
remove:
  hooks: ["*"]                # or event names ("SessionStart") / command substrings ("LoadContext")
  env: [CLAUDE_CODE_EFFORT_LEVEL]
  skills: ["Intelligence/Evals"]   # category or Category/Child
claudemd:
  drop_sections: ["Response Format"]   # heading text, case-insensitive substring
  drop_lines: ["77"]                    # ORIGINAL 1-indexed line numbers, "a-b" ranges ok
  drop_matching: ["STORY EXPLANATION"]  # JS regex per line
  # file: path/to/alt-CLAUDE.md        # replace wholesale (also lets you A/B a rewrite)
  # append: "extra rule text"
settings_overrides: { model: sonnet }   # deep-merged last; null deletes a key
```

…or pass selectors ad hoc (adds ONE profile to the run): `--without hooks --without "claudemd-section:Response Format" --name lean`.

A selector that matches nothing fails the build loudly — fix the typo rather than trusting a no-op ablation.

### Step 2: Dry-run (free) — confirm the plan and eyeball a profile

```bash
bun AblationRunner.ts run --suite setup-ablation --profiles clean,full,lean --models haiku,fable --dry-run
cat Results/ablations/<runId>/profiles/lean/PROFILE.json | head -60
CLAUDE_CONFIG_DIR=$PWD/../../Results/ablations/<runId>/profiles/lean claude   # optional: drive it by hand
```

### Step 3: Run the matrix

```bash
bun AblationRunner.ts run --suite setup-ablation --profiles clean,full,lean --baseline full --models haiku,fable --trials 2
```

- Cells run sequentially (rate limits; fixture dirs are fixed paths). Budget ≈ tasks × trials × profiles × models spawns — the 5-task suite is ~$0.05/task on haiku, more on fable.
- Every finished cell is written immediately; a killed run keeps its partial `report.md`. Resume with `--resume <runId>`.
- Cells never persist to `MEMORY/VALIDATION/evals/` — RegressionAlert/EvalHealthDigest baselines are untouched.

### Step 4: Read the report

`Results/ablations/<runId>/report.md`:

1. **Matrix** — passed/scored · mean · cost · wall per profile × model.
2. **Attribution** — each profile's Δ vs the baseline profile on the same model. A component whose removal costs nothing on the new model is a candidate for deletion; one whose removal costs a lot is load-bearing.
3. **Per-task** — which specific behavior moved (identity/voice line, routing, skills, scope discipline, raw coding).
4. **Model comparison on the baseline** — "did the new model change the picture?"

Sanity check FIRST: `ablation_identity` must fail on `clean` and pass on `full`. Both passing = the profile is leaking the live config; both failing = the model is ignoring CLAUDE.md. Either way, stop and debug before reading anything else. Then discount any cell with `infra-skipped` tasks (spawn/auth failures — no behavioral signal) and `--resume` it.

### Step 5: Act — and keep the evidence

- Deleting/trimming a component: cite the run id + per-task table in the change's commit message or memory note.
- New model: re-run the SAME profiles with `--models <new>` and compare its baseline row to the old model's (`report --run` re-renders any past run).
- Testing a branch's CLAUDE.md/skills/hooks before merge: `--home ~/.claude/worktrees/<wt>` builds the profiles from that checkout.

## Adding ablation-sensitive tasks

A task earns a place in `setup-ablation` only if some named component should flip it. Prefer deterministic graders (`regex_match`, `state_check`, `binary_tests`, `tool_calls`) — LLM judges add cost per cell and noise across models. For file-state tasks use `isolation: none` + a fixed `working_dir` under `/tmp/kaya-ablation-fixtures/<task>` with `setup_commands` that overwrite the fixture every trial (sandbox trials delete their dir before graders run). Then `EvalExecutor.ts smoke --name setup-ablation`.

## Gotchas

- `binary_tests.test_command` is split on whitespace into argv (a 2026-09-04 fix — before that `"bun test"` was one token and every grade was 0).
- `regex_match` patterns are JS regexes: no inline `(?i)`; use `params.flags: "i"`.
- Nested `skills/<Category>/<Child>/SKILL.md` files are not discovered by Claude Code — only category-level `SKILL.md`. Removing a child changes what the category's routing can reach, not the skill list the model sees; `ablation_skill_awareness` checks category names for that reason.
- `--bare` is NOT the isolation mechanism (API-key auth only). `CLAUDE_CONFIG_DIR` is.
