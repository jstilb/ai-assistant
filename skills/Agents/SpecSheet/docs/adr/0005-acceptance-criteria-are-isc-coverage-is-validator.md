# Acceptance criteria become ISC rows; UX/UI coverage is validator-enforced

Per-screen acceptance criteria (Given/When/Then) become **behavioral ISC rows** verified via the browser (Playwright), feeding the existing ISC quality gate and the build→verify loop. **Screen×State Matrix** coverage, accessibility, design-token-by-name usage, and no-lorem are enforced by new `validateUXCompleteness` / `validateUICompleteness` checks in `SpecValidator` — *not* as ISC rows.

This keeps ISC counts within the existing per-effort ceilings (S 5-10 / M 10-20 / L 20-35) and preserves the meaning of an ISC row as *behavioral* verification, while still making completeness a hard gate.

## Considered Options

- **Every screen×state and a11y rule as its own ISC row.** Rejected: blows the row ceiling on large UIs and dilutes the behavioral signal.
- **Validator-only, no UX/UI ISC rows.** Rejected: the build→verify loop wouldn't independently verify UI behavior per screen.
