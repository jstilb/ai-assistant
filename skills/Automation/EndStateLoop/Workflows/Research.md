# Research (the lab)

A lab is for a capability that two approaches did not solve. It runs tries on a score, not units. (Source: PLAN-REWORK-1, change 4; Kaya's design, 2026-11-18.)

## When a lab opens (mechanical; OrchestrateV2 step 9)
The gate fired (`Board.ts gate` exit 5), and the two closed units of the stall were on the same step or score. Then the third approach is a lab. Without that trigger, there is no lab.

## Files: `<board folder>/lab/<name>/`
- `QUESTION.md`: the capability; the score and its bar; the development set (the lab may see it); the held-out set (only the examiner opens it).
- `SOURCES.md`, first: how others solve the problem, at least 5 sources with quotes. A Claude research agent writes it. No try starts before it exists.
- `LOG.md`: one table line for each try: method · n · score · minutes · keep or drop, and why.
- `BEST.md`: the best method so far, its score, its commit.

## Rules
- A lab is one board unit that stays open and uses one builder slot. Its tries are not units: a try that closed `shipped none` would count toward the gate.
- A try is small (target: 30 minutes). No try decides on fewer than 60 items. A miss by 1 or 2 items is "not decided".
- The first lab session must write one `LOG.md` line (the smoke test).

## Exits
- (a) The bar is met on the development set: the unit puts the method in the product and closes by the run. The examiner checks it one time on the held-out set.
- (b) After 12 tries or 8 builder hours with no method at the bar: close the unit `fail`; write `VERDICT.md` (the best method, the score curve, what is not tested); post one scope question for Jm with a default; open the next lab unit with a method of a different kind. The lab does not stop itself (only Jm stops a plan, 2026-11-08).
