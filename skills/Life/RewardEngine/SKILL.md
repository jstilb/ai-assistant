---
name: RewardEngine
description: Randomized (variable-ratio) rewards to incentivize good work. You finish a real piece of work, you "roll" — most rolls give a small reward or an encouraging near-miss, occasionally a medium reward, rarely a jackpot. The unpredictability is the active ingredient — it's the slot-machine reinforcement schedule, redirected from the C0 media trap toward your actual goals. USE WHEN reward me, claim reward, roll reward, randomized reward, variable reward, incentivize good work, treat myself, i earned a reward, loot box, gamify habits, motivate me.
---

# RewardEngine

A self-motivation tool built on the **variable-ratio reinforcement schedule** — the single
most powerful behavioral pattern for sustaining effort. Reward delivered after an
*unpredictable* amount of effort, with *unpredictable* magnitude, produces high, steady,
extinction-resistant motivation. That's the slot-machine loop. This skill harnesses the same
dopamine mechanism behind Jm's **C0** challenge (uncontrolled low-value media grazing) and
points it at real work toward his goals (G37, G41, habits S9–S12).

You do good work → you roll → outcome is randomized:

- ~45% **near-miss** (no reward, but an encouraging line — the misses are what make the wins land)
- ~38% **small** reward
- ~14% **medium** reward
- ~3% **jackpot** (odds climb with your day-streak)

## Why it stays honest (this only works if it does)

- **The odds are auditable math.** The RNG (seedable mulberry32) and the weighted schedule are
  deterministic and inspectable — fairness is not a black box. `odds` shows you the live numbers.
- **Rolls are scarce.** Daily roll cap (5) + a cooldown (30 min) keep each roll special.
- **Pity timer.** After 3 consecutive near-misses you're *guaranteed* a reward — the schedule
  motivates, it doesn't grind you down.
- **Immutable ledger.** Every roll is appended to `ledger.jsonl`; `history` shows it.
- **Optional LLM qualification gate.** If you describe the work, a fast model decides whether it
  genuinely qualifies (blocks "i breathed and existed", passes real effort). Fail-open, and
  `--no-llm` overrides. The *only* LLM parts are this gate and the reveal flavor-text — the
  odds are math.

## Quick reference

```bash
E=~/.claude/skills/Life/RewardEngine/Tools/RewardEngine.ts

bun $E roll --work "shipped the X fix, all tests green"   # roll (LLM gates qualification)
bun $E roll --no-llm                                      # roll, skip the gate
bun $E roll --seed 42                                     # deterministic (testing/demos)
bun $E stats                                              # streak, totals, today's rolls
bun $E history [--limit N]                                # recent ledger entries
bun $E menu                                               # show the reward menu
bun $E odds                                               # current effective odds
```

## The reward menu

Edit `config/rewards.json` — that's your menu. Rewards are grouped into `small` / `medium` /
`jackpot` tiers, each a list you pick from. They ship aligned to Jm's TELOS (pour-over, surf
check at Ocean Beach, a chapter of the novel, plan a Mexico trip leg, book the weekend trip for
a jackpot) and lean toward things that *move you forward* or are guilt-free, **time-boxed**
treats — not the grazing trap. Tune the menu, the tier weights, the daily cap, the cooldown,
and the streak bonus all in that one file.

```jsonc
{
  "schedule": {
    "pReward": 0.55,                              // chance any roll yields a reward
    "tierWeights": { "small": 70, "medium": 25, "jackpot": 5 },
    "pityAfter": 3,                              // guaranteed reward after N near-misses
    "dailyRollCap": 5,
    "cooldownMinutes": 30,
    "streak": { "jackpotBonusPerDay": 1, "maxBonus": 15 }  // streak raises jackpot odds
  },
  "rewards": { "small": [ ... ], "medium": [ ... ], "jackpot": [ ... ] },
  "nearMiss": [ ... ]
}
```

## How it flows

```
do real work
   │
   ▼  roll --work "<what you did>"
1. gate     → daily cap + cooldown (keeps rolls scarce)
2. qualify  → (optional) fast LLM: is this genuinely good work?  [fail-open, --no-llm overrides]
3. resolve  → seeded RNG draws outcome from the variable-ratio schedule  [pure, auditable]
4. persist  → advance streak / near-miss / totals; append to ledger
5. reveal   → slot-machine reveal (LLM flavor line if available, else templated)
```

## State & files

| What | Where |
|------|-------|
| Reward menu + schedule | `skills/Life/RewardEngine/config/rewards.json` |
| Streak / counters | `$KAYA_HOME/runtime/reward-engine/state.json` |
| Roll ledger | `$KAYA_HOME/runtime/reward-engine/ledger.jsonl` |

## Tests

`bun test ./skills/Life/RewardEngine/tests/RewardEngine.test.ts` — 24 tests covering the RNG
determinism, tier distribution, streak escalation, pity guarantee, daily-cap rollover, cooldown,
streak day-continuity, and ledger/state round-trips. All pure logic (no LLM, injected clock).
