---
name: SpecSheet
description: Library backing the automated spec-generation pipeline (QueueRouter/SpecPipelineRunner) and the grill flow — screen-inventory parsing, UX/UI structural validation, GrillMe research directives. USE WHEN debugging spec-pipeline UX/UI gating, screen inventory coverage, or grill directive generation.
---

# SpecSheet — Spec-Pipeline Support Library

**As of 2026-07-02, the interactive `/specsheet` workflows (CreateSpec, QuickSpec,
SpecFromDescription, LucidTasksSpecSheet, AnalyzeSpec, IdealEndState, GroundedIdeal,
GenerateVisionDiagram, ValidateSpec, TestStrategy) are retired.** An audit found only
175 of this skill's ~6,385 markdown lines actually reached the live pipeline — the
rest was a parallel, disconnected interactive path. Spec generation for real work now
lives entirely in the automated **QueueRouter spec-pipeline**
(`skills/Automation/QueueRouter/Tools/SpecPipelineRunner.ts`); the grill/research
front end is the **grill flow** (`skills/Automation/QueueRouter/Workflows/GrillTask.md`).
See `/queuerouter` and `/grillme`.

## What Survives Here (live pipeline consumers)

| File | Consumer | Role |
|------|----------|------|
| `CONTEXT.md` | `SpecPipelineRunner.ts` (~L649, `SPECSHEET_CONTEXT_DOC`) | Read verbatim into UX/UI agent context bundles |
| `UXUISpecFormat.md` | `SpecPipelineRunner.ts` (~L648, `UXUI_FORMAT_DOC`) | Read verbatim into UX/UI agent context bundles |
| `Tools/GrillMeLens.ts` | `GrillTask.md` (QueueRouter) + `SpecPipelineRunner.ts` (lazy-imported for research-phase directives; failure is non-fatal) | Socratic lens directives for directed research |
| `Tools/ScreenInventory.ts` | `Tools/SpecValidator.ts` | Parses the Screen Inventory table; `coverageGaps` for structural checks |
| `Tools/UXUIStage.ts` | `SpecPipelineRunner.ts` (imported directly) | Pure gating/model/sequence rules for the UX/UI stage (surface gate, effort→model, review-on-Medium+) |
| `Tools/SpecValidator.ts` — `validateUXCompleteness`, `deriveBehavioralISC` | `SpecPipelineRunner.ts` (imported directly) | Structural screen×state coverage gate; renders GWT acceptance criteria as behavioral ISC rows |

`Workflows/CurrentWork.md` and `Workflows/GenerateHumanGuide.md` are interactive
workflows that remain (out of scope for this deletion sweep) — the former is still
routed to for ad hoc implementation-ready specs, the latter for human-procedure docs.
Both are separate from the automated pipeline above.

## What Was Deleted (2026-07-02)

Interactive spec workflows retired — spec generation for real work lives in the
QueueRouter pipeline now, not in interview-driven `/specsheet` chat commands.

Removed: `Workflows/{CreateSpec,QuickSpec,SpecFromDescription,LucidTasksSpecSheet,
AnalyzeSpec,IdealEndState,GroundedIdeal,GenerateVisionDiagram,ValidateSpec,
TestStrategy}.md`, `Tools/{SpecRouter,VisionSpecIndex}.ts`,
`Templates/VisionTiers/{GroundedIdeal,SolarpunkVision}.md`, and the always-pass
`validateUICompleteness` stub in `Tools/SpecValidator.ts` (its keyword checks had
already moved to the LLM spec-quality judge in `SpecPipelineRunner.judgeSpecQuality`).

## Pointers

- Automated spec generation: `/queuerouter`, `skills/Automation/QueueRouter/Tools/SpecPipelineRunner.ts`
- Grill / research front end: `/grillme`, `skills/Automation/QueueRouter/Workflows/GrillTask.md`
- UX/UI spec format reference: `UXUISpecFormat.md`
- ISC-ready implementation spec (still interactive): `Workflows/CurrentWork.md`

---

**Last Updated:** 2026-07-02
