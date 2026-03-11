# Kaya -- Personal AI Infrastructure

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0%2B-blue.svg)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/runtime-Bun-f472b6.svg)](https://bun.sh/)
[![Skills](https://img.shields.io/badge/skills-60%2B-brightgreen.svg)](#skill-catalog)
[![Claude Code](https://img.shields.io/badge/powered%20by-Claude%20Code-6366f1.svg)](https://docs.anthropic.com/en/docs/claude-code)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)

A production-grade AI agent framework with 60+ composable skills, autonomous task execution, voice interaction, and persistent memory. Built on Anthropic's Claude Code as the foundation for a fully autonomous personal AI assistant.

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
  skills/             # 60+ composable skill modules
    Agents/           # Multi-agent orchestration and composition
    AutonomousWork/   # Parallel task execution engine
    CalendarAssistant/# Google Calendar automation
    VoiceInteraction/ # Bidirectional voice (desktop + mobile)
    Browser/          # Playwright-based browser automation
    ...               # 55+ more skills
  agents/             # Agent personality definitions and traits
  bin/                # CLI tools and cron scripts
  hooks/              # Git hooks and lifecycle automation
  lib/                # Shared libraries (cron, daemon, messaging)
  VoiceServer/        # ElevenLabs-powered TTS server
  MEMORY/             # Persistent state, learnings, and context
  Observability/      # System monitoring and health checks
  KAYASECURITYSYSTEM/  # Security protocols and threat models
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
- Council-style multi-agent debates

## Skill Catalog

| Category | Skills | Description |
|----------|--------|-------------|
| **Core** | System, lib/core | System kernel and maintenance |
| **Agents** | Agents, AgentMonitor, Council, Simulation | Multi-agent orchestration and evaluation |
| **Productivity** | CalendarAssistant, Gmail, Kaya, DailyBriefing | Personal assistant capabilities |
| **Development** | AgentProjectSetup, CreateCLI, CreateSkill, Browser | Engineering and automation tools |
| **Research** | OSINT, Recon, FirstPrinciples, RedTeam | Intelligence gathering and analysis |
| **Content** | ContentAggregator, Fabric, Obsidian, KnowledgeGraph | Knowledge management and synthesis |
| **Commerce** | Shopping, Instacart, Cooking | Consumer automation |
| **Communication** | Telegram, VoiceInteraction, CommunityOutreach | Messaging and outreach |
| **Security** | WebAssessment, PromptInjection, KAYASECURITYSYSTEM | Security testing and protocols |
| **Meta** | SkillAudit, SpecSheet, Evals, KayaUpgrade | Self-improvement and quality |

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

# Start the voice server
cd VoiceServer && ./start.sh

# Launch Claude Code with Kaya loaded
claude
```

See [INSTALL.md](INSTALL.md) for detailed setup instructions.

## How Skills Work

Each skill follows a standardized structure:

```
skills/ExampleSkill/
  SKILL.md            # Manifest: triggers, workflows, integration
  _Context.md         # Domain knowledge loaded on demand
  Tools/              # TypeScript utilities
  Workflows/          # Step-by-step workflow definitions
```

Skills are discovered and loaded dynamically by the CORE router based on keyword matching in user requests. The router reads each skill's `USE WHEN` trigger clause to determine relevance.

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
- [Voice Server](VoiceServer/README.md) -- TTS server setup and usage

## License

MIT


## Related Projects

- [ai-assistant](https://github.com/[user]/ai-assistant) — Autonomous AI assistant powered by Claude Code
- [mcp-toolkit-server](https://github.com/[user]/mcp-toolkit-server) — MCP server toolkit for Claude AI integration
- [context-engineering-toolkit](https://github.com/[user]/context-engineering-toolkit) — Context window optimization tools
