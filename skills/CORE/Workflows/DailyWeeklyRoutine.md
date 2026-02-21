# Daily & Weekly Routine

**Shared workflow document for User and Kaya's coordinated daily and weekly routines.**

This document defines the structured cadence that connects TELOS goals, lead measures, and daily execution. Both User and Kaya reference this for timing, responsibilities, and integration points.

---

## the user's Daily Routine

### Morning Brief (8:00 AM)

User receives the morning briefing via Telegram and voice. This is the anchor point for the day.

**What User sees:**
- Weather and calendar overview
- WIG progress (G0, G1, G2) with current metrics
- Lead measure performance (S0-S8) with gap analysis
- Habit tracking with 7-day rolling averages
- 5-7 ranked priority candidates for the day
- Overdue and due-today tasks from LucidTasks
- News digest across tracked topics

**What User does:**
1. Review the briefing on Telegram (2-3 min)
2. Note top 3 priorities from the suggested list
3. Decide on the alignment hour focus area
4. Check calendar for meeting preparation needs

### Alignment Hour (9:00 - 10:00 AM)

Dedicated hour for working on alignment-supporting activities. This directly feeds lead measures S1 (Pomodoro) and S5 (Alignment Hour).

**Rules:**
- Pick one WIG-aligned task from the priority candidates
- Use Pomodoro technique (25 min work / 5 min break)
- No meetings, no Slack, no media during this block
- Log completion in DTR tracking

### Work Blocks (10:00 AM - 5:00 PM)

Execute on the day's priorities. Calendar events take precedence; remaining time follows the priority ranking from the morning brief.

**Guidelines:**
- Reference the morning brief priority list when choosing what to work on
- Use boredom blocks (S0) between tasks instead of reaching for media
- Apply STORER protocol (S2) before any low-value media consumption
- Track community events (S3) and social invitations (S4) as they occur

### Evening Check-In (8:00 PM)

*Phase 2 deliverable.* User reviews what was accomplished vs. what was planned.

**What it will include:**
- Comparison of planned priorities vs. completed work
- Habit check-ins for the day (did boredom blocks happen? stretching? PT?)
- Quick reflection on alignment score
- Tomorrow's early flags

---

## Kaya's Daily Routine

### Morning Brief Generation (7:55 AM)

Kaya assembles the morning briefing automatically via the DailyBriefing system.

**Process:**
1. Execute all enabled blocks from `BriefingConfig.yaml` in priority order
2. Read habit data from `habit_building` Google Sheet
3. Read lead measure data from `goal_achievement` Google Sheet
4. Fetch LucidTasks tasks and Google Calendar events
5. Cross-reference to generate priority candidates
6. Write planned priorities to `MEMORY/BRIEFINGS/planned-priorities-{date}.json`
7. Format and deliver via Telegram, voice, push, and written log

**Integration Points:**
- `kaya-cli sheets read` for DTR sheet data
- `kaya-cli tasks --json` for task data
- `kaya-cli gcal today --json` for calendar data
- `BriefingGenerator.ts` orchestrates all blocks

### Priority Suggestions (8:00 AM)

Part of the morning brief delivery. Kaya suggests 5-7 ranked priorities based on:

1. **Overdue tasks** (highest urgency)
2. **Due-today tasks** (time-sensitive)
3. **Goal-aligned tasks** (linked to WIGs G0/G1/G2)
4. **Quick wins** (under 30 minutes, high impact)

Each priority includes:
- Time estimate
- Alignment tag (which goal/mission it supports)
- Source (LucidTasks task, calendar event, or goal-derived)

### Evening Summary (8:00 PM)

*Phase 2 deliverable.* Kaya compares planned vs. actual.

**What it will do:**
1. Read planned priorities from morning JSON file
2. Check LucidTasks for completed tasks
3. Calculate completion rate
4. Identify carried-over items
5. Capture habit data for the day
6. Deliver summary via Telegram

### Habit Capture (Throughout Day)

*Phase 2 deliverable.* Kaya accepts habit check-ins via Telegram commands.

**Examples:**
- "Boredom block done" -> logs S0 for the day
- "Morning stretch done" -> logs S6 for the day
- "Pomodoro complete" -> logs S1 for the day

---

## Weekly Routine

### Sunday Scorecard (Sunday 9:00 AM)

*Phase 3 deliverable.* Comprehensive weekly review.

**What it will include:**

1. **WIG Progress Table**
   - G0: Low-value media hours (current vs. target)
   - G1: Friend-making progress (events attended, invitations sent)
   - G2: Alignment score (current vs. target)

2. **Lead Measure Scorecard**
   - All 9 strategies (S0-S8) with weekly percentage
   - Week-over-week trend arrows
   - Color-coded status (green/yellow/red)

3. **Habit Consistency Matrix**
   - 7-day grid showing daily habit completion
   - Rolling averages with trend direction

4. **Commitment Review**
   - What was committed to last week
   - What was actually accomplished
   - Completion rate and patterns

5. **Next-Week Planning**
   - Carry-over items from this week
   - Upcoming calendar events that affect planning
   - Suggested focus areas based on worst-performing lead measures

### Weekly Data Sources

| Data Source | What It Provides | Access Method |
|-------------|-----------------|---------------|
| `habit_building` sheet | Daily habit completion data | `kaya-cli sheets read` |
| `goal_achievement` sheet | WIG metrics, lead measure scores | `kaya-cli sheets read` |
| `alignment` sheet | Alignment score tracking | `kaya-cli sheets read` |
| LucidTasks | Task completion history | `kaya-cli tasks --json` |
| Google Calendar | Event attendance | `kaya-cli gcal today --json` |
| TELOS files | Goal definitions, strategy targets | Direct file read |
| `MEMORY/BRIEFINGS/` | Planned priorities history | File system |

---

## Integration Points

### DailyBriefing Skill

The DailyBriefing skill is the execution engine for the morning brief. It runs the following blocks:

| Block | Source | Data |
|-------|--------|------|
| GoalsBlock | TELOS files | WIG status, missions, focus |
| StrategiesBlock | TELOS STRATEGIES.md | Lead measure performance |
| HabitTrackingBlock | `habit_building` sheet | 7-day habit averages |
| LeadMeasuresBlock | `goal_achievement` sheet | WIG + lead measure gaps |
| PriorityCandidatesBlock | LucidTasks + Calendar | Ranked daily priorities |
| CalendarBlock | `kaya-cli gcal` | Today's events |
| LucidTasksBlock | `kaya-cli tasks` | Due/overdue tasks |
| WeatherBlock | Weather API | Current conditions |
| NewsBlock | News sources | Topic-filtered articles |
| ApprovalQueueBlock | Kaya queue | Pending approvals |
| MissionGroupedBlock | LucidTasks + TELOS | Tasks by mission |
| StaleItemBlock | LucidTasks + Memory | Stale/forgotten items |

### TELOS System

Goals, missions, strategies, and challenges are defined in `skills/CORE/USER/TELOS/`. The briefing reads from these files for context but does not modify them. Weekly scorecard updates may propose TELOS file updates for the user's approval.

### DTR Sheets

The Decision Tracking & Review (DTR) system uses Google Sheets as the data store:

- **habit_building** (`1xrGAGvKlgckHbjnMevs9ZhlwtNWaUL5CzzgRQ82X9LA`): Daily habit checkboxes, rolling averages
- **goal_achievement** (`1iiX2qfRn6Gx1q1yLu5Xu8nV-x7S_KA45gykjgQKTJdw`): WIG metrics, strategy scores
- **alignment** (`1LFOEWT6FQPupiyWEAOu9bxwB7C1dLvqAAn-S_fpf69U`): Daily alignment scores

### LucidTasks

Task management via `kaya-cli tasks`. Tasks are linked to goals/missions through project names and tags.

### Google Calendar

Event management via `kaya-cli gcal`. Calendar data helps identify available time blocks and meeting preparation needs.

---

## Phase Roadmap

| Phase | Deliverables | Status |
|-------|-------------|--------|
| Phase 1 | Workflow doc, HabitTrackingBlock, LeadMeasuresBlock, PriorityCandidatesBlock | In Progress |
| Phase 2 | Evening check-in, habit capture via Telegram, planned vs. actual comparison | Planned |
| Phase 3 | Weekly scorecard, trend analysis, commitment review, next-week planning | Planned |

---

*This document is the shared reference for the daily and weekly routine. Update as phases are completed.*
