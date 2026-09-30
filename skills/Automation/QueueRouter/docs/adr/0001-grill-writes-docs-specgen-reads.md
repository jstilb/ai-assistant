# Grill writes domain docs; spec-gen reads them

The interactive `/queue grill` step adopts **GrillWithDocs** instead of bare GrillMe: every grill creates or updates the item's **primary-domain** skill `CONTEXT.md` (and its entry in the root `CONTEXT-MAP.md`), and spec generation injects that glossary's `## Language` + `## Relationships` into the spec prompt (`SpecPipelineRunner.loadDomainVocabularyForItem`). This turns the one human-present, high-context moment per item into durable domain knowledge that feeds future grills and every future spec in the domain — grilled or not. The headless autonomous research path (`GrillMeLens`) is unchanged: it has no human to interview, so GrillWithDocs does not apply there.

## Considered Options

- **Only document domains that already have a `CONTEXT.md`** — rejected: misses exactly the recurring infrastructure items (QueueRouter, SpecSheet, AutonomousWork) where the payoff concentrates, and never bootstraps a new domain's glossary.
- **Glossary-challenge only, never auto-write** — rejected: keeps terminology discipline but discards the durable capture, which is GrillWithDocs's whole reason for being.
- **Write docs but keep them human-facing only (spec-gen unchanged)** — rejected: the docs would be write-only from the pipeline's perspective; closing the loop into spec-gen is what makes the doc-writing pay the pipeline back and is the highest-leverage half of the change.

## Consequences

- A root `CONTEXT-MAP.md` becomes **mandatory infrastructure** the moment a second `CONTEXT.md` exists, and keeping it current becomes part of every grill.
- The spec-gen prompt grows by roughly the size of the domain glossary (capped at ~4 000 chars in `extractDomainVocabulary`).
- A thin or wrong first-grill glossary creates *challenge-friction* for every later grill in that domain. **Mitigation:** first-touch glossaries are explicitly **provisional** — `## Language` terms only, no forced `## Relationships` until a later grill confirms them.
- Spec quality lifts for non-grilled items too: any item whose title/notes name a documented skill inherits that skill's canonical vocabulary automatically.
