# SessionLifecycle Workflow

**Purpose:** Generate a detailed diagram of the Kaya session lifecycle showing all hook execution points and data flow.

---

## Quick Start

```bash
# Generate lifecycle diagram
bun ~/.claude/skills/Content/SystemFlowchart/Tools/DiagramBuilder.ts lifecycle

# Scan hooks for details
bun ~/.claude/skills/Content/SystemFlowchart/Tools/SystemScanner.ts hooks
```

---

## Workflow Steps

### Step 1: Scan Hooks

Use SystemScanner to get current hook configuration:

```bash
bun ~/.claude/skills/Content/SystemFlowchart/Tools/SystemScanner.ts hooks
```

Returns JSON with hook name, path, event type, and description.

### Step 2: Generate Lifecycle Diagram

Use DiagramBuilder to generate the sequence diagram:

```bash
bun ~/.claude/skills/Content/SystemFlowchart/Tools/DiagramBuilder.ts lifecycle
```

Output: `Output/markdown/session-lifecycle.md`

### Step 3: Generate PNG (Optional)

```bash
bun ~/.claude/skills/Content/SystemFlowchart/Tools/ArtBridge.ts generate \
  --title "Kaya Session Lifecycle" \
  --file Output/markdown/session-lifecycle.md \
  --output ~/Downloads/session-lifecycle.png
```

---

## Detailed Session Lifecycle Documentation

Create `~/.claude/skills/Content/SystemFlowchart/Output/SESSION_LIFECYCLE.md`:

```markdown
# Kaya Session Lifecycle

**Generated:** [TIMESTAMP]

This document details the complete lifecycle of a Kaya session from initialization to termination.

---

## Overview

```mermaid
stateDiagram-v2
    [*] --> SessionStart: Claude Code launches
    SessionStart --> Ready: Context loaded
    Ready --> Processing: User submits prompt
    Processing --> ToolExecution: Tools invoked
    ToolExecution --> Processing: Tool results
    Processing --> ResponseGeneration: Processing complete
    ResponseGeneration --> Ready: Response delivered
    Ready --> SessionEnd: User exits
    SessionEnd --> [*]: Session terminated
```

---

## Detailed Hook Execution Flow

### SessionStart Phase (3 hooks)

```mermaid
sequenceDiagram
    participant CC as Claude Code
    participant SG as StartupGreeting
    participant LC as LoadContext
    participant CV as CheckVersion
    participant V as Voice Server
    participant Ctx as Context

    Note over CC: SESSION INITIALIZATION

    CC->>SG: SessionStart event
    SG->>V: POST /notify (catchphrase)
    SG-->>CC: Kaya banner (stderr)
    Note over SG: Non-blocking

    CC->>LC: SessionStart event
    LC->>Ctx: Read CORE/SKILL.md
    LC->>Ctx: Read _USERCONTEXT/SKILL.md
    LC->>Ctx: Read current-work.json
    LC-->>CC: Injected context (stdout)
    Note over LC: BLOCKING - must complete

    CC->>CV: SessionStart event
    CV-->>CC: Version notification (stderr)
    Note over CV: Non-blocking

    Note over CC: READY FOR PROMPTS
```

### UserPromptSubmit Phase (5 hooks)

```mermaid
sequenceDiagram
    participant U as User
    participant CC as Claude Code
    participant FE as FormatEnforcer
    participant AWC as AutoWorkCreation
    participant ERC as ExplicitRatingCapture
    participant ISC as ImplicitSentimentCapture
    participant UTT as UpdateTabTitle
    participant M as Memory
    participant V as Voice

    U->>CC: Submit prompt
    Note over CC: UserPromptSubmit event

    CC->>FE: Hook triggered
    FE-->>CC: Response format template (stdout)
    Note over FE: BLOCKING

    CC->>AWC: Hook triggered
    AWC->>M: Create WORK/ directory
    AWC->>M: Write META.yaml
    AWC->>M: Update current-work.json
    Note over AWC: Non-blocking

    CC->>ERC: Hook triggered
    ERC->>M: Check for "N - text" pattern
    alt Rating found
        ERC->>M: Write to ratings.jsonl
    end
    Note over ERC: Non-blocking

    CC->>ISC: Hook triggered
    ISC->>M: Check if explicit rating exists
    alt No explicit rating
        ISC->>ISC: Haiku inference for sentiment
        ISC->>M: Write to ratings.jsonl
    end
    Note over ISC: Non-blocking

    CC->>UTT: Hook triggered
    UTT->>V: Announce task
    UTT->>UTT: Set Kitty tab color
    Note over UTT: Non-blocking

    Note over CC: BEGIN PROCESSING
```

### PreToolUse Phase (per tool invocation)

```mermaid
sequenceDiagram
    participant CC as Claude Code
    participant SV as SecurityValidator
    participant SQ as SetQuestionTab
    participant Tool as Tool Execution

    CC->>SV: PreToolUse (Bash/Edit/Write/Read)
    SV->>SV: Load patterns.yaml
    SV->>SV: Evaluate command safety

    alt Allowed
        SV-->>CC: {continue: true}
        CC->>Tool: Execute tool
    else Ask User
        SV-->>CC: {decision: "ask", message}
        CC->>CC: Prompt user
    else Block
        SV-->>CC: exit(2)
        Note over CC: Tool blocked
    end

    CC->>SQ: PreToolUse (AskUserQuestion)
    SQ->>SQ: Set Kitty tab to TEAL
    SQ-->>CC: Continue
```

### Stop Phase (response completion)

```mermaid
sequenceDiagram
    participant CC as Claude Code
    participant SO as StopOrchestrator
    participant RC as ResponseCapture
    participant TTR as TabTitleReset
    participant VC as VoiceCompletion
    participant M as Memory
    participant V as Voice

    CC->>SO: Stop event

    SO->>RC: Trigger
    RC->>M: Save response to WORK/items/
    RC->>M: Update current-work.json

    SO->>TTR: Trigger
    TTR->>TTR: Reset Kitty tab to default

    SO->>VC: Trigger
    VC->>VC: Parse voice line from response
    VC->>V: POST /notify (voice line)

    Note over CC: RESPONSE DELIVERED
```

### SessionEnd Phase (session termination)

```mermaid
sequenceDiagram
    participant CC as Claude Code
    participant WCL as WorkCompletionLearning
    participant SS as SessionSummary
    participant M as Memory

    Note over CC: USER EXITS

    CC->>WCL: SessionEnd event
    WCL->>WCL: Analyze session transcript
    WCL->>WCL: Opus inference for learnings
    WCL->>M: Write to LEARNING/ALGORITHM/

    CC->>SS: SessionEnd event
    SS->>M: Generate summary.md
    SS->>M: Mark work COMPLETED
    SS->>M: Clear current-work.json

    Note over CC: SESSION TERMINATED
```

---

## Hook Configuration Reference

| Hook | Event | Type | Output |
|------|-------|------|--------|
| StartupGreeting | SessionStart | Non-blocking | stderr |
| LoadContext | SessionStart | **Blocking** | stdout |
| CheckVersion | SessionStart | Non-blocking | stderr |
| FormatEnforcer | UserPromptSubmit | **Blocking** | stdout |
| AutoWorkCreation | UserPromptSubmit | Non-blocking | files |
| ExplicitRatingCapture | UserPromptSubmit | Non-blocking | files |
| ImplicitSentimentCapture | UserPromptSubmit | Non-blocking | files |
| UpdateTabTitle | UserPromptSubmit | Non-blocking | Kitty/voice |
| SecurityValidator | PreToolUse | **Blocking** | decision |
| SetQuestionTab | PreToolUse | Non-blocking | Kitty |
| AgentOutputCapture | SubagentStop | Non-blocking | files |
| StopOrchestrator | Stop | Non-blocking | voice/files |
| WorkCompletionLearning | SessionEnd | Non-blocking | files |
| SessionSummary | SessionEnd | Non-blocking | files |

---

## State Files Used

| File | Purpose | Updated By |
|------|---------|-----------|
| `MEMORY/STATE/current-work.json` | Active work pointer | AutoWorkCreation, ResponseCapture, SessionSummary |
| `MEMORY/LEARNING/SIGNALS/ratings.jsonl` | User ratings | ExplicitRatingCapture, ImplicitSentimentCapture |
| `MEMORY/SECURITY/security-events.jsonl` | Security log | SecurityValidator |
| `MEMORY/WORK/*/items/response.md` | Claude responses | ResponseCapture |
| `MEMORY/WORK/*/summary.md` | Session summary | SessionSummary |
```

### Step 3: Save and Announce

```bash
mkdir -p ~/.claude/skills/Content/SystemFlowchart/Output
# Write document
open ~/.claude/skills/Content/SystemFlowchart/Output/SESSION_LIFECYCLE.md
```

Voice notification:
```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Session lifecycle diagram generated"}' \
  > /dev/null 2>&1 &
```
