---
name: GenerateHumanGuide
description: Generate step-by-step human procedure guide and create linked LucidTask + queue item. USE WHEN AutonomousWork detects a human-required action.
---

# GenerateHumanGuide Workflow

Triggered by AutonomousWork when an ISC row requires direct human action (external portal, manual account creation, physical action).

---

## Input

| Parameter | Required | Description |
|-----------|----------|-------------|
| `taskTitle` | Yes | Short title for the human task |
| `reasonAiCannot` | Yes | Why AI cannot perform this action |
| `blockedItemId` | Yes | WorkQueue item ID that depends on this action |
| `blockedItemTitle` | Yes | Title of the blocked work item |
| `contextDetails` | Yes | Detailed context: URLs, account names, specific actions needed |

---

## Steps

### 1. Generate Procedure via Inference

Use the smart Inference model to generate numbered imperative steps with specific URLs, buttons, and field names.

```bash
echo "<prompt>" | bun ~/.claude/tools/Inference.ts smart
```

Prompt template:
```
Generate a step-by-step procedure for a human to complete this task.
Rules:
- Numbered imperative steps (e.g., "1. Navigate to...")
- Include specific URLs, button names, field names where known
- Each step should be one atomic action
- Include expected confirmations (e.g., "You should see a green success banner")

Task: {{taskTitle}}
Reason AI can't do it: {{reasonAiCannot}}
Context: {{contextDetails}}
```

### 2. Fill Template and Save Guide

1. Read `skills/SpecSheet/Templates/HumanGuide.template.md`
2. Fill all `{{VARIABLE}}` placeholders with generated content and input parameters
3. Generate slug from title: lowercase, hyphens, max 50 chars
4. Save to: `plans/HumanGuides/{YYYYMMDD}_{HHmmss}_{slug}.md`

### 3. Create LucidTask

```bash
bun ~/.claude/skills/Productivity/LucidTasks/Tools/TaskManager.ts add "{{taskTitle}}" \
  --status next \
  --priority 1 \
  --desc "Human action required. Guide: {{guideFilePath}}. Blocked work: {{blockedItemTitle}} [{{blockedItemId}}]"
```

Then tag with labels via edit:
```bash
bun ~/.claude/skills/Productivity/LucidTasks/Tools/TaskManager.ts edit {{lucidTaskId}} \
  --queue-item-id {{queueItemId}}
```

Note: Labels `jm-task` and `human-required` should be set via the DB directly or through context tags.

### 4. Add to jm-tasks Queue

```bash
bun ~/.claude/skills/Automation/QueueRouter/Tools/QueueManager.ts add \
  --title "{{taskTitle}}" \
  --queue jm-tasks \
  --context '{"lucidTaskId":"{{lucidTaskId}}","proxyItemId":"{{proxyItemId}}","guideFilePath":"{{guideFilePath}}"}'
```

### 5. Link LucidTask to Queue Item

```bash
bun ~/.claude/skills/Productivity/LucidTasks/Tools/TaskManager.ts edit {{lucidTaskId}} \
  --queue-item-id {{queueItemId}}
```

### 6. Return Result

```json
{
  "lucidTaskId": "t-...",
  "queueItemId": "...",
  "proxyItemId": "...",
  "guideFilePath": "plans/HumanGuides/..."
}
```

---

## Error Handling

- **Inference fails:** Fall back to generic steps with a note to Jm to flesh out manually
- **LucidTask creation fails:** Log error, return partial result (guide file still created)
- **Queue add fails:** Log error, guide and task still usable independently

---

## Example Usage (from Orchestrate workflow)

```
AutonomousWork detects ISC row: "Configure Stripe webhook endpoint in dashboard"
  → reasonAiCannot: "Requires browser login to Stripe dashboard with 2FA"
  → blockedItemId: "1708123456-abc123"
  → blockedItemTitle: "Payment Integration Phase 2"

GenerateHumanGuide produces:
  → Guide: plans/HumanGuides/20260223_161500_configure-stripe-webhook.md
  → LucidTask: t-hg-abc123 (status: next, labels: jm-task, human-required)
  → Queue item in jm-tasks
  → Proxy WorkItem in WorkQueue (status: blocked)
```
