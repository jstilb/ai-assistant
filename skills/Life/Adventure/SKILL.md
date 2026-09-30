---
name: Adventure
description: Travel & adventure companion — plan grounded day-by-day itineraries, thoughtful date plans, and spontaneous "surprise me" trips; build & track checkable packing lists (camping, beach, surf, international, …); and keep a countdown-aware pipeline of upcoming trips. USE WHEN travel, trip, itinerary, adventure, date idea, date night, plan a date, spontaneous, road trip, camping, backpacking, packing list, what to pack, national park, weekend trip, Baja, Mexico, surf trip, getaway, vacation, explore.
---

# Adventure — Trips, Itineraries, Dates, Spontaneity & Packing

The adventure OS. Five tools that turn "I want to go somewhere" into a real, tracked plan you can act on — grounded in Jm's M0 Adventurer mission (explore Mexico/Baja, 3 new countries, a national park) and San Diego / Ocean Beach home base.

Two are **deterministic** (no LLM — trip tracking, base packing lists); three are **grounded LLM** generators (itineraries, date plans, spontaneous suggestions) that each validate their output before trusting it, mirroring the Cooking skill's LLM-output gates.

---

## The five tools

| Tool | What it does | LLM? |
|------|--------------|------|
| **`TripTracker.ts`** | The deterministic backbone. Owns `data/trips.json`. Tracks the pipeline of trips (destination, dates, type, companions, budget, links to itinerary + packing). Killer feature `agenda`: upcoming trips sorted by proximity with a **countdown**, a **readiness note**, and a **"start packing" nudge** inside a 7-day window. | No |
| **`PackingListGenerator.ts`** | Build & track **checkable** packing lists. Deterministic type-aware base template (`PACKING_PROFILES`: camping, backpacking, beach, surf, roadtrip, international, city, daytrip) + universal base + season adds, with optional **grounded LLM enrichment** for destination-specifics. Owns `data/packing-lists.json`; check items off as you pack; flags unpacked **essentials**. | Base: No · `--enrich`: Yes |
| **`ItineraryPlanner.ts`** | Grounded **day-by-day itinerary** (morning/afternoon/evening blocks, meals, logistics, rough costs) for any destination + dates + interests + budget + pace. Validated (must cover exactly N days, no empty days) → Obsidian doc. `--trip <id>` links it onto a tracked trip. | Yes |
| **`DatePlanner.ts`** | Grounded, thoughtful **date plans** — a natural arc (opener → shared experience → wind-down), a weather/backup alternative, logistics, and conversation starters. Defaults to San Diego; real neighborhoods + venue *types*, never invented business names. | Yes |
| **`SpontaneousAdventure.ts`** | The **"I've got a free window — surprise me"** engine. Turns a time window + home base + radius + budget into 3-4 ready-to-go options with a hook, a plan, honest drive time, cost, and an **adventure score**. Biased toward the novel; weaves in Jm's standing M0 goals. `--commit <n>` turns a whim into a tracked trip. | Yes |

All state paths resolve through `AdventurePaths.ts` (env override → production default) so tests/canaries sandbox everything away from live data.

---

## When to reach for which

- **"Help me plan my trip to Oaxaca in December"** → `TripTracker add` to track it, then `ItineraryPlanner plan --trip <id>` to fill the days, then `PackingListGenerator generate --profile international --trip <id>`.
- **"What should I pack for camping this weekend?"** → `PackingListGenerator generate --profile camping --season <s>` (add `--enrich` + `--destination` for spot-specific items).
- **"Plan a date for Saturday afternoon"** → `DatePlanner plan --vibe … --time afternoon`.
- **"I have a free Saturday, surprise me"** → `SpontaneousAdventure suggest --window "a free Saturday"`.
- **"What trips do I have coming up / am I ready?"** → `TripTracker agenda`.
- **General travel/gear/destination questions** → answer inline (see Conversational workflows) — no tool needed.

---

## CLI reference

### TripTracker — `bun skills/Life/Adventure/Tools/TripTracker.ts <cmd>`

| Subcommand | Purpose | Usage |
|------------|---------|-------|
| `add` | Start tracking a trip | `add --destination <name> [--type <t>] [--start <YYYY-MM-DD>] [--end <YYYY-MM-DD>] [--with <who>] [--budget <usd>] [--itinerary <path>] [--packing <id>] [--notes <text>]` |
| `list` | Show trips | `list [--status <planning\|upcoming\|active\|completed\|cancelled\|all>]` (default: open trips) |
| `show` | Print one trip | `show --id <id>` |
| `update` | Edit fields | `update --id <id> [any add flag] [--status <s\|none>] [--budget <usd\|none>]` |
| `agenda` | Upcoming trips + countdown + readiness + packing nudge | `agenda [--date <YYYY-MM-DD>]` |
| `complete` / `cancel` | Terminal status | `complete --id <id>` / `cancel --id <id>` |
| `remove` | Delete a trip record | `remove --id <id>` |

Trip types: `camping, roadtrip, international, city, beach, backpacking, surf, daytrip, other`. Status is derived from the calendar (planning → upcoming → active → completed) unless pinned via `update --status` / `complete` / `cancel`. `--date` overrides "today" for testability.

### PackingListGenerator — `bun skills/Life/Adventure/Tools/PackingListGenerator.ts <cmd>`

| Subcommand | Purpose | Usage |
|------------|---------|-------|
| `generate` | Build a list for a profile | `generate --profile <type> [--destination <name>] [--days <n>] [--season <spring\|summer\|fall\|winter\|any>] [--trip <tripId>] [--label <text>] [--enrich]` |
| `list` | Show saved lists w/ progress | `list` |
| `show` | Print one list (numbered, grouped by category) | `show --id <id>` |
| `check` / `uncheck` | Toggle item(s) packed by **number or text substring** | `check --id <id> --item <number\|text>` |
| `status` | Progress + unpacked **essentials** | `status --id <id>` |
| `remove` | Delete a list | `remove --id <id>` |

`--enrich` adds 5-12 destination-specific items via one grounded LLM call; if it fails, the base list is still produced (enrichment is best-effort). Every generate/check also (re)writes an Obsidian doc so the list is usable on your phone while packing.

### ItineraryPlanner — `bun skills/Life/Adventure/Tools/ItineraryPlanner.ts plan`

`plan --destination <name> --days <n> [--start <YYYY-MM-DD>] [--interests <csv>] [--budget <level|usd>] [--pace <relaxed|balanced|packed>] [--with <who>] [--trip <id>] [--dry-run]`

### DatePlanner — `bun skills/Life/Adventure/Tools/DatePlanner.ts plan`

`plan [--vibe <text>] [--budget <text>] [--time <text>] [--location <city>] [--season <text>] [--duration <hrs>] [--notes <text>] [--dry-run]` — defaults location to San Diego, CA.

### SpontaneousAdventure — `bun skills/Life/Adventure/Tools/SpontaneousAdventure.ts suggest`

`suggest [--window <text>] [--from <place>] [--radius <mi>] [--budget <text>] [--vibe <text>] [--with <who>] [--goals <csv>] [--commit <n>] [--date <YYYY-MM-DD>] [--dry-run]` — defaults `--from` to San Diego / Ocean Beach and `--goals` to Jm's M0 adventurer goals.

**`--dry-run` semantics:** the three LLM tools still call inference and print the result under `--dry-run`; they only suppress the *side effects* (Obsidian doc write, trip link/commit). The deterministic tools' file writes always happen.

---

## Safety rails & grounding

- **LLM-output validation gates** (every generator validates before writing):
  - `ItineraryPlanner.validateItinerary()`: destination + a real overview; **exactly N day objects**, each with ≥1 activity block, each block having a non-empty activity.
  - `DatePlanner.validateDatePlan()`: a title, **≥2 beats** each with a real activity, and a **real weather/backup alternative** (≥10 chars) — a date plan with no plan-B fails loud.
  - `SpontaneousAdventure.validateSuggestions()`: **≥2 options**, each with a name and a real plan (≥15 chars); adventure scores clamped to 1-10.
  - `PackingListGenerator.enrichItems()`: validated, de-duplicated against the base list, marked `source:"enriched"`.
- **No invented specifics.** Every LLM prompt is instructed to use real regions / neighborhoods / venue *types* and honest drive times, but **never invent business names, addresses, phone numbers, hours, or URLs** — those go stale and mislead. Docs carry a "confirm hours/bookings before you go" footer.
- **Nothing outward, nothing bought.** This skill only reads/writes local state + Obsidian docs. It never sends a message, books, or purchases. Committing a spontaneous pick just creates a *tracked* trip record.
- **Deterministic cores stay LLM-free.** `TripTracker` and `buildBaseItems` make zero LLM calls — the parts that must be reliable (dates, countdowns, essential-item coverage, checkbox state) are pure functions, fully unit-tested.

---

## Data & files

- **`data/trips.json`** — single owner `TripTracker.ts`. `{trips: Trip[], lastUpdated}`; each `Trip` is `{id, destination, type, startDate, endDate, status, companions, budget, itineraryRef, packingListId, notes, createdAt, updatedAt}`. `status` is `null` (derive from calendar) or pinned `planning|upcoming|active|completed|cancelled`.
- **`data/packing-lists.json`** — single owner `PackingListGenerator.ts`. `{lists: PackingList[], lastUpdated}`; each list holds `items[]` of `{category, name, essential, packed, source}`.
- **Base packing template** lives in `PACKING_PROFILES` + `UNIVERSAL_BASE` + `SEASON_ADDS` (consts in `PackingListGenerator.ts`) — edit those to tune the default checklists.
- **Standing spontaneous goals** live in `DEFAULT_GOALS` (const in `SpontaneousAdventure.ts`) — Jm's M0 adventurer goals; override per-call with `--goals`.
- **Obsidian docs** under `~/Desktop/obsidian/Adventure/` (resolved via `adventureVaultDir()`; the folder is created on first write and does not exist before then):
  - `Itinerary - <Destination>[-<start>].md`, `Date - <Title>.md`, `Packing - <Label>.md`.
- **Path seam** `AdventurePaths.ts`: `adventureVaultDir()` / `tripsStatePath()` / `packingStatePath()` resolve `ADVENTURE_VAULT_DIR` / `ADVENTURE_TRIPS_PATH` / `ADVENTURE_PACKING_PATH` at **call time** — this is what lets tests sandbox all writes.

---

## Conversational workflows (PROMPT-ONLY — no tool calls)

Answered inline by LLM judgment — no Adventure tool is invoked. Ask about dates, budget, group size, and interests conversationally, only as needed.

### DestinationIdeas
Triggers: "where should I go", "trip ideas", "somewhere warm/cheap/close". Suggest 3-5 destinations matched to the season, budget, time window, and Jm's M0 goals (favor Mexico/Baja, national parks, novel-over-familiar). For each: one-line hook, best-for, rough cost, ideal length, why-now. Offer to spin the pick into a tracked trip + itinerary.

### TravelLogistics
Triggers: "how do I get to", "visa for", "best time to visit", "is it safe". Answer with grounded, current-as-of-training guidance; flag anything that changes often (visa rules, safety, entry requirements) as "verify before booking." Use WebSearch for anything time-sensitive.

### GearAdvice
Triggers: "what tent/pack/bag", "gear for", "do I need". Answer by use-case (car camping vs backpacking vs travel), climate, and budget; give a couple of concrete category picks and what to prioritize. Don't invent specific model prices.

### CampingHelp
Triggers: "camping tips", "how to camp", "campfire", "bear safety", "leave no trace". Answer with practical, safety-first guidance (site selection, food storage, fire rules, LNT). For a specific trip, hand off to `PackingListGenerator generate --profile camping`.

### DateIdeasQuick
Triggers: "date idea", "something to do with her". If they want a full plan, hand off to `DatePlanner`. For a quick brainstorm, give 3-5 varied ideas (active / cozy / cultural / adventurous) with a one-line why-it-works.

### ItineraryTweak
Triggers: "adjust my itinerary", "add a rest day", "make it cheaper". Read the existing Obsidian itinerary doc if referenced, and revise it in place (re-run `ItineraryPlanner` with adjusted flags, or edit the doc directly for small changes).

---

## Integration

### Uses
- **Inference** — `lib/core/Inference.ts` `inference()` (standard tier) for the three generators + packing enrichment.
- **Obsidian** — itinerary / date / packing docs under `~/Desktop/obsidian/Adventure/` (via `adventureVaultDir()`; created on first write).
- **WebSearch** — time-sensitive travel logistics (visas, safety, seasonality) in conversational workflows.
- **Telos (M0)** — the spontaneous engine and destination ideas are biased toward Jm's Adventurer goals.

### Testing
- `bun test <absolute path to Tools/__tests__/>` — always absolute paths (relative args trigger discovery mode).
- `TripTracker.test.ts` and `PackingListGenerator.test.ts` are fully deterministic (no LLM) — they run on every `bun test`. Every mutating/CLI test sandboxes `ADVENTURE_TRIPS_PATH` / `ADVENTURE_PACKING_PATH` / `ADVENTURE_VAULT_DIR` at temp dirs; date-sensitive assertions pass an explicit `asOf` / `--date`.
- The LLM `enrichItems` path is the only `RUN_LLM_TESTS=1`-gated block; the default run makes zero LLM calls.
