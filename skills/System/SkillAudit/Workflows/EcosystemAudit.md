# EcosystemAudit — All-Skills Audit

> Replaces: AuditAll + AnalyzeEcosystem

## Trigger

- "audit all skills"
- "ecosystem audit"
- "skill ecosystem health"
- "analyze ecosystem"
- "consolidate skills"

## Overview

Batch audit of all skills in `~/.claude/skills/` with cross-skill analysis. Uses parallel agents for quick audits, deep-dives on flagged skills, and produces an ecosystem health report with consolidation recommendations.

## Phase 1: Catalog & Categorize

1. Run `SkillInventory.ts --summary --json`
2. Categorize skills:
   - **System:** CORE, System, AutoMaintenance, ContextManager, ContinualLearning
   - **Domain:** Browser, JobEngine, Calendar, etc.
   - **Private:** underscore-prefixed skills
   - **Deprecated:** DevGraph, ContextGraph, etc. (marked deprecated)
3. Load all prior audit reports from `MEMORY/SkillAudits/`

## Phase 2: Parallel Quick Audits

Spawn Intern agents in batches of 8 skills each. Each agent runs deterministic analyzers only (Phase 2 of ComprehensiveAudit).

**Per-skill output:** Implementation Quality score, Code Hygiene score, Context Efficiency score + 1-sentence summary + top finding.

```
For each batch of 8 skills:
  Spawn 8 Intern agents (model: haiku):
    Run StructuralScorer.ts [SkillName] --json
    Run DeadCodeDetector.ts [SkillName] --json
    Run ContextCostAnalyzer.ts [SkillName] --json
    Return: {skillName, scores, topFinding}
```

## Phase 3: Identify Priority Skills

From quick audit scores, flag:

| Category | Condition | Priority |
|----------|-----------|----------|
| **Critical** | Any deterministic dimension <3 | Immediate deep audit |
| **High Potential** | High utility signal (referenced by many skills) + low implementation score | High-value improvement |
| **Consolidation Candidates** | Trigger overlap >50% (from TriggerAnalyzer) | Review for merge |
| **Validity Concerns** | No references from other skills, no hook integrations, no recent WORK/ sessions | May be shelf-ware |

## Phase 4: Deep Audit Priority Skills

Spawn Architect agents (model: sonnet) for full ComprehensiveAudit on flagged skills.

**Cap:** Max 10 parallel deep audits. Remainder noted as "deferred".

## Phase 5: Cross-Skill Analysis

1. Run `TriggerAnalyzer.ts --matrix --threshold 40` — full overlap matrix
2. Run `DependencyMapper.ts --format mermaid` — ecosystem dependency graph
3. **Domain clustering:** Group skills into:
   - Productivity (Calendar, Tasks, Gmail)
   - Content (Art, Fabric, ContentAggregator)
   - Development (CreateSkill, CreateCLI, AgentProjectSetup, UIBuilder)
   - Maintenance (System, AutoMaintenance, AutoInfoManager)
   - Learning (ContinualLearning, DigitalMaestro, KnowledgeGraph)
   - Security (RedTeam, WebAssessment, Recon, PromptInjection)
   - Automation (AutonomousWork, ProactiveEngine)
4. **Pipeline chain detection:** Follow `Feeds Into` links to find multi-skill pipelines
5. **Orphan detection:** Skills with zero in-degree and zero out-degree
6. **Hook coverage map:** Which skills have hooks, which should, which hook events are underutilized

## Phase 6: Consolidation Analysis

For each pair above 40% trigger overlap:
- Same domain? Subset relationship? Combined <150 lines?
- Different user intents? Different complexity tiers?
- **Recommend one of:**
  - A absorbs B
  - B absorbs A
  - Create new C from A + B
  - Keep separate (with justification)
- Include migration steps if merge recommended

## Phase 7: Report & Learn

Generate ecosystem report with:

```markdown
# Ecosystem Audit Report — [DATE]

## Health Summary
- GREEN: N skills | YELLOW: N skills | RED: N skills
- Overall Ecosystem Health: [status]

## Top 5 Performers
| Skill | Score | Strength |

## Bottom 5 Needing Work
| Skill | Score | Primary Issue |

## Consolidation Opportunities
| Pair | Overlap | Recommendation | Migration Effort |

## Dependency Graph
[Mermaid diagram]

## Trigger Overlap Matrix
[Table of pairs >40%]

## Hook Coverage Gaps
| Skill | Has Hooks | Should Have | Missing Events |

## Domain Groupings
[Domain clusters with skill lists]

## Trend Analysis
[vs prior ecosystem audit if exists]

## Prioritized Roadmap
### Immediate (P1)
### Short-term (P2)
### Strategic (P3)
```

Save to `MEMORY/SkillAudits/ecosystem-[YYYY-MM-DD].md`
Write ecosystem-level learning to `MEMORY/LEARNING/SYSTEM/`

5. If ecosystem overall health is RED, or if overall health degraded compared to prior ecosystem audit:
   trigger `notifySync('SkillAudit: Ecosystem health [status] — [N] skills critical, [M] need work')`
