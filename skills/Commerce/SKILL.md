---
name: Commerce
description: Online shopping, Instacart grocery ordering, and job search. USE WHEN shopping, buy, purchase, instacart, groceries, job, job search, jobsearch, apply, OR commerce tasks.
---

# Commerce

Commerce and job tools — covering online shopping assistance, Instacart grocery ordering, and the full job search and application engine.

## Sub-Skills

| Sub-Skill | Triggers | Load |
|-----------|----------|------|
| **Instacart** | groceries, instacart, add to cart, grocery shopping, order food, grocery list, buy groceries, shopping list | `Commerce/Instacart/SKILL.md` |
| **JobSearch** | jobs scan, auto-apply, tailored application, resume tailoring, cover letter, ats check, job package, network referral, job hunt, applications | `Commerce/JobSearch/SKILL.md` |
| **Shopping** | shopping, buy, purchase, need to find, looking for product, gift ideas, price comparison, what should i get, best [product], non-grocery cart, retailer product list, or user mentions needing something to buy | `Commerce/Shopping/SKILL.md` |

## Workflow Routing

When a sub-skill is identified from the table above:
1. Read the sub-skill's SKILL.md for its full routing and workflow list
2. Execute the appropriate workflow from that sub-skill's directory

## Voice Notification

Use `notifySync()` from `lib/core/NotificationService.ts`
