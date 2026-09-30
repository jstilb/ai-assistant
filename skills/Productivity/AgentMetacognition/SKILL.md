---
name: AgentMetacognition
description: Intelligence synthesis from cross-session patterns. USE WHEN find patterns, what patterns have you noticed, connect to goals, enrich knowledge, what should I know, weekly intelligence, synthesize learnings.
---

# AgentMetacognition

**Intelligence synthesis layer** that turns raw learning signals into actionable knowledge — with the judgment done by the model reading real data, not by deterministic pattern-matchers.

## Purpose

AgentMetacognition sits **on top of MemoryStore** to synthesize knowledge from:
- Session ratings and learning signals (`MEMORY/LEARNING/SIGNALS/`)
- TELOS goals and missions
- Obsidian vault notes

**Key Distinction:**

| MemoryStore | AgentMetacognition |
|-------------|-------------------|
| Stores raw data | Synthesizes knowledge |
| Captures entries | Reads signals, finds patterns (LLM judgment) |
| Searches memory | Connects to TELOS goals |
| Storage layer | Intelligence layer |

## What happened to wisdom-frame synthesis (2026-07-09)

The deterministic weekly pipeline (`SynthesisOrchestrator`, `PatternExtractor`,
`FrameWriter`, `FrameImpactTracker`, `StateManager`, `KnowledgeSynthesizer`,
`CronHealthMonitor`/`ChangeDetector`) was **deleted**, not simplified:

- Wisdom-frame session injection was retired 2026-05-02 (commit `b23008d68`):
  **CLAUDE.md and auto-memory are the canonical home for behavioral rules.**
  The pipeline kept producing frames nothing consumed.
- Its judgment was keyword-bucket counting (`confidence = occurrences/signals ×
  recency`), which produced only junk frames it later self-demoted. In 18
  weekly cron runs it never produced a surviving frame; the one load-bearing
  frame (`MEMORY/WISDOM/FRAMES/estimation-calibration.md`, referenced by
  CLAUDE.md) predates the pipeline and was outside its fixed taxonomy.
- Per "determinism must earn its place": signal capture and quality gating
  stay deterministic-with-LLM-midband (below); pattern significance, conflict
  checks, and dedup are model judgment exercised in workflows and auto-memory.

`MEMORY/WISDOM/FRAMES/` still exists and workflows may read it as context,
but nothing writes new frames.

## When to Trigger

**Goal connection triggers:**
- "Connect to goals", "How does this relate to my goals"
- "Goal progress", "Which goals are active"

**Enrichment triggers:**
- "Enrich with context", "Add research"
- "What does Obsidian say about..."

**Intelligence triggers:**
- "What should I know", "Morning briefing"
- "Weekly intelligence", "What's important"

## Tools

| Tool | Purpose | CLI |
|------|---------|-----|
| **GoalConnector** | Link insights to TELOS goals | `bun Tools/GoalConnector.ts --list-goals` |
| **ExternalEnricher** | Pull from Obsidian, apply Fabric | `bun Tools/ExternalEnricher.ts --search "topic"` |
| **EstimationCapture** | Weekly estimate-vs-actual capture from LucidTasks into the signals ledger | `bun Tools/EstimationCapture.ts` |
| **LearningPulseAppender** | Append Learning Pulse to briefings (pure utility) | _library only_ |
| **SignalLedger** | Quality-gated append of learning signals to `MEMORY/LEARNING/SIGNALS/` | _library only_ (used by IssueTrace/IssueLearningBridge) |
| **SignalQualityGate** | Classify signals real/noise — deterministic bands, LLM for the ambiguous mid-band | `bun Tools/SignalQualityGate.ts --test-fixtures` |

## Workflow Routing

| Workflow | Trigger | File |
|----------|---------|------|
| **ConnectToGoals** | "connect to goals", TELOS changes, "goal insights" | `Workflows/ConnectToGoals.md` |
| **EnrichKnowledge** | "enrich with context", "add research", "obsidian context" | `Workflows/EnrichKnowledge.md` |
| **GenerateIntelligence** | "what should I know", "morning briefing", "weekly intelligence" | `Workflows/GenerateIntelligence.md` |
| **SignalClassification** | called by `SignalQualityGate.evaluate()` for mid-band signals | `Workflows/SignalClassification.md` |

## Integration

### Uses
- **MemoryStore** (`lib/core/MemoryStore.ts`) - Read raw entries, write synthesized insights
- **TELOS** (`USER/TELOS/`) - Goal structure for connections
- **Obsidian vault** (`/Users/[user]/Desktop/obsidian/`) - External knowledge source
- **Fabric** (`skills/Intelligence/Fabric/`) - Analysis patterns

### Feeds In
- **IssueTrace/IssueLearningBridge** appends dev-issue signals via `SignalLedger`
- **Rating hooks** (`ExplicitRatingCapture`, `SessionRatingCapture`) append to `ratings.jsonl` directly

### Scheduled
- None. `learning-weekly-digest` (Tue 09:00, agent-mode; it replaced the
  retired `graph-weekly-synthesis` 2026-07-10) was deleted 2026-09-30 per Jm.
  It ran `EstimationCapture.ts`, read the last 7 days of
  `MEMORY/LEARNING/SIGNALS/*`, sent a proposals-only digest, and refreshed the
  estimation-calibration wisdom frame's numbers — those numbers no longer
  auto-refresh; run `EstimationCapture.ts` manually when needed.
  (LearningContextProvider was deleted with the old cron — its report parser
  had been schema-mismatched since 2026-03, and nothing read its output.)

## Related Documentation

- **MemoryStore:** `lib/core/MemoryStore.ts` - Storage layer
- **TELOS:** `USER/TELOS/` - Goal structure
- **Fabric:** `skills/Intelligence/Fabric/SKILL.md` - Pattern application
- **AutoMaintenance:** `skills/Automation/AutoMaintenance/SKILL.md` - Scheduled workflows
