# Pipeline UX/UI agents run as single-shot inference() with inlined context, not tool-capable claude -p spawns

The automated pipeline's UX/UI stage (`runUXUIStageForPipeline` in SpecPipelineRunner) spawned each designer step (UXDesigner → UIDesigner → Designer review) as a nested `claude -p --allowedTools Read,Glob,Grep` subprocess. After ADR 0002 (QueueRouter) removed the research spawn, this was the **last tool-capable nested spawn in the pipeline** — and tool-capable nested spawns hang when the pipeline runs from an interactive session (re-confirmed 2026-06-12; env hardening does not fix it; the auto-mode classifier blocks the spawn). The stage had never fired in production, so the defect was latent but guaranteed: the first browser/native item to reach spec-gen interactively would wedge.

The key observation: the designer agents used their tools *only* to self-read static Kaya-internal docs (`UXDesignerContext.md` → `UXUISpecFormat.md`, UXSpec/UISpec SKILL + Workflows + Templates/References). Generation is driven entirely by the spec text. So the decision is to inline those docs into the prompt script-side and run each step as a single-shot, tool-less `inference()` call — the same transport spec-gen already uses, which demonstrably works in every session type (`--tools ''`, hardened env, fd-redirected output).

Mechanics:

- `defaultSpawnSubagent` calls `inference()`; the previously informational-only `StageStep.model` is now wired (Opus → `smart`, Sonnet → `standard`), and the 8-minute per-step timeout is passed explicitly (inference level defaults — standard=90s — would otherwise spuriously kill generation steps).
- `buildUXUIAgentPrompt` assembles per-agent **context bundles** (`loadBundle`): `existsSync`-guarded reads with fallback paths for known-stale doc references, per-file char caps with visible `[... truncated ...]` markers, sections joined under `### <basename>` headers. Missing files are skipped, never fatal — the pure-text completeness gates (`validateUXCompleteness`/`validateUICompleteness`) remain the quality net.
- `SpawnSubagentFn` gains an optional `model` field — backward compatible with all existing test mocks.

## Considered Options

- **Harden the spawn env and keep tool access** — rejected: empirically refuted. Env hardening (OAuth token injection, nesting-var stripping) was re-tested 2026-06-12 on the research spawn and did not unblock interactive nested tool-capable spawns.
- **Restrict the pipeline to non-interactive (cron/autonomous) contexts only** — rejected: violates ADR 0004's interactive-first principle; `grill finalize` legitimately drives items through spec-gen (and thus this stage) from interactive sessions.
- **Partial inlining (inline the top-level Context.md, let the agent read the rest)** — rejected: still requires tools, so still hangs. The doc chain is static and small enough (~35–44KB capped per agent) to inline wholesale.
- **Modify the `*Context.md` files to be self-contained** — rejected: interactive workflows (CurrentWork.md Step 4d, CreateSpec.md Step 7.5) still read the doc chain from disk per ADR 0004. The bundles inline copies; the source docs are unchanged.

## Consequences

- **Zero tool-capable nested spawns remain in the spec pipeline.** Every LLM call is a single-shot `inference()` — the pipeline is interactive-safe end to end.
- The `*Context.md` files and the UXSpec/UISpec skill docs are unchanged and remain the single source of truth; the bundles are read at prompt-build time, so doc edits flow into the next pipeline run automatically.
- `StageStep.model` is now load-bearing: Large-effort items genuinely run Opus (`smart`) for generation, and the Designer review pass always does.
- Single-shot generation (no tool-assisted exploration) leans harder on the completeness gates. A gate failure bounces the item to `awaiting-context` with specific feedback — the clean-fail path replaces the hang.
- Known same-class defects elsewhere (out of scope here): `UpgradeTriage.ts:449` and `EditorialEngine.ts:290` still use unhardened nested spawns in other subsystems.
