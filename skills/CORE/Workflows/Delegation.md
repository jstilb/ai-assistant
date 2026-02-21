# Delegation Workflow

Comprehensive guide to delegating tasks to agents in the hybrid agent system.

## 🚨 CRITICAL: Agent Type Selection

**FIRST, determine what the user is asking for:**

| User Says | Action | Tool |
|-------------|--------|------|
| "**custom agents**", "spin up **custom** agents" | Use **AgentFactory** to generate unique agents with distinct voices | `bun run AgentFactory.ts` |
| "spin up agents", "launch agents", "bunch of agents" | Use **generic Intern** agents for parallel grunt work | `Task(subagent_type="Intern")` |
| "interns", "use interns" | Use **Intern** agents | `Task(subagent_type="Intern")` |
| "use Ava", "get Remy to", "[named agent]" | Use the **named agent** directly | `Task(subagent_type="PerplexityResearcher")` |

**The word "custom" is the KEY differentiator:**
- "custom agents" → AgentFactory (unique prompts + unique voices)
- "agents" (no "custom") → Interns (same voice, parallel work)

### 🚫 FORBIDDEN — Never Do This

When user says "custom agents", **NEVER** use Task tool subagent_types directly:

```typescript
// ❌ WRONG - These are NOT custom agents
Task({ subagent_type: "Architect", prompt: "..." })
Task({ subagent_type: "Designer", prompt: "..." })
Task({ subagent_type: "Engineer", prompt: "..." })
```

Task tool subagent_types (Architect, Designer, Engineer, etc.) are pre-built workflow agents. They do NOT have unique voices or AgentFactory composition. They are for internal workflow use only.

**For custom agents, invoke the Agents skill** → `Skill("Agents")` or follow CreateCustomAgent workflow.

See: `SYSTEM/PAIAGENTSYSTEM.md` for full routing rules | `skills/Agents/SKILL.md` for agent composition system.

---

## How the User Interacts

**Users just talk naturally.** Examples:

- "Research these 5 companies for me" → I spawn 5 parallel Intern agents
- "Spin up custom agents to analyze psychology" → I use AgentFactory for each agent
- "I need a legal expert to review this contract" → I compose a dynamic agent
- "Get Ava to investigate this" → I use the named Perplexity researcher
- "I need someone skeptical about security to red-team this" → I compose security + skeptical + adversarial

**Users never touch CLI tools.** The system uses them internally based on what you ask for.

## Triggers

- "delegate", "spawn agents", "launch agents" → Interns
- "**custom agents**", "specialized agents" → AgentFactory
- "use an intern", "use researcher", "use [agent name]" → Named/Intern
- "in parallel", "parallelize" → Multiple agents
- "I need an expert in", "get me someone who" → Dynamic composition

## The Hybrid Agent Model

The system supports two types of agents:

| Type | Definition | Best For |
|------|------------|----------|
| **Named Agents** | Persistent identities with backstories and voice mappings | Recurring work, voice output, relationship continuity |
| **Dynamic Agents** | Task-specific specialists composed from traits | One-off tasks, novel combinations, parallel grunt work |

**I decide which to use based on your request.** You don't need to specify.

## Named Agents (When I Use Them)

| Agent | Personality | I Use When You Say... |
|-------|-------------|----------------------|
| Ava (Perplexity) | Investigative journalist | "research", "find out", "investigate" |
| Ava Sterling (Claude) | Strategic thinker | "analyze strategically", "what are implications" |
| Alex (Gemini) | Multi-perspective | "get different viewpoints", "comprehensive" |
| Johannes (Grok) | Contrarian fact-checker | "challenge this", "what's wrong with" |
| Remy (Codex) | Curious technical archaeologist | "dig into the code", "how does this work" |
| Marcus (Engineer) | Battle-scarred leader | "implement this", "build", "code" |
| Serena (Architect) | Academic visionary | "design the system", "architecture" |
| Rook (Pentester) | Reformed grey hat | "security test", "find vulnerabilities" |
| Dev (Intern) | Brilliant overachiever | General-purpose, parallel tasks |

## Dynamic Agents (When I Compose Them)

When your request needs a specific expertise combination that no named agent provides, I compose one from traits.

**Example:** "I need someone with legal expertise who's really skeptical to review this contract for security issues"

I internally run:
```
AgentFactory --traits "legal,security,skeptical,meticulous,systematic"
```

And get a custom agent with exactly those characteristics.

### Available Traits I Can Compose

**Expertise** (domain knowledge):
- security, legal, finance, medical, technical
- research, creative, business, data, communications

**Personality** (behavior style):
- skeptical, enthusiastic, cautious, bold, analytical
- creative, empathetic, contrarian, pragmatic, meticulous

**Approach** (work style):
- thorough, rapid, systematic, exploratory
- comparative, synthesizing, adversarial, consultative

### Example Compositions

| You Say | I Compose |
|---------|-----------|
| "Legal expert, really thorough" | legal + meticulous + thorough |
| "Security red team" | security + contrarian + adversarial |
| "Quick business assessment" | business + pragmatic + rapid |
| "Empathetic user researcher" | research + empathetic + synthesizing |

## Internal Tools (For System Use)

These are the tools I use behind the scenes:

```bash
# Compose dynamic agent
bun run ~/.claude/skills/Agents/Tools/AgentFactory.ts --task "..." --output prompt

# List available traits
bun run ~/.claude/skills/Agents/Tools/AgentFactory.ts --list
```

### Available Traits

**Expertise** (domain knowledge):
- `security` - Vulnerabilities, threats, defense strategies
- `legal` - Contracts, compliance, liability
- `finance` - Valuation, markets, ROI
- `medical` - Healthcare, clinical, treatment
- `technical` - Software, architecture, debugging
- `research` - Academic methodology, source evaluation
- `creative` - Content, storytelling, visual thinking
- `business` - Strategy, competitive analysis, operations
- `data` - Statistics, visualization, patterns
- `communications` - Messaging, audience, PR

**Personality** (behavior style):
- `skeptical` - Questions assumptions, demands evidence
- `enthusiastic` - Finds excitement, positive framing
- `cautious` - Considers edge cases, failure modes
- `bold` - Takes risks, makes strong claims
- `analytical` - Data-driven, logical, systematic
- `creative` - Lateral thinking, unexpected connections
- `empathetic` - Considers human impact, user-centered
- `contrarian` - Takes opposing view, stress-tests
- `pragmatic` - Focuses on what works
- `meticulous` - Attention to detail, precision

**Approach** (work style):
- `thorough` - Exhaustive, no stone unturned
- `rapid` - Quick assessment, key points
- `systematic` - Structured, step-by-step
- `exploratory` - Follow interesting threads
- `comparative` - Evaluates options, trade-offs
- `synthesizing` - Combines sources, integrates
- `adversarial` - Red team, find weaknesses
- `consultative` - Advisory, recommendations

### Example Compositions

```bash
# Security architecture review
--traits "security,skeptical,thorough,adversarial"

# Legal contract review
--traits "legal,cautious,meticulous,systematic"

# Creative content development
--traits "creative,enthusiastic,exploratory"

# Red team critique
--traits "contrarian,skeptical,adversarial,bold"

# Quick business assessment
--traits "business,pragmatic,rapid,comparative"
```

## Model Selection

**CRITICAL FOR SPEED**: Always specify the right model for the task.

| Task Type | Model | Why |
|-----------|-------|-----|
| Deep reasoning, architecture | `opus` | Maximum intelligence |
| Standard implementation, analysis | `sonnet` | Balance of speed + capability |
| Simple checks, parallel grunt work | `haiku` | 10-20x faster, sufficient |

```typescript
// WRONG - defaults to Opus, takes minutes
Task({ prompt: "Check if file exists", subagent_type: "Intern" })

// RIGHT - Haiku for simple task
Task({ prompt: "Check if file exists", subagent_type: "Intern", model: "haiku" })
```

**Rule of Thumb:**
- Grunt work or verification → `haiku`
- Implementation or research → `sonnet`
- Strategic/architectural → `opus` or default

## Foreground Delegation

Standard blocking delegation - waits for agent to complete.

### Single Agent

```typescript
Task({
  description: "Research competitor",
  prompt: "Investigate Acme Corp's recent product launches...",
  subagent_type: "PerplexityResearcher",
  model: "sonnet"
})
// Blocks until complete, returns result
```

### Parallel Agents

**ALWAYS use a single message with multiple Task calls for parallel work:**

```typescript
// Send as SINGLE message with multiple tool calls
Task({
  description: "Research company A",
  prompt: "Investigate Company A...",
  subagent_type: "Intern",
  model: "haiku"
})
Task({
  description: "Research company B",
  prompt: "Investigate Company B...",
  subagent_type: "Intern",
  model: "haiku"
})
Task({
  description: "Research company C",
  prompt: "Investigate Company C...",
  subagent_type: "Intern",
  model: "haiku"
})
// All run in parallel, all results returned together
```

### Spotcheck Pattern

**ALWAYS launch a spotcheck intern after parallel work:**

```typescript
// After parallel agents complete
Task({
  description: "Spotcheck parallel results",
  prompt: "Review these results for consistency and completeness: [results]",
  subagent_type: "Intern",
  model: "haiku"
})
```

## Background Delegation

Non-blocking delegation - agents run while you continue working.

See: `Workflows/BackgroundDelegation.md` for full details.

```typescript
Task({
  description: "Background research",
  prompt: "Research X...",
  subagent_type: "PerplexityResearcher",
  model: "haiku",
  run_in_background: true  // Returns immediately
})
// Returns { agent_id: "abc123", status: "running" }

// Check later
TaskOutput({ agentId: "abc123", block: false })

// Retrieve when ready
TaskOutput({ agentId: "abc123", block: true })
```

## Decision Matrix

### Named vs Dynamic

| Situation | Choice | Reason |
|-----------|--------|--------|
| "Research AI news" | Named (Ava/Perplexity) | Standard research, voice needed |
| "Review this contract for security risks" | Dynamic (legal+security+cautious) | Novel combination |
| "Explore the codebase" | Named (Explore agent) | Built for this |
| "Create 5 parallel researchers" | Dynamic (research+rapid) | Grunt work, no personality needed |
| "Red team this idea" | Named (Johannes) OR Dynamic | Depends on whether voice needed |
| "Strategic architecture review" | Named (Serena) | Deep expertise, relationship |

### Foreground vs Background

| Situation | Choice | Reason |
|-----------|--------|--------|
| Need results immediately | Foreground | Blocking is fine |
| Have other work to do | Background | Don't want to wait |
| 3+ parallel tasks | Background | More flexible |
| Single quick task | Foreground | Simpler |
| Newsletter research | Background | Write while researching |

## Full Context Requirements

When delegating, ALWAYS include:

1. **WHY** - Business context, why this matters
2. **WHAT** - Current state, existing implementation
3. **EXACTLY** - Precise actions, file paths, patterns
4. **SUCCESS CRITERIA** - What good output looks like

```typescript
Task({
  description: "Audit auth security",
  prompt: `
    ## Context
    We're preparing for SOC 2 audit. Need to verify our auth implementation.

    ## Current State
    Auth is in src/auth/, uses JWT with refresh tokens.

    ## Task
    1. Review all auth-related code
    2. Check for OWASP Top 10 vulnerabilities
    3. Verify token handling is secure
    4. Check for timing attacks in password comparison

    ## Success Criteria
    - Comprehensive security assessment
    - Specific file:line references for any issues
    - Severity ratings for each finding
    - Remediation recommendations
  `,
  subagent_type: "Pentester",
  model: "sonnet"
})
```

## Tier 3: Agent Teams Delegation

When `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` is set, a third delegation tier becomes available that spawns agents as a coordinated team with isolated processes and P2P messaging.

### When to Use Agent Teams (Tier 3)

| Scenario | Use Teams? | Why |
|----------|-----------|-----|
| Multiple agents doing concurrent git work (branching, commits) | **Yes** | Prevents branch contamination from concurrent `git checkout` |
| Multi-agent coordination where agents need to share intermediate results | **Yes** | P2P messaging enables direct agent-to-agent communication |
| Parallel implementation tasks across different directories | **Yes** | Each member gets its own `workingDir` and process isolation |
| Simple independent research tasks | No | Regular Task tool is simpler and sufficient |
| Single agent delegation | No | Teams overhead is not justified for one agent |

### Decision Criteria: Teams vs Regular Delegation

Use this flowchart to decide:

1. **Is `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` set?** No -> Use regular Tier 1/2 delegation.
2. **Are agents doing concurrent git operations?** Yes -> Use Teams (mandatory to prevent contamination).
3. **Do agents need to communicate with each other mid-task?** Yes -> Use Teams (P2P messaging).
4. **Are there more than 3 agents working on interdependent tasks?** Yes -> Use Teams (shared task queue helps coordination).
5. **Otherwise** -> Regular delegation is fine.

### How to Invoke

Teams delegation is accessed through the orchestrator's `spawnAsTeam()` method, which handles all the TeamsBridge setup and teardown automatically:

```typescript
import { orchestrator } from '~/.claude/skills/CORE/Tools/AgentOrchestrator.ts';

// Spawns as team when Teams is available, falls back to spawn() otherwise
const results = await orchestrator.spawnAsTeam(
  [
    { type: 'Engineer', name: 'frontend', model: 'sonnet' },
    { type: 'Engineer', name: 'backend', model: 'sonnet' },
    { type: 'Intern', name: 'tests', model: 'haiku' },
  ],
  'Implement the user profile feature',
  { teamName: 'profile-feature' }
);
```

### Routing Rules Update

The full delegation routing priority is now:

1. **Tier 1 - Direct Delegation**: Single agent, simple task, no coordination needed. Use `Task()` tool.
2. **Tier 2 - Orchestrated Delegation**: Multiple agents, parallel work, result aggregation needed. Use `orchestrator.spawn()` or `orchestrator.spawnWithAggregation()`.
3. **Tier 3 - Team Delegation**: Multiple agents needing git isolation, P2P messaging, or shared task queues. Use `orchestrator.spawnAsTeam()`. Automatically falls back to Tier 2 when Teams is unavailable.

### Reference

- TeamsBridge: `~/.claude/skills/CORE/Tools/TeamsBridge.ts`
- Agent Teams architecture: `~/.claude/SYSTEM/PAIAGENTSYSTEM.md`
- SpawnParallelAgents Teams mode: `~/.claude/skills/Agents/Workflows/SpawnParallelAgents.md`

## Related

- **Agents skill**: `~/.claude/skills/Agents/` - Complete agent composition system
  - Agent personalities: `AgentPersonalities.md`
  - Traits: `Data/Traits.yaml`
  - Agent factory: `Tools/AgentFactory.ts`
  - Workflows: `Workflows/CreateCustomAgent.md`, `Workflows/SpawnParallelAgents.md`
- Background delegation: `~/.claude/skills/CORE/Workflows/BackgroundDelegation.md`
