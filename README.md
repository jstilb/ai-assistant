# Kaya -- Personal AI Infrastructure

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0%2B-blue.svg)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/runtime-Bun-f472b6.svg)](https://bun.sh/)
[![Skills](https://img.shields.io/badge/skills-70-brightgreen.svg)](#skill-catalog)
[![Claude Code](https://img.shields.io/badge/powered%20by-Claude%20Code-6366f1.svg)](https://docs.anthropic.com/en/docs/claude-code)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)

A production-grade AI agent framework with 70 leaf skills, autonomous task execution, voice interaction, and persistent memory. Built on Anthropic's Claude Code as the foundation for a fully autonomous personal AI assistant.

## Why I Built This

After working extensively with AI assistants, I noticed a fundamental gap: every session starts from zero. There is no continuity, no memory of preferences, no ability to proactively take action. I wanted an AI system that:

- **Remembers everything** -- past decisions, preferences, learnings across sessions
- **Acts autonomously** -- executes multi-step workflows without constant supervision
- **Composes capabilities** -- chains specialized skills together for complex tasks
- **Speaks and listens** -- bidirectional voice interaction, not just text

Kaya is the result: a skill-based architecture where each capability is a self-contained module that Claude Code can discover, load, and execute. The system handles everything from calendar management and grocery shopping to security reconnaissance and multi-agent debates.

## Architecture

```
kaya/
  skills/             # 11 categories and 70 leaf skills
    Automation/       # AutonomousWork, QueueRouter, AutoMaintenance
    Productivity/     # LucidTasks, LifeOS, DailyBriefing
    Development/      # Browser and engineering workflows
    ...               # 8 other categories
  apps/Canvas/        # Kaya desktop surface
  bin/                # CLI tools and launchd job wrappers
  hooks/              # Claude Code lifecycle hooks
  lib/                # Shared TypeScript libraries
  MEMORY/             # File-backed system state and cron manifests
  Observability/      # Monitoring applications
  KAYASECURITYSYSTEM/ # Security patterns and guidance
```

## Key Capabilities

### Autonomous Task Execution
The `AutonomousWork` skill orchestrates parallel agent execution -- multiple Claude instances working on independent tasks simultaneously with branch-isolated git operations.

### Skill Composition
Skills are composable modules with standardized interfaces. Each skill exposes:
- A `SKILL.md` manifest with triggers, workflows, and integration points
- Optional TypeScript tooling in `Tools/` directories
- Workflow definitions in `Workflows/` directories
- Context files that load domain knowledge on demand

### Voice Interaction
Bidirectional voice system supporting desktop (local mic/speaker) and mobile (Telegram) channels, powered by ElevenLabs TTS with configurable voice personalities per agent.

### Persistent Memory
The `MEMORY/` subsystem provides:
- **Learning signals** -- Pattern recognition across sessions with sentiment tracking
- **State management** -- Persistent JSON state for skills, work queues, and cron jobs
- **Validation logs** -- Configuration and work integrity checks
- **Voice event history** -- Timestamped voice interaction logs

### Multi-Agent System
The `Agents/` skill enables dynamic agent composition with:
- Specialized agent roles (Engineer, Designer, Researcher)
- Personality trait mapping and voice assignment
- Parallel orchestration with branch isolation

## Skill Catalog

Skills live under `skills/<Category>/<SkillName>/`, organized into 11 top-level categories.
Examples below are illustrative, not exhaustive -- see each category's own `SKILL.md` for the full list.

| Category | Example Skills | Description |
|----------|-----------------|-------------|
| **Agents** | SpecSheet | Agent context files and spec-pipeline support |
| **Automation** | AutonomousWork, QueueRouter, AutoMaintenance, ProactiveEngine | Autonomous execution, queue routing, scheduling |
| **Commerce** | Instacart, JobEngine, Shopping | Online shopping and job search |
| **Communication** | Gmail, Telegram, VoiceInteraction | Email, messaging, and voice interaction |
| **Content** | Art, ContentAggregator, SystemFlowchart, VoiceNotes | Content generation and system visualization |
| **Data** | Apify, BrightData, DataScience, WebAssessment | Data collection and statistical analysis |
| **Development** | Browser, CreateSkill, TDD, ImproveCodebaseArchitecture | Engineering, CLI, and codebase tools |
| **Intelligence** | Research, ArgumentMapper, Evals, KnowledgeGraph | Research, analysis, and evaluation |
| **Life** | Cooking, Anki, Telos, DnD | Lifestyle, goals, and hobbies |
| **Productivity** | CalendarAssistant, DailyBriefing, LucidTasks, LifeOS | Tasks, calendar, and daily planning |
| **System** | AgentMonitor, KayaUpgrade, PublicSync | System integrity, monitoring, and sync |

## Tech Stack

- **Runtime**: Bun (TypeScript/JavaScript)
- **AI Foundation**: Claude Code (Anthropic)
- **Voice**: ElevenLabs TTS with WebSocket streaming
- **Browser Automation**: Playwright CLI (Browse.ts)
- **Messaging**: Telegram Bot API
- **Calendar**: Google Calendar CLI
- **State**: JSON-based persistent state with validation
- **Scheduling**: macOS launchd for cron-style automation

## Quick Start

```bash
# Clone and install
git clone https://github.com/[user]/kaya.git ~/.claude
cd ~/.claude
bun run install.ts

# Launch Claude Code with Kaya loaded
claude
```

See [INSTALL.md](INSTALL.md) for detailed setup instructions.

## How Skills Work

Each skill follows a standardized structure:

```
skills/ExampleSkill/
  SKILL.md            # Manifest: triggers, workflows, integration
  CONTEXT.md          # Optional domain vocabulary
  Tools/              # TypeScript utilities
  Workflows/          # Step-by-step workflow definitions
```

Claude Code reads relevant `SKILL.md` files and follows their workflows. The `USE WHEN` clause describes when a skill applies; there is no separate CORE router.

## Development

```bash
# Run the installer wizard
bun run install.ts

# Validate system integrity
# (within a Claude Code session)
/system integrity check

# Audit skill quality
/skill-audit
```

## Documentation

- [Installation Guide](INSTALL.md) -- Prerequisites, setup, and configuration
- [Architecture](docs/architecture.md) -- System design and data flow
- [ADR-001: Skill-based Architecture](docs/decisions/001-skill-based-architecture.md)
- [ADR-002: Memory Persistence](docs/decisions/002-memory-persistence.md)

## License

MIT


## Related Projects

- [ai-assistant](https://github.com/[user]/ai-assistant) — Autonomous AI assistant powered by Claude Code
- [mcp-toolkit-server](https://github.com/[user]/mcp-toolkit-server) — MCP server toolkit for Claude AI integration
- [context-engineering-toolkit](https://github.com/[user]/context-engineering-toolkit) — Context window optimization tools
