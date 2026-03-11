---
name: ContinualLearning
description: Intelligence synthesis from cross-session patterns. USE WHEN find patterns, what patterns have you noticed, connect to goals, enrich knowledge, what changed, what should I know, weekly intelligence, synthesize learnings.
---

# ContinualLearning

**Intelligence synthesis layer** that transforms raw data into actionable knowledge.

## Purpose

ContinualLearning sits **on top of MemoryStore** to synthesize knowledge from:
- Session transcripts and ratings
- Voice events and behavior signals
- TELOS goals and missions
- Obsidian vault notes
- System changes and patterns

**Key Distinction:**

| MemoryStore | ContinualLearning |
|-------------|-------------------|
| Stores raw data | Synthesizes knowledge |
| Captures entries | Detects patterns |
| Searches memory | Connects to TELOS goals |
| Manages lifecycle | Enriches with Obsidian/Fabric |
| Storage layer | Intelligence layer |

## When to Trigger

**Synthesis triggers:**
- "Find patterns", "What patterns have you noticed"
- "Analyze my sessions", "Show me trends"
- "What have I learned", "Learning summary"

**Goal connection triggers:**
- "Connect to goals", "How does this relate to my goals"
- "Goal progress", "Which goals are active"
- "What insights connect to G28"

**Enrichment triggers:**
- "Enrich with context", "Add research"
- "What does Obsidian say about..."
- "Apply Fabric pattern"

**Intelligence triggers:**
- "What should I know", "Morning briefing"
- "Weekly intelligence", "What's important"
- "What changed", "System changes"

**Proactive triggers (automated):**
- Daily maintenance → light synthesis
- Weekly maintenance → full pattern analysis
- TELOS file changes → goal re-connection
- High-impact ratings → pattern capture

## Tools

| Tool | Purpose | CLI |
|------|---------|-----|
| **KnowledgeSynthesizer** | Aggregate signals into patterns | `bun Tools/KnowledgeSynthesizer.ts --week` |
| **GoalConnector** | Link insights to TELOS goals | `bun Tools/GoalConnector.ts --list-goals` |
| **ExternalEnricher** | Pull from Obsidian, apply Fabric | `bun Tools/ExternalEnricher.ts --search "topic"` |
| **ChangeDetector** | Monitor system for changes | `bun Tools/ChangeDetector.ts --scan` |
| **InsightGenerator** | Generate briefings | `bun Tools/InsightGenerator.ts --daily` |
| **ContextWeaver** | Combine knowledge sources | `bun Tools/ContextWeaver.ts --session` |
| **BackfillIndexer** | Index unindexed MEMORY/LEARNING/ files into MemoryStore | `bun Tools/BackfillIndexer.ts` |

## Workflow Routing

| Workflow | Trigger | File |
|----------|---------|------|
| **SynthesizePatterns** | "find patterns", daily maintenance, "analyze sessions" | `Workflows/SynthesizePatterns.md` |
| **ConnectToGoals** | "connect to goals", TELOS changes, "goal insights" | `Workflows/ConnectToGoals.md` |
| **EnrichKnowledge** | "enrich with context", "add research", "obsidian context" | `Workflows/EnrichKnowledge.md` |
| **DetectChanges** | "what changed", hourly scheduled, "system changes" | `Workflows/DetectChanges.md` |
| **GenerateIntelligence** | "what should I know", "morning briefing", "weekly intelligence" | `Workflows/GenerateIntelligence.md` |
| **BackfillLearnings** | "backfill learnings", "index learnings", "reindex memory" | Run `bun Tools/BackfillIndexer.ts` |
| **SynthesizeWisdom** | "synthesize wisdom", "update wisdom frames", "crystallize patterns", weekly AutoInfoManager scheduled | `Workflows/SynthesizeWisdom.md` |

## Integration

### Uses
- **MemoryStore** (`lib/core/MemoryStore.ts`) - Read raw entries, write synthesized insights
- **TELOS** (`USER/TELOS/`) - Goal structure for connections
- **Obsidian vault** (`/Users/[user]/Desktop/obsidian/`) - External knowledge source
- **Fabric** (`skills/Intelligence/Fabric/`) - Analysis patterns
- **NotificationService** - Voice output for briefings

### Feeds Into
- **AutoMaintenance** - Daily/weekly synthesis workflows
- **InformationManager** - Woven context for session prep

## Tool Usage Examples

### Synthesize Weekly Patterns

```bash
# Run synthesis for the last week
bun ~/.claude/skills/Productivity/ContinualLearning/Tools/KnowledgeSynthesizer.ts --week

# Output includes:
# - Pattern detection from ratings, sessions, voice
# - Frustration/success categorization
# - Trend analysis
# - Recommendations
```

### Connect Insight to Goals

```bash
# Find which goals relate to a learning
bun ~/.claude/skills/Productivity/ContinualLearning/Tools/GoalConnector.ts --connect "AI productivity improvements"

# Output: G28 (AI proficiency), M5 (Professional), relevance scores
```

### Generate Morning Briefing

```bash
# Get daily intelligence
bun ~/.claude/skills/Productivity/ContinualLearning/Tools/InsightGenerator.ts --daily

# Output includes:
# - Quick stats (sessions, ratings, patterns)
# - Highlights from synthesis
# - Action items
# - Goal progress
# - Focus recommendation
```

### Detect System Changes

```bash
# Create baseline first
bun ~/.claude/skills/Productivity/ContinualLearning/Tools/ChangeDetector.ts --baseline

# Later, scan for changes
bun ~/.claude/skills/Productivity/ContinualLearning/Tools/ChangeDetector.ts --scan

# Output: Added/modified/deleted files, significance levels, learning opportunities
```

### Weave Context for Topic

```bash
# Get unified context for a topic
bun ~/.claude/skills/Productivity/ContinualLearning/Tools/ContextWeaver.ts --topic "AI tools"

# Combines: TELOS goals, memory learnings, Obsidian notes, synthesis patterns
```

## State Files

| File | Purpose |
|------|---------|
| `State/last-synthesis.json` | Tracks last synthesis run, pattern history |
| `State/change-baseline.json` | Baseline for change detection |

## Architecture

```
Raw Data Sources          Synthesis Layer              Output
─────────────────         ───────────────              ──────
ratings.jsonl      →
voice-events.jsonl →      KnowledgeSynthesizer   →    Pattern Reports
session transcripts→                                   Synthesis Files

TELOS/GOALS.md     →      GoalConnector          →    Goal Connections
TELOS/MISSIONS.md  →                                   Relevance Scores

Obsidian vault     →      ExternalEnricher       →    Enriched Context
Fabric patterns    →                                   Applied Insights

File system        →      ChangeDetector         →    Change Reports
                                                       Learning Opportunities

All sources        →      InsightGenerator       →    Daily/Weekly Briefings
                                                       Goal Progress

All sources        →      ContextWeaver          →    Unified Context Packages
```

## Customization

### Pattern Detection

Customize patterns in `Tools/KnowledgeSynthesizer.ts`:

```typescript
// Frustration patterns - keywords that indicate problems
const FRUSTRATION_PATTERNS: Record<string, RegExp> = {
  "Time/Performance Issues": /time|slow|delay|hang|wait/i,
  "Incomplete Work": /incomplete|missing|partial/i,
  // Add your own patterns...
};

// Success patterns - keywords that indicate wins
const SUCCESS_PATTERNS: Record<string, RegExp> = {
  "Fast Iteration": /quick|fast|rapid|smooth/i,
  // Add your own patterns...
};
```

### Thresholds

Adjust detection sensitivity:

```typescript
// Minimum occurrences to create a pattern
const MIN_PATTERN_COUNT = 2;

// Minimum average score for recommendations
const MIN_RECOMMENDATION_SCORE = 4.0;
```

### Keyword Mappings

Map voice events and session keywords to behaviors in `Tools/KnowledgeSynthesizer.ts`:

```typescript
// Behavior detection
if (message.includes("coding") || message.includes("implementing")) {
  behaviorCounts["Coding Focus"]++;
}
```

### Obsidian Vault Path

Set via environment variable or default:

```bash
export OBSIDIAN_VAULT="/path/to/your/vault"
```

Or edit `Tools/ExternalEnricher.ts` to change the default path.

## Maintenance Integration

The skill integrates with AutoMaintenance:

**Daily:**
```bash
# Light synthesis (ratings only)
bun Tools/KnowledgeSynthesizer.ts --week --source ratings
bun Tools/ChangeDetector.ts --scan --scope telos
```

**Weekly:**
```bash
# Full synthesis
bun Tools/KnowledgeSynthesizer.ts --week
bun Tools/InsightGenerator.ts --weekly --save
bun Tools/ChangeDetector.ts --baseline
```

**Monthly:**
```bash
# Deep analysis
bun Tools/KnowledgeSynthesizer.ts --month
bun Tools/ContextWeaver.ts --deep --limit 20
```

## Voice Notification

Use `notifySync()` from `lib/core/NotificationService.ts` for spoken briefings:

```typescript
import { notifySync } from "../../../lib/core/NotificationService";

const briefing = await generateDailyBriefing();
notifySync(`${briefing.greeting}. ${briefing.focusRecommendation}`);
```

## Related Documentation

- **MemoryStore:** `lib/core/MemoryStore.ts` - Storage layer
- **TELOS:** `USER/TELOS/` - Goal structure
- **Fabric:** `skills/Intelligence/Fabric/SKILL.md` - Pattern application
- **AutoMaintenance:** `skills/Automation/AutoMaintenance/SKILL.md` - Scheduled workflows
