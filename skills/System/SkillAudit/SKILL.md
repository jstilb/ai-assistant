---
name: SkillAudit
description: Deep skill analysis, evaluation, and optimization system. USE WHEN audit skill, evaluate skill, analyze skills, skill quality, skill review, consolidate skills, skill health, ecosystem audit, skill report, compare to industry, run skill evals.
version: 2.0.0
---
# SkillAudit v2 — Skill Analysis & Optimization System

**PURPOSE:** Complete evaluation of any Kaya skill across 11 dimensions, producing actionable diagnostic reports. The definitive quality gate for the Kaya skill ecosystem.

---

## Voice Notification

> Use `notifySync()` from `lib/core/NotificationService.ts`
> Triggers on: P1 findings, RED health status, ecosystem health degradation

---

## Workflow Routing

### Core Audit Workflows

| Workflow | Trigger | Purpose | File |
|----------|---------|---------|------|
| **ComprehensiveAudit** | "audit [skill]", "evaluate [skill]", "review [skill]", "deep analysis of [skill]" | Full 11-dimension evaluation of one skill | `Workflows/ComprehensiveAudit.md` |
| **EcosystemAudit** | "audit all skills", "ecosystem audit", "skill ecosystem health", "consolidate skills" | Batch audit all skills with cross-skill analysis | `Workflows/EcosystemAudit.md` |

### Research & Validation

| Workflow | Trigger | Purpose | File |
|----------|---------|---------|------|
| **ResearchBestPractices** | "compare to industry", "skill best practices", "how others do it" | Research external implementations and compare | `Workflows/ResearchBestPractices.md` |
| **ValidateWithEvals** | "validate [skill] with evals", "run skill evals", "behavioral test [skill]" | Run behavioral evals with audit correlation | `Workflows/ValidateWithEvals.md` |

---

## The 11 Dimensions

| # | Dimension | Weight | Type | Scored By |
|---|-----------|--------|------|-----------|
| 1 | **Behavioral Fidelity** | 15% | Inferential | `BehaviorVerifier.ts` |
| 2 | **Implementation Quality** | 10% | Deterministic | `StructuralScorer.ts` |
| 3 | **Integration Fitness** | 10% | Hybrid | `DependencyMapper.ts` + `IntegrationOpportunityFinder.ts` |
| 4 | **Skill Validity** | 10% | Inferential | `ValidityAssessor.ts` |
| 5 | **Context Efficiency** | 8% | Deterministic | `ContextCostAnalyzer.ts` |
| 6 | **Code Hygiene** | 10% | Deterministic | `DeadCodeDetector.ts` + `RedundancyDetector.ts` |
| 7 | **Refactoring Need** | 8% | Deterministic | `ConventionChecker.ts` + `RedundancyDetector.ts` |
| 8 | **Context Routing** | 7% | Deterministic | `TriggerAnalyzer.ts` |
| 9 | **Complexity** | 7% | Hybrid | `ComplexityEvaluator.ts` |
| 10 | **Learning & Memory** | 8% | Hybrid | Inline (ComprehensiveAudit Phase 4) |
| 11 | **Agent Balance** | 7% | Inferential | `ComplexityEvaluator.ts` |

### Health Thresholds

- **RED:** Any dimension <3 OR >=3 dimensions below 5
- **YELLOW:** >=2 dimensions below 6
- **GREEN:** All dimensions >=5 and <2 below 6

---

## Tools

### Deterministic Analyzers (no LLM, fast)

| Tool | Dimension(s) | Purpose |
|------|-------------|---------|
| `SkillInventory.ts` | Foundation | File/metric/trigger/dependency discovery |
| `StructuralScorer.ts` | #2 Implementation | CreateSkill compliance scoring |
| `DependencyMapper.ts` | #3 Integration | Dependency graph, hub/leaf/isolated |
| `TriggerAnalyzer.ts` | #8 Context Routing | Jaccard trigger overlap analysis |
| `RedundancyDetector.ts` | #6 + #7 | Code duplication, workflow overlap |
| `DeadCodeDetector.ts` | #6 Code Hygiene | Unused exports, orphans, stale refs |
| `ContextCostAnalyzer.ts` | #5 Context Efficiency | Token cost, trigger precision |
| `ConventionChecker.ts` | #7 Refactoring | Convention violation detection |

### Inferential Evaluators (require LLM judgment)

| Tool | Dimension(s) | Purpose |
|------|-------------|---------|
| `BehaviorVerifier.ts` | #1 Behavioral Fidelity | Expected vs Actual vs Ideal gap analysis |
| `IntegrationOpportunityFinder.ts` | #3 Integration | Cross-catalog synergy detection |
| `ValidityAssessor.ts` | #4 Skill Validity | Usage evidence and uniqueness check |
| `ComplexityEvaluator.ts` | #9 + #11 | LOC-vs-value and agent balance |

### Shared Modules

| Module | Purpose |
|--------|---------|
| `constants.ts` | All weights, thresholds, paths, scoring deductions |
| `utils.ts` | File I/O, trigger extraction, directory helpers |
| `report-builder.ts` | Structured report generation |
| `learning-writer.ts` | Write findings to MEMORY/LEARNING/ |

---

## Quick Reference

### Single Skill Audit
```bash
# Full audit (deterministic + inferential)
bun Tools/StructuralScorer.ts Browser --json
bun Tools/DeadCodeDetector.ts Browser --json
bun Tools/ContextCostAnalyzer.ts Browser --json
bun Tools/ConventionChecker.ts Browser --json

# Fast mode (deterministic only)
# Use --skipInferential flag in ComprehensiveAudit workflow
```

### Ecosystem Audit
```bash
bun Tools/SkillInventory.ts --summary --json
bun Tools/TriggerAnalyzer.ts --matrix --threshold 40
bun Tools/DependencyMapper.ts --format mermaid
```

---

## Integration

### Uses

- **CORE** — StateManager, NotificationService, GenerateSkillIndex
- **Evals** — EvalExecutor for behavioral validation
- **Agents** — AgentFactory for multi-agent ecosystem audits
- **ContinualLearning** — Learning synthesis from audit findings

### Feeds Into

- **ContinualLearning** — Audit findings → MEMORY/LEARNING/SYSTEM/
- **CreateSkill** — Audit recommendations inform standards
- **System** — Findings supplement integrity checks
- **AutonomousWork** — Audit reports as work items with ISC

---

## Customization

### Scoring Weights
All dimension weights and deduction values are in `Tools/constants.ts`. Reviewed monthly based on accumulated audit data.

### Health Thresholds
Configurable in `constants.ts` via `HEALTH_THRESHOLDS`.

### Output Format
Reports support both markdown (default) and JSON (`--json` flag).

---

## Examples

**Example 1: Audit a Single Skill**
```
User: "audit Browser"
Kaya: Runs ComprehensiveAudit on Browser skill.
       Phase 1: Discovery → Phase 2: 7 deterministic analyzers → Phase 3: 4 inferential evaluators → Phase 4: Memory/Hook analysis → Phase 5: Synthesis → Phase 6: Report saved to MEMORY/SkillAudits/Browser-2026-02-25.md
```

**Example 2: Ecosystem Health Check**
```
User: "audit all skills"
Kaya: Runs EcosystemAudit.
       Quick audits 67 skills in batches of 8 → Deep audits flagged skills → Cross-skill analysis → Consolidation recommendations → Ecosystem report saved.
```

**Example 3: Fast Deterministic-Only Audit**
```
User: "quick audit JobEngine"
Kaya: Runs ComprehensiveAudit with --skipInferential.
       Deterministic analyzers only. Inferential dimensions marked "partial". Faster, cheaper.
```
