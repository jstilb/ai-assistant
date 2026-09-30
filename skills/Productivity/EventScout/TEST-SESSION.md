# EventScout — Joint Acceptance Test (agent + Jm)

> Paste this whole file as the prompt for a fresh agent. It runs a hands-on test of EventScout **with Jm in the loop** as the human evaluator.

---

You are running a hands-on acceptance test of the **EventScout** skill **together with Jm** (the user). EventScout recommends San Diego events matching natural-language constraints. Your job is to drive it through realistic scenarios, present each result clearly, and have **Jm judge it against his actual taste and real-world knowledge** — then capture what works and what needs fixing. You are not here to validate; you are here to find real gaps. Be honest and concrete.

## Setup — read first
- Run queries via: `bun ~/.claude/skills/Productivity/EventScout/cli.ts query "<natural language>" [--limit N]`
- Other commands: `prefetch` (refresh the cache), `list-sources`, `save <eventId>`, `add-to-calendar <eventId>`, `feedback`.
- Read **`~/.claude/skills/Productivity/EventScout/InterestProfile.json`** so you know Jm's taste: music / comedy / theater / festivals / community / arts / talks favored; **sports deprioritized**; home = **Ocean Beach**; radius 25mi; flexible vibe; drawn to unique/cultural/food events; parking-difficulty is a mild deterrent.
- Read **`SKILL.md`** for the known limitations (below) so you don't mis-report them as bugs.
- Optional: run `prefetch` once at the start so the cache is fresh (note: it scrapes ~26 sites + LLM, takes several minutes; or rely on the existing cache / the 07:00+18:00 scheduled job).

## Protocol — for EACH scenario
1. Run the query. Show Jm the ranked picks (title, when, where, price, why-it-fits, link).
2. Ask Jm: **(a)** Are these relevant to your taste? **(b)** Is the info accurate — date/time/venue/price/link? **(c)** Would you actually go to the #1 pick? **(d)** Anything you *expected* to see that's missing?
3. Record his answers verbatim-ish. Where he flags an accuracy doubt, **cross-check that event against the real source website** and report whether EventScout or the doubt was right.

### Scenarios to run
1. **Broad:** "what should I do this weekend"
2. **Category:** "live music in the next two weeks"
3. **Budget:** "free things to do this week" — then "something cheap this weekend"
4. **Vibe + company:** "a chill date-night idea this weekend" — then "something fun with friends Friday night"
5. **Specific date:** "things to do on June 13"
6. **Niche:** "something unusual or one-of-a-kind coming up" (tests his 'unique experiences' interest)
7. **Edge cases:** a vague one ("anything good?") and an impossible one ("opera at 3am tomorrow") — confirm it degrades gracefully (sensible defaults / clean "no results", no crash).

## Actions (test with cleanup)
- With Jm, pick one result he likes → `save <eventId>` → confirm it lands in his LifeOS `activity_ideas` (he decides whether to keep it).
- `add-to-calendar <eventId>` for one → confirm it appears on his calendar. **If it was only a test, delete it afterward.**

## Capture — end with a findings summary
- **Ranking quality:** did the top picks match Jm's taste? Any clearly-wrong ordering?
- **Data accuracy:** wrong dates/times/venues/prices, malformed links, or hallucinated events? (cite the cross-checks)
- **Coverage gaps:** events Jm *knows* are happening that EventScout missed — name the source so it can be promoted.
- **Constraint handling:** did date / price / radius / category / vibe filters behave?
- **Rough edges / bugs:** output noise, confusing UX, anything that felt off.
- **Jm's overall verdict (1–10) + the top 3 improvements to prioritize.**

## Known limitations — do NOT re-report these as bugs
- **Source coverage ~12/26 today.** The rest (Bandsintown, sandiego.org, the pro-sports team sites, Union-Tribune, SD Reader, some civic calendars) are a documented promotion backlog — they need a real headless browser or per-site adapters. Missing events from *those* sources are expected; missing events from a *working* source IS a finding.
- **Monday-start weeks:** "this week" asked late in the week (e.g. Sunday) yields a short window; "this month" falls back to a 7-day default. Be explicit ("next two weeks", "June 13") for precise control.
- **Occasional imperfect field** on LLM-extracted events (e.g. a malformed ticket URL) from messy HTML sources.
- **Learned-feedback gate is intentionally CLOSED** until ≥10 rated outings (≥3/category) — ranking uses Jm's hand-seeded profile for now; that's by design (anti-overfit).

Clean up any test calendar/sheet artifacts you create. Keep Jm engaged as the judge throughout — his real reaction is the test.
