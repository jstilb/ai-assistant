---
name: Development
description: Skill creation, CLI tools, UI building, browser automation, and Unix CLI. USE WHEN create skill, create CLI, UI builder, browser, unix, shell, OR developer tools.
---

# Development

Software development tools — covering skill creation scaffolding, CLI tool generation, UI component building, browser automation, and Unix CLI assistance.

## Sub-Skills

| Sub-Skill | Triggers | Load |
|-----------|----------|------|
| **Browser** | browser, screenshot, debug web, verify ui, troubleshoot frontend, ai browser interaction, extract page data, autonomous browser tasks | `Development/Browser/SKILL.md` |
| **CreateCLI** | create cli, build cli, command-line tool, bash replacement, api wrapper cli | `Development/CreateCLI/SKILL.md` |
| **CreateSkill** | create skill, new skill, validate skill, canonicalize skill, eval skill, test skill, optimize skill description, compare skill versions, a/b skill test, skill structure audit | `Development/CreateSkill/SKILL.md` |
| **Diagnose** | diagnose, debug this, hard bug, broken, throwing, failing, performance regression, flaky test, build a feedback loop, ranked hypotheses, post-mortem, root cause analysis | `Development/Diagnose/SKILL.md` |
| **DomainModeling** | the user wants to pin down domain terminology, a ubiquitous language, record an architectural decision, or when another skill needs to maintain the domain model | `Development/DomainModeling/SKILL.md` |
| **GrillWithDocs** | grill with docs, stress-test plan against codebase, sharpen vocabulary, update context | `Development/GrillWithDocs/SKILL.md` |
| **ImproveCodebaseArchitecture** | improve architecture, find refactoring opportunities, deepen modules, consolidate tightly-coupled code, make codebase more testable, ai-navigable architecture, deletion test, find shallow modules, surface friction, design it twice | `Development/ImproveCodebaseArchitecture/SKILL.md` |
| **Prototype** | the user wants to sanity-check whether a state model, logic feels right, or explore what a ui should look like | `Development/Prototype/SKILL.md` |
| **RecallPlan** | recall last plan, what plans did i write, list my plans, find a plan, resume a plan, show me plan x, which plan was that | `Development/RecallPlan/SKILL.md` |
| **ReverseSpec** | reverse spec, reverse-engineer a spec, spec this skill, spec this hook, spec this module, rebuild-from-scratch spec, spec coverage, which modules lack specs, stale specs, cross-spec analysis, find redundancies across skills, spec contradictions, spec synergies, spec sweep | `Development/ReverseSpec/SKILL.md` |
| **SetupMattPocockSkills** | setupmattpocockskills | `Development/SetupMattPocockSkills/SKILL.md` |
| **TDD** | tdd, test driven development, red green refactor, write tests first, vertical slice, tracer bullet, integration tests, behavior tests, public interface tests | `Development/TDD/SKILL.md` |
| **UIBuilder** | build ui, create component, ui builder, generate ui, design component, mockup, prototype ui, shadcn component, create page, create layout, build interface, ui workflow, recreate ui, clone ui, screenshot to code | `Development/UIBuilder/SKILL.md` |
| **UISpec** | ui spec, uispec, wireframe, component spec, design tokens, accessibility spec, generate ui spec, ui realization, ui wireframe, screen wireframe, component inventory, token spec, a11y spec, ui for feature | `Development/UISpec/SKILL.md` |
| **UnixCLI** | user wants cli operations, pipe operations, youtube download, calendar via cli, drive sync, gmail cli, gemini cli, tasks cli, bluesky cli, or mentions kaya-cli, unix tools, command-line interface | `Development/UnixCLI/SKILL.md` |
| **UXSpec** | ux spec, uxspec, user experience spec, user flows, screen inventory, screen state matrix, microcopy, acceptance criteria, ux document, generate ux, ux for feature, user flow diagram, information architecture | `Development/UXSpec/SKILL.md` |
| **Wayfinder** | wayfinder | `Development/Wayfinder/SKILL.md` |

## Workflow Routing

When a sub-skill is identified from the table above:
1. Read the sub-skill's SKILL.md for its full routing and workflow list
2. Execute the appropriate workflow from that sub-skill's directory

## Voice Notification

Use `notifySync()` from `lib/core/NotificationService.ts`
