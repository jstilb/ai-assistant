# ComprehensiveAudit — Single-Skill Full Audit

> Replaces: AuditSingle + DeepTechnicalAnalysis

## Trigger

- "audit [skill]"
- "evaluate [skill]"
- "review [skill]"
- "deep analysis of [skill]"

## Overview

Full 11-dimension evaluation of a single skill. Runs deterministic analyzers first (fast, no LLM), then inferential evaluators (require judgment), then synthesizes into a scored report with action items.

## Phase 1: Discovery (deterministic)

1. Run `SkillInventory.ts [SkillName]` — collect files, metrics, triggers, dependencies
2. Read all SKILL.md, workflow .md files, tool .ts files into memory
3. Load `skill-index.json` for cross-reference data (fallback: read SKILL.md files directly)
4. Load `settings.json` hooks configuration
5. Check `MEMORY/SkillAudits/` for prior audit reports on this skill

## Phase 2: Deterministic Analysis (parallel — 7 scoring analyzers)

Run all 7 scoring analyzers concurrently (SkillInventory runs in Phase 1 as foundation). No LLM calls. Fast.

| Analyzer | Dimension(s) Scored | What It Checks |
|----------|---------------------|----------------|
| `StructuralScorer.ts` | #2 Implementation Quality | SKILL.md, TitleCase, frontmatter, description, USE WHEN, examples, Customization, Voice Notification, Workflow Routing Table |
| `DependencyMapper.ts` | #3 Integration (partial) | Dependency graph, hub/leaf/isolated classification |
| `TriggerAnalyzer.ts` | #8 Context Routing | Jaccard similarity vs all other skills, overlap candidates |
| `DeadCodeDetector.ts` | #6 Code Hygiene | Unused exports, orphaned files, stale refs, TODO/FIXME, deprecated code outside `_DEPRECATED/` |
| `ContextCostAnalyzer.ts` | #5 Context Efficiency | Token count, trigger precision, description length |
| `ConventionChecker.ts` | #7 Refactoring Need | raw fetch(), raw JSON.parse(readFileSync()), `any` types, @ts-ignore |
| `RedundancyDetector.ts` | #6 Code Hygiene + #7 Refactoring | Code duplication, workflow overlap, internal trigger conflicts |

**Execution:**
```bash
# Run each analyzer and collect results
bun Tools/StructuralScorer.ts [SkillName] --json
bun Tools/DeadCodeDetector.ts [SkillName] --json
bun Tools/ContextCostAnalyzer.ts [SkillName] --json
bun Tools/ConventionChecker.ts [SkillName] --json
bun Tools/RedundancyDetector.ts [SkillName] --json
bun Tools/TriggerAnalyzer.ts --threshold 40
bun Tools/DependencyMapper.ts --format json
```

## Phase 2.5: Verify Deterministic Findings (inferential cross-check)

Before scoring, review each deterministic finding for false positives:

1. **Orphaned files** — For each flagged orphan, check if it's loaded via readFileSync(),
   join() paths, referenced in JSON config files, or consumed as data. Read the flagged file
   and nearby .ts files to confirm. Mark as FALSE POSITIVE if actually used.

2. **Stale references** — For each flagged stale ref, check if the file was moved
   (lib/core/, renamed, restructured). Check import statements in .ts files for the
   actual path. Mark as FALSE POSITIVE if the reference points to a real file.

3. **Convention violations** — For each raw JSON.parse(readFileSync()) flag, check if the
   file is read-only config (acceptable) vs mutable state (should use StateManager).
   Adjust severity accordingly.

Discard FALSE POSITIVE findings before Phase 5 scoring.

> **Note:** DeadCodeDetector now runs inferential verification by default (Phase 2 handles
> this automatically). This phase exists as defense-in-depth for when `--no-verify` is used
> or when other deterministic tools produce findings that need human-level judgment.

## Phase 3: Inferential Evaluation (uses Phase 2 data)

Spawn evaluator agents. Each receives the deterministic data + file contents.

| Evaluator | Dimension(s) Scored | Judgment Required |
|-----------|---------------------|-------------------|
| `BehaviorVerifier.ts` | #1 Behavioral Fidelity | Expected vs Actual vs Ideal gap analysis per workflow |
| `IntegrationOpportunityFinder.ts` | #3 Integration (inferential half) | Cross-reference against skill catalog + hook lifecycle |
| `ValidityAssessor.ts` | #4 Skill Validity | Usage evidence from skills, hooks, WORK/ sessions |
| `ComplexityEvaluator.ts` | #9 Complexity + #11 Agent Balance | LOC-vs-value, deterministic-vs-inferential boundaries |

**Execution:**
```bash
bun Tools/BehaviorVerifier.ts [SkillName] --json
bun Tools/IntegrationOpportunityFinder.ts [SkillName] --json
bun Tools/ValidityAssessor.ts [SkillName] --json
bun Tools/ComplexityEvaluator.ts [SkillName] --json
```

## Phase 4: Memory & Hook Analysis (inline — dimension #10)

No dedicated tool — evaluated inline during synthesis.

### 4.0 Prior Learning Read-Back (deterministic)
Call `readPriorLearnings(skillName)` and `readPriorAuditActions(skillName)` from learning-writer.ts.
Store results as `priorContext`. Inject into `report.priorContext` AFTER all scoring in Phase 5.

**Critical constraint:** Prior learnings are informational only. They MUST NOT influence
dimension scores, finding detection, or action item priority. Raw analysis in Phases 2-5
runs independently. Prior context is overlaid post-scoring for the report only.

### 4.1b Prior Audit Trend Data (deterministic)
If a prior audit report was found in Phase 1 step 5:
- Read the most recent `[SkillName]-[YYYY-MM-DD].md` from `MEMORY/SkillAudits/`
- Extract from YAML frontmatter: `overallScore`, `overallHealth`, `date`
- Extract dimension scores from the Dimension Scores table
- Note any unresolved P1/P2 action items from prior report

### 4.1 Learning Integration Check (deterministic)
- Grep skill code for `MEMORY/LEARNING`, `MemoryStore`, `capture()`, `ratings.jsonl` references
- Check if skill writes any learnings on completion
- Check if skill reads past learnings to inform behavior
- Check `MEMORY/LEARNING/` for entries tagged with this skill name

### 4.2 Hook Integration Check (deterministic)
- Parse `settings.json` hooks for references to this skill
- Check if skill has hook files in `hooks/` directory
- Map which hook events could benefit this skill

### 4.3 Gap Assessment (inferential)
- Given what this skill does, should it write learnings?
- Which hooks would add value without over-engineering?
- Are audit results being used to improve skills over time?

**Score Dimension #10: Learning & Memory**
- 10 = appropriate bidirectional learning integration
- 5 = writes but doesn't read (or vice versa)
- 1 = no integration where it clearly should have some
- N/A for skills where learning integration is genuinely unnecessary

## Phase 5: Synthesis & Scoring

1. Calculate each dimension score per constants.ts scoring framework
2. Determine overall health:
   - RED: Any dimension <3 OR >=3 dimensions below 5
   - YELLOW: >=2 dimensions below 6
   - GREEN: Otherwise
3. Calculate overall score as weighted average (weights in constants.ts)
4. Generate priority-ranked action items from all findings
5. If prior audit data is available:
   - Compute score delta per dimension (current - prior)
   - Flag any dimension that regressed >2 points as HIGH-severity finding
   - Populate `metadata.priorAuditDate`, `metadata.priorOverallScore`, `metadata.priorOverallHealth`
6. After all scoring, populate `report.priorContext` from Phase 4.0 data (informational overlay only)

## Phase 6: Report & Learn

1. Generate structured markdown report per report-builder.ts schema
2. Save to `MEMORY/SkillAudits/[SkillName]-[YYYY-MM-DD].md`
3. Write summary learning to `MEMORY/LEARNING/SYSTEM/` via learning-writer.ts
4. If any P1 findings: trigger voice notification via `notifySync()`
5. If `--json` flag: also output JSON to stdout
6. If trend data available: report-builder.ts automatically includes Trend section via populated metadata fields

## Options

| Flag | Effect |
|------|--------|
| `--json` | Output JSON matching AuditReport interface |
| `--skipInferential` / `--fast` | Run deterministic only, flag inferential dimensions as "partial" |
| `--dimensions [list]` | Evaluate only specified dimensions |

## Output

See `report-builder.ts` for full report schema. Every report includes:
- Executive Summary (health, score, critical findings, action items)
- Dimension Scores table (all 11)
- Per-dimension detail sections with findings and recommendations
- Action Items table (priority, action, dimension, effort, impact)
- Metadata (duration, checks, evaluations, learnings)
