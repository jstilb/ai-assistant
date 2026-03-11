#!/usr/bin/env bun
/**
 * DiagramBuilder.ts
 *
 * Transforms system scan results into Mermaid diagram data.
 * Generates different diagram types for Kaya architecture visualization.
 *
 * Usage:
 *   bun DiagramBuilder.ts overview         # System overview diagram
 *   bun DiagramBuilder.ts lifecycle        # Session lifecycle sequence diagram
 *   bun DiagramBuilder.ts ecosystem        # Skill ecosystem with categories
 *   bun DiagramBuilder.ts memory           # Memory structure diagram
 *   bun DiagramBuilder.ts all              # Generate all diagrams
 */

import { fullScan, type SystemScan, type HookInfo } from './SystemScanner.ts';
import { categorizeSkills, type CategorizationResult } from './SkillCategorizer.ts';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';

const KAYA_DIR = process.env.KAYA_DIR || process.env.KAYA_HOME || join(process.env.HOME || '', '.claude');

// ============================================================================
// Types
// ============================================================================

export interface DiagramOutput {
  name: string;
  type: 'flowchart' | 'sequence' | 'classDiagram' | 'graph';
  mermaid: string;
  description: string;
}

export interface DiagramSet {
  timestamp: string;
  diagrams: DiagramOutput[];
}

// ============================================================================
// Diagram Builders
// ============================================================================

/**
 * Build system overview diagram
 */
export async function buildSystemOverview(scan: SystemScan): Promise<DiagramOutput> {
  const mermaid = `flowchart TB
    subgraph Core["Kaya Core"]
        Settings["settings.json<br/>Identity & Config"]
        CORE["CORE Skill<br/>System Reference"]
        Hooks["Hook System<br/>${scan.stats.hookCount} hooks"]
    end

    subgraph Skills["Skill Ecosystem"]
        Public["Public Skills<br/>${scan.stats.publicSkillCount} skills"]
        Private["Private Skills<br/>${scan.stats.privateSkillCount} skills"]
        Workflows["Workflows<br/>${scan.stats.workflowCount} total"]
    end

    subgraph Memory["Memory System"]
        WORK["WORK/<br/>Active sessions"]
        LEARNING["LEARNING/<br/>Captured insights"]
        STATE["STATE/<br/>System state"]
    end

    subgraph Agents["Agent System"]
        TaskAgents["Task Subagents<br/>Architect, Engineer, etc."]
        CustomAgents["Custom Agents<br/>Via AgentFactory"]
        NamedAgents["Named Agents<br/>Persistent voices"]
    end

    Settings --> CORE
    CORE --> Hooks
    CORE --> Skills
    Hooks --> Memory
    Skills --> Agents
    Skills --> Memory
    Workflows --> Agents

    classDef core fill:#1e3a5f,stroke:#93c5fd,color:#fff
    classDef skills fill:#064e3b,stroke:#6ee7b7,color:#fff
    classDef memory fill:#4c1d95,stroke:#c4b5fd,color:#fff
    classDef agents fill:#7c2d12,stroke:#fdba74,color:#fff

    class Settings,CORE,Hooks core
    class Public,Private,Workflows skills
    class WORK,LEARNING,STATE memory
    class TaskAgents,CustomAgents,NamedAgents agents`;

  return {
    name: 'system-overview',
    type: 'flowchart',
    mermaid,
    description: 'High-level Kaya system architecture showing core components and relationships',
  };
}

/**
 * Build session lifecycle sequence diagram
 */
export async function buildSessionLifecycle(hooks: HookInfo[]): Promise<DiagramOutput> {
  // Group hooks by event type
  const byEvent: Record<string, HookInfo[]> = {};
  for (const hook of hooks) {
    if (!byEvent[hook.eventType]) {
      byEvent[hook.eventType] = [];
    }
    byEvent[hook.eventType].push(hook);
  }

  const sessionStartHooks = byEvent['SessionStart'] || [];
  const promptSubmitHooks = byEvent['UserPromptSubmit'] || [];
  const preToolHooks = byEvent['PreToolUse'] || [];
  const stopHooks = byEvent['Stop'] || [];
  const sessionEndHooks = byEvent['SessionEnd'] || [];

  const mermaid = `sequenceDiagram
    participant U as User
    participant CC as Claude Code
    participant H as Hooks
    participant S as Skills
    participant M as Memory
    participant V as Voice

    Note over CC: SESSION START

    rect rgb(30, 58, 95)
    Note right of CC: SessionStart Event
    ${sessionStartHooks.map(h => `    CC->>H: ${h.name}`).join('\n    ')}
    H->>V: Voice greeting
    H->>CC: Load CORE context
    end

    U->>CC: Submit prompt

    rect rgb(6, 78, 59)
    Note right of CC: UserPromptSubmit Event
    ${promptSubmitHooks.map(h => `    CC->>H: ${h.name}`).join('\n    ')}
    H->>M: Rating/sentiment capture
    end

    CC->>S: Process with skills

    rect rgb(76, 29, 149)
    Note right of CC: PreToolUse Event
    ${preToolHooks.map(h => `    CC->>H: ${h.name}`).join('\n    ')}
    H->>CC: Security validation
    end

    S->>CC: Tool results
    CC->>U: Generate response

    rect rgb(124, 45, 18)
    Note right of CC: Stop Event
    ${stopHooks.map(h => `    CC->>H: ${h.name}`).join('\n    ')}
    H->>V: Voice completion
    end

    Note over CC: SESSION END

    rect rgb(51, 65, 85)
    Note right of CC: SessionEnd Event
    ${sessionEndHooks.map(h => `    CC->>H: ${h.name}`).join('\n    ')}
    H->>M: Session summary capture
    end`;

  return {
    name: 'session-lifecycle',
    type: 'sequence',
    mermaid,
    description: 'Session lifecycle showing hook execution order from start to end',
  };
}

/**
 * Build skill ecosystem diagram with categories
 */
export async function buildSkillEcosystem(categories: CategorizationResult): Promise<DiagramOutput> {
  const metaSkills = categories.skillsByCategory.Meta;
  const orchSkills = categories.skillsByCategory.Orchestration;
  const specSkills = categories.skillsByCategory.Specialized;

  // Build subgraphs for each category
  const metaNodes = metaSkills.map(s => {
    const id = s.replace(/[^a-zA-Z0-9]/g, '');
    return `        ${id}["${s}"]`;
  }).join('\n');

  const orchNodes = orchSkills.map(s => {
    const id = s.replace(/[^a-zA-Z0-9]/g, '');
    return `        ${id}["${s}"]`;
  }).join('\n');

  // Group specialized skills for readability (max 6 per row)
  const specNodes = specSkills.map(s => {
    const id = s.replace(/[^a-zA-Z0-9]/g, '');
    return `        ${id}["${s}"]`;
  }).join('\n');

  const mermaid = `flowchart TB
    subgraph Meta["Meta Skills (${metaSkills.length})"]
        direction LR
${metaNodes}
    end

    subgraph Orchestration["Orchestration Skills (${orchSkills.length})"]
        direction LR
${orchNodes}
    end

    subgraph Specialized["Specialized Skills (${specSkills.length})"]
        direction TB
${specNodes}
    end

    %% Category relationships
    Meta --> Orchestration
    Meta --> Specialized
    Orchestration --> Specialized

    %% Key dependencies
    CORE --> System

    classDef meta fill:#1e3a5f,stroke:#93c5fd,color:#fff
    classDef orch fill:#4c1d95,stroke:#c4b5fd,color:#fff
    classDef spec fill:#064e3b,stroke:#6ee7b7,color:#fff

    class ${metaSkills.map(s => s.replace(/[^a-zA-Z0-9]/g, '')).join(',')} meta
    class ${orchSkills.map(s => s.replace(/[^a-zA-Z0-9]/g, '')).join(',')} orch
    class ${specSkills.map(s => s.replace(/[^a-zA-Z0-9]/g, '')).join(',')} spec`;

  return {
    name: 'skill-ecosystem',
    type: 'flowchart',
    mermaid,
    description: 'Skill ecosystem organized by Meta/Orchestration/Specialized categories',
  };
}

/**
 * Build memory structure diagram
 */
export async function buildMemoryStructure(scan: SystemScan): Promise<DiagramOutput> {
  const memDirs = scan.memory.directories.map(d => d.name);

  const mermaid = `flowchart TB
    subgraph MEMORY["MEMORY/ (${scan.memory.totalFiles} files)"]
        direction TB

        ${memDirs.includes('WORK') ? `subgraph WORK["WORK/"]
            WorkSession["Session directories"]
            WorkMeta["META.yaml"]
            WorkIdeal["IDEAL.md"]
            WorkItems["items/"]
        end` : ''}

        ${memDirs.includes('LEARNING') ? `subgraph LEARNING["LEARNING/"]
            Signals["SIGNALS/"]
            Ratings["ratings.jsonl"]
            Algorithm["ALGORITHM/"]
            Patterns["PATTERNS/"]
        end` : ''}

        ${memDirs.includes('State') ? `subgraph STATE["State/"]
            CurrentWork["current-work.json"]
            IntegrityState["integrity-state.json"]
            TabTitle["tab-title.json"]
        end` : ''}

        ${memDirs.includes('MAINTENANCE') ? `subgraph MAINTENANCE["MAINTENANCE/"]
            Daily["daily/"]
            Weekly["weekly/"]
            Monthly["monthly/"]
        end` : ''}

        ${memDirs.includes('VALIDATION') ? `subgraph VALIDATION["VALIDATION/"]
            ConfigVal["config-validation-*.jsonl"]
            WorkVal["work-validation-*.jsonl"]
        end` : ''}

        ${memDirs.includes('research') ? `subgraph RESEARCH["research/"]
            ResearchOut["Agent research outputs"]
        end` : ''}

        ${memDirs.includes('KNOWLEDGE') ? `subgraph KNOWLEDGE["KNOWLEDGE/"]
            KnowDaily["daily/"]
            KnowWeekly["weekly/"]
            KnowMonthly["monthly/"]
        end` : ''}
    end

    %% Data flows
    SessionCapture["Session<br/>Capture"] --> WORK
    LearningCapture["Learning<br/>Capture"] --> LEARNING
    StateUpdates["State<br/>Updates"] --> STATE
    MaintenanceRuns["Maintenance<br/>Workflows"] --> MAINTENANCE

    classDef memory fill:#4c1d95,stroke:#c4b5fd,color:#fff
    classDef flow fill:#1e3a5f,stroke:#93c5fd,color:#fff`;

  return {
    name: 'memory-structure',
    type: 'flowchart',
    mermaid,
    description: 'MEMORY/ directory organization and data flow',
  };
}

/**
 * Build configuration flow diagram
 */
export async function buildConfigurationFlow(): Promise<DiagramOutput> {
  const mermaid = `flowchart LR
    subgraph Settings["settings.json"]
        Identity["daidentity<br/>(AI name, voice)"]
        Principal["principal<br/>(User name, tz)"]
        HookConfig["hooks<br/>(registrations)"]
        Permissions["permissions<br/>(tool access)"]
    end

    subgraph SYSTEM["SYSTEM/ Defaults"]
        SysResponse["RESPONSEFORMAT.md"]
        SysSecurity["KAYASECURITYSYSTEM/"]
        SysSkills["TitleCase Skills"]
        SysDocs["Documentation"]
    end

    subgraph USER["USER/ Overrides"]
        UserResponse["RESPONSEFORMAT.md"]
        UserSecurity["KAYASECURITYSYSTEM/"]
        UserSkills["_ALLCAPS Skills"]
        UserCustom["Customizations"]
    end

    Settings --> SYSTEM
    SYSTEM --> USER

    USER -->|"USER exists?"| Final["Active Config"]
    SYSTEM -->|"No USER"| Final

    Note["USER files always<br/>override SYSTEM"] -.- USER

    classDef settings fill:#1e3a5f,stroke:#93c5fd,color:#fff
    classDef system fill:#064e3b,stroke:#6ee7b7,color:#fff
    classDef user fill:#4c1d95,stroke:#c4b5fd,color:#fff

    class Identity,Principal,HookConfig,Permissions settings
    class SysResponse,SysSecurity,SysSkills,SysDocs system
    class UserResponse,UserSecurity,UserSkills,UserCustom user`;

  return {
    name: 'configuration-flow',
    type: 'flowchart',
    mermaid,
    description: 'Configuration inheritance from settings.json through SYSTEM/USER tiers',
  };
}

/**
 * Build agent architecture diagram
 */
export async function buildAgentArchitecture(): Promise<DiagramOutput> {
  const mermaid = `flowchart TB
    subgraph TaskAgents["Task Tool Subagent Types"]
        direction LR
        Architect["Architect"]
        Engineer["Engineer"]
        Intern["Intern"]
        Explore["Explore"]
        Plan["Plan"]
        QATester["QATester"]
        Designer["Designer"]
    end

    subgraph ResearchAgents["Research Agents"]
        direction LR
        ClaudeRes["ClaudeResearcher"]
        GrokRes["GrokResearcher"]
        GeminiRes["GeminiResearcher"]
        CodexRes["CodexResearcher"]
    end

    subgraph CustomAgents["Custom Agents (AgentFactory)"]
        Factory["AgentFactory<br/>Composition"]
        Personality["Personality<br/>Assignment"]
        Voice["ElevenLabs<br/>Voice Mapping"]
    end

    subgraph NamedAgents["Named Agents"]
        Kaya["Kaya<br/>(Primary)"]
        Others["Other Named<br/>Agents"]
    end

    %% Relationships
    TaskAgents -->|"internal workflows"| Workflows["Skill Workflows"]
    ResearchAgents -->|"Research skill"| Research["Research Tasks"]
    Factory --> Personality --> Voice
    NamedAgents -->|"recurring work"| Sessions["User Sessions"]

    User["User Request"] -->|"'custom agents'"| Factory
    User -->|"'spawn interns'"| Intern

    classDef task fill:#1e3a5f,stroke:#93c5fd,color:#fff
    classDef research fill:#064e3b,stroke:#6ee7b7,color:#fff
    classDef custom fill:#4c1d95,stroke:#c4b5fd,color:#fff
    classDef named fill:#7c2d12,stroke:#fdba74,color:#fff`;

  return {
    name: 'agent-architecture',
    type: 'flowchart',
    mermaid,
    description: 'Agent system showing Task subagents, research agents, custom agents, and named agents',
  };
}

// ============================================================================
// Main Generation
// ============================================================================

/**
 * Generate all diagrams
 */
export async function generateAllDiagrams(): Promise<DiagramSet> {
  const scan = await fullScan();
  const categories = await categorizeSkills();

  const diagrams = await Promise.all([
    buildSystemOverview(scan),
    buildSessionLifecycle(scan.hooks),
    buildSkillEcosystem(categories),
    buildMemoryStructure(scan),
    buildConfigurationFlow(),
    buildAgentArchitecture(),
  ]);

  return {
    timestamp: new Date().toISOString(),
    diagrams,
  };
}

/**
 * Save diagrams to Output directory as markdown files
 */
export async function saveDiagrams(set: DiagramSet, outputDir?: string): Promise<string[]> {
  const dir = outputDir || join(KAYA_DIR, 'skills', 'SystemFlowchart', 'Output', 'markdown');

  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }

  const savedFiles: string[] = [];

  for (const diagram of set.diagrams) {
    const content = `# ${diagram.name.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}

${diagram.description}

**Generated:** ${set.timestamp}

\`\`\`mermaid
${diagram.mermaid}
\`\`\`
`;

    const filePath = join(dir, `${diagram.name}.md`);
    await writeFile(filePath, content);
    savedFiles.push(filePath);
  }

  return savedFiles;
}

// ============================================================================
// CLI
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'all';

  const scan = await fullScan();
  const categories = await categorizeSkills();

  let diagram: DiagramOutput | null = null;

  switch (command) {
    case 'overview':
      diagram = await buildSystemOverview(scan);
      break;

    case 'lifecycle':
      diagram = await buildSessionLifecycle(scan.hooks);
      break;

    case 'ecosystem':
      diagram = await buildSkillEcosystem(categories);
      break;

    case 'memory':
      diagram = await buildMemoryStructure(scan);
      break;

    case 'config':
      diagram = await buildConfigurationFlow();
      break;

    case 'agents':
      diagram = await buildAgentArchitecture();
      break;

    case 'all':
      const set = await generateAllDiagrams();
      const savedFiles = await saveDiagrams(set);
      console.log('Generated diagrams:');
      for (const file of savedFiles) {
        console.log(`  - ${file}`);
      }
      console.log(`\nTotal: ${savedFiles.length} diagrams`);
      return;

    case '--json':
      const allDiagrams = await generateAllDiagrams();
      console.log(JSON.stringify(allDiagrams, null, 2));
      return;

    default:
      console.log(`
DiagramBuilder - Generate Kaya Architecture Diagrams

Usage:
  bun DiagramBuilder.ts overview     System overview diagram
  bun DiagramBuilder.ts lifecycle    Session lifecycle sequence diagram
  bun DiagramBuilder.ts ecosystem    Skill ecosystem with categories
  bun DiagramBuilder.ts memory       Memory structure diagram
  bun DiagramBuilder.ts config       Configuration flow diagram
  bun DiagramBuilder.ts agents       Agent architecture diagram
  bun DiagramBuilder.ts all          Generate and save all diagrams
  bun DiagramBuilder.ts --json       Output all diagrams as JSON
`);
      return;
  }

  if (diagram) {
    console.log(`# ${diagram.name}\n`);
    console.log(`${diagram.description}\n`);
    console.log('```mermaid');
    console.log(diagram.mermaid);
    console.log('```');
  }
}

main().catch(console.error);
