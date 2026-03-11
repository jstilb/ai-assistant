# Kaya System Architecture

**Generated:** 2026-01-24 18:40 PST
**Kaya Version:** v2.3
**Skills:** 57
**Hooks:** 19

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Session Lifecycle](#2-session-lifecycle)
3. [Skill Ecosystem](#3-skill-ecosystem)
4. [Memory System](#4-memory-system)
5. [Configuration Flow](#5-configuration-flow)
6. [Agent Architecture](#6-agent-architecture)
7. [Workflow Routing](#7-workflow-routing)
8. [Hook Reference](#8-hook-reference)
9. [Security Architecture](#9-security-architecture)
10. [Core Infrastructure Tools](#10-core-infrastructure-tools)

---

## 1. System Overview

Kaya (Personal AI Infrastructure) is a personalized agentic system designed to help people accomplish their goals in life. The system achieves *Euphoric Surprise* through results that are thorough, thoughtful, and effective.

### Founding Principles

1. **Customization for Your Goals** - Kaya exists to help achieve your specific objectives
2. **The Algorithm** - Current State → Ideal State via ISC-driven iteration
3. **Continuously Upgrading System** - Learns from every interaction
4. **CLI-First Design** - Core tools are command-line utilities
5. **Code Before Prompts** - Typed, reusable infrastructure over ad-hoc prompts
6. **Determinism & Reproducibility** - Verifiable outputs, not luck-based

```mermaid
flowchart TB
    subgraph Core["Kaya Core"]
        Settings["settings.json\n(identity, config)"]
        Secrets["secrets.json\n(API keys, gitignored)"]
        CORE["CORE Skill\n(always loaded)"]
        Hooks["Hook System\n(19 hooks)"]
    end

    subgraph Skills["Skill Ecosystem (57 skills)"]
        Infrastructure["Infrastructure\n(System, Agents, AutonomousWork)"]
        Research["Research & Analysis\n(Research, OSINT, Council, RedTeam)"]
        Knowledge["Knowledge Management\n(Obsidian, Anki, ContinualLearning)"]
        Automation["Automation & Tools\n(Browser, Shopping, Instacart)"]
        Creative["Content & Creative\n(Art, CreateSkill, Fabric)"]
        Security["Security\n(WebAssessment, Recon, PromptInjection)"]
    end

    subgraph Memory["Memory System"]
        WORK["WORK/\n(sessions)"]
        LEARNING["LEARNING/\n(insights)"]
        STATE["State/\n(operational)"]
    end

    subgraph External["External Services"]
        Voice["Voice Server\n(ElevenLabs TTS)"]
        Asana["Asana\n(task management)"]
        Obsidian_Ext["Obsidian\n(PKM vault)"]
        MCP["MCP Servers\n(Calendar, Gmail, etc)"]
    end

    subgraph VisualOutput["Visual Output"]
        Daemon["Kaya Daemon\n(port 18000)"]
        Canvas["Canvas\n(http://localhost:18000/canvas)"]
        PTYBackend["PTY Backend\n(terminal sessions)"]
        Telegram_Out["Telegram\n(mobile output)"]
    end

    Settings --> CORE
    Secrets --> CORE
    CORE --> Hooks
    CORE --> Skills
    Hooks --> Memory
    Skills --> Memory
    Hooks --> Voice
    Skills --> External
    Skills --> MCP
    Skills -->|"renderToCanvas"| Canvas
    Canvas <-->|"WebSocket\n(JSON-RPC 2.0)"| Daemon
    PTYBackend <-->|"pty protocol"| Daemon
    Skills -->|"DailyBriefing output"| Canvas
```

---

## 2. Session Lifecycle

Complete flow from session start to termination, showing all hook execution points.

```mermaid
sequenceDiagram
    participant U as User
    participant CC as Claude Code
    participant H as Hooks
    participant S as Skills
    participant M as Memory
    participant V as Voice

    rect rgb(240, 248, 255)
        Note over CC: SESSION START (4 hooks)
        CC->>H: SessionStart event
        H->>CC: ConfigValidator (validate settings.json)
        H->>V: StartupGreeting (banner + voice)
        H->>CC: LoadContext (inject CORE + _USERCONTEXT)
        H->>CC: CheckVersion (notify if update)
    end

    rect rgb(255, 250, 240)
        Note over U,CC: USER PROMPT (5 hooks)
        U->>CC: Submit prompt
        CC->>H: UserPromptSubmit event
        H->>CC: FormatEnforcer (response template)
        H->>M: AutoWorkCreation (WORK/ dir)
        H->>M: ExplicitRatingCapture (N - text)
        H->>M: ImplicitSentimentCapture (emotion)
        H->>V: UpdateTabTitle (announce task)
    end

    rect rgb(240, 255, 240)
        Note over CC,S: PROCESSING (5 PreToolUse + 5 PostToolUse)
        CC->>S: Process with skills
        S->>H: PreToolUse (SecurityValidator - Bash/Edit/Write/Read)
        S->>H: PreToolUse (SetQuestionTab - AskUserQuestion)
        S->>CC: Tool results
        S->>H: PostToolUse (OutputValidator - Bash/Edit/Write/Read)
        S->>H: PostToolUse (QuestionAnswered - AskUserQuestion)
    end

    rect rgb(255, 240, 245)
        Note over CC,V: STOP (1 hook)
        CC->>H: Stop event
        H->>M: StopOrchestrator (ResponseCapture)
        H->>V: StopOrchestrator (VoiceCompletion)
    end

    rect rgb(245, 240, 255)
        Note over CC,M: SESSION END (3 hooks)
        CC->>H: SessionEnd event
        H->>M: WorkValidator (validate work state)
        H->>M: WorkCompletionLearning (extract insights)
        H->>M: SessionSummary (mark completed)
    end

    rect rgb(255, 245, 230)
        Note over CC,M: SUBAGENT STOP (1 hook)
        CC->>H: SubagentStop event
        H->>M: AgentOutputCapture (aggregate results)
    end
```

---

## 3. Skill Ecosystem

### 3.1 Skill Categories

```mermaid
flowchart TB
    subgraph AlwaysLoaded["Always Loaded (3)"]
        CORE["CORE"]
        USERCTX["_USERCONTEXT"]
        DTR["_DTR"]
    end

    subgraph Infrastructure["Infrastructure (7 skills)"]
        System["System"]
        Agents["Agents"]
        AutoMaint["AutoMaintenance"]
        TaskMaint["TaskMaintenance"]
        KnowMaint["KnowledgeMaintenance"]
        AutonomousWork["AutonomousWork"]
        AgentSetup["AgentProjectSetup"]
    end

    subgraph Research["Research & Analysis (10 skills)"]
        Research_Skill["Research"]
        OSINT["OSINT"]
        FP["FirstPrinciples"]
        Council["Council"]
        RedTeam["RedTeam"]
        Prompting["Prompting"]
        Recon["Recon"]
        Evals["Evals"]
        BeCreative["BeCreative"]
        SpecSheet["SpecSheet"]
    end

    subgraph Knowledge["Knowledge (8 skills)"]
        Obsidian["Obsidian"]
        CL["ContinualLearning"]
        CG["InformationManager"]
        N2A["NotesToAnki"]
        Anki["Anki"]
        Telos["Telos"]
        Fabric["Fabric"]
        S2N["SocialToNotes"]
    end

    subgraph Automation["Automation (12 skills)"]
        Browser["Browser"]
        Shopping["Shopping"]
        Instacart["Instacart"]
        Spotify["Spotify"]
        Cooking["Cooking"]
        Designer["Designer"]
        Calendar["CalendarAssistant"]
        Decision["DecisionAssistant"]
        Study["StudyPlanner"]
        Asana["AsanaTriage"]
        Gmail["Gmail"]
        GeminiSync["GeminiSync"]
    end

    subgraph Creative["Creative & Content (9 skills)"]
        Art["Art"]
        CreateCLI["CreateCLI"]
        CreateSkill["CreateSkill"]
        Documents["Documents"]
        KayaUpgrade["KayaUpgrade"]
        KayaSync["KayaSync"]
        Upgrades["Upgrades"]
        AnnualReports["AnnualReports"]
        SkillAudit["SkillAudit"]
    end

    subgraph Security["Security (6 skills)"]
        WebAssessment["WebAssessment"]
        PromptInjection["PromptInjection"]
        SECUpdates["SECUpdates"]
        PI["PrivateInvestigator"]
        SystemFlowchart["SystemFlowchart"]
        Aphorisms["Aphorisms"]
    end

    subgraph DataAccess["Data Access (2 skills)"]
        Apify["Apify"]
        BrightData["BrightData"]
    end

    CORE --> System
    CORE --> ALGO
    ALGO --> Agents
    ALGO --> Council
    ALGO --> RedTeam
    ALGO --> AutonomousWork
```

### 3.2 Skill Dependency Graph

```mermaid
graph LR
    subgraph Orchestrators["Orchestrators"]
        System["System"]
        AutonomousWork["AutonomousWork"]
    end

    subgraph Workers["Worker Skills"]
        Council["Council"]
        RedTeam["RedTeam"]
        Research["Research"]
        Agents["Agents"]
        Evals["Evals"]
    end

    subgraph Tools["Tool Skills"]
        Browser["Browser"]
        Obsidian["Obsidian"]
        Anki["Anki"]
        Gmail["Gmail"]
    end

    subgraph Data["Data Skills"]
        Apify["Apify"]
        BrightData["BrightData"]
    end

    AutonomousWork -->|"THOROUGH"| Council
    AutonomousWork -->|"parallel"| Agents
    Agents -->|"research"| Research
    Research -->|"web"| Browser
    Research -->|"scrape"| BrightData
    Research -->|"social"| Apify
    Obsidian -->|"cards"| Anki
    System -->|"schedule"| AutoMaint["AutoMaintenance"]
    Evals -->|"verify"| ALGO
```

### 3.3 Complete Skill List (57 skills)

| Category | Skills |
|----------|--------|
| **Always Loaded** | CORE, _USERCONTEXT, _DTR |
| **Infrastructure** | System, Agents, AutoMaintenance, AutonomousWork, TaskMaintenance, KnowledgeMaintenance, AgentProjectSetup |
| **Research & Analysis** | Research, OSINT, FirstPrinciples, Council, RedTeam, Prompting, Recon, Evals, BeCreative, SpecSheet |
| **Knowledge** | Obsidian, ContinualLearning, InformationManager, NotesToAnki, Anki, Telos, Fabric, SocialToNotes |
| **Automation** | Browser, Shopping, Instacart, Spotify, Cooking, Designer, CalendarAssistant, DecisionAssistant, StudyPlanner, AsanaTriage, Gmail, GeminiSync |
| **Creative & Content** | Art, CreateCLI, CreateSkill, Documents, KayaUpgrade, KayaSync, Upgrades, AnnualReports, SkillAudit |
| **Security** | WebAssessment, PromptInjection, SECUpdates, PrivateInvestigator, SystemFlowchart, Aphorisms |
| **Data Access** | Apify, BrightData |

---

## 4. Memory System

### 4.1 Directory Structure

```mermaid
flowchart TB
    subgraph MEMORY["MEMORY/"]
        subgraph WORK["WORK/ (Sessions)"]
            WorkDir["YYYYMMDD-HHMMSS_slug/"]
            ISC["ISC.json"]
            Scratch["scratch/"]
            Artifacts["artifacts/"]
        end

        subgraph LEARNING["LEARNING/ (Insights)"]
            ALGORITHM["ALGORITHM/\n(improvements)"]
            SIGNALS["SIGNALS/\n(ratings.jsonl)"]
            FAILURES["FAILURES/\n(recovery patterns)"]
            SYSTEM_L["SYSTEM/\n(patterns)"]
        end

        subgraph STATE["State/ (Operational)"]
            CurrentWork["current-work.json"]
            IntegrityState["integrity-state.json"]
            AlgoState["algorithm-state.json"]
            TabTitle["tab-title.json"]
            AsanaTasks["asana-ai-tasks.json"]
            QueuedTasks["queued-tasks-*.json"]
            Cache["cache/"]
        end

        subgraph Scheduled["Scheduled Outputs"]
            TASKS["TASKS/"]
            KNOWLEDGE_Dir["KNOWLEDGE/"]
            MAINTENANCE["MAINTENANCE/"]
            NOTIFICATIONS["NOTIFICATIONS/"]
        end

        SECURITY["security/"]
        RESEARCH["research/"]
        UPDATES["KAYASYSTEMUPDATES/"]
        VALIDATION["VALIDATION/"]
        VOICE["VOICE/"]
        SkillAudits["SkillAudits/"]
    end
```

### 4.2 Data Flow

```mermaid
flowchart LR
    subgraph Input["Input Sources"]
        User["User Prompts"]
        Tools["Tool Outputs"]
        Sessions["Session Events"]
        Ratings["User Ratings"]
    end

    subgraph Hooks["Hook Processing"]
        AWC["AutoWorkCreation"]
        RC["StopOrchestrator"]
        Rating["ExplicitRatingCapture"]
        Sentiment["ImplicitSentimentCapture"]
        WCL["WorkCompletionLearning"]
    end

    subgraph Storage["MEMORY/"]
        WORK["WORK/"]
        LEARNING["LEARNING/"]
        STATE["State/"]
    end

    subgraph Output["Output Uses"]
        Context["Context Injection"]
        Analytics["Analytics"]
        Resume["Work Resumption"]
        ISC["ISC Tracking"]
    end

    User --> AWC --> WORK
    AWC --> STATE
    Tools --> RC --> WORK
    User --> Rating --> LEARNING
    User --> Sentiment --> LEARNING
    Sessions --> WCL --> LEARNING
    STATE --> Context
    LEARNING --> Analytics
    WORK --> Resume
    WORK --> ISC
```

### 4.3 Retention Policies

| Data Type | Location | Retention |
|-----------|----------|-----------|
| Sessions | WORK/ | Indefinite |
| Learnings | LEARNING/ | Permanent |
| Security Events | security/ | Permanent |
| Recovery Snapshots | recovery/ | 7 days |
| Execution Logs | execution/ | 30 days |
| Cache | State/cache/ | TTL-based |

---

## 5. Configuration Flow

### 5.1 SYSTEM/USER Two-Tier Pattern

```mermaid
flowchart LR
    subgraph Settings["settings.json"]
        Identity["daidentity\n(name, voice)"]
        Principal["principal\n(user info)"]
        HookConfig["hooks\n(lifecycle)"]
        Permissions["permissions\n(allow/deny/ask)"]
        Plugins["enabledPlugins\n(playwright, etc)"]
    end

    subgraph Secrets["secrets.json (gitignored)"]
        ElevenLabs["ELEVENLABS_API_KEY"]
        Asana["ASANA_ACCESS_TOKEN"]
        Gemini["GEMINI_API_KEY"]
    end

    subgraph SYSTEM["SYSTEM/ (Defaults)"]
        SysResponse["RESPONSEFORMAT.md"]
        SysSecurity["KAYASECURITYSYSTEM/"]
        SysRules["AISTEERINGRULES.md"]
        SysDocs["Documentation/*.md"]
    end

    subgraph USER["USER/ (Overrides)"]
        UserResponse["RESPONSEFORMAT.md"]
        UserSecurity["KAYASECURITYSYSTEM/"]
        UserRules["AISTEERINGRULES.md"]
        UserAssets["ASSETMANAGEMENT.md"]
        UserContacts["CONTACTS.md"]
        UserStack["TECHSTACKPREFERENCES.md"]
    end

    Settings --> SYSTEM
    Secrets --> CORE["CORE Skill"]
    SYSTEM --> USER
    USER -->|"USER exists?"| Final["Active Config"]
    SYSTEM -->|"No USER"| Final
```

### 5.2 Configuration Priority

```mermaid
flowchart TB
    Request["Config Request"]

    Request --> Check{"USER/\nexists?"}
    Check -->|"Yes"| USER["Use USER/"]
    Check -->|"No"| SYSTEM["Use SYSTEM/"]

    USER --> Active["Active Configuration"]
    SYSTEM --> Active

    subgraph Examples["Example Lookups"]
        Ex1["Response Format:\nUSER/RESPONSEFORMAT.md → SYSTEM/RESPONSEFORMAT.md"]
        Ex2["Security Patterns:\nUSER/KAYASECURITYSYSTEM/ → KAYASECURITYSYSTEM/"]
        Ex3["Private Skills:\n_ALLCAPS prefix - never sync to public"]
    end
```

---

## 6. Agent Architecture

### 6.1 Three-Tier Agent Model

```mermaid
flowchart TB
    subgraph Tier1["Tier 1: Task Tool Subagent Types (Internal)"]
        Architect["Architect"]
        Engineer["Engineer"]
        Intern["Intern"]
        Explore["Explore"]
        Plan["Plan"]
        QATester["QATester"]
        Designer_Agent["Designer"]
        Pentester["Pentester"]
        Artist["Artist"]
    end

    subgraph Tier2["Tier 2: Research Agents"]
        ClaudeResearcher["ClaudeResearcher"]
        GrokResearcher["GrokResearcher"]
        GeminiResearcher["GeminiResearcher"]
        CodexResearcher["CodexResearcher"]
    end

    subgraph Tier3["Tier 3: Custom Agents"]
        AgentFactory["AgentFactory\n(Agents skill)"]
        Personality["Personality\nTraits"]
        Voice["ElevenLabs\nVoice"]
    end

    subgraph Named["Named Agents"]
        Kaya["Kaya (Primary)"]
    end

    Tier1 -->|"workflow use"| Internal["Internal Workflows"]
    Tier2 -->|"Research skill"| Research["Research Tasks"]
    AgentFactory -->|"user: 'custom agents'"| Personality
    Personality --> Voice
    Named --> Sessions["Recurring Work"]
```

### 6.2 Agent Selection Guide

| Agent Type | Trigger | Use Case |
|------------|---------|----------|
| **Architect** | Complex design needs | System architecture, planning |
| **Engineer** | Implementation work | TDD, code writing |
| **Intern** | Parallel grunt work | Data collection, simple tasks |
| **Explore** | Codebase search | Finding files, understanding code |
| **Plan** | Approach planning | Implementation strategies |
| **QATester** | Validation | Browser testing, verification |
| **Research Agents** | `/research` or Research skill | Multi-source synthesis |
| **Custom Agents** | "custom agents", "spin up agents" | Unique personalities |

---

## 7. Workflow Routing

### 7.1 Intent Detection Flow

```mermaid
flowchart LR
    UserIntent["User Intent"]

    subgraph Detection["Intent Detection"]
        Keywords["Keyword\nMatching"]
        Context["Context\nAnalysis"]
        Slash["Slash\nCommands"]
    end

    subgraph Routing["Skill Routing"]
        SkillMatch["Skill\nActivation"]
        WorkflowSelect["Workflow\nSelection"]
    end

    subgraph Execution["Execution"]
        Voice["Voice\nNotification"]
        WorkflowRun["Run\nWorkflow"]
        Tools["Tool\nInvocation"]
        ISC["ISC\nTracking"]
    end

    UserIntent --> Keywords
    UserIntent --> Context
    UserIntent --> Slash
    Keywords --> SkillMatch
    Context --> SkillMatch
    Slash --> SkillMatch
    SkillMatch --> WorkflowSelect
    WorkflowSelect --> Voice
    Voice --> WorkflowRun
    WorkflowRun --> Tools
    WorkflowRun --> ISC
```

### 7.2 Key Trigger Mappings

| User Says | Skill | Workflow |
|-----------|-------|----------|
| "audit system", "integrity check" | System | IntegrityCheck |
| "create diagram", "visualize" | Art | Visualize |
| "run council", "debate" | Council | Debate |
| "custom agents", "spin up agents" | Agents | AgentFactory |
| "remember this", "save for later" | ContinualLearning | Capture |
| "system diagram", "update flowchart" | SystemFlowchart | GenerateArchitecture |
| "iterate until" | AutonomousWork | ralph_loop mode |
| "security scan" | System | SecurityScan |
| "browser", "screenshot" | Browser | Navigate |
| "triage tasks" | AsanaTriage | ReviewTasks |

### 7.3 Core Workflows (CORE/Workflows/)

| Workflow | Purpose |
|----------|---------|
| **Delegation.md** | Spawn parallel agents for complex tasks |
| **BackgroundDelegation.md** | Launch non-blocking agents |
| **TreeOfThought.md** | Structured decision-making |
| **GitPush.md** | Push changes with proper commits |
| **SessionContinuity.md** | Maintain context across sessions |
| **SessionCommit.md** | Commit session work to git |
| **HomeBridgeManagement.md** | Smart home automation |
| **ImageProcessing.md** | Image analysis workflows |
| **Transcription.md** | Audio transcription processing |

---

## 8. Hook Reference

### 8.1 All Hooks (19 files, 24 registrations)

| Hook | Event | Matcher | Purpose |
|------|-------|---------|---------|
| ConfigValidator | SessionStart | - | Validate settings.json schema |
| StartupGreeting | SessionStart | - | Display banner, voice catchphrase |
| LoadContext | SessionStart | - | Inject CORE + _USERCONTEXT |
| CheckVersion | SessionStart | - | Notify of Claude Code updates |
| FormatEnforcer | UserPromptSubmit | - | Inject response format template |
| AutoWorkCreation | UserPromptSubmit | - | Create WORK/ directory |
| ExplicitRatingCapture | UserPromptSubmit | - | Parse "N - text" ratings |
| ImplicitSentimentCapture | UserPromptSubmit | - | Haiku inference on emotion |
| UpdateTabTitle | UserPromptSubmit | - | Kitty tab + voice announcement |
| SecurityValidator | PreToolUse | Bash | Command safety validation |
| SecurityValidator | PreToolUse | Edit | File modification validation |
| SecurityValidator | PreToolUse | Write | File creation validation |
| SecurityValidator | PreToolUse | Read | File read validation |
| SetQuestionTab | PreToolUse | AskUserQuestion | Set question tab state |
| OutputValidator | PostToolUse | Bash | Command output validation |
| OutputValidator | PostToolUse | Edit | Edit success validation |
| OutputValidator | PostToolUse | Write | Write success validation |
| OutputValidator | PostToolUse | Read | Read success validation |
| QuestionAnswered | PostToolUse | AskUserQuestion | Reset tab after question |
| StopOrchestrator | Stop | - | Response capture + voice |
| WorkValidator | SessionEnd | - | Validate work session state |
| WorkCompletionLearning | SessionEnd | - | Extract learnings (Opus) |
| SessionSummary | SessionEnd | - | Mark work completed |
| AgentOutputCapture | SubagentStop | - | Capture subagent results |

### 8.2 Hook Execution Timeline

```mermaid
gantt
    title Hook Execution Timeline
    dateFormat X
    axisFormat %s

    section SessionStart
    ConfigValidator     :0, 1
    StartupGreeting     :1, 2
    LoadContext         :2, 3
    CheckVersion        :3, 4

    section UserPromptSubmit
    FormatEnforcer      :4, 5
    AutoWorkCreation    :5, 6
    ExplicitRatingCapture :5, 6
    ImplicitSentimentCapture :5, 6
    UpdateTabTitle      :5, 6

    section PreToolUse
    SecurityValidator   :6, 7
    SetQuestionTab      :6, 7

    section PostToolUse
    OutputValidator     :7, 8
    QuestionAnswered    :7, 8

    section Stop
    StopOrchestrator    :8, 9

    section SessionEnd
    WorkValidator       :9, 10
    WorkCompletionLearning :9, 10
    SessionSummary      :9, 10

    section SubagentStop
    AgentOutputCapture  :10, 11
```

### 8.3 Hook Utilities (hooks/lib/)

| Utility | Purpose |
|---------|---------|
| paths.ts | Path resolution and environment variables |
| identity.ts | Identity configuration from settings.json |
| notifications.ts | Notification service integration |
| observability.ts | Logging and trace emission |
| metadata-extraction.ts | Extract context from responses |
| response-format.ts | Response format validation |
| time.ts | Timezone-aware time utilities |
| learning-utils.ts | Learning capture patterns |
| change-detection.ts | Detect system state changes |
| work-utils.ts | Work session management |
| recovery-types.ts | Error recovery patterns |
| TraceEmitter.ts | Structured event tracing |

---

## 9. Security Architecture

### 9.1 Permission Levels

```mermaid
flowchart LR
    subgraph Permissions["Permission Levels"]
        Allow["allow\n(auto-approved)"]
        Ask["ask\n(user confirms)"]
        Deny["deny\n(blocked)"]
    end

    subgraph AllowList["Auto-Allowed"]
        Bash["Bash"]
        Read["Read/Write/Edit"]
        Web["WebFetch/WebSearch"]
        Tools["Glob/Grep/Task"]
        MCP["mcp__*"]
    end

    subgraph AskList["Requires Confirmation"]
        Destructive["rm -rf ~, rm -rf /"]
        Disk["diskutil commands"]
        GitForce["git push --force"]
        GHDelete["gh repo delete"]
        Secrets["~/.ssh/*, ~/.aws/*"]
    end

    Allow --> AllowList
    Ask --> AskList
```

### 9.2 Security Validation Flow

```mermaid
flowchart TB
    Tool["Tool Invocation"]

    Tool --> Matcher{"Permission\nMatcher"}

    Matcher -->|"allow"| Execute["Execute"]
    Matcher -->|"ask"| Confirm{"User\nConfirm?"}
    Matcher -->|"deny"| Block["Block"]

    Confirm -->|"Yes"| Execute
    Confirm -->|"No"| Block

    Execute --> SecurityHook["SecurityValidator\nHook"]
    SecurityHook --> patterns["Check patterns.yaml"]
    patterns --> Final{"Pattern\nMatch?"}

    Final -->|"blocked"| Block
    Final -->|"confirm"| UserAsk["Ask User"]
    Final -->|"alert"| Log["Log + Execute"]
    Final -->|"pass"| Run["Run Tool"]
```

### 9.3 Repository Security

| Repository | Purpose | Rules |
|------------|---------|-------|
| **Private ($KAYA_HOME)** | Personal instance | Never push public, contains sensitive data |
| **Public (danielmiessler/Kaya)** | Template | Sanitized examples only |

**Before every commit:** Run `git remote -v` to verify correct repository.

### 9.4 Secrets Management

**Location:** `$KAYA_HOME/secrets.json` (gitignored)

| Secret | Purpose |
|--------|---------|
| ELEVENLABS_API_KEY | Voice server TTS |
| ELEVENLABS_VOICE_ID | Default voice ID |
| ASANA_ACCESS_TOKEN | Task management |
| GEMINI_API_KEY | Gemini MCP integration |

---

## 10. Core Infrastructure Tools

Located in `lib/core/`:

| Tool | Purpose | Use When |
|------|---------|----------|
| **StateManager** | Type-safe state persistence | Managing JSON state files, queues, caches |
| **NotificationService** | Multi-channel notifications | Voice, push, discord alerts |
| **ConfigLoader** | SYSTEM/USER tiered config | Loading skill configs, settings.json |
| **CachedHTTPClient** | HTTP with caching, retry | Fetching URLs, API calls |
| **MemoryStore** | Unified memory storage | Capturing learnings, research, sessions |
| **ApprovalQueue** | Approval workflows | Human-in-loop decisions |
| **AgentOrchestrator** | Parallel agent spawning | Multi-agent work, spotcheck |
| **WorkflowExecutor** | Workflow execution | Daily/Weekly/Monthly maintenance |

---

## Quick Reference

### File Locations

| Component | Path |
|-----------|------|
| Settings | `~/.claude/settings.json` |
| Secrets | `~/.claude/secrets.json` |
| Skills | `~/.claude/skills/` |
| Hooks | `~/.claude/hooks/` |
| Memory | `~/.claude/MEMORY/` |
| Voice Server | `~/.claude/VoiceServer/` |
| Tools | `~/.claude/tools/` |
| Plans | `~/.claude/Plans/` |
| Observability | `~/.claude/Observability/` |

### Key State Files

| File | Purpose |
|------|---------|
| `MEMORY/State/current-work.json` | Active work session pointer |
| `MEMORY/State/integrity-state.json` | System health check throttling |
| `MEMORY/State/algorithm-state.json` | Algorithm execution state |
| `MEMORY/LEARNING/SIGNALS/ratings.jsonl` | User rating signals |
| `MEMORY/security/` | Security audit log |

### Enabled Plugins

| Plugin | Purpose |
|--------|---------|
| playwright | Browser automation |
| audit-context-building@trailofbits | Code analysis |
| differential-review@trailofbits | PR security review |
| static-analysis@trailofbits | CodeQL/Semgrep |
| variant-analysis@trailofbits | Bug variant hunting |
| sharp-edges@trailofbits | Footgun detection |

---

*Generated by SystemFlowchart skill*
*For updates, run: "update architecture diagram" or "review Kaya system"*
