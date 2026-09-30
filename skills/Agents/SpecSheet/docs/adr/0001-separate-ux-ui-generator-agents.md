# Separate UX/UI generator agents instead of reusing the Designer agent

The existing **Designer** agent is defined (`skills/Agents/DesignerContext.md`) as a review-only critic that explicitly "does NOT make design decisions," and it pre-loads a `skills/FrontendDesign/` skill that does not exist anywhere in the tree — so it cannot generate UX/UI specs as-is. We decided to add two dedicated generator agents, **UXDesigner** and **UIDesigner**, that run the new UX and UI skills, and to keep **Designer** as a separate review pass over the generated spec. This preserves a clean generate-then-critique split and avoids overloading one agent with contradictory mandates (generate vs. review).

## Considered Options

- **Reuse Designer as a thin runner + fix its context** (broaden reviewer→generator, repoint the dangling `FrontendDesign` references). Rejected: collapses the generate/review distinction onto one agent.
- **Skill prompt fully overrides the agent at runtime.** Rejected: relies on the skill to paper over a broken, mis-scoped agent context.
- **Separate UXDesigner + UIDesigner generators, Designer as reviewer** (chosen).

## Consequences

- Two new agent definitions to author and maintain (UXDesigner, UIDesigner).
- The **Designer** agent's pre-existing defects are now independent cleanup, not blockers: dangling `skills/FrontendDesign/*` references and a stale WCAG 2.1 reference (`DesignerContext.md:38`) should be fixed regardless.
- Generator agents must source their design knowledge from the UX/UI skills (single source of truth) rather than embedding their own copies — to avoid recreating the dangling-reference problem that disabled Designer.
