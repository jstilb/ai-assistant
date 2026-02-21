# CreateSpec Workflow

**Full interview-driven specification generation for AI agents and tasks.**

## Prerequisites

Before starting, confirm:
- User has a clear agent/task concept (even if vague)
- User is available for 8-12 questions

## Clarification Protocol

During the interview, limit follow-up clarification to a maximum of **3 questions**.

**Priority order for clarifications:**
1. Scope — what's in/out
2. Security/Privacy — data handling, access control
3. UX — user-facing behavior
4. Technical — integration details

Beyond 3 clarifications, make informed guesses using context and industry standards. Mark inferred answers with `⚠️ INFERRED - verify`.

## Interview Flow

The interview uses AskUserQuestion with the native Claude Code UI. Each phase covers one of the six core areas.

### Phase 0: Foundation

**Question 0.1: What are you building?**
```
Header: "Agent Type"
Question: "What kind of AI agent or task are you specifying?"
Options:
- "Autonomous Agent" - Works independently, makes decisions
- "Task Executor" - Follows explicit instructions
- "Assistant/Copilot" - Augments human work
- "Pipeline Component" - Part of larger system
```

**Question 0.2: Name and purpose**
```
Header: "Identity"
Question: "What should this agent be called, and what's its primary purpose in one sentence?"
Options: [Text input - no predefined options]
```

### Phase 1: Commands & Capabilities

**Question 1.1: Primary capability**
```
Header: "Core Function"
Question: "What is the ONE main thing this agent must do well?"
Options: [Text input]
```

**Question 1.2: Supporting capabilities**
```
Header: "Additional Functions"
Question: "What other capabilities does it need to support its primary function?"
Options:
- "Read/analyze content"
- "Search/retrieve information"
- "Generate/create content"
- "Modify/transform data"
- "Communicate/notify"
- "Integrate with external systems"
multiSelect: true
```

**Question 1.3: Tools and APIs**
```
Header: "Tools"
Question: "What tools, APIs, or systems will this agent need access to?"
Options: [Text input]
```

### Phase 2: Testing & Validation

**Question 2.1: Success definition**
```
Header: "Success Criteria"
Question: "How will you know if the agent's output is correct?"
Options:
- "Matches expected format/schema"
- "Passes automated tests"
- "Human review approval"
- "Measurable metrics (accuracy, speed)"
- "No errors/exceptions"
multiSelect: true
```

**Question 2.2: Failure modes**
```
Header: "Failure Modes"
Question: "What does failure look like for this agent? What must NOT happen?"
Options: [Text input]
```

**Question 2.3: Quality thresholds**
```
Header: "Quality Bar"
Question: "What quality thresholds apply?"
Options:
- "High accuracy (≥95%)" - Critical decisions, production systems
- "Standard accuracy (≥90%)" - Most use cases
- "Best effort" - Non-critical, exploratory
- "Custom metrics" - I'll specify
```

### Phase 3: Structure & Context

**Question 3.1: Required context**
```
Header: "Context"
Question: "What context must this agent have access to?"
Options:
- "Codebase/file system"
- "Documentation/knowledge base"
- "User preferences/history"
- "External data sources"
- "Previous conversation/session"
- "Domain-specific knowledge"
multiSelect: true
```

**Question 3.2: Input specification**
```
Header: "Input"
Question: "What format will inputs come in?"
Options:
- "Natural language text"
- "Structured data (JSON, YAML)"
- "Files/documents"
- "API payloads"
- "Mixed/variable"
```

**Question 3.3: Output specification**
```
Header: "Output"
Question: "What format should outputs be in?"
Options:
- "Natural language text"
- "Structured data (JSON, YAML)"
- "Code/scripts"
- "Documents/reports"
- "Actions (API calls, file writes)"
- "Mixed/variable"
multiSelect: true
```

### Phase 4: Style & Behavior

**Question 4.1: Communication style & verbosity**
```
Header: "Tone & Verbosity"
Question: "How should this agent communicate, and how much should it explain?"
Options:
- "Professional, minimal" - Formal tone, brief status updates
- "Professional, detailed" - Formal tone, full reasoning trail
- "Friendly, minimal" - Conversational tone, brief updates
- "Friendly, detailed" - Conversational tone, thorough explanations
- "Technical, silent" - Precise language, output only
- "Technical, standard" - Precise language, explains key decisions
```

### Phase 5: Workflow & Process

**Question 5.1: Execution pattern**
```
Header: "Execution"
Question: "How should this agent approach its work?"
Options:
- "Single-shot" - One input → one output
- "Iterative" - Multiple refinement cycles
- "Multi-step" - Sequential phases
- "Parallel" - Concurrent subtasks
- "Interactive" - Back-and-forth with user
```

**Question 5.2: Decision handling & escalation**
```
Header: "Decisions & Escalation"
Question: "When facing ambiguity, what should the agent do — and what triggers human review?"
Options:
- "Ask for clarification; escalate on uncertainty or high-impact decisions"
- "Best judgment; escalate on errors or resource limits"
- "Conservative choice; escalate at explicit checkpoints"
- "Try multiple approaches; fully autonomous, no escalation"
```

### Phase 6: Boundaries & Guardrails

**Question 6.1: Always allowed**
```
Header: "Always OK"
Question: "What should this agent ALWAYS be allowed to do without asking?"
Options: [Text input]
```

**Question 6.2: Ask first**
```
Header: "Ask First"
Question: "What actions require human approval before proceeding?"
Options: [Text input]
```

**Question 6.3: Never allowed**
```
Header: "Never"
Question: "What must this agent NEVER do under any circumstances?"
Options: [Text input]
```

### Phase 7: Operational (Optional)

**Question 7.1: Integration points**
```
Header: "Integration"
Question: "What does this agent integrate with?"
Options: [Text input]
```

## Generation

After interview completion:

1. **Compile answers** into structured data
2. **Load template** from `Templates/SpecTemplate.md`
3. **Generate spec** filling all sections
4. **Highlight gaps** where answers were vague
5. **Output** final markdown spec

## Output Location

Save generated spec to one of:
- `~/.claude/Plans/Specs/[AgentName]-spec.md` (default)
- User-specified location
- Clipboard (if requested)

## Post-Generation

Offer next steps:
- "Generate prompt from this spec" → Prompting skill
- "Create agent from this spec" → Agents skill
- "Create skill from this spec" → CreateSkill skill
