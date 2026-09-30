# Telos Architecture

## Context Detection

**How Kaya determines which TELOS context:**

| User Request | Context | Location |
|--------------|---------|----------|
| "my TELOS", "my goals", "my beliefs", "add to TELOS" | Personal TELOS | `~/.claude/USER/TELOS/` |
| "Alma", "TELOSAPP", "analyze [project]", "dashboard for" | Project TELOS | User-specified directory |
| "analyze ~/path/to/project" | Project TELOS | Specified path |

---

# Part 1: Personal TELOS

## Location

**CRITICAL PATH:** All personal TELOS files are located at:
```
~/.claude/USER/TELOS/
```

Personal TELOS lives in the CORE USER directory, NOT directly under the Telos skill directory.

## Personal TELOS Framework

All files located in `~/.claude/USER/TELOS/`:

### Core Philosophy
- **MISSIONS.md** - Life missions (M0-M6)
- **BELIEFS.md** - Core beliefs and world model

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
- **STATUS.md** - Current state across all life areas

### Change Tracking
- **updates.md** - Comprehensive changelog of all TELOS updates

BOOKS, IDEAS, LEARNED, MOVIES, PREDICTIONS, TRAUMAS, WISDOM and WRONG (plus TELOS.md and MISSION.md) were unfilled scaffolds, deleted in the 2026-09 context-pollution audit — see `USER/TELOS/README.md` before recreating one.

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
--> Kaya scans for .md and .csv files anywhere in tree
```

## Analysis Workflow

### Step 1: Identify Target
- User mentions project name (TELOSAPP, Alma, etc.)
- User provides path explicitly

### Step 2: Scan Files

```bash
find $TARGET_DIR -type f \( -name "*.md" -o -name "*.csv" \)
```

Index: Markdown structure, CSV schema, cross-references, entities.

### Step 3: Relationship Analysis

Build relationship graph:
1. **Entity Extraction** - Identify unique entities
2. **Connection Discovery** - Find explicit/implicit links
3. **Dependency Mapping** - Trace dependencies
4. **Network Construction** - Build directed graph

### Step 4: Generate Insights

- **Dependency Chains**: PROBLEMS --> GOALS --> STRATEGIES --> PROJECTS
- **Bottlenecks**: What blocks progress?
- **Goal Alignment**: Projects aligned with objectives?
- **Progress Metrics**: Completion percentages

### Step 5: Create Outputs

1. **Markdown Report** - Static analysis with Mermaid diagrams
2. **Web Dashboard** - Interactive Next.js app with Tailwind CSS
3. **JSON Export** - Structured data
4. **Executive Summary** - Narrative overview

## Common Project TELOS Files

### Context Files
- **OVERVIEW.md**, **COMPANY.md**, **PROBLEMS.md**, **GOALS.md**, **MISSION.md**, **STRATEGIES.md**, **PROJECTS.md**

### Operational Files
- **EMPLOYEES.md**, **ENGINEERING_TEAMS.md**, **BUDGET.md**, **KPI_TRACKING.md**, **APPLICATIONS.md**, **TOOLS.md**, **VENDORS.md**

### Security Files
- **VULNERABILITIES.md**, **SECURITY_POSTURE.md**, **THREAT_MODEL.md**

### Data Files (CSV)
- **data/VULNERABILITIES.csv**, **data/INCIDENTS.csv**, **data/VENDORS.csv**

## Visualization Types

- **Dependency Graphs** - Mermaid diagrams
- **Progress Tables** - Tailwind-styled tables with filters
- **Metrics Cards** - Custom card layouts
- **Timeline Charts** - Progress over time
- **Status Dashboards** - KPI overviews
- **Relationship Networks** - Mermaid or custom SVG
