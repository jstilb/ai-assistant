# DetectChanges Workflow

Monitor system for changes that represent learning opportunities.

## Purpose

Detect significant changes in:
- TELOS files (goals, missions, strategies)
- Skill definitions
- Memory entries
- System configuration

Generate learning opportunities from changes.

## Trigger Patterns

- "What changed", "Show changes"
- "System changes", "TELOS updates"
- Hourly scheduled scan (via launchd)
- Before weekly synthesis (baseline update)

## Execution Steps

### 1. Create/Update Baseline

First time or weekly reset:

```bash
# Create baseline snapshot
bun ~/.claude/skills/Productivity/ContinualLearning/Tools/ChangeDetector.ts --baseline

# Output:
# 📸 Creating baseline snapshot...
#    Files tracked: 234
#    Scopes: telos, skills, memory, config
#    Saved to: State/change-baseline.json
```

### 2. Scan for Changes

```bash
# Scan all scopes
bun ~/.claude/skills/Productivity/ContinualLearning/Tools/ChangeDetector.ts --scan

# Scan specific scope
bun ~/.claude/skills/Productivity/ContinualLearning/Tools/ChangeDetector.ts --scan --scope telos
```

### 3. Process Results

```typescript
import { detectChanges } from "./Tools/ChangeDetector";

const report = await detectChanges(["telos", "skills", "memory"]);

// Report contains:
// - changes: DetectedChange[] with type, category, significance
// - summary: { added, modified, deleted, highSignificance }
// - learningOpportunities: string[]
```

### 4. Present Changes

Format for user:

```markdown
## Change Detection Report

**Baseline:** {{baselineTimestamp}}
**Scanned:** {{now}}

### Summary
- Added: {{added}}
- Modified: {{modified}}
- Deleted: {{deleted}}
- High Significance: {{highSignificance}}

### High Significance Changes
⚠️ {{change.reason}}
⚠️ {{change.reason}}

### Learning Opportunities
→ {{opportunity}}
→ {{opportunity}}
```

## Scopes

| Scope | What's Tracked | Location |
|-------|----------------|----------|
| `telos` | Goals, missions, strategies | `USER/TELOS/` |
| `skills` | SKILL.md, workflows, tools | `skills/` |
| `memory` | Learnings, synthesis, entries | `MEMORY/` |
| `config` | Settings, configuration | `~/.claude/` |

## Significance Levels

| Level | Criteria |
|-------|----------|
| **High** | TELOS goals/missions modified, skill definitions changed, files deleted |
| **Medium** | Synthesis files, workflow changes, large content changes (>1KB) |
| **Low** | Regular memory entries, minor updates |

## Learning Opportunities

The detector generates actionable insights:

| Change | Opportunity |
|--------|-------------|
| TELOS updated | "Consider running goal alignment synthesis" |
| New skill added | "Document capabilities and triggers" |
| High memory activity | "Consider pattern synthesis" |
| Files deleted | "Review for archival" |

## Integration

### Hourly Scan (via launchd)

```bash
# In AutoMaintenance or launchd
bun ~/.claude/skills/Productivity/ContinualLearning/Tools/ChangeDetector.ts --scan --scope telos --json
```

### Weekly Baseline Reset

```bash
# Weekly maintenance
bun ~/.claude/skills/Productivity/ContinualLearning/Tools/ChangeDetector.ts --baseline
```

### Before Synthesis

```typescript
import { detectChanges } from "./Tools/ChangeDetector";
import { synthesize } from "./Tools/KnowledgeSynthesizer";

// Check for changes first
const changes = await detectChanges(["telos"]);

if (changes.summary.highSignificance > 0) {
  // Goals changed - run goal-connected synthesis
  // ...
}

// Then synthesize
await synthesize({ period: "week", sources: ["ratings", "sessions"] });
```

## State File

`State/change-baseline.json` contains:

```json
{
  "timestamp": "2026-02-01T10:00:00Z",
  "version": 1,
  "files": {
    "/path/to/file.md": {
      "path": "/path/to/file.md",
      "hash": "abc123...",
      "size": 1234,
      "modified": "2026-01-31T15:00:00Z"
    }
  }
}
```

## Related

- **ChangeDetector:** `Tools/ChangeDetector.ts`
- **AutoMaintenance:** `skills/Automation/AutoMaintenance/SKILL.md`
- **SynthesizePatterns:** `Workflows/SynthesizePatterns.md`
