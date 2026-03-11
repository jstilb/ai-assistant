---
name: SystemFlowchart
description: Kaya system architecture visualization and documentation. USE WHEN Kaya system diagram, Kaya architecture flowchart, visualize Kaya, Kaya system map, how does Kaya work, show Kaya structure, update architecture diagram, mermaid diagram.
---

# SystemFlowchart

Creates and maintains comprehensive visual documentation of Kaya system architecture. Generates both **Mermaid markdown** (version-controllable, renders in GitHub/Obsidian) and **PNG images** (professional visuals via Art skill).

## Skill Categories

Kaya skills are organized into three categories:

| Category | Purpose | Examples |
|----------|---------|----------|
| **Meta** | Skills about skills/system - infrastructure, configuration, visualization | CORE, System, SystemFlowchart, SkillAudit, CreateSkill, KayaSync, KayaUpgrade |
| **Orchestration** | Coordination engines - multi-agent, workflows, scheduling | Agents, Council, RedTeam, AutonomousWork, AutoMaintenance, ProactiveEngine |
| **Specialized** | Domain-specific functionality | Research, Browser, Art, Shopping, Cooking, Gmail, Calendar, etc. |

## Diagram Types

| Diagram | Description | File |
|---------|-------------|------|
| System Overview | High-level architecture with major components | `system-overview.md` |
| Session Lifecycle | Hook execution flow from start to end | `session-lifecycle.md` |
| Skill Ecosystem | Skills organized by Meta/Orchestration/Specialized | `skill-ecosystem.md` |
| Memory Structure | MEMORY/ directory organization | `memory-structure.md` |
| Configuration Flow | settings.json → SYSTEM → USER inheritance | `configuration-flow.md` |
| Agent Architecture | Task subagents, research agents, custom agents | `agent-architecture.md` |

## Output Locations

```
Output/
├── markdown/           # Mermaid .md files (quick rendering)
│   ├── system-overview.md
│   ├── session-lifecycle.md
│   ├── skill-ecosystem.md
│   ├── memory-structure.md
│   ├── configuration-flow.md
│   └── agent-architecture.md
├── images/             # Art-generated PNGs (professional visuals)
│   └── *.png
└── .cache-state.json   # Staleness tracking
```

Master architecture document: `~/.claude/USER/KAYA_ARCHITECTURE.md`

## Tools

| Tool | Purpose | Usage |
|------|---------|-------|
| `SystemScanner.ts` | Scan skills, hooks, memory, detect changes | `bun SystemScanner.ts [scan\|skills\|hooks\|memory\|hash]` |
| `SkillCategorizer.ts` | Categorize skills into Meta/Orchestration/Specialized | `bun SkillCategorizer.ts [--json\|--diagram]` |
| `DiagramBuilder.ts` | Generate Mermaid diagrams from scan data | `bun DiagramBuilder.ts [all\|overview\|lifecycle\|ecosystem\|...]` |
| `ArtBridge.ts` | Generate PNG images via Art skill | `bun ArtBridge.ts [generate\|batch\|all]` |
| `CacheManager.ts` | Track staleness, decide when to regenerate | `bun CacheManager.ts [status\|check\|update\|invalidate]` |

## Workflow Routing

| Trigger | Workflow | Description |
|---------|----------|-------------|
| "system diagram", "architecture flowchart" | `Workflows/GenerateArchitecture.md` | Full system architecture (MD + PNG) |
| "session lifecycle", "hook flow" | `Workflows/SessionLifecycle.md` | Session start → stop flow |
| "skill map", "skill dependencies" | `Workflows/SkillMap.md` | Skill hierarchy with categories |
| "memory structure", "memory diagram" | `Workflows/MemoryStructure.md` | MEMORY/ directory organization |

## Examples

**Example 1: Generate system architecture**
```
User: "Show me the Kaya system architecture"
-> Runs: bun DiagramBuilder.ts all
-> Generates Mermaid markdown for all 6 diagram types
-> Optionally generates PNG via Art skill
-> "Generated system architecture diagrams in Output/markdown/"
```

**Example 2: Visualize skill ecosystem**
```
User: "Map the skill dependencies"
-> Runs: bun SkillCategorizer.ts --diagram
-> Categorizes skills into Meta/Orchestration/Specialized
-> Generates skill-ecosystem.md with relationships
```

**Example 3: Check if diagrams are stale**
```
User: "Are the architecture diagrams up to date?"
-> Runs: bun CacheManager.ts check
-> Reports staleness status per diagram type
-> Suggests regeneration if system changes detected
```

## Quick Start

```bash
# Check if regeneration needed
bun ~/.claude/skills/Content/SystemFlowchart/Tools/CacheManager.ts check

# Generate all Mermaid diagrams
bun ~/.claude/skills/Content/SystemFlowchart/Tools/DiagramBuilder.ts all

# Generate PNG images (optional)
bun ~/.claude/skills/Content/SystemFlowchart/Tools/ArtBridge.ts all

# Update cache after generation
bun ~/.claude/skills/Content/SystemFlowchart/Tools/CacheManager.ts update

# View skill categories
bun ~/.claude/skills/Content/SystemFlowchart/Tools/SkillCategorizer.ts
```

## Customization

| Option | Default | Description |
|--------|---------|-------------|
| `output_dir` | `~/.claude/skills/Content/SystemFlowchart/Output/` | Base directory for generated diagrams |
| `markdown_subdir` | `markdown/` | Subdirectory for Mermaid markdown files |
| `images_subdir` | `images/` | Subdirectory for PNG image files |
| `cache_ttl_hours` | `24` | Hours before cache considers diagrams stale |
| `categories` | `['Meta', 'Orchestration', 'Specialized']` | Skill categories to include in ecosystem diagrams |
| `art_model` | `nano-banana-pro` | Image generation model for PNG output |
| `art_size` | `2K` | Image resolution for PNG output |
| `art_aspect_ratio` | `16:9` | Aspect ratio for PNG output |

## Voice Notification

Uses the `notifySync` pattern for voice announcements during diagram generation:

```typescript
import { notifySync } from '../../hooks/lib/notifications.ts';

// Announce diagram generation start
notifySync('Generating system architecture diagrams');

// Announce completion
notifySync('Architecture diagrams generated and cached');
```

## Context Strategy

**On-demand with cache** (not always-loaded). Architecture diagrams change infrequently, so they're generated only when:
1. User requests diagram ("system diagram", "architecture flowchart")
2. Cache check detects system changes (skills/hooks/memory modified)

---

## Integration

### Uses
- **CORE skill** - System architecture and configuration
- **Art skill** - PNG generation via TechnicalDiagrams workflow
- **skills/** directory - Scans for skill definitions and relationships
- **hooks/** directory - Hook configuration for lifecycle diagrams
- **settings.json** - Configuration inheritance patterns

### Feeds Into
- **Documentation** - Visual architecture references
- **System skill** - Integrity validation with visual context
- **Kaya onboarding** - Understanding system structure
- **USER/KAYA_ARCHITECTURE.md** - Master architecture document

### MCPs Used
- None (generates Mermaid diagrams from filesystem, Art skill for PNGs)
