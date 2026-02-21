---
name: RedTeam
description: Adversarial analysis with 32 agents. USE WHEN red team, attack idea, counterarguments, critique, stress test. SkillSearch('redteam') for docs.
---
# RedTeam Skill

Military-grade adversarial analysis using parallel agent deployment. Breaks arguments into atomic components, attacks from 32 expert perspectives (engineers, architects, pentesters, interns), synthesizes findings, and produces devastating counter-arguments with steelman representations.

## Voice Notification

→ Use `notifySync()` from `skills/CORE/Tools/NotificationService.ts`

## Workflow Routing

Route to the appropriate workflow based on the request.

**When executing a workflow, output this notification directly:**

```
Running the **WorkflowName** workflow from the **RedTeam** skill...
```

| Trigger | Workflow |
|---------|----------|
| Red team analysis (stress-test existing content) | `Workflows/ParallelAnalysis.md` |
| Adversarial validation (produce new content via competition) | `Workflows/AdversarialValidation.md` |

---

## Context Files

- `Philosophy.md` - Core philosophy, success criteria, agent types
- `Integration.md` - Skill integration, FirstPrinciples usage, output format

---

## Examples

**Attack an architecture proposal:**
```
User: "red team this microservices migration plan"
--> Workflows/ParallelAnalysis.md
--> Returns steelman + devastating counter-argument (8 points each)
```

**Devil's advocate on a business decision:**
```
User: "poke holes in my plan to raise prices 20%"
--> Workflows/ParallelAnalysis.md
--> Surfaces the ONE core issue that could collapse the plan
```

**Adversarial validation for content:**
```
User: "battle of bots - which approach is better for this feature?"
--> Workflows/AdversarialValidation.md
--> Synthesizes best solution from competing ideas
```

---

## Integration

### Uses
- **Parallel agents** - 32 expert perspectives via Task tool (Engineer, Architect, Intern)
- **FirstPrinciples** - Foundational analysis for decomposition phase
- **Research agents** - Claude, Gemini, Grok for multi-perspective synthesis

### Feeds Into
- **Council** - Red team analysis informs multi-perspective debates
- **Architecture decisions** - Counter-arguments improve proposals
- **Planning workflows** - Stress-tested plans before implementation

### MCPs Used
- None (orchestrates parallel Task agents)

---

**Last Updated:** 2025-12-20
