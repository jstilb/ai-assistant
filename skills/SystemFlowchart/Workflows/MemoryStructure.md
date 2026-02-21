# MemoryStructure Workflow

**Purpose:** Generate a diagram showing the MEMORY/ directory structure, data flow, and how different components write to and read from memory.

---

## Quick Start

```bash
# Generate memory structure diagram
bun ~/.claude/skills/SystemFlowchart/Tools/DiagramBuilder.ts memory

# Scan memory for details
bun ~/.claude/skills/SystemFlowchart/Tools/SystemScanner.ts memory
```

---

## Workflow Steps

### Step 1: Scan Memory Directory

Use SystemScanner to analyze memory structure:

```bash
bun ~/.claude/skills/SystemFlowchart/Tools/SystemScanner.ts memory
```

Returns JSON with directories, file counts, and structure.

### Step 2: Generate Memory Diagram

Use DiagramBuilder to generate the flowchart:

```bash
bun ~/.claude/skills/SystemFlowchart/Tools/DiagramBuilder.ts memory
```

Output: `Output/markdown/memory-structure.md`

### Step 3: Generate PNG (Optional)

```bash
bun ~/.claude/skills/SystemFlowchart/Tools/ArtBridge.ts generate \
  --title "Kaya Memory System" \
  --file Output/markdown/memory-structure.md \
  --output ~/Downloads/memory-structure.png
```

---

## Detailed Memory Structure Documentation

Create `~/.claude/skills/SystemFlowchart/Output/MEMORY_STRUCTURE.md`:

```markdown
# Kaya Memory System Architecture

**Generated:** [TIMESTAMP]
**Total Files:** [count]
**Total Directories:** [count]

---

## Memory System Overview

The MEMORY/ directory is Kaya's persistent storage for work sessions, learnings, signals, and state. It enables intelligence to compound across sessions.

```mermaid
flowchart TB
    subgraph MEMORY["MEMORY/"]
        WORK["WORK/\n(Active & completed work)"]
        LEARNING["LEARNING/\n(Insights & patterns)"]
        STATE["STATE/\n(Operational state)"]
        TASKS["TASKS/\n(Task management)"]
        KNOWLEDGE["KNOWLEDGE/\n(Knowledge management)"]
        MAINTENANCE["MAINTENANCE/\n(System health)"]
        SECURITY["SECURITY/\n(Security logs)"]
        RESEARCH["research/\n(Research outputs)"]
        UPDATES["KAYASYSTEMUPDATES/\n(Documentation)"]
    end
```

---

## Directory Structure Detail

### WORK/ - Work Sessions

```mermaid
flowchart TB
    subgraph WORK["WORK/"]
        Dir["YYYY-MM-DD_description/"]

        subgraph Contents["Work Directory Contents"]
            META["META.yaml\n(metadata, effort level)"]
            IDEAL["IDEAL.md\n(Ideal State Criteria)"]
            ISC["IdealState.jsonl\n(ISC tracking)"]
            Items["items/\n(work items)"]
            Summary["summary.md\n(completion summary)"]
        end

        Dir --> Contents
    end

    AutoWork["AutoWorkCreation hook"] -->|"creates"| Dir
    Response["ResponseCapture hook"] -->|"writes"| Items
    SessionSum["SessionSummary hook"] -->|"writes"| Summary
```

**Work Directory Lifecycle:**
1. `AutoWorkCreation` creates directory on prompt submit
2. `ResponseCapture` saves responses to `items/`
3. `SessionSummary` adds `summary.md` at session end

### LEARNING/ - Insights & Patterns

```mermaid
flowchart TB
    subgraph LEARNING["LEARNING/"]
        subgraph SIGNALS["SIGNALS/"]
            Ratings["ratings.jsonl\n(user ratings 1-10)"]
            Sentiment["sentiment.jsonl\n(emotion detection)"]
        end

        ALGORITHM["ALGORITHM/\n(algorithm learnings)"]
        PATTERNS["PATTERNS/\n(extracted patterns)"]
    end

    Explicit["ExplicitRatingCapture"] -->|"N - text"| Ratings
    Implicit["ImplicitSentimentCapture"] -->|"inference"| Sentiment
    WorkLearn["WorkCompletionLearning"] -->|"Opus analysis"| ALGORITHM
```

**Signal Capture:**
- **Explicit ratings:** Pattern "8 - great!" → parsed and stored
- **Implicit sentiment:** Haiku inference on emotional content
- **Learnings:** Opus analysis of session at SessionEnd

### STATE/ - Operational State

```mermaid
flowchart TB
    subgraph STATE["STATE/"]
        CurrentWork["current-work.json\n(active work pointer)"]
        Trending["trending-cache.json\n(query cache)"]
        Model["model-cache.txt\n(model history)"]
        Integrity["integrity/\n(audit reports)"]
    end

    AutoWork["AutoWorkCreation"] -->|"set"| CurrentWork
    Response["ResponseCapture"] -->|"update"| CurrentWork
    SessionSum["SessionSummary"] -->|"clear"| CurrentWork
```

**current-work.json Schema:**
```json
{
  "active_work_dir": "MEMORY/WORK/2025-01-20_task-description/",
  "current_item": 1,
  "status": "in_progress" | "completed",
  "started_at": "ISO timestamp"
}
```

### TASKS/ - Task Management

```mermaid
flowchart TB
    subgraph TASKS["TASKS/"]
        Daily["daily/\n(daily summaries)"]
        Weekly["weekly/\n(weekly triages)"]
        Monthly["monthly/\n(monthly reports)"]
    end

    TaskMaint["TaskMaintenance skill"] -->|"runs"| Daily
    TaskMaint -->|"runs"| Weekly
    TaskMaint -->|"runs"| Monthly
```

### KNOWLEDGE/ - Knowledge Management

```mermaid
flowchart TB
    subgraph KNOWLEDGE["KNOWLEDGE/"]
        KDaily["daily/\n(inbox processing)"]
        KWeekly["weekly/\n(vault synthesis)"]
        KMonthly["monthly/\n(pattern learning)"]
    end

    KnowMaint["KnowledgeMaintenance skill"] -->|"runs"| KDaily
    KnowMaint -->|"runs"| KWeekly
    KnowMaint -->|"runs"| KMonthly
```

### MAINTENANCE/ - System Health

```mermaid
flowchart TB
    subgraph MAINTENANCE["MAINTENANCE/"]
        MDaily["daily/\n(integrity checks)"]
        MWeekly["weekly/\n(full audits)"]
        MMonthly["monthly/\n(upgrades)"]
    end

    AutoMaint["AutoMaintenance skill"] -->|"6am daily"| MDaily
    AutoMaint -->|"3am Sunday"| MWeekly
    AutoMaint -->|"4am 1st"| MMonthly
```

### SECURITY/ - Security Logs

```mermaid
flowchart TB
    subgraph SECURITY["SECURITY/"]
        Events["security-events.jsonl"]
    end

    SecVal["SecurityValidator hook"] -->|"logs"| Events
```

---

## Data Flow Diagram

```mermaid
flowchart LR
    subgraph Input["Input Sources"]
        User["User Prompts"]
        Tools["Tool Outputs"]
        Sessions["Session Events"]
    end

    subgraph Hooks["Hook Processing"]
        AWC["AutoWorkCreation"]
        RC["ResponseCapture"]
        Rating["Rating Capture"]
        WCL["WorkCompletionLearning"]
    end

    subgraph Storage["MEMORY/"]
        WORK
        LEARNING
        STATE
    end

    subgraph Output["Output Uses"]
        Context["Context Injection"]
        Analytics["Analytics/Insights"]
        Resume["Work Resumption"]
    end

    User --> AWC
    AWC --> WORK
    AWC --> STATE

    Tools --> RC
    RC --> WORK

    User --> Rating
    Rating --> LEARNING

    Sessions --> WCL
    WCL --> LEARNING

    STATE --> Context
    LEARNING --> Analytics
    WORK --> Resume
```

---

## File Formats Reference

| File | Format | Purpose |
|------|--------|---------|
| `META.yaml` | YAML | Work metadata, effort level |
| `IDEAL.md` | Markdown | Ideal State Criteria definition |
| `IdealState.jsonl` | JSONL | ISC item tracking |
| `ratings.jsonl` | JSONL | User rating signals |
| `current-work.json` | JSON | Active work pointer |
| `security-events.jsonl` | JSONL | Security audit log |
| `summary.md` | Markdown | Work session summary |

---

## Hook → Memory Mapping

| Hook | Writes To | Reads From |
|------|-----------|-----------|
| AutoWorkCreation | WORK/, STATE/current-work.json | — |
| ResponseCapture | WORK/items/, STATE/current-work.json | STATE/current-work.json |
| ExplicitRatingCapture | LEARNING/SIGNALS/ratings.jsonl | — |
| ImplicitSentimentCapture | LEARNING/SIGNALS/ratings.jsonl | LEARNING/SIGNALS/ratings.jsonl |
| SecurityValidator | SECURITY/security-events.jsonl | patterns.yaml |
| WorkCompletionLearning | LEARNING/ALGORITHM/ | transcript |
| SessionSummary | WORK/summary.md, STATE/ | STATE/current-work.json |
| LoadContext | — | STATE/current-work.json |
```

### Step 3: Save and Announce

```bash
mkdir -p ~/.claude/skills/SystemFlowchart/Output
# Write document
open ~/.claude/skills/SystemFlowchart/Output/MEMORY_STRUCTURE.md
```

Voice notification:
```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Memory structure diagram generated"}' \
  > /dev/null 2>&1 &
```
