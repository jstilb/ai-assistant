# UISpec Example — Replaced by Co-located Example

> The old standalone `## UI Spec — <Screen>` format has been superseded.
>
> **The canonical combined UX + UI example is:**
> `skills/Development/UISpec/Templates/example-uxui-spec.md`
>
> That file shows the complete output of UXDesigner + UIDesigner in the co-located
> format required by `skills/Agents/SpecSheet/UXUISpecFormat.md`. It passes all
> SpecValidator checks:
>   - `parseScreenInventory` → ok: true
>   - `coverageGaps` → 0 gaps
>   - `validateUXCompleteness` → pass: true (`validateUICompleteness` was a no-op
>     pass-through, deleted in J4 — its keyword checks moved to the LLM spec-quality
>     judge in `SpecPipelineRunner.judgeSpecQuality`)
>   - `deriveBehavioralISC` → ≥ 2 ISC rows (one per screen)
>
> ## Format Summary (from UXUISpecFormat.md)
>
> **UIDesigner edits each `## Screen: <Name> (`id`)` section in place.**
> It does NOT create `## UI Spec — …` sections.
>
> Inside each `## Screen:` section, UIDesigner inserts:
> - `### State: <state>` — H3, one per state in the screen's inventory entry
>   (annotated HTML+Tailwind wireframe + **A11y notes**)
> - `### Component Inventory` — after the last state block
> - `### Accessibility (WCAG 2.2 AA)` — with aria+contrast required
>
> See `per-screen-ui-section.md` for the insertion template.
