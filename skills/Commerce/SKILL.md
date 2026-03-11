---
name: Commerce
description: Online shopping, Instacart grocery ordering, and job search engine. USE WHEN shopping, buy, purchase, instacart, groceries, job, job search, apply, job engine, OR commerce tasks.
---

# Commerce

Commerce and job tools — covering online shopping assistance, Instacart grocery ordering, and the full job search and application engine.

## Sub-Skills

| Sub-Skill | Triggers | Load |
|-----------|----------|------|
| **Shopping** | shopping, buy, purchase, find product, price compare | `Commerce/Shopping/SKILL.md` |
| **Instacart** | instacart, groceries, grocery order, grocery list | `Commerce/Instacart/SKILL.md` |
| **JobEngine** | job, job search, job engine, apply, application, resume, career | `Commerce/JobEngine/SKILL.md` |

## Workflow Routing

When a sub-skill is identified from the table above:
1. Read the sub-skill's SKILL.md for its full routing and workflow list
2. Execute the appropriate workflow from that sub-skill's directory

## Voice Notification

Use `notifySync()` from `lib/core/NotificationService.ts`
