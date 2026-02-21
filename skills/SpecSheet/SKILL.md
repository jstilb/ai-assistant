---
name: SpecSheet
description: Generate comprehensive spec sheets for AI agents and tasks. USE WHEN spec sheet, agent spec, task specification, agent requirements, define agent, agent design document, PRD for agent.
---

# SpecSheet - AI Agent & Task Specification Generator

**Creates comprehensive, actionable specifications for AI agents and tasks through structured interviews.**
## Overview

SpecSheet produces quality spec sheets optimized for AI-driven development. Based on analysis of 2,500+ agent configuration files and industry best practices, it uses an interview-driven approach with a 3-clarification protocol to capture the six core areas that make specifications effective.

**Key Sources:**
- [Addy Osmani's Guide to AI Agent Specs](https://addyosmani.com/blog/good-spec/)
- [TM Forum IG1412 AI Agent Specification Template](https://www.tmforum.org/resources/guidebook/ig1412-ai-agent-specification-template-v1-0-0/)
- [OpenAI Practical Guide to Building Agents](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf)

## Voice Notification

-> Use `notifySync()` from `skills/CORE/Tools/NotificationService.ts`

## Workflow Routing

### Vision Hierarchy Workflows

| Trigger | Workflow | Description |
|---------|----------|-------------|
| "solarpunk vision", "utopian spec", "ideal end state", "ideal spec" | `Workflows/IdealEndState.md` | Research + debate → Solarpunk Vision (utopian north star) |
| "grounded ideal", "achievable spec", "practical ideal" | `Workflows/GroundedIdeal.md` | Technology constraints → achievable excellence with user stories and tech-agnostic criteria |
| "current work spec", "implementation spec", "work spec" | `Workflows/CurrentWork.md` | ISC-ready spec for immediate execution |
| "vision diagram", "spec diagram" | `Workflows/GenerateVisionDiagram.md` | Mermaid diagrams for vision specs |
| "analyze spec", "spec consistency", "cross-artifact check", "validate spec consistency" | `Workflows/AnalyzeSpec.md` | Cross-artifact consistency analysis across vision tiers |

### Standard Spec Workflows

| Trigger | Workflow | Description |
|---------|----------|-------------|
| "create spec", "new spec sheet" | `Workflows/CreateSpec.md` | Full interview → spec generation |
| "quick spec", "minimal spec" | `Workflows/QuickSpec.md` | Abbreviated 5-question interview |
| "spec from description" | `Workflows/SpecFromDescription.md` | Generate spec from natural language description |
| "validate spec" | `Workflows/ValidateSpec.md` | Check existing spec against best practices |
| "lucidtasks spec", "spec for task", "task spec" | `Workflows/LucidTasksSpecSheet.md` | Generate spec from LucidTasks task details |
| "spec audit", "audit task specs" | `Workflows/LucidTasksSpecSheet.md` (batch mode) | Audit all tasks for missing specs |

### Vision Hierarchy

```
SOLARPUNK VISION (Utopian North Star)
    │ Humans, environment, technology in harmony
    │ Unconstrained by current limitations
    ▼
GROUNDED IDEAL (Achievable Excellence)
    │ Best possible with today's technology
    │ Conscious compromises documented
    ▼
CURRENT WORK (Practical Path)
    │ Bridges current state to grounded ideal
    │ Outputs ISC rows for THEALGORITHM
```

### Task-Type Overlays

Current Work specs can apply task-type overlays:
- `Templates/Overlays/AITask.overlay.md` — Agent/automation specifics
- `Templates/Overlays/HumanTask.overlay.md` — Manual work, approvals
- `Templates/Overlays/CodingProject.overlay.md` — Implementation details

## The Six Core Areas

Research shows the most effective AI specs cover these six areas:

### 1. Commands & Capabilities
What the agent can DO. Not just tool names—full executable operations with parameters.

**Interview Questions:**
- What specific actions must this agent perform?
- What tools/APIs will it need access to?
- What's the primary capability vs. supporting capabilities?

### 2. Testing & Validation
How to verify the agent works correctly.

**Interview Questions:**
- How will you know if output is correct?
- What does failure look like?
- What test cases should always pass?
- What accuracy/quality thresholds apply?

### 3. Structure & Context
What the agent needs to understand about its environment.

**Interview Questions:**
- What context must the agent have access to?
- What domain knowledge is required?
- What's the input format? Output format?
- What schemas or data structures are involved?

### 4. Style & Behavior
How the agent should communicate and behave.

**Interview Questions:**
- What tone/voice should responses have?
- Are there formatting requirements?
- How verbose vs. concise?
- Any persona or character traits?

### 5. Workflow & Process
The execution pattern and decision logic.

**Interview Questions:**
- What's the step-by-step process?
- Where are decision points?
- What triggers escalation or human review?
- How does it handle ambiguity?

### 6. Boundaries & Guardrails
The three-tier permission system proven most effective:

| Tier | Description | Example |
|------|-------------|---------|
| ✅ **Always** | Safe actions, no approval needed | Read files, search, format output |
| ⚠️ **Ask First** | High-impact, needs confirmation | Modify production, send emails, make purchases |
| 🚫 **Never** | Absolute prohibitions | Expose secrets, delete without backup, bypass auth |

**Interview Questions:**
- What should this agent ALWAYS be allowed to do?
- What requires human approval first?
- What must NEVER happen under any circumstances?

## AI-Specific Metrics

Effective AI specs include measurable targets:

| Metric | Industry Target | Notes |
|--------|----------------|-------|
| Accuracy | ≥90% | On labeled test set |
| Task Completion | ≥90% | End-to-end success |
| Hallucination Rate | <2% | Fabricated information |
| Response Time | <5s typical | Depends on task complexity |
| Error Recovery | Graceful | Clear error messages, fallback behavior |

## Examples

**Example 1: Create a spec for a research agent**
```
User: "Create a spec sheet for an AI research agent"
→ Invokes CreateSpec workflow
→ Conducts structured interview using AskUserQuestion
→ Generates comprehensive spec with all six areas
→ Outputs markdown spec sheet
```

**Example 2: Quick spec for simple task**
```
User: "Quick spec for a code review agent"
→ Invokes QuickSpec workflow
→ 5 focused questions
→ Generates minimal viable spec
```

**Example 3: Generate from description**
```
User: "Spec from description: An agent that monitors Slack for support questions and drafts responses"
→ Invokes SpecFromDescription workflow
→ Infers answers to interview questions
→ Generates draft spec
→ Highlights areas needing clarification
```

**Example 4: Solarpunk vision**
```
User: "Solarpunk vision for personal knowledge management"
→ Invokes IdealEndState workflow
→ Deep problem excavation interview
→ Extensive research (12 parallel agents)
→ Council debate on problem framing (4 agents, 3 rounds)
→ Unconstrained vision definition (solarpunk themes)
→ Ideal UX design (even "unrealistic" features)
→ Red team challenge (6 attack vectors)
→ Grounding assessment (categorize achievability)
→ Synthesizes into comprehensive Solarpunk Vision spec
```

**Example 5: Grounded ideal**
```
User: "Create grounded ideal for my PKM system"
→ Invokes GroundedIdeal workflow
→ Loads existing Solarpunk Vision (if exists)
→ Technology assessment (what's possible now)
→ Constraint mapping (solarpunk → grounded)
→ Architecture design (practical system)
→ Milestone planning (path to grounded ideal)
→ Outputs achievable excellence spec
```

**Example 6: Current work spec**
```
User: "Current work spec for adding semantic search"
→ Invokes CurrentWork workflow
→ Detects vision context (loads Grounded Ideal)
→ Current state analysis
→ Gap analysis (what this work accomplishes)
→ ISC generation (8-12 verifiable criteria)
→ Applies CodingProject overlay
→ Outputs implementation-ready spec for THEALGORITHM
```

## Template Structure

All generated specs follow this structure:

```markdown
# [Agent/Task Name] Specification

## Overview
- **Purpose**: [One sentence]
- **Owner**: [Who maintains this]
- **Version**: [Semantic version]
- **Last Updated**: [Date]

## 1. Commands & Capabilities
### Primary Capability
### Supporting Capabilities
### Required Tools/APIs

## 2. Testing & Validation
### Success Criteria
### Test Cases
### Quality Metrics

## 3. Structure & Context
### Required Context
### Input Specification
### Output Specification
### Domain Knowledge

## 4. Style & Behavior
### Tone
### Formatting
### Persona (if applicable)

## 5. Workflow & Process
### Step-by-Step Process
### Decision Points
### Escalation Triggers

## 6. Boundaries & Guardrails
### ✅ Always (No Approval)
### ⚠️ Ask First (Requires Confirmation)
### 🚫 Never (Prohibited)

## 7. Integration
### Dependencies
### Feeds Into
### MCPs/APIs Used

## 8. Operational
### Model Requirements
### Latency Expectations
### Monitoring & Observability
```

**Full template:** `Templates/SpecTemplate.md`

## Integration

### Uses
- **AskUserQuestion** - Structured interview flow
- **CORE** - System patterns and standards
- **Prompting** - For spec-to-prompt conversion
- **Research** - Extensive research for IdealEndState workflow (12 parallel agents)
- **Council** - Multi-perspective debate for problem framing
- **RedTeam** - Adversarial challenge of ideal vision
- **LucidTasks** - Task fetching and updating (LucidTasksSpecSheet workflow)

### Feeds Into
- **Agents** - Specs can generate agent prompts
- **CreateSkill** - Specs inform skill creation
- **THEALGORITHM** - Specs define Ideal State Criteria
- **Implementation Roadmaps** - IdealEndState specs guide milestone planning
- **TaskMaintenance** - Weekly spec audit ensures task coverage
- **AutonomousWork** - Specs enable autonomous task execution

### Data Sources
- **LucidTasks** - Task details, notes (for LucidTasksSpecSheet workflow)

## Examples

**Example 5: Generate spec for LucidTasks task**
```
User: "Create a spec for this task" [provides task title or ID]
→ Invokes LucidTasksSpecSheet workflow
→ Fetches task details from LucidTasks DB
→ Classifies task type (agent, feature, bugfix, etc.)
→ Generates appropriate spec
→ Saves spec to plans/Specs/
```

**Example 6: Audit all tasks for specs**
```
User: "Audit my tasks for spec sheets"
→ Invokes LucidTasksSpecSheet workflow in batch mode
→ Fetches all incomplete tasks
→ Filters for spec-worthy tasks
→ Generates specs for tasks missing them
→ Reports: "Generated 12 specs, skipped 45 simple tasks"
```

---

**Last Updated:** 2026-02-01
