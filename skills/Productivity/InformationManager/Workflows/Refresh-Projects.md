# Refresh-Projects Workflow

Generate comprehensive context for code projects, including per-project detail.

**Category:** Refresh (Source → Source)
**Trigger:** `refresh projects`, `update project contexts`

## Purpose

Orchestrate full projects context generation **in place within the projects directory**:
1. Generate `_Context.md` for each project folder
2. Aggregate into top-level `ProjectsAggregateContext.md`
3. Provide complete AI-navigable documentation of development work

This is a **Refresh** workflow: it updates context files IN the source (projects directory), not in Kaya's context directory.

## Config

Reads from `config/projects.json`:
- `projectsDir`: Root directory containing projects
- `excludeFolders`: Folders to skip
- `techStackDetection`: File → tech stack mapping

## Execution Steps

### 1. Load Config and Scan Projects

```bash
# Load config
cat ~/.claude/skills/Productivity/InformationManager/config/projects.json

# Get all project folders (exclude hidden, node_modules, etc.)
find /Users/[user]/Desktop/projects -maxdepth 1 -type d \
  -not -name '.*' \
  -not -name 'node_modules' \
  | sort
```

### 2. For Each Project, Gather Data

For each project directory:

1. **Detect tech stack** from config files:
   - `package.json` → Node.js/TypeScript
   - `Cargo.toml` → Rust
   - `go.mod` → Go
   - `pyproject.toml` → Python
   - `Gemfile` → Ruby

2. **Extract git info**:
   - Last 5 commit messages
   - Branch name
   - Remote URL

3. **Inventory key files**:
   - README.md
   - SPEC.md / specification files
   - AGENTS.md
   - Configuration files

4. **Count structure**:
   - Source files by type
   - Subdirectories

### 3. Generate Per-Project _Context.md

Create/update `{project}/_Context.md` using this template:

```markdown
---
tags: [context, project, ai-context]
last_updated: {{CURRENT_DATE}}
generated_by: Refresh-Projects
tech_stack: {{tech_stack}}
---

# {{project_name}} Context

AI-readable context for this project.

## Quick Reference

| Metric | Value |
|--------|-------|
| **Tech Stack** | {{tech_stack}} |
| **Location** | {{project_path}} |
| **Primary Language** | {{primary_language}} |
| **Last Commit** | {{last_commit_date}} |

## Project Structure

### Key Files
{{#each key_files}}
- `{{this.name}}` - {{this.description}}
{{/each}}

### Directories
{{#each directories}}
- `{{this.name}}/` - {{this.file_count}} files
{{/each}}

## Recent Activity

### Last 5 Commits
{{#each recent_commits}}
- {{this.hash}} - {{this.message}} ({{this.date}})
{{/each}}

## Configuration

### Detected Config Files
{{#each config_files}}
- `{{this}}`
{{/each}}

## AI Navigation Guide

When working on this project:
1. Check README.md for project overview
2. Check SPEC.md or specifications for requirements
3. Check AGENTS.md for agent configuration
4. Source code is in `{{source_dir}}/`
```

### 4. Aggregate All Projects

Create/update `/Users/[user]/Desktop/projects/ProjectsAggregateContext.md`:

```markdown
---
tags: [context, projects-summary, ai-context]
last_updated: {{CURRENT_DATE}}
generated_by: Refresh-Projects
project_count: {{count}}
---

# Projects Aggregate Context

AI-readable overview of all development projects.

## Quick Reference

| Metric | Value |
|--------|-------|
| **Projects Directory** | `/Users/[user]/Desktop/projects/` |
| **Total Projects** | {{total_count}} |
| **Projects with Context** | {{context_count}} |

## Projects by Tech Stack

### TypeScript/Node.js
| Project | Description | Last Activity | Context |
|---------|-------------|---------------|---------|
{{#each typescript_projects}}
| {{this.name}} | {{this.description}} | {{this.last_activity}} | [[_Context]] |
{{/each}}

### Rust
| Project | Description | Last Activity | Context |
|---------|-------------|---------------|---------|
{{#each rust_projects}}
| {{this.name}} | {{this.description}} | {{this.last_activity}} | [[_Context]] |
{{/each}}

### Python
| Project | Description | Last Activity | Context |
|---------|-------------|---------------|---------|
{{#each python_projects}}
| {{this.name}} | {{this.description}} | {{this.last_activity}} | [[_Context]] |
{{/each}}

### Other
| Project | Tech Stack | Last Activity | Context |
|---------|------------|---------------|---------|
{{#each other_projects}}
| {{this.name}} | {{this.tech}} | {{this.last_activity}} | [[_Context]] |
{{/each}}

## Recently Active

Projects with commits in the last 7 days:
{{#each recent_projects}}
- **{{this.name}}** - {{this.last_commit_message}}
{{/each}}

## Context File Locations

### Aggregate
- `ProjectsAggregateContext.md` - This file

### Per-Project
{{#each all_projects}}
- `{{this.name}}/_Context.md`
{{/each}}
```

### 5. Report Results

```markdown
## Refresh-Projects Complete

**Projects processed:** {{count}}
**Context files generated:** {{count}}

### Project Summary
| Project | Tech Stack | Status |
|---------|------------|--------|
| lucidview | TypeScript | ✅ _Context.md updated |
| pai | TypeScript | ✅ _Context.md updated |
| ... | ... | ... |

### Projects Skipped
- .git (hidden)
- node_modules (dependencies)
```

## Options

```yaml
projects:
  skip: [node_modules, .git, build, dist, target]

detection:
  package.json: "TypeScript/Node.js"
  Cargo.toml: "Rust"
  go.mod: "Go"
  pyproject.toml: "Python"
  Gemfile: "Ruby"

parallel:
  enabled: true
  max_concurrent: 3

output:
  aggregate: true
  per_project: true
```

## Tools Called

- `FolderContextGenerator.ts --template local` - For each project's _Context.md
- `AggregateContextGenerator.ts --source-type local` - For ProjectsAggregateContext.md

## Integration

**Called by:**
- Sync-Projects workflow (generates context, then syncs to Kaya)
- Manual invocation
- Weekly maintenance

## Maintenance Schedule

Run this workflow:
- After starting new projects
- Weekly for freshness
- Before code review sessions
- After major refactors
