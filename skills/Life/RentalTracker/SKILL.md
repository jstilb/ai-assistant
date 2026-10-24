---
name: RentalTracker
description: Ocean Beach (San Diego) rental tracker — scans Craigslist + Redfin every 2h for 1–2BR ≤ $3,500, LLM-reads each new listing once (dishwasher, laundry, A/C, house/yard, kitchen, scam risk), scores it 0–100 against Jm's criteria, drops stale/removed listings, and pages Telegram ONLY for exceptional listings. Ranked filterable board at /rentals on the LifeOS dashboard. USE WHEN rental, apartment hunt, ocean beach rentals, OB apartments, places for rent, housing search, rental listings, rental board, shortlist apartment, moving, new place to live.
---

# RentalTracker

Finds Jm a place in **Ocean Beach** without him having to refresh Craigslist. Built from the
2026-10-21 scratch-pad capture (task `t-mviaucrs-4hh1qy`).

**Criteria** (all in `config/ocean-beach.json`, re-read every scan, so edits re-score everything):

| | |
|---|---|
| Must | 1–2 BR · ≤ $3,500 · **dishwasher** · in Ocean Beach (≤ 1.3 mi from the OB shoreline, south of the river channel) |
| Score (0–100) | price 25 (full at ≤ $3,000, ideal band $2.5–3k) · beach proximity 20 · walk to Newport Ave / Voltaire St 15 · laundry 12 (in-unit) / 6 (on-site) · house + backyard 15 · big kitchen 8 · A/C 5 |
| Penalties | dishwasher unknown −15 · scam risk medium −10 / high −40 |
| Alert | score ≥ **80** AND dishwasher **confirmed** AND scam risk low — each listing (and its reposts/cross-posts) at most once, ever |

## How it works

```
cron (every 2h, 07:15–23:15)  →  RentalTracker.ts scan
  1. search   Craigslist sapi JSON (postal 92107, 2 mi) + Redfin stingray rentals (zip 92107)
              → keep hits inside Ocean Beach (Geo.ts)
  2. reconcile new / seen / missed; price history          (Store.ts)
  3. detail   craigslist posting page (body + attributes); redfin /amenities + /floorPlans
  4. extract  LLM fast tier, schema-constrained, 6 per batch, cached per content hash (Extract.ts)
              source checkboxes (W/D in unit, Dishwasher, A/C, PrivateYard) override the model
  5. score    every active listing, transparent per-factor breakdown  (Score.ts)
  6. alert    AlertGate page → Telegram, only for exceptional + never-alerted + not-rejected
```

- **Stale listings drop off**: a listing that misses **2 consecutive successful** scans of its
  source is expired (a failed scan never expires anything — no mass-expiry on an outage);
  Craigslist posts older than 30 days and Redfin older than 75 days expire as stale; deleted
  Craigslist posts expire when their page says so. Expired listings stay in state (hidden) for 30
  days so a re-post doesn't re-alert.
- **Duplicates**: Craigslist reposters vary the title, so same-source dupes match on pin + price +
  beds; Craigslist↔Redfin cross-posts match within ~80 m and $100. The board shows one card with
  "also on craigslist (×13 reposts)".
- **Never silent**: if inference fails, those listings fall back to keyword extraction, are
  tagged `keyword-read` on the board, counted in the run summary and logged to the failure log.
  A source failure shows as a banner on the board; the cron exits 1 only if every source failed.
- **Zillow / Apartments.com** are bot-walled (403). Redfin's rental feed already aggregates
  RentPath/Zillow-fed inventory, so that ground is covered.

## The board — `/rentals` on the LifeOS dashboard (:31337)

Cards ranked by fit: score badge, price/beds/sqft, photo, feature chips (✓/?/✗ dishwasher,
laundry, yard, A/C, kitchen, type, scam flag, NEW, price drop, alerted), walking minutes to the
beach / Newport / Voltaire, the LLM's one-line summary + highlights/concerns, score breakdown.

Filters (remembered in the browser): view (must-haves / all / ⭐ shortlist / contacted / toured /
rejected / expired), sort (fit / price / newest / beach), max price, beds, walk time, toggles for
✓ dishwasher · W/D in unit · yard · A/C, text search. Buttons: **Shortlist · Contacted · Toured ·
Reject** + a note per listing — saved to state; rejected listings never alert.

Without the dashboard: `bun Tools/RentalTracker.ts serve` → http://127.0.0.1:31340/rentals.

## CLI

```bash
R=~/.claude/skills/Life/RentalTracker/Tools/RentalTracker.ts
bun $R scan                     # what the cron runs (add --no-alert / --no-llm / --json)
bun $R board [--limit 20] [--all] [--json]
bun $R show craigslist:7988256273
bun $R decide craigslist:7988256273 shortlist "ask about the yard"
bun $R status                   # counts + last 5 runs
bun $R serve [--port 31340]
```

Agents: `GET /api/rentals` (rows + runs + criteria), `POST /api/rentals/decision`
(`x-kaya-rentals: 1` header), described at `GET /api/rentals/help`.

## Files

| Path | What |
|---|---|
| `config/ocean-beach.json` | criteria, weights, geo (coast + Newport/Voltaire polylines, OSM-verified), sources, expiry, alert threshold |
| `Tools/RentalTracker.ts` | scan orchestration, alert formatting, CLI |
| `Tools/Sources.ts` | Craigslist + Redfin fetchers / pure parsers |
| `Tools/Extract.ts` | LLM feature extraction + keyword fallback |
| `Tools/Score.ts` · `Tools/Geo.ts` | scoring, distances |
| `Tools/Store.ts` | state, lifecycle/expiry, dedupe, decisions |
| `Tools/Board.ts` | `/rentals` page + `/api/rentals*` (mounted by LifeOS `DashboardServer.ts`) |
| `MEMORY/daemon/cron/manifests/rental-tracker-ob.yaml` | the schedule |
| `~/.kaya/runtime/RENTALS/ocean-beach.json` | live state (out of repo; `KAYA_RUNTIME` overrides) |

Tests: `bun test skills/Life/RentalTracker` (parsers run against fixtures captured from the live
endpoints; the scan loop runs with injected network/LLM/alert sender).

## Tuning

- Too quiet / too noisy → `alerts.minScore` (75; Jm lowered it from 80 on 2026-10-23 so the best
  apartments can alert — at 80 only in-unit W/D or a house + yard could reach it). On 2026-10-22 the
  best live listing scored 74. Jm kept the price curve (full points ≤ $3k, 30% at $3.5k).
- Want the alert for a specific kind of place regardless of score → raise that factor's weight.
- Another neighborhood → copy the config, change `geo` + `sources.*.postal/regionId`.

## Voice Notification

Use `notifySync()` from `lib/core/NotificationService.ts`
