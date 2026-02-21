# Kaya Agent System

The three-tier agent system for Kaya. Defines when and how to use each tier.

---

## Three-Tier Architecture

| Tier | What | Mechanism | When |
|------|------|-----------|------|
| **Tier 1: Task Subagents** | Intern, Architect, Engineer, etc. | Claude Code Task tool (`subagent_type`) | Grunt work, spotcheck, research, parallel processing |
| **Tier 2: Named/Dynamic Agents** | AgentFactory compositions + personality backstories | `AgentFactory.ts` + `Traits.yaml` | Recurring work, voice diversity, unique expertise combinations |
| **Tier 3: Agent Teams** | Independent Claude Code instances with P2P messaging | `TeamsBridge.ts` | Autonomous work, git-safe parallel execution, coordination |

---

## Tier 1: Task Subagents

Pre-built workflow agents invoked via the Task tool. These run in the same process and share git context.

### Available Types

| Type | Purpose | Model |
|------|---------|-------|
| `Intern` | General-purpose grunt work, parallel processing | haiku/sonnet |
| `Engineer` | Code implementation, TDD | sonnet/opus |
| `Architect` | System design, architecture decisions | opus |
| `Designer` | UX/UI design, user-centered solutions | sonnet |
| `Explore` | Codebase exploration, file search | haiku/sonnet |
| `Plan` | Implementation planning | sonnet/opus |
| `ClaudeResearcher` | Academic research, multi-query search | sonnet |
| `GeminiResearcher` | Multi-perspective Google Gemini research | sonnet |
| `GrokResearcher` | Contrarian fact-based research via xAI | sonnet |
| `CodexResearcher` | Technical archaeology, code deep-dives | sonnet |
| `Pentester` | Security testing, vulnerability assessment | sonnet |
| `QATester` | Browser-based quality assurance | sonnet |
| `Algorithm` | ISC creation and evolution | opus |

### Usage Pattern

```typescript
Task({
  description: "Research competitors",
  prompt: "Research these 5 companies...",
  subagent_type: "Intern",
  model: "haiku"
})
```

### Limitations

- **Shared process**: All subagents run in the same process
- **No P2P messaging**: Subagents cannot communicate with each other directly
- **Git contamination risk**: Concurrent git operations can cross-contaminate branches
- **No persistent identity**: Each invocation starts fresh

### Best For

- Simple parallel research (same task, different inputs)
- Spotcheck verification
- One-off analysis tasks
- Quick file exploration

---

## Tier 2: Named/Dynamic Agents

Agents with persistent identities, backstories, and voice mappings. Composed via `AgentFactory.ts` from traits defined in `Traits.yaml`.

### Named Agents (Persistent Identities)

| Agent | Type | Voice | Specialty |
|-------|------|-------|-----------|
| Ava Chen | ClaudeResearcher | Strategic thinker | Research, investigation |
| Marcus Webb | Engineer | Battle-scarred leader | Implementation, code |
| Serena Blackwood | Architect | Academic visionary | System design |
| Rook Blackburn | Pentester | Reformed grey hat | Security |
| Dev Patel | Intern | Brilliant overachiever | General purpose |
| Aditi Sharma | Designer | User advocate | UX/UI |
| Remy | CodexResearcher | Curious archaeologist | Code deep-dives |
| Johannes | GrokResearcher | Contrarian fact-checker | Unbiased analysis |

### Dynamic Composition

Compose agents on-the-fly from trait categories:

- **Expertise**: security, legal, finance, medical, technical, research, creative, business, data, communications
- **Personality**: skeptical, enthusiastic, cautious, bold, analytical, creative, empathetic, contrarian, pragmatic, meticulous
- **Approach**: thorough, rapid, systematic, exploratory, comparative, synthesizing, adversarial, consultative

```bash
bun run AgentFactory.ts --traits "security,skeptical,adversarial" --task "Red team this API" --output json
```

### Usage

- When user says **"custom agents"** -> invoke Agents skill, which uses AgentFactory
- When user says **"agents"** (no "custom") -> use Tier 1 Intern subagents
- When user says **named agent** (e.g., "get Ava to...") -> use that named agent's subagent_type

### Best For

- Tasks requiring unique expertise combinations
- Voice diversity in results presentation
- Recurring work with relationship continuity
- Council debates with distinct perspectives

---

## Tier 3: Agent Teams

Independent Claude Code instances that each run in their own process with their own git context. Communicate via file-based inbox messaging. Managed through `TeamsBridge.ts`.

### Architecture

```
┌────────────────────────────────────────┐
│           TEAMS BRIDGE                  │
│   (TeamsBridge.ts - abstraction layer) │
└───────┬──────────┬──────────┬──────────┘
        │          │          │
   ┌────▼───┐ ┌───▼────┐ ┌──▼─────┐
   │Member 1│ │Member 2│ │Member 3│
   │(claude)│ │(claude)│ │(claude)│
   │own git │ │own git │ │own git │
   │context │ │context │ │context │
   └───┬────┘ └───┬────┘ └───┬────┘
       │          │          │
       └──────────┼──────────┘
                  │
            ┌─────▼─────┐
            │  Inboxes   │
            │  (P2P msgs)│
            └────────────┘
```

### Key Benefit: Git Safety

Each team member is a separate `claude -p` process with its own working directory and git context. This eliminates the branch contamination bug where concurrent `git checkout` operations in a shared process cause commits to land on wrong branches.

### Feature Flag

Controlled by environment variable:

```
CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
```

When unavailable, all code gracefully falls back to Tier 1 patterns (Promise.allSettled with subagents).

### Communication

- **Inbox messaging**: Each member has a file-based inbox (`messages.json`)
- **Broadcast**: Lead can send to all members simultaneously
- **Shared task queue**: File-based task queue visible to all members
- **Results directory**: Each member writes results to disk

### Usage Pattern

```typescript
import { TeamsBridge } from './TeamsBridge.ts';

if (TeamsBridge.isAvailable()) {
  const team = await TeamsBridge.create({
    teamName: 'batch-work',
    delegateMode: true,
    autoCleanup: true,
  });

  if (team) {
    const results = await team.spawn([
      { role: 'worker-1', task: 'Build feature A', workingDir: '/path/a' },
      { role: 'worker-2', task: 'Build feature B', workingDir: '/path/b' },
    ]);

    await team.broadcast('Starting coordination phase');
    // ... monitor progress via shared tasks ...
    await team.cleanup();
  }
} else {
  // Legacy fallback: Promise.allSettled with Task subagents
  const results = await Promise.allSettled(items.map(processItem));
}
```

### Best For

- **Autonomous work** (AutonomousWork skill batch processing)
- **Git-safe parallel execution** (each member on its own branch)
- **Agent coordination** (Council debates with direct P2P messaging)
- **Multi-agent scenarios** (Simulation fault injection testing)
- **Staged deployment** (RedTeam collaborative attack discovery)

---

## Routing Decision Matrix

| User Says | Tier | Why |
|-----------|------|-----|
| "Research these 5 companies" | Tier 1 (Intern) | Simple parallel, same task |
| "Custom agents to analyze this" | Tier 2 (AgentFactory) | Unique expertise needed |
| "Get Ava to investigate" | Tier 2 (Named) | Specific agent requested |
| "Start autonomous work" | Tier 3 (Teams) | Git safety, independent processes |
| "Council debate on X" | Tier 1 or 3 | Tier 1 default, Tier 3 if Teams available |
| "Red team this argument" | Tier 1 | 32 parallel agents, no git needed |
| "Run ralph loop" | Tier 1 or 3 | Tier 3 for within-iteration parallelism |

---

## Integration Points

| Skill | Tier 1 | Tier 2 | Tier 3 |
|-------|--------|--------|--------|
| AutonomousWork | Legacy fallback | - | Primary (git safety) |
| Agents | Intern spawning | AgentFactory | Team-aware composition |
| Council | Current (transcript passing) | Named personalities | P2P debate (preferred) |
| RedTeam | Current (32 parallel) | - | Staged deployment |
| Simulation | Single-agent | - | Multi-agent scenarios |
| Evals | Standard grading | - | Team coordination grading |
| AgentMonitor | Trace collection | - | Team inbox monitoring |
| _RALPHLOOP | Current (single agent) | - | Parallel exploration |

---

## Key Files

| File | Purpose |
|------|---------|
| `skills/CORE/Tools/TeamsBridge.ts` | Central Agent Teams abstraction |
| `skills/CORE/Tools/TeamsBridge.test.ts` | Unit tests |
| `skills/CORE/Tools/AgentOrchestrator.ts` | Tier 1 orchestration |
| `skills/Agents/Tools/AgentFactory.ts` | Tier 2 dynamic composition |
| `skills/Agents/Data/Traits.yaml` | Trait definitions |
| `skills/CORE/Workflows/Delegation.md` | Delegation routing guide |

---

## Anti-Patterns

| Do NOT | Instead |
|--------|---------|
| Use Tier 1 for concurrent git operations | Use Tier 3 (Teams) for git safety |
| Use Tier 2 for simple parallel grunt work | Use Tier 1 (Intern) for speed |
| Skip fallback when Teams unavailable | Always provide Promise.allSettled fallback |
| Assume Teams feature is enabled | Always check `TeamsBridge.isAvailable()` first |
| Use Task subagent_types for "custom agents" | Invoke Agents skill / AgentFactory |

---

*Last updated: 2026-02-06*
