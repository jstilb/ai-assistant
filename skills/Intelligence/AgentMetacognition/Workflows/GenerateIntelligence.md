# GenerateIntelligence Workflow

Generate actionable intelligence briefings from synthesized knowledge.

## Purpose

Produce intelligence outputs:
- Daily briefings with quick stats and focus
- Weekly intelligence reports with pattern analysis
- Goal-focused insights
- Topic-centered intelligence

## Trigger Patterns

- "What should I know", "Morning briefing"
- "Weekly intelligence", "Weekly report"
- "What's important", "Status update"
- Morning routine (automated)
- End of week (automated)

---

## Execution: Daily Briefing

**When to use:** Jm asks "what should I know", "morning briefing", "daily briefing", or similar.

### Step 1 — Gather live data

Read the following sources in parallel:

1. `MEMORY/LEARNING/SIGNALS/ratings.jsonl` — filter to last 24 hours; extract session count and average rating.
2. `MEMORY/WISDOM/FRAMES/*.md` — note: frames were retired 2026-05-02; only `estimation-calibration.md` remains (numbers no longer auto-refreshed since the learning-weekly-digest cron was deleted 2026-09-30).
3. `USER/TELOS/GOALS.md` — extract WIG goals (marked `isWIG: true` or flagged as wildly important).
4. `MEMORY/LEARNING/SYNTHESIS/` — read the most recent synthesis report for top patterns and recommendations.
5. Current date and time — determine day of week for focus recommendation.

### Step 2 — Synthesize and format

Using the data gathered in Step 1, produce the following sections:

**Quick Stats**

| Metric | Value |
|--------|-------|
| Sessions (last 24h) | _from ratings.jsonl_ |
| Avg Rating | _from ratings.jsonl_ |
| Top Pattern | _from synthesis report_ |
| Active WIGs | _count from GOALS.md_ |

**Highlights** (2-3 bullets)
- Surface the most significant signals from the last 24 hours.
- Pull from synthesis report insights and any ratings ≥ 8 or ≤ 3.

**Action Items** (1-2 bullets)
- Flag any recurring frustration patterns (count ≥ 3).
- Surface top recommendation from synthesis report.

**Focus Recommendation**
- Monday: "Start of week — review WIGs and set weekly intentions."
- Friday: "End of week — consolidate learnings and celebrate wins."
- Otherwise: identify the top frustration pattern or top WIG and recommend action.

**Goal Progress** (top 3 WIGs)
- For each WIG, note any learnings from the last 24h that connect to it.
- If none: "No recent activity."

**Learning Pulse** (if synthesis-state.json is available)
- Read `State/synthesis-state.json` for: `activeFrameCount`, `candidateFrameCount`, `lastRun`, `patternHistory`.
- Report frame counts, last synthesis date, top 3 patterns.

### Step 3 — Output

Present the briefing as a formatted markdown block. Voice summary (16 words max): top rating, top pattern, and focus recommendation.

---

## Execution: Weekly Intelligence

**When to use:** Jm asks "weekly intelligence", "weekly report", "what happened this week", or similar.

### Step 1 — Gather weekly data

1. `MEMORY/LEARNING/SIGNALS/ratings.jsonl` — filter to last 7 days.
2. `MEMORY/WISDOM/FRAMES/*.md` — only `estimation-calibration.md` remains (CANDIDATES/ was deleted 2026-07-10; nothing writes new frames).
3. `MEMORY/LEARNING/SYNTHESIS/` — most recent synthesis report for pattern history.
4. `USER/TELOS/GOALS.md` — all WIG goals.

### Step 2 — Synthesize

**Pattern Analysis**
- Emerging: patterns with count ≥ 3 in the `success` category this week.
- Declining: patterns in the `frustration` category with count = 1 (fading issues).
- Stable: patterns appearing 2-5 times across both categories.

**Goal Connections**
- For each WIG, identify how many signals from the week relate to it.
- Pull the most representative learning per goal.

**Recommendations** (up to 5, deduplicated)
- Capitalize on the top emerging pattern.
- Investigate the top declining frustration if relevant.
- Surface up to 3 recommendations from the synthesis report.

**Next Week Focus** (up to 3 items)
- Continue momentum on the goal with most activity.
- Resolve the top high-count frustration if count ≥ 3.
- Reinforce the top success pattern with count ≥ 2.

### Step 3 — Output

Present as a formatted weekly intelligence report in markdown. Save to `MEMORY/LEARNING/INSIGHTS/YYYY-MM-DD-weekly.md` if Jm requests saving.

---

## Execution: Goal-Focused Insights

**When to use:** Jm asks "insights for goal G28", "what have I learned about G28".

1. Read `USER/TELOS/GOALS.md` to find the goal by ID.
2. Search `MEMORY/` for learnings referencing the goal ID or title keywords.
3. Read `MEMORY/WISDOM/FRAMES/*.md` for frames related to the goal's domain.
4. Produce: relevant learnings (up to 10), related patterns, recommendations.

---

## Execution: Topic Intelligence

**When to use:** Jm asks "insights on productivity", "what do I know about X".

1. Search `MEMORY/` for learnings matching the topic keyword.
2. Check `USER/TELOS/GOALS.md` for goals related to the topic.
3. Check `MEMORY/WISDOM/FRAMES/*.md` for wisdom frames on the topic.
4. Produce: relevant goals, top learnings, related patterns.

---

## Output Location

When saving:
- Daily briefings → `MEMORY/LEARNING/INSIGHTS/YYYY-MM-DD-daily.md`
- Weekly reports → `MEMORY/LEARNING/INSIGHTS/YYYY-MM-DD-weekly.md`

---

## Related

- **SynthesizePatterns:** `Workflows/SynthesizePatterns.md`
- **ConnectToGoals:** `Workflows/ConnectToGoals.md`
- **LearningPulseAppender:** `Tools/LearningPulseAppender.ts` (pure utility for `appendLearningPulse`)
- **ProactiveEngine:** `skills/Automation/ProactiveEngine/SKILL.md`
