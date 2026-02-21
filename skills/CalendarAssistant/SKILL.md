---
name: CalendarAssistant
description: Google Calendar automation via CLI with intelligent goal-aligned scheduling, automatic break insertion, conflict resolution, decision rationale, schedule health reports, batch operations, behavioral learning, feedback-weighted scoring, and invitation handling. USE WHEN schedule meeting, check calendar, list events, add event, delete event, find free time, respond to invite, calendar agenda, schedule smart, optimize calendar, goal alignment, break schedule, calendar optimize, analyze schedule, deep work, focus time, schedule optimization, calendar intelligence, time blocking, schedule health, batch schedule, invitation rules, learn patterns, auto accept.
triggers:
  - schedule meeting
  - check calendar
  - list events
  - add event
  - delete event
  - find free time
  - calendar agenda
  - optimize calendar
  - schedule smart
  - goal alignment
  - analyze schedule
  - insert breaks
  - calendar intelligence
  - time blocking
  - focus time
  - deep work scheduling
  - schedule health
  - batch schedule
  - invitation rules
  - learn patterns
  - auto accept
---

# CalendarAssistant - Intelligent Calendar Management System

Direct interface to Google Calendar for scheduling, viewing, and managing events via `kaya-cli calendar` (powered by gcalcli), with intelligence layers for goal alignment scoring, automatic break insertion, conflict detection, scheduling optimization, and transparent decision rationale.

---

## Summary

CalendarAssistant combines CLI-based calendar CRUD with intelligence layers: goal alignment scoring, break insertion frameworks (Pomodoro 25/5, 52/17, custom), multi-dimensional slot optimization, conflict detection with resolution suggestions, and transparent decision rationale. Every scheduling action is logged to an immutable audit trail and gated by safety guardrails.

---

## CLI Commands Available

| CLI Command | Purpose |
|-------------|---------|
| `kaya-cli calendar agenda` | View upcoming events for a time period |
| `kaya-cli calendar list` | List available calendars |
| `kaya-cli calendar search` | Search for events within a time period |
| `kaya-cli calendar add` | Add a detailed event to the calendar |
| `kaya-cli calendar quick` | Quick-add an event with natural language |
| `kaya-cli calendar edit` | Edit an existing calendar event |
| `kaya-cli calendar delete` | Delete an event from the calendar |
| `kaya-cli calendar calw` | Get a week-based agenda in calendar format |
| `kaya-cli calendar calm` | Get a month agenda in calendar format |
| `kaya-cli calendar conflicts` | Find event conflicts |
| `kaya-cli calendar remind` | Execute command if event occurs within time |

---

## CLI to MCP Mapping Reference

| MCP Tool (deprecated) | CLI Equivalent |
|-----------------------|----------------|
| `mcp__google-calendar__get-current-time` | `date` (system command) |
| `mcp__google-calendar__list-events` | `kaya-cli calendar agenda` or `kaya-cli calendar list` |
| `mcp__google-calendar__search-events` | `kaya-cli calendar search` |
| `mcp__google-calendar__create-event` | `kaya-cli calendar add` or `kaya-cli calendar quick` |
| `mcp__google-calendar__update-event` | `kaya-cli calendar edit` |
| `mcp__google-calendar__delete-event` | `kaya-cli calendar delete` |
| `mcp__google-calendar__get-freebusy` | `kaya-cli calendar agenda` (check for gaps) |
| `mcp__google-calendar__respond-to-event` | Manual via web interface |

---

## Intelligence Tools

| Tool | Purpose |
|------|---------|
| **CalendarOrchestrator.ts** | Main entry point - routes requests through pipeline |
| **IntentParser.ts** | Natural language to structured intent (7 types) |
| **TemporalResolver.ts** | NL date/time to ISO 8601 timestamps with timezone |
| **GoogleCalendarAdapter.ts** | CRUD via kaya-cli calendar commands |
| **GoalStore.ts** | Hierarchical goal storage via StateManager |
| **GoalAlignmentEngine.ts** | Score events against goals (0-100) |
| **BreakInsertionEngine.ts** | Pomodoro 25/5, 52/17, custom break frameworks |
| **ConflictDetector.ts** | Time overlap detection + resolution suggestions |
| **SchedulingOptimizer.ts** | Multi-dimensional slot scoring |
| **ApprovalRouter.ts** | Gate high-impact actions |
| **PreferenceStore.ts** | User preferences, override tracking, preference versioning (snapshot/restore) |
| **AuditLogger.ts** | Immutable append-only JSONL audit log with PII filtering (SHA-256), log rotation, query interface |
| **RationaleGenerator.ts** | Template-based decision explanations with per-dimension scoring, prohibited phrase filter |
| **SafetyGuardrails.ts** | Hard blocks on prohibited actions, dry-run mode |
| **ScheduleHealthReport.ts** | Daily/weekly health analysis with balance scoring |
| **BatchOperations.ts** | Bulk schedule, reschedule, template-based scheduling |
| **BehavioralLearningV2.ts** | Pattern extraction from event history |
| **SlotScoringV2.ts** | Feedback-weighted slot scoring with preference learning |
| **InvitationHandler.ts** | Auto-accept/decline rules with priority evaluation |

### Intelligence Commands

| Command | Purpose |
|---------|---------|
| `echo "request" \| bun run Tools/CalendarOrchestrator.ts` | Process natural language calendar request |
| `bun run Tools/CalendarOrchestrator.ts analyze` | Analyze current schedule for goal alignment |
| `bun run Tools/CalendarOrchestrator.ts optimize` | Get optimization suggestions for today |
| `bun run Tools/CalendarOrchestrator.ts goal add "Goal" --level quarterly` | Add a goal to the hierarchy |
| `echo "request" \| bun run Tools/CalendarOrchestrator.ts --dry-run` | Simulate without calendar changes |
| `bun run Tools/PreferenceStore.ts show` | Show current user preferences |
| `bun run Tools/PreferenceStore.ts suggestions` | Show override-based preference update suggestions |
| `bun run Tools/PreferenceStore.ts snapshot "label"` | Create a preference version snapshot |
| `bun run Tools/PreferenceStore.ts restore <id>` | Restore preferences from a snapshot |
| `bun run Tools/PreferenceStore.ts history` | List preference version history |
| `bun run Tools/AuditLogger.ts read [limit]` | Read recent audit entries |
| `bun run Tools/AuditLogger.ts stats [since-iso]` | Get audit statistics |
| `bun run Tools/AuditLogger.ts event <event-id>` | Get audit trail for specific event |
| `bun run Tools/AuditLogger.ts query --start ISO --end ISO --type TYPE` | Query audit log with filters |

---

## Workflow Routing

| Trigger | Workflow | Action |
|---------|----------|--------|
| "what's on my calendar", "today's schedule" | **ViewAgenda** | Show upcoming events |
| "schedule meeting", "add event" | **CreateEvent** | Add new event |
| "find time", "when am I free" | **FindFreeTime** | Identify available slots |
| "reschedule", "move meeting" | **EditEvent** | Modify existing event |
| "cancel meeting", "delete event" | **DeleteEvent** | Remove event |
| "conflicts", "double booked" | **CheckConflicts** | Find overlapping events |
| "this week", "next week" | **WeekView** | Calendar week view |
| "schedule smart", "deep work", "focus time" | **ScheduleEvent** | Intelligent scheduling with goal alignment |
| "optimize schedule", "analyze schedule" | **OptimizeSchedule** | Schedule optimization suggestions |
| "goal alignment", "how aligned" | **AnalyzeAlignment** | Weekly goal alignment analysis |
| "schedule health", "health report" | **ScheduleHealth** | Daily/weekly health analysis |
| "batch schedule", "bulk add" | **BatchSchedule** | Bulk event creation |
| "apply template", "schedule template" | **ApplyTemplate** | Template-based scheduling |
| "learn patterns", "behavioral" | **LearnPatterns** | Extract patterns from history |
| "invitation rules", "auto accept" | **InvitationRules** | Manage auto-accept/decline |

---

## Quick Reference

### Common Commands

```bash
# View today's agenda
kaya-cli calendar agenda

# View next 7 days
kaya-cli calendar agenda "today" "7 days from now"

# Search for events
kaya-cli calendar search "meeting"

# Quick add event (natural language)
kaya-cli calendar quick "Lunch with John tomorrow at noon"

# Add detailed event
kaya-cli calendar add --title "Team Standup" --when "Monday 9am" --duration 30

# View week calendar
kaya-cli calendar calw

# View month calendar
kaya-cli calendar calm

# Delete an event
kaya-cli calendar delete "event title"

# Find conflicts
kaya-cli calendar conflicts
```

### Agenda Options

| Flag | Purpose |
|------|---------|
| `--calendar NAME` | Filter to specific calendar |
| `--details all` | Show full event details |
| `--tsv` | Tab-separated output (for parsing) |
| `--nostarted` | Hide events that have started |
| `--nodeclined` | Hide declined events |

### Add Event Options

| Flag | Purpose |
|------|---------|
| `--title TITLE` | Event title |
| `--when TIME` | Event start time |
| `--duration MINS` | Duration in minutes |
| `--end TIME` | Alternative to duration |
| `--where LOCATION` | Event location |
| `--who EMAIL` | Add attendee (repeatable) |
| `--description TEXT` | Event description |
| `--allday` | Create all-day event |
| `--reminder "15m popup"` | Set reminder |
| `--calendar NAME` | Target calendar |
| `--noprompt` | Don't prompt for missing data |

---

## Execution Steps

### ViewAgenda Workflow

1. **Determine time range:**
   - "today" -> `kaya-cli calendar agenda`
   - "this week" -> `kaya-cli calendar agenda "today" "7 days"`
   - "next month" -> `kaya-cli calendar agenda "today" "30 days"`
2. **Execute agenda command**
3. **Parse output** and format for user
4. **Offer actions:** add event, show details, find free time

### CreateEvent Workflow

1. **Parse user intent:**
   - Title, time, duration, location, attendees
2. **Use quick add** for simple events:
   ```bash
   kaya-cli calendar quick "Meeting with Bob Friday at 2pm for 1 hour"
   ```
3. **Use detailed add** for complex events:
   ```bash
   kaya-cli calendar add --title "Sprint Planning" \
     --when "Monday 10am" --duration 60 \
     --where "Conference Room A" \
     --who "team@company.com" --noprompt
   ```
4. **Confirm creation** with event details

### FindFreeTime Workflow

1. **Get agenda** for time period:
   ```bash
   kaya-cli calendar agenda "today" "7 days" --details time
   ```
2. **Analyze gaps** between events
3. **Report available slots** considering:
   - Working hours (9am-6pm by default)
   - Meeting duration needed
   - Buffer time preferences
4. **Offer to schedule** in available slot

### EditEvent Workflow

1. **Search for event** to identify it:
   ```bash
   kaya-cli calendar search "meeting title"
   ```
2. **Get event details** with ID:
   ```bash
   kaya-cli calendar agenda --details id
   ```
3. **Edit the event:**
   ```bash
   kaya-cli calendar edit "event title"
   ```
4. **Confirm changes**

### DeleteEvent Workflow

1. **Search for event** to confirm:
   ```bash
   kaya-cli calendar search "event title"
   ```
2. **Delete with confirmation:**
   ```bash
   kaya-cli calendar delete "event title"
   ```
3. **Report deletion**

### CheckConflicts Workflow

1. **Run conflict detection:**
   ```bash
   kaya-cli calendar conflicts
   ```
2. **Report overlapping events**
3. **Suggest resolutions**

### ScheduleEvent Workflow (Intelligent)

1. Parse user intent via IntentParser (Haiku for simple, Sonnet for complex)
2. Resolve temporal expressions via TemporalResolver
3. Fetch current calendar state via GoogleCalendarAdapter
4. Load goals and preferences
5. Run ConflictDetector on proposed time
6. Score candidate slots via SchedulingOptimizer
7. Check approval gates via ApprovalRouter
8. Execute via GoogleCalendarAdapter (or simulate in dry-run)
9. Log to AuditLogger
10. Generate and return rationale

### OptimizeSchedule Workflow

1. Fetch today's calendar events
2. Score each event for goal alignment
3. Detect break coverage gaps
4. Identify conflicts and density issues
5. Generate optimization suggestions with rationale
6. Present suggestions ranked by impact

### AnalyzeAlignment Workflow

1. Load active goals from GoalStore
2. Fetch calendar events for target period
3. Score each event against goals (0-100)
4. Compute daily/weekly alignment scores
5. Tag events with matched goals
6. Generate alignment report with recommendations

---

## Time Parsing Examples

gcalcli understands natural language time expressions:

| Expression | Interpretation |
|------------|----------------|
| `tomorrow at 2pm` | Next day, 2:00 PM |
| `Monday 9am` | Next Monday, 9:00 AM |
| `next week` | 7 days from now |
| `Jan 15 10:30am` | Specific date and time |
| `in 2 hours` | 2 hours from now |
| `noon` | 12:00 PM |
| `3pm for 1 hour` | 3:00 PM, 60 minute duration |

---

## Examples

**Example 1: Check today's schedule**
```
User: "What's on my calendar today?"
Kaya:
-> Runs: kaya-cli calendar agenda
-> Parses output
-> "Today you have: 9am Team Standup, 2pm Client Call, 4pm 1:1 with Manager"
```

**Example 2: Schedule a meeting**
```
User: "Schedule a meeting with Sarah tomorrow at 3pm for an hour"
Kaya:
-> Runs: kaya-cli calendar add --title "Meeting with Sarah" \
         --when "tomorrow 3pm" --duration 60 --noprompt
-> "Created: Meeting with Sarah, tomorrow at 3:00 PM (1 hour)"
```

**Example 3: Quick add with natural language**
```
User: "Add lunch with the team Friday at noon"
Kaya:
-> Runs: kaya-cli calendar quick "Lunch with the team Friday at noon"
-> "Added: Lunch with the team, Friday 12:00 PM"
```

**Example 4: Find available time**
```
User: "When am I free this week for a 2-hour meeting?"
Kaya:
-> Runs: kaya-cli calendar agenda "today" "7 days" --details time
-> Analyzes gaps between events
-> "Available 2-hour slots this week:
   - Tuesday 2pm-4pm
   - Wednesday 10am-12pm
   - Friday 3pm-5pm"
```

**Example 5: Schedule deep work with goal alignment**
```
User: "Schedule 2 hours for deep work on Project X tomorrow morning"
Kaya:
-> Parses intent: create, title="Deep Work: Project X", duration=120min
-> Resolves "tomorrow morning" to 2026-02-06 09:00 PST
-> Checks calendar: 09:00-11:00 is free
-> Scores slot: goal_alignment=92, time_preference=88, break_coverage=95, density=75
-> Creates event via kaya-cli calendar add
-> Rationale: "Scheduled deep work block aligned with your Q1 goal 'Complete Project X' (92% alignment). Morning slot selected for optimal focus time."
```

**Example 6: Optimize today's schedule**
```
User: "Optimize my schedule for today"
Kaya:
-> Fetches today's events (8 events)
-> Goal alignment: 67% (3 events untagged)
-> Break coverage: 45% (missing breaks between 10am-2pm block)
-> Conflicts: 1 overlap at 3pm
-> Suggestions:
   1. "Insert 15-min break at 12:00 between Planning and Design Review (break coverage +20%)"
   2. "Move 3pm Client Call to 3:30pm to resolve overlap with Sprint Review"
   3. "Consider moving Admin Tasks to afternoon - low goal alignment, freeing morning for Q1 project work"
```

**Example 7: Analyze weekly goal alignment**
```
User: "How aligned is my week with my goals?"
Kaya:
-> Loads 3 quarterly goals, 8 weekly goals
-> Scores 32 events across the week
-> Weekly alignment: 71%
-> Breakdown:
   - "Complete Q1 Report": 8 hours scheduled (target: 10) - 80%
   - "Team Development": 3 hours scheduled (target: 4) - 75%
   - "Client Relationships": 6 hours scheduled (target: 5) - 100%
-> Recommendations: "Add 2 more hours for Q1 Report work. Thursday afternoon has a 3-hour free block."
```

**Example 8: Delete an event**
```
User: "Cancel my meeting with John tomorrow"
Kaya:
-> Runs: kaya-cli calendar search "John" --details all
-> Finds matching event
-> Runs: kaya-cli calendar delete "Meeting with John"
-> "Deleted: Meeting with John, scheduled for tomorrow at 2pm"
```

---

## Customization

### Break Frameworks
Configure in preferences:
- `pomodoro`: 25 min work / 5 min break (15 min every 4 cycles)
- `52-17`: 52 min work / 17 min break
- `custom`: User-defined work/break intervals

### Scoring Weights
Adjust optimization dimensions (default weights):
- `goalAlignment`: 0.35
- `timeOfDayPreference`: 0.25
- `breakCoverageImpact`: 0.20
- `calendarDensity`: 0.20

### Protected Time Blocks
Define times that require approval to schedule over:
- Working hours boundaries
- Focus time blocks
- Personal time

### Approval Thresholds
- External attendee count: 3 (default)
- Confidence threshold: 75% (default)

### Preference Management (Phase 4)
- **Working hours**: Configurable start/end times (default 09:00-17:00)
- **Preferred focus time**: morning, afternoon, or evening
- **Default event duration**: Minutes (default 60)
- **Buffer between events**: Minutes (default 5)
- **Override tracking**: After 5 overrides in the same category, the system suggests updating the preference
- **Preference versioning**: Snapshot current preferences before experiments, restore if needed

### Audit Log (Phase 4)
- **PII filtering**: Event titles, attendee emails, descriptions are SHA-256 hashed in audit entries
- **Log rotation**: Automatic rotation when file exceeds configured max size (default 50MB)
- **Query interface**: Filter by date range, action type, event ID
- **Immutable**: Append-only design - no delete or update operations exposed

### Rationale Engine (Phase 4)
- **Per-dimension scoring**: Goal Alignment, Time-of-Day Preference, Calendar Density, Break Coverage
- **Prohibited phrases**: 16 phrases blocked including "I think", "probably", "seems good"
- **Template-based**: Consistent human-readable explanations for every scheduling decision

---

## Voice Notification

```bash
curl -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message":"Calendar operation completed","voice_id":"XrExE9yKIg1WjnnlVkGX","title":"CalendarAssistant"}'
```

---

## Safety Rules

**Requires User Approval:**
- Deleting events
- Modifying events with attendees
- Sending meeting invites
- Scheduling over protected time blocks
- Actions below confidence threshold

**Allowed Without Approval:**
- Viewing agenda and calendar
- Searching for events
- Checking for conflicts
- Finding free time
- Dry-run simulations
- Goal alignment analysis

---

## Integration

### Uses
- **kaya-cli calendar** - All calendar CRUD operations (via gcalcli)
- **Tools/Inference.ts** - LLM inference (fast/standard levels)
- **StateManager** - Persistent state for goals, preferences, audit
- **settings.json** - User timezone (America/Los_Angeles)
- **Contacts** - Lookup attendee info from `USER/CONTACTS.md`

### Feeds Into
- **AutoMaintenance** - Schedule health metrics
- **THEALGORITHM** - Goal progress tracking
- **TaskMaintenance** - Extract action items from meetings
- **Gmail** - Meeting-related email threads

### CLIs Used
- **gcalcli** (via kaya-cli calendar) - Full calendar automation

### MCPs Used
- None (uses kaya-cli calendar commands, not direct API)

---

## Configuration

The calendar CLI uses Google OAuth2 for authentication.

**Initial Setup:**
```bash
kaya-cli calendar init
```

**Configuration Location:**
```
~/Library/Application Support/gcalcli/
```

**Default Calendar:**
Set in `~/.gcalclirc` or via `--default-calendar` flag.

---

**Last Updated:** 2026-02-06
