# LucidTasksSpecSheet Workflow

**Generate spec sheets for LucidTasks tasks based on task type classification.**

Use when:
- Processing LucidTasks tasks for spec sheet generation
- Running weekly spec sheet audits
- Single task spec generation from LucidTasks

## Overview

This workflow connects LucidTasks task management with SpecSheet generation by:
1. Fetching task details from the LucidTasks SQLite DB
2. Classifying the task type
3. Selecting the appropriate spec template
4. Generating a spec sheet
5. Saving the spec to disk and updating the task notes

---

## Task Type Classification

### Classification Matrix

| Task Type | Indicators | Spec Template | Priority |
|-----------|------------|---------------|----------|
| **Agent** | "agent", "bot", "automated", "autonomous" | Full SpecTemplate.md | High |
| **Feature** | "add", "implement", "create", "build" | QuickSpec (Feature variant) | High |
| **Bug Fix** | "fix", "bug", "broken", "error", "issue" | BugSpec (minimal) | Medium |
| **Research** | "research", "investigate", "explore", "analyze" | ResearchSpec | Medium |
| **Content** | "write", "draft", "document", "blog" | ContentSpec | Low |
| **Automation** | "automate", "script", "workflow", "pipeline" | Full SpecTemplate.md | High |
| **Integration** | "connect", "integrate", "sync", "API" | IntegrationSpec | High |
| **Maintenance** | "update", "upgrade", "migrate", "refactor" | MaintenanceSpec | Medium |
| **Simple** | Short tasks, single action items | No spec needed | Skip |

### Classification Logic

```javascript
function classifyTask(task) {
  const name = task.title.toLowerCase();
  const notes = (task.notes || '').toLowerCase();
  const combined = `${name} ${notes}`;

  if (/\b(agent|bot|automated|autonomous)\b/.test(combined)) return 'agent';
  if (/\b(automate|script|workflow|pipeline)\b/.test(combined)) return 'automation';
  if (/\b(connect|integrate|sync|api)\b/.test(combined)) return 'integration';
  if (/\b(add|implement|create|build)\b/.test(combined)) return 'feature';
  if (/\b(fix|bug|broken|error|issue)\b/.test(combined)) return 'bugfix';
  if (/\b(research|investigate|explore|analyze)\b/.test(combined)) return 'research';
  if (/\b(write|draft|document|blog)\b/.test(combined)) return 'content';
  if (/\b(update|upgrade|migrate|refactor)\b/.test(combined)) return 'maintenance';

  if (notes.length < 50) return 'simple';
  return 'feature';
}
```

---

## Execution Steps

### Step 1: Voice Notification

```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Generating spec sheet for LucidTask"}' \
  > /dev/null 2>&1 &
```

Output: `Running the **LucidTasksSpecSheet** workflow from the **SpecSheet** skill...`

### Step 2: Fetch Task Details

```bash
kaya-cli tasks show TASK_ID --json
```

Or via TaskDB directly:
```typescript
const db = getTaskDB();
const task = db.getTask(taskId);
```

### Step 2.5: Vision Context Detection

**Goal:** Check for existing vision specs that apply to this task's domain.

**Process:**

1. Identify task domain from title and project name
2. Search for vision specs: `ls ~/.claude/Plans/Specs/*domain*.md 2>/dev/null`
3. If Grounded Ideal exists, extract applicable constraints and add as INFERRED ISC rows

### Step 3: Classify Task Type

Apply classification matrix to determine:
- Task type (agent, feature, bugfix, etc.)
- Appropriate spec template
- Whether spec is needed (skip simple tasks)

**Skip criteria (no spec needed):**
- Task title < 20 characters AND no notes
- Task type is "simple"
- Task notes already contain "## Spec Sheet" marker

### Step 4: Generate Spec Sheet

Based on task type, generate appropriate spec using `Templates/SpecTemplate.md` or
variant templates. Spec is saved to `~/.claude/plans/Specs/` and appended to task notes.

---

## Batch Processing Mode

For processing multiple tasks:

1. Fetch all tasks with status `inbox` or `next`
2. Filter out tasks that already have specs (check notes for `---SPEC---`)
3. Classify remaining tasks
4. Skip "simple" tasks
5. Generate specs in parallel (5 at a time)
6. Update task notes with spec content
7. Report results

---

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| Skip simple tasks | true | Don't generate specs for trivial tasks |
| Spec marker | `---SPEC---` | Marker to identify existing specs |
| Batch size | 25 | Tasks per batch in batch mode |
| Parallel specs | 5 | Concurrent spec generations |

---

## Integration

### Uses
- **LucidTasks TaskDB** - Task fetching and updating via `getTaskDB()`
- **SpecTemplate.md** - Full spec template
- **CORE** - System patterns

### Feeds Into
- **AutonomousWork** - Specs enable autonomous execution

---

**Last Updated:** 2026-02-20
