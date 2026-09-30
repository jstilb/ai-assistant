---
name: GenerateHumanGuide
description: Generate step-by-step human procedure guide and create a linked LucidTask in the "Kaya — Needs Jm" project. USE WHEN AutonomousWork detects a human-required action.
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

### 3. Create LucidTask in "Kaya — Needs Jm"

```bash
bun ~/.claude/skills/Productivity/LucidTasks/Tools/TaskManager.ts add "{{taskTitle}}" \
  --status next \
  --priority 1 \
  --project "Kaya — Needs Jm" \
  --disposition autonomous \
  --desc "Human action required. Guide: {{guideFilePath}}. Blocked work: {{blockedItemTitle}} [{{blockedItemId}}]"
```

The dedicated project gives the task its own board column at localhost:7777. Do NOT
set `--queue-item-id` on it — that arms the reverse-sync archive hook against the
blocked work item. The proxy WorkItem's `humanTaskRef` carries the linkage instead.

Note: Labels `jm-task` and `human-required` should be set via the DB directly or through context tags.

### 4. Return Result

```json
{
  "lucidTaskId": "t-...",
  "proxyItemId": "...",
  "guideFilePath": "plans/HumanGuides/..."
}
```

---

## Error Handling

- **Inference fails:** Fall back to generic steps with a note to Jm to flesh out manually
- **LucidTask creation fails:** Log error, return partial result (guide file still created)

---

## Example Usage (from Orchestrate workflow)

```
AutonomousWork detects ISC row: "Configure Stripe webhook endpoint in dashboard"
  → reasonAiCannot: "Requires browser login to Stripe dashboard with 2FA"
  → blockedItemId: "1708123456-abc123"
  → blockedItemTitle: "Payment Integration Phase 2"

GenerateHumanGuide produces:
  → Guide: plans/HumanGuides/20260223_161500_configure-stripe-webhook.md
  → LucidTask: t-hg-abc123 (project: Kaya — Needs Jm, status: next, labels: jm-task, human-required)
  → Proxy WorkItem in WorkQueue (status: blocked)
```
