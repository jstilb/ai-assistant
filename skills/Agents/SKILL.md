---
name: Agents
description: Dynamic agent composition and management system. USE WHEN user says create custom agents, spin up custom agents, specialized agents, OR asks for agent personalities, available traits, agent voices. Handles custom agent creation, personality assignment, voice mapping, and parallel agent orchestration.
---

# Agents - Custom Agent Composition System

**Auto-routes when user mentions custom agents, agent creation, or specialized personalities.**
## Overview

The Agents skill is a complete agent composition and management system. It consolidates all agent-related infrastructure:
- Dynamic agent composition from traits (expertise + personality + approach)
- Personality definitions and voice mappings
- Custom agent creation with unique voices
- Parallel agent orchestration patterns

## Voice Notification

→ Use `notifySync()` from `skills/CORE/Tools/NotificationService.ts`

### Voice Mapping Flow

Dynamic agents receive voice assignments through a multi-stage resolution pipeline defined in `Data/Traits.yaml`. The resolution follows a strict priority chain: **trait combination mappings → single-trait fallbacks → default voice**.

1. **Trait Inference**: When a task is provided, `inferTraitsFromTask()` scans the task description against keyword lists defined for each expertise, personality, and approach trait. Missing categories receive smart defaults: `analytical` for personality, `thorough` for approach, `research` for expertise.

2. **Combination Mappings**: The resolved trait set is matched against the `mappings` section in `Traits.yaml`. Each mapping specifies a required trait set (e.g., `["skeptical", "analytical"]`) and a target voice. The system finds all mappings where every listed trait is present in the agent's traits, then selects the most specific match (highest trait count). A 3-trait mapping always wins over a 2-trait mapping.

3. **Single-Trait Fallbacks**: If no combination mapping fully matches, the system iterates through the agent's trait keys and checks the `fallbacks` section. The first trait that has a fallback entry provides the voice. Each fallback includes both a voice name and a corresponding `_voice_id` key (e.g., `skeptical: "George"` plus `skeptical_voice_id: "JBFqnCBsd6RMkjVDRZzb"`).

4. **Default Voice**: If neither mappings nor fallbacks produce a match, the system returns the default voice (`Daniel`, ID: `onwK4e9ZLuTAKqWW03F9`).

5. **Voice Registry**: All 41 voices in the registry are tagged with characteristics (e.g., `["authoritative", "measured", "intellectual"]`), descriptive text, and tuned `stability`/`similarity_boost` values for ElevenLabs TTS. Zero pending or placeholder entries remain.

## Workflow Routing

**Available Workflows:**
- **CREATECUSTOMAGENT** - Create specialized custom agents → `Workflows/CreateCustomAgent.md`
- **LISTTRAITS** - Show available agent traits → `Workflows/ListTraits.md`
- **SPAWNPARALLEL** - Launch parallel agents → `Workflows/SpawnParallelAgents.md`

## Examples

**Example 1: Create custom agents for analysis**
```
User: "Spin up 5 custom science agents to analyze this data"
→ Invokes CREATECUSTOMAGENT workflow
→ Runs AgentFactory 5 times with DIFFERENT trait combinations
→ Each agent gets unique personality + matched voice
→ Launches agents in parallel with model: "sonnet"
```

**Example 2: List available traits**
```
User: "What agent personalities can you create?"
→ Invokes LISTTRAITS workflow
→ Displays expertise (security, legal, finance, etc.)
→ Shows personality types (skeptical, enthusiastic, analytical, etc.)
→ Lists approach styles (thorough, rapid, systematic, etc.)
```

**Example 3: Spawn parallel researchers**
```
User: "Launch 10 agents to research these companies"
→ Invokes SPAWNPARALLEL workflow
→ Creates 10 Intern agents (generic, same voice)
→ Uses model: "haiku" for speed
→ Launches spotcheck agent after completion
```

## Architecture

### Hybrid Agent Model

The system uses two types of agents:

| Type | Definition | Best For |
|------|------------|----------|
| **Named Agents** | Persistent identities with backstories (Remy, Ava, Marcus) | Recurring work, voice output, relationships |
| **Dynamic Agents** | Task-specific specialists composed from traits | One-off tasks, novel combinations, parallel work |

### The Agent Spectrum

```
┌─────────────────────────────────────────────────────────────────────┐
│   NAMED AGENTS          HYBRID USE          DYNAMIC AGENTS          │
│   (Relationship)        (Best of Both)      (Task-Specific)         │
├──────────────────────────────────────────────────────────────────────┤
│ Remy, Ava, Marcus   "Security expert      Ephemeral specialist      │
│                      with Johannes's      composed from traits      │
│                      skepticism"                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## Route Triggers

**CRITICAL: The word "custom" is the KEY trigger:**

| User Says | What to Use | Why |
|-----------|-------------|-----|
| "**custom agents**", "create **custom** agents" | AgentFactory | Unique prompts + unique voices |
| "agents", "launch agents", "bunch of agents" | Generic Interns | Same voice, parallel grunt work |
| "use Remy", "get Ava to" | Named agent | Pre-defined personality |

**Other triggers:**
- "agent personalities", "available traits" → LISTTRAITS workflow
- "specialized agents", "expert in X" → CREATECUSTOMAGENT workflow
- "parallel agents", "spawn 5 agents" → SPAWNPARALLEL workflow

## Components

### Data

**Traits.yaml** (`Data/Traits.yaml`)
- Expertise areas: security, legal, finance, medical, technical, research, creative, business, data, communications
- Personality dimensions: skeptical, enthusiastic, cautious, bold, analytical, creative, empathetic, contrarian, pragmatic, meticulous
- Approach styles: thorough, rapid, systematic, exploratory, comparative, synthesizing, adversarial, consultative
- Voice mappings: Trait combinations → ElevenLabs voices
- Voice registry: 41 voices with characteristics (all characterized, zero pending)

### Templates

**DynamicAgent.hbs** (`Templates/DynamicAgent.hbs`)
- Handlebars template for dynamic agent prompts
- Composes: expertise + personality + approach + voice assignment
- Includes operational guidelines and response format

### Tools

**AgentFactory.ts** (`Tools/AgentFactory.ts`)
- Dynamic agent composition engine
- Infers traits from task description
- Maps trait combinations to appropriate voices
- Outputs complete agent prompt ready for Task tool

```bash
# Usage examples
bun run ~/.claude/skills/Agents/Tools/AgentFactory.ts --task "Review security architecture"
bun run ~/.claude/skills/Agents/Tools/AgentFactory.ts --traits "legal,skeptical,meticulous"
bun run ~/.claude/skills/Agents/Tools/AgentFactory.ts --list
```

### Personalities

**AgentPersonalities.md** (`AgentPersonalities.md`)
- Named agent definitions with full backstories
- Voice settings and personality traits
- Character development and communication styles
- JSON configuration for voice server

**Named Agents:**
- Jamie - Expressive eager buddy
- Rook Blackburn (Pentester) - Reformed grey hat
- Priya Desai (Artist) - Aesthetic anarchist
- Aditi Sharma (Designer) - Design school perfectionist
- Dev Patel (Intern) - Brilliant overachiever
- Ava Chen (Perplexity) - Investigative analyst
- Ava Sterling (Claude) - Strategic sophisticate
- Alex Rivera (Gemini) - Multi-perspective analyst
- Marcus Webb (Engineer) - Battle-scarred leader
- Serena Blackwood (Architect) - Academic visionary
- Emma Hartley (Writer) - Technical storyteller

## Integration Points

### CORE ConfigLoader (`skills/CORE/Tools/ConfigLoader.ts`)

AgentFactory uses `loadTieredConfig()` from the CORE ConfigLoader for traits loading. The tiered config system checks for user-level overrides (USER tier), then system-level config (SYSTEM tier), before falling back to the legacy `Data/Traits.yaml` path. This enables per-user trait customization without modifying the skill directly. The config key is `agents-traits` with environment prefix `KAYA_AGENTS`.

### Prompting Helpers (`skills/Prompting/Tools/helpers.ts`)

AgentFactory imports and registers shared Handlebars helpers via `registerHelpers()` from the Prompting skill. These helpers (uppercase, lowercase, titlecase, conditionals, etc.) are available within `Templates/DynamicAgent.hbs` for template rendering. The registration is idempotent and happens once at module load time.

### Voice Server (`~/.claude/VoiceServer/`)

The VoiceServer is a local HTTP service that converts text to speech via ElevenLabs. Dynamic agents receive a `voiceId` from the voice resolution pipeline, which the orchestrating system passes to the VoiceServer when speaking the agent's `COMPLETED` line. The voice server configuration (`voices.json`) maps named roles (engineer, researcher, etc.) to voice IDs, while dynamic agents bypass this mapping by providing their voice ID directly.

- Server endpoint: `http://localhost:8888/notify`
- Named agents: voice mapped via `voices.json` role lookup
- Dynamic agents: voice mapped via `Traits.yaml` registry and resolution pipeline
- Personality-driven voice notifications use `notifySync()` from CORE

### CORE Skill (`~/.claude/skills/CORE/`)

The CORE skill references Agents for custom agent creation in its delegation patterns. It documents the distinction between custom agents (unique trait-composed personalities with matched voices) and generic intern agents (parallel grunt work with shared voice). The CORE routing logic directs "custom agent" requests to the Agents skill's CREATECUSTOMAGENT workflow.

## Usage Patterns

### For Users (Natural Language)

Users talk naturally:
- "I need a legal expert to review this contract" → System composes legal + analytical + thorough agent
- "Spin up 5 custom science agents" → System uses AgentFactory 5 times with different traits
- "Launch agents to research these companies" → System spawns generic Intern agents
- "Get me someone skeptical about security" → System composes security + skeptical + adversarial agent

### Internal Process

When user says "custom agents", the assistant:
1. Invokes CREATECUSTOMAGENT workflow
2. Runs AgentFactory for EACH agent with DIFFERENT trait combinations
3. Gets unique prompt + voice ID for each
4. Launches agents using Task tool with the composed prompt
5. Each agent has a distinct personality-matched voice

Example internal execution:
```bash
# User: "Create 3 custom research agents"

# Agent 1
bun run AgentFactory.ts --traits "research,enthusiastic,exploratory"
# Output: Prompt with voice "Jeremy" (energetic)

# Agent 2
bun run AgentFactory.ts --traits "research,skeptical,thorough"
# Output: Prompt with voice "George" (intellectual)

# Agent 3
bun run AgentFactory.ts --traits "research,analytical,systematic"
# Output: Prompt with voice "Drew" (professional)

# Launch all 3 with Task tool
Task({ prompt: <agent1_prompt>, subagent_type: "Intern", model: "sonnet" })
Task({ prompt: <agent2_prompt>, subagent_type: "Intern", model: "sonnet" })
Task({ prompt: <agent3_prompt>, subagent_type: "Intern", model: "sonnet" })
```

## Model Selection

Always specify the appropriate model:

| Task Type | Model | Speed Multiplier |
|-----------|-------|------------------|
| Grunt work, simple checks | `haiku` | 10-20x faster |
| Standard analysis, research | `sonnet` | Balanced |
| Deep reasoning, architecture | `opus` | Maximum intelligence |

**Rule:** Parallel agents especially benefit from `haiku` for speed.

## Related Skills

- **CORE** - Main system identity and delegation patterns
- **VoiceNarration** - Voice output for content (separate from agent notifications)
- **Development** - Uses Engineer and Architect agents

## Version History

- **v1.1.0** (2026-02-10): Template hardening (triple-brace removal), voice characterization (14 voices: Kael, Haseeb, Liberty, Hope, Brittney, Nolan, Mariana, Bradford, Ravi, Elena, Manav, Soren, Peter, Talia), test suite (90%+ coverage), SKILL.md documentation expansion
- **v1.0.0** (2025-12-16): Initial creation - consolidated all agent infrastructure into discrete skill
