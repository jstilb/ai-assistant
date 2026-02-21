# SpecFromDescription Workflow

**Generate a draft specification from a natural language description.**

Use when:
- User has a clear mental model but limited time
- Starting point for refinement
- Rapid ideation/prototyping

## Process

### Step 1: Parse Description

Extract from user's natural language:
- Agent name (infer or ask)
- Core purpose
- Key capabilities mentioned
- Implied constraints
- Success indicators

### Step 1.5: Infer User Stories

From the parsed description, generate **2-4 user stories**:

**Format:**
```
As a [role], I want [capability] so that [benefit].
Priority: P1 / P2 / P3
```

**Priority assignment:**
- **P1** — Core functionality; the agent cannot fulfill its purpose without this
- **P2** — Supporting functionality; enhances the core but not essential at launch
- **P3** — Enhancement; nice-to-have, can be deferred

**For each story, generate acceptance criteria:**
```
Given [precondition]
When [action]
Then [expected outcome]
```

Mark all inferred stories with `⚠️ INFERRED - verify`.

### Step 2: Infer Missing Elements

For each of the 6 core areas, infer reasonable defaults based on:
- Agent type (research, automation, generation, etc.)
- Domain (code, content, data, communication)
- Complexity signals in description

**Inference Heuristics:**

| Description Contains | Infer |
|---------------------|-------|
| "monitor", "watch", "alert" | Event-driven, real-time, notifications |
| "generate", "create", "write" | Output-focused, creative latitude |
| "analyze", "review", "check" | Read-heavy, accuracy-critical |
| "automate", "execute", "run" | Action-heavy, guardrails critical |
| "search", "find", "lookup" | Query-based, retrieval-focused |

### Step 3: Generate Draft Spec

Use the full SpecTemplate.md but:
- Fill inferred sections with best guesses
- Include user stories from Step 1.5 in the spec under a **User Stories** section
- Mark uncertain sections with `⚠️ INFERRED - verify`
- Leave clearly unknown sections as `{{NEEDS_INPUT}}`

### Step 4: Highlight Gaps

After generation, list:
```
## Sections Needing Review

⚠️ The following were inferred and should be verified:
- [Section]: [What was inferred and why]

❓ The following need your input:
- [Section]: [What question to answer]
```

### Step 5: Offer Refinement

```
Options:
1. "Refine this spec" → Enter targeted Q&A for flagged sections
2. "Full interview" → Run complete CreateSpec workflow
3. "Good enough" → Accept as-is
```

## Example

**Input:**
```
"An agent that monitors Slack for support questions, searches our docs for answers, and drafts responses for human review"
```

**Inferred:**
- **Type:** Assistant/Copilot (human review = not fully autonomous)
- **Capabilities:** Monitor (Slack), Search (docs), Generate (responses)
- **Guardrails:** Ask first for sending (human review mentioned)
- **Input:** Slack messages
- **Output:** Draft responses
- **Integration:** Slack API, documentation search

**Flagged for review:**
- What Slack channels to monitor?
- What documentation sources?
- Response format requirements?
- Escalation criteria?
