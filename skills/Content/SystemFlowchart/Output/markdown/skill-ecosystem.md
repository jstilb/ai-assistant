# Skill Ecosystem

Skill ecosystem organized by Meta/Orchestration/Specialized categories

**Generated:** 2026-02-28T01:12:11.170Z

```mermaid
flowchart TB
    subgraph Meta["Meta Skills (10)"]
        direction LR
        Art["Art"]
        CreateSkill["CreateSkill"]
        Fabric["Fabric"]
        GeminiSync["GeminiSync"]
        KayaUpgrade["KayaUpgrade"]
        PublicSync["PublicSync"]
        Research["Research"]
        SkillAudit["SkillAudit"]
        System["System"]
        SystemFlowchart["SystemFlowchart"]
    end

    subgraph Orchestration["Orchestration Skills (11)"]
        direction LR
        AgentMonitor["AgentMonitor"]
        Agents["Agents"]
        AutoInfoManager["AutoInfoManager"]
        AutoMaintenance["AutoMaintenance"]
        AutonomousWork["AutonomousWork"]
        ContinualLearning["ContinualLearning"]
        Evals["Evals"]
        ProactiveEngine["ProactiveEngine"]
        QueueRouter["QueueRouter"]
        Simulation["Simulation"]
    end

    subgraph Specialized["Specialized Skills (33)"]
        direction TB
        Anki["Anki"]
        Apify["Apify"]
        ArgumentMapper["ArgumentMapper"]
        BrightData["BrightData"]
        Browser["Browser"]
        CalendarAssistant["CalendarAssistant"]
        Canvas["Canvas"]
        CommunityOutreach["CommunityOutreach"]
        ContentAggregator["ContentAggregator"]
        ContextManager["ContextManager"]
        Cooking["Cooking"]
        CreateCLI["CreateCLI"]
        DailyBriefing["DailyBriefing"]
        Designer["Designer"]
        DigitalMaestro["DigitalMaestro"]
        DnD["DnD"]
        Gmail["Gmail"]
        Graph["Graph"]
        InformationManager["InformationManager"]
        Instacart["Instacart"]
        JobEngine["JobEngine"]
        KnowledgeGraph["KnowledgeGraph"]
        LucidTasks["LucidTasks"]
        Obsidian["Obsidian"]
        Prompting["Prompting"]
        Shopping["Shopping"]
        SpecSheet["SpecSheet"]
        Telegram["Telegram"]
        Telos["Telos"]
        UIBuilder["UIBuilder"]
        UnixCLI["UnixCLI"]
        VoiceInteraction["VoiceInteraction"]
        WebAssessment["WebAssessment"]
    end

    %% Category relationships
    Meta --> Orchestration
    Meta --> Specialized
    Orchestration --> Specialized

    %% Key dependencies
    System --> SkillAudit
    AutonomousWork --> Agents
    QueueRouter --> AutonomousWork

    classDef meta fill:#1e3a5f,stroke:#93c5fd,color:#fff
    classDef orch fill:#4c1d95,stroke:#c4b5fd,color:#fff
    classDef spec fill:#064e3b,stroke:#6ee7b7,color:#fff

    class Art,CreateSkill,Fabric,GeminiSync,KayaUpgrade,PublicSync,Research,SkillAudit,System,SystemFlowchart meta
    class AgentMonitor,Agents,AutoInfoManager,AutoMaintenance,AutonomousWork,ContinualLearning,Evals,ProactiveEngine,QueueRouter,Simulation orch
    class Anki,Apify,ArgumentMapper,BrightData,Browser,CalendarAssistant,Canvas,CommunityOutreach,ContentAggregator,ContextManager,Cooking,CreateCLI,DailyBriefing,Designer,DigitalMaestro,DnD,Gmail,Graph,InformationManager,Instacart,JobEngine,KnowledgeGraph,LucidTasks,Obsidian,Prompting,Shopping,SpecSheet,Telegram,Telos,UIBuilder,UnixCLI,VoiceInteraction,WebAssessment spec
```
