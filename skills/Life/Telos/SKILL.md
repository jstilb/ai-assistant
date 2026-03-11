---
name: Telos
description: Life OS with goal tracking, project dependency mapping, dashboard generation, narrative writing, and weekly reviews. USE WHEN TELOS, life goals, goal dashboard, projects, dependencies, weekly review, goal progress, books, movies, life direction.
---

# Telos

**TELOS** (Telic Evolution and Life Operating System) is a comprehensive context-gathering system with two applications:

1. **Personal TELOS** - {principal.name}'s life context system (beliefs, goals, lessons, wisdom) at `~/.claude/USER/TELOS/`
2. **Project TELOS** - Analysis framework for organizations/projects (relationships, dependencies, goals, progress)
## Voice Notification

-> Use `notifySync()` from `lib/core/NotificationService.ts`

## Workflow Routing

**When executing a workflow, output this notification directly:**

```
Running the **WorkflowName** workflow from the **Telos** skill...
```

| Workflow | Trigger | File |
|----------|---------|------|
| **Update** | "add to TELOS", "update my goals", "add book to TELOS" | `Workflows/Update.md` |
| **InterviewExtraction** | "extract content", "extract interviews", "analyze interviews" | `Workflows/InterviewExtraction.md` |
| **CreateNarrativePoints** | "create narrative", "narrative points", "TELOS report", "n=24" | `Workflows/CreateNarrativePoints.md` |
| **WriteReport** | "write report", "McKinsey report", "create TELOS report", "professional report" | `Workflows/WriteReport.md` |

**Note:** For general project analysis, dashboards, dependency mapping, and executive summaries, the skill handles these directly without a separate workflow file.

## Examples

**Example 1: Update personal TELOS**
```
User: "add Project Hail Mary to my TELOS books"
--> Invokes Update workflow
--> Creates timestamped backup of BOOKS.md
--> Adds book entry with formatted metadata
--> Logs change in updates.md with timestamp
```

**Example 2: Analyze project with TELOS**
```
User: "analyze ~/Projects/MyApp with TELOS"
--> Scans all .md and .csv files in directory
--> Extracts entities, relationships, dependencies
--> Returns analysis with dependency chains and progress metrics
```

**Example 3: Build project dashboard**
```
User: "build a dashboard for TELOSAPP"
--> Launches up to 10 parallel engineers
--> Creates Next.js dashboard with Tailwind CSS
--> Returns interactive dashboard with metrics cards, progress tables
```

**Example 4: Generate narrative points**
```
User: "create TELOS narrative for Acme Corp, n=24"
--> Invokes CreateNarrativePoints workflow
--> Analyzes TELOS context (situation, problems, recommendations)
--> Returns 24 crisp bullet points (8-12 words each)
--> Output is slide-ready for presentations or customer briefings
```

**Example 5: Generate McKinsey-style report**
```
User: "write a TELOS report for Acme Corp"
--> Invokes WriteReport workflow
--> First runs CreateNarrativePoints to generate story content
--> Maps narrative to McKinsey report structure
--> Generates web-based report with professional styling
--> Output at {project_dir}/report - run `bun dev` to view
--> White background, subtle Tokyo Night Storm accents
--> Includes: cover page, executive summary, findings, recommendations, roadmap
```

---

## Context Detection

**How {daidentity.name} determines which TELOS context:**

| User Request | Context | Location |
|--------------|---------|----------|
| "my TELOS", "my goals", "my beliefs", "add to TELOS" | Personal TELOS | `~/.claude/USER/TELOS/` |
| "Alma", "TELOSAPP", "analyze [project]", "dashboard for" | Project TELOS | User-specified directory |
| "analyze ~/path/to/project" | Project TELOS | Specified path |

---

# Part 1: Personal TELOS ({principal.name}'s Life)

## Location

**CRITICAL PATH:** All personal TELOS files are located at:
```
~/.claude/USER/TELOS/
```

Personal TELOS lives in the CORE USER directory, NOT directly under the Telos skill directory.

## Personal TELOS Framework

All files located in `~/.claude/USER/TELOS/`:

### Core Philosophy
- **TELOS.md** - Main framework document
- **MISSION.md** - Life mission statement
- **BELIEFS.md** - Core beliefs and world model
- **WISDOM.md** - Accumulated wisdom

### Life Data
- **BOOKS.md** - Favorite books
- **MOVIES.md** - Favorite movies
- **LEARNED.md** - Lessons learned over time
- **WRONG.md** - Things {principal.name} was wrong about (growth tracking)

### Mental Models
- **FRAMES.md** - Mental frames and perspectives
- **MODELS.md** - Mental models used for decision-making
- **NARRATIVES.md** - Personal narratives and self-stories
- **STRATEGIES.md** - Strategies being employed in life

### Goals & Challenges
- **GOALS.md** - Life goals (short-term and long-term)
- **PROJECTS.md** - Active projects
- **PROBLEMS.md** - Problems to solve
- **CHALLENGES.md** - Current challenges being faced
- **PREDICTIONS.md** - Predictions about the future
- **TRAUMAS.md** - Past traumas (for context and healing)

### Change Tracking
- **updates.md** - Comprehensive changelog of all TELOS updates

## Working with Personal TELOS

### Read Files

```bash
# View specific file
read ~/.claude/USER/TELOS/GOALS.md
read ~/.claude/USER/TELOS/BELIEFS.md

# View recent updates
read ~/.claude/USER/TELOS/updates.md
```

### Update Personal TELOS

**CRITICAL:** Never manually edit. Use the Update workflow.

**Workflow:** `Workflows/Update.md`

The workflow provides:
- Automatic timestamped backups
- Change logging in updates.md
- Version history preservation
- Proper formatting and structure

**Valid files for updates:** All files listed in the Personal TELOS Framework section above (BELIEFS.md through WRONG.md, 18 files total).

---

# Part 2: Project TELOS (Organizational Analysis)

## Capabilities

For any project directory, TELOS provides:

1. **Relationship Discovery** - Find how files/entities connect
2. **Dependency Mapping** - Identify what depends on what
3. **Goal Extraction** - Discover stated and implied objectives
4. **Progress Analysis** - Track advancement and metrics
5. **Narrative Generation** - Create executive summaries
6. **Visual Dashboards** - Build beautiful UIs with data

## Target Directory Detection

**Flexible file discovery - no required structure:**

```bash
# User specifies directory
"Analyze ~/Cloud/Projects/TELOSAPP"
--> {daidentity.name} scans for .md and .csv files anywhere in tree

# {daidentity.name} automatically finds all .md and .csv files regardless of structure
```

## Analysis Workflow

### Step 1: Identify Target

**Auto-detection:**
- User mentions project name (TELOSAPP, Alma, etc.)
- User provides path explicitly
- {daidentity.name} looks for common project locations

### Step 2: Scan Files

Discover all markdown and CSV files:
```bash
find $TARGET_DIR -type f \( -name "*.md" -o -name "*.csv" \)
```

Index:
- Markdown structure (headings, sections, links)
- CSV schema (columns, data types)
- Cross-references and mentions
- Entities (people, teams, projects, problems)

### Step 3: Relationship Analysis

Build relationship graph:
1. **Entity Extraction** - Identify unique entities
2. **Connection Discovery** - Find explicit/implicit links
3. **Dependency Mapping** - Trace dependencies
4. **Network Construction** - Build directed graph

### Step 4: Generate Insights

Produce analytics:
- **Dependency Chains**: PROBLEMS --> GOALS --> STRATEGIES --> PROJECTS
- **Bottlenecks**: What blocks progress?
- **Goal Alignment**: Projects aligned with objectives?
- **Progress Metrics**: Completion percentages
- **Risk Areas**: Overdue items, blocked work

### Step 5: Create Outputs

**Output Formats:**

1. **Markdown Report** - Static analysis with Mermaid diagrams
2. **Web Dashboard** - Interactive Next.js app with Tailwind CSS
3. **JSON Export** - Structured data
4. **Executive Summary** - Narrative overview
5. **Custom Format** - As requested

## Building Dashboards

### Parallel Engineer Strategy

**CRITICAL: When building UIs, use up to 16 parallel engineers.**

**Launch Strategy:**
Use single message with 10 Task calls in parallel:

```
Engineer 1: Project structure + layout + navigation
Engineer 2: Overview page with metrics cards
Engineer 3: Projects page with progress tracking
Engineer 4: Teams page with performance tables
Engineer 5: Vulnerabilities/issues page
Engineer 6: Progress timeline visualization
Engineer 7: Data parsing library (MD/CSV)
Engineer 8: Shared components (cards, badges, tables)
Engineer 9: Design polish and theme
Engineer 10: Integration and testing
```

### Dashboard Requirements

**Tech Stack:**
- Next.js 15 + TypeScript
- Tailwind CSS 4
- Lucide React icons
- Tokyo Night Day theme (professional light)

**Features:**
- Dependency graphs (Mermaid diagrams)
- Progress tables (sortable, filterable)
- Metrics cards (KPIs, stats)
- Timeline visualizations
- Relationship networks

**Design:**
```css
--background: #ffffff
--foreground: #1a1b26
--primary: #2e7de9
--accent: #9854f1
--destructive: #f52a65
--success: #33b579
--warning: #f0a020
```

## Common TELOS Files

**Standard Project TELOS Structure** (auto-detected):

### Context Files
- **OVERVIEW.md** - Project overview
- **COMPANY.md** - Organization context
- **PROBLEMS.md** - Issues to solve
- **GOALS.md** - Objectives
- **MISSION.md** - Mission statement
- **STRATEGIES.md** - Strategic approaches
- **PROJECTS.md** - Active initiatives

### Operational Files
- **EMPLOYEES.md** - Team members
- **ENGINEERING_TEAMS.md** - Team structure
- **BUDGET.md** - Financial tracking
- **KPI_TRACKING.md** - Metrics
- **APPLICATIONS.md** - App inventory
- **TOOLS.md** - Tooling
- **VENDORS.md** - Third parties

### Security Files
- **VULNERABILITIES.md** - Security issues
- **SECURITY_POSTURE.md** - Security state
- **THREAT_MODEL.md** - Threats

### Data Files (CSV)
- **data/VULNERABILITIES.csv** - Vuln tracking
- **data/INCIDENTS.csv** - Incident log
- **data/VENDORS.csv** - Vendor data

**Note:** Files are optional. TELOS adapts to whatever exists.

## Visualization Types

**Available Visualizations:**

- **Dependency Graphs** - Mermaid diagrams
- **Progress Tables** - Tailwind-styled tables with filters
- **Metrics Cards** - Custom card layouts
- **Timeline Charts** - Progress over time
- **Status Dashboards** - KPI overviews
- **Relationship Networks** - Mermaid or custom SVG

---

## Security & Privacy

**Personal TELOS:**
- NEVER commit to public repos
- NEVER share publicly
- Always backup before changes
- Use Update workflow only

**Project TELOS:**
- May contain sensitive data
- Ask before sharing externally
- Redact sensitive info in examples
- Follow Kaya security protocols

---

## Key Principles

1. **Dual Context** - Handles both personal and project TELOS seamlessly
   - Personal TELOS: `~/.claude/USER/TELOS/` (in CORE USER directory)
   - Project TELOS: User-specified directories
2. **Auto-Detection** - Determines context from user question
3. **Flexible Discovery** - Finds files regardless of structure
4. **TELOS Methodology** - Applies relationships, dependencies, goals, narratives
5. **Parallel Execution** - Up to 10 engineers for dashboard builds
6. **Visual Excellence** - Beautiful outputs with Tailwind CSS + Lucide icons
7. **Privacy-Aware** - Respects sensitive data
8. **Integrated** - Works with development, research, and other skills

---

**TELOS is {principal.name}'s life operating system AND project analysis framework. One skill, two powerful contexts.**

**Remember:** Personal TELOS files live at `~/.claude/USER/TELOS/` (in the CORE USER directory)

---

## Integration

### Uses
- **USER/TELOS/** - Personal life framework files
- **Parallel engineers** - Up to 16 Task agents for dashboard builds
- **Filesystem** - Project directory scanning for .md and .csv files
- **USER/TELOS/** - User-specific preferences and configuration

### Feeds Into
- **_USERCONTEXT** - Life framework summary for session context
- **_DTR** - Goal and status tracking from TELOS data
- **ContinualLearning** - Life lessons and wisdom capture
- **Dashboard outputs** - Interactive Next.js visualizations

### MCPs Used
- None (direct filesystem and parallel agents)
