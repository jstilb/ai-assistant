# Adventure — Travel & Adventure Domain

Kaya's travel-and-adventure domain: trip tracking, day-by-day itinerary planning, date planning, spontaneous-trip suggestion, and packing-list generation/tracking — anchored on Jm's M0 Adventurer mission and San Diego / Ocean Beach home base. This glossary fixes the vocabulary the five tools share.

## Language

**Trip**:
A tracked record in `data/trips.json` (owned by `TripTracker.ts`) tying together destination, dates, type, companions, budget, and links out to an itinerary doc and a packing list. Lightweight — the *pipeline entry*, not the plan itself.
_Avoid_: using "trip" for the itinerary content (that's the Itinerary).

**Trip type**:
One of `camping, roadtrip, international, city, beach, backpacking, surf, daytrip, other`. Drives the default packing profile and framing. Distinct from **status**.

**Trip status**:
Lifecycle: `planning → upcoming → active → completed` (derived from the calendar via `effectiveStatus()`) or `cancelled`. `null` on the record means "derive from dates"; a non-null value is a **pinned** override (set by `update --status`, `complete`, or `cancel`).
_Avoid_: treating the stored `status` field as always populated — it is usually `null` and derived.

**Agenda**:
`TripTracker`'s killer view — open trips sorted soonest-first, each with a **countdown** (days until start), a **readiness note** (itinerary planned? packing linked? budget set?), and a **packing nudge** when the trip is within `PACKING_NUDGE_DAYS` (7). Undated "someday" ideas sort last.
_Avoid_: "list" (that's the raw dump; agenda is the prioritized, annotated view).

**Itinerary**:
A grounded, validated **day-by-day** plan (exactly N days, each with morning/afternoon/evening blocks + meals + logistics) produced by `ItineraryPlanner.ts` and written to an Obsidian doc. Linked onto a Trip via `itineraryRef`.

**Date plan**:
A `DatePlanner.ts` output: a natural arc of 2-4 **beats** (opener → shared experience → wind-down) plus a **backup** (weather/plan-B), logistics, and conversation starters. Defaults to San Diego.
_Avoid_: "itinerary" for a date — a date plan is beats + backup, not dated days.

**Beat**:
One ordered segment of a date plan (activity + why-it-works + approx cost). A date has 2-4 beats.

**Spontaneous option / adventure score**:
A `SpontaneousAdventure.ts` suggestion: a named adventure with a hook, a concrete plan, drive time, cost, and an **adventure score** (1-10, higher = bolder/more novel). Options are sorted boldest-first; `--commit <n>` turns one into a tracked Trip.

**Packing profile**:
The trip-type key into `PACKING_PROFILES` (camping, backpacking, beach, surf, roadtrip, international, city, daytrip, other) that selects the deterministic base checklist, merged with the **universal base** and **season adds**.

**Packing list**:
A checkable, categorized list in `data/packing-lists.json` (owned by `PackingListGenerator.ts`). Each item is `{category, name, essential, packed, source}` where `source` ∈ `base | enriched`.

**Essential**:
A packing item flagged don't-leave-without-it. `status` surfaces any **unpacked essentials** — the guardrail against forgetting your passport / tent / meds.

**Base vs enriched (packing)**:
**Base** items come from the deterministic template (no LLM) and are the same for a given profile+season every time. **Enriched** items are added by one optional grounded LLM call (`--enrich`) for destination-specifics; they never overwrite base items and are de-duplicated against them.

**Grounded / no invented specifics**:
Every LLM generator names real regions, neighborhoods, and venue *types* and honest drive times, but is forbidden from inventing business names, addresses, phone numbers, hours, or URLs (they go stale). Docs carry a "confirm before you go" footer.

**Path seam**:
`AdventurePaths.ts` (`adventureVaultDir()` / `tripsStatePath()` / `packingStatePath()`) resolves the vault + state paths from env vars **at call time**, so tests/canaries can sandbox every write away from live data — never cache these into a module const.

## Boundaries

- **Deterministic vs LLM.** `TripTracker` and `buildBaseItems` make **zero** LLM calls — dates, countdowns, checkbox state, and essential coverage must be reliable. Itinerary/date/spontaneous generation and packing enrichment are the only LLM concerns, and each validates its output before trusting it.
- **Nothing outward, nothing bought.** The skill only reads/writes local JSON state and Obsidian docs. It never messages, books, or purchases. "Committing" a spontaneous pick just creates a tracked Trip record.
