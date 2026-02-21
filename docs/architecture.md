# Architecture

## System Overview

Kaya is a skill-based AI agent infrastructure built on Claude Code. The system enables an LLM to dynamically discover, load, and execute specialized capabilities through a composable skill architecture with persistent memory.

## High-Level Architecture

```mermaid
graph TB
    subgraph User Interface
        CC[Claude Code CLI]
        TG[Telegram Bot]
        VC[Voice Server]
    end

    subgraph CORE Router
        RT[Skill Router] --> |keyword match| SK[Skill Loader]
        SK --> SM[SKILL.md Manifest]
        SK --> CT[_Context.md]
        SK --> TL[Tools/]
        SK --> WF[Workflows/]
    end

    subgraph Skill Layer
        direction LR
        S1[CalendarAssistant]
        S2[AutonomousWork]
        S3[Browser]
        S4[Gmail]
        SN[...60+ skills]
    end

    subgraph Infrastructure
        MEM[MEMORY/] --> LS[Learning Signals]
        MEM --> ST[State Management]
        MEM --> VL[Validation Logs]
        VS[VoiceServer] --> EL[ElevenLabs TTS]
        CRON[bin/ Scripts] --> LD[launchd Scheduler]
        MCP[MCP Servers] --> GM[Gemini]
        BRW[Browser Skill] --> PW[Playwright CLI]
    end

    CC --> RT
    TG --> RT
    VC --> RT
    RT --> S1
    RT --> S2
    RT --> S3
    RT --> S4
    RT --> SN
    S1 --> MEM
    S2 --> MEM
    S3 --> MEM
```

## Skill Discovery and Loading

```mermaid
sequenceDiagram
    participant User
    participant CORE as CORE Router
    participant Skill as Skill Module
    participant Memory as MEMORY/

    User->>CORE: Natural language request
    CORE->>CORE: Parse keywords against USE WHEN triggers
    CORE->>Skill: Load SKILL.md manifest
    Skill->>Skill: Load _Context.md (domain knowledge)
    Skill->>Skill: Execute workflow steps
    Skill->>Memory: Persist state changes
    Skill->>User: Return results
```

## Multi-Agent Execution

```mermaid
graph LR
    subgraph Orchestrator
        AW[AutonomousWork] --> |spawn| A1[Agent: Engineer]
        AW --> |spawn| A2[Agent: Designer]
        AW --> |spawn| A3[Agent: Researcher]
    end

    subgraph Isolation
        A1 --> B1[Branch: feature/task-1]
        A2 --> B2[Branch: feature/task-2]
        A3 --> B3[Branch: feature/task-3]
    end

    subgraph Merge
        B1 --> PR1[PR #1]
        B2 --> PR2[PR #2]
        B3 --> PR3[PR #3]
    end
```

## Key Design Decisions

### 1. Markdown-First Skill Definitions

Skills are defined in Markdown rather than code. This means:
- Claude Code can read and understand skill capabilities natively
- No compilation step -- skills are discovered at runtime
- Human-readable documentation doubles as machine-readable configuration
- The `USE WHEN` trigger clause enables keyword-based routing

### 2. Persistent Memory via JSON State Files

State is stored as JSON files in `MEMORY/` rather than a database because:
- Git-trackable state changes
- No infrastructure dependencies
- Human-readable for debugging
- Atomic file writes prevent corruption

### 3. Branch-Isolated Parallel Execution

When multiple agents work simultaneously, each operates on its own git branch. This prevents:
- File conflicts between concurrent agents
- Cross-contamination of commits
- Race conditions on shared state files

### 4. Voice as a First-Class Channel

The voice server runs as a persistent background service (via launchd) so that:
- Agents can speak without user interaction
- Notifications are audible, not just visual
- Mobile interaction via Telegram voice messages is seamless

## Data Flow

```
User Request
    |
    v
CORE Router (keyword matching)
    |
    v
Skill SKILL.md (manifest + triggers)
    |
    v
_Context.md (domain knowledge)
    |
    v
Workflow Execution (Tools/, Workflows/)
    |
    +---> External APIs (Google, Telegram, ElevenLabs)
    |
    +---> MCP Servers (Gemini)
    |
    +---> Browser Skill (Playwright CLI via Browse.ts)
    |
    +---> MEMORY/ (state persistence)
    |
    v
User Response (text, voice, or action)
```
