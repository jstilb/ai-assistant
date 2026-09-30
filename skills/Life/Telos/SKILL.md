---
name: Telos
description: Life OS with goal tracking, project dependency mapping, dashboard generation, narrative writing, and weekly reviews. USE WHEN TELOS, life goals, goal dashboard, projects, dependencies, weekly review, goal progress, books, movies, life direction.
---

# Telos

**TELOS** (Telic Evolution and Life Operating System) manages personal life context (`~/.claude/USER/TELOS/`) and provides organizational analysis for any project directory.

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

## Customization

- Personal TELOS path: `~/.claude/USER/TELOS/` (override via `KAYA_HOME` env var)
- Timezone: `KAYA_TZ` env var (defaults to system timezone)

## Examples

**Update personal TELOS:**
```
User: "add Project Hail Mary to my TELOS books"
--> Invokes Update workflow → creates backup → appends entry → logs change
```

**Analyze a project:**
```
User: "analyze ~/Projects/MyApp with TELOS"
--> Scans .md and .csv files → extracts entities, dependencies, goals
```

**Build a dashboard:**
```
User: "build a dashboard for TELOSAPP"
--> Launches up to 16 parallel engineers → creates Next.js dashboard
```

**Generate narrative points:**
```
User: "create TELOS narrative for Acme Corp, n=24"
--> Returns 24 crisp bullet points (8-12 words each), slide-ready
```

## Security & Privacy

- Personal TELOS: NEVER commit to public repos. Use Update workflow only.
- Project TELOS: May contain sensitive data. Redact before sharing externally.

## Integration

### Uses
- **USER/TELOS/** - Personal life framework files
- **Parallel engineers** - Up to 16 Task agents for dashboard builds
- **Filesystem** - Project directory scanning for .md and .csv files

### Feeds Into
- **_USERCONTEXT** - Life framework summary for session context
- **_DTR** - Goal and status tracking from TELOS data
- **AgentMetacognition** - Life lessons and wisdom capture

### MCPs Used
- None (direct filesystem and parallel agents)

### Further Documentation
- Architecture & file structure: `docs/architecture.md`
- Dashboard design spec: `docs/artifact-app-design.md`
