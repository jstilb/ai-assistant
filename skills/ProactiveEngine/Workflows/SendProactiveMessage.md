# SendProactiveMessage Workflow

**Purpose:** Manually send a proactive message or briefing outside of scheduled cron execution. Useful for testing, one-off requests, or immediate briefings.

**Triggers:** "send briefing now", "give me my briefing", "send proactive message", "what's on my agenda", "summarize my day"

---

## Voice Notification

```typescript
import { notifySync } from '~/.claude/skills/CORE/Tools/NotificationService.ts';
notifySync("Sending proactive message");
```

Running the **SendProactiveMessage** workflow from the **ProactiveEngine** skill...

---

## When to Use

- User wants immediate briefing (not waiting for cron)
- Testing a cron job before scheduling
- One-off check-in or status update
- Manual trigger of scheduled content
- Ad-hoc proactive outreach

---

## Execution

### Step 1: Understand Message Type

Parse user request to determine what to send:

| User Says | Action |
|-----------|--------|
| "Give me my morning briefing" | Execute daily-briefing task now |
| "Send me an evening summary" | Execute evening-summary task now |
| "What's on my calendar today?" | Calendar-only briefing |
| "Summarize my day so far" | Current day summary |
| "Any urgent tasks?" | Priority task check |

### Step 2: Determine Output Method

**Default**: voice (spoken via TTS)

**Override options**:
- "text message" → push notification
- "in Discord" → discord channel
- "just show me" → silent (display only, no audio)

### Step 3: Gather Context

Based on message type, collect relevant information:

#### Morning Briefing Context
```typescript
// Calendar
const todayEvents = await getCalendarEvents(today);

// Tasks
const priorityTasks = await getLucidTasks({
  priority: 'high',
  dueDate: today
});

// Weather
const weather = await getWeatherForecast();

// Recent work
const recentWork = await scanMemoryWork(yesterday);
```

#### Evening Summary Context
```typescript
// Today's activity
const sessions = await getMemorySessions(today);
const completedTasks = await getLucidTasks({
  completedDate: today
});

// Tomorrow preview
const tomorrowEvents = await getCalendarEvents(tomorrow);
const tomorrowTasks = await getLucidTasks({
  dueDate: tomorrow
});
```

#### Custom Request Context
Adapt based on user's specific question:
- Calendar query → fetch calendar API
- Task query → fetch LucidTasks API
- Communication → check email/messages
- Status → system health check

### Step 4: Generate Message

Use the same task description from the corresponding cron job (if applicable) or craft custom message based on request.

**Template structure**:
```
Greeting: "Good [morning/afternoon/evening], {principal.name}"
Context: Brief intro to what you're covering
Content: Structured information
Closing: Action items or reflection prompt
```

**Keep concise**:
- Morning briefing: ~2 minutes speaking
- Evening summary: ~3 minutes speaking
- Quick check: ~30 seconds speaking

### Step 5: Send via Requested Channel

#### Voice Output
```typescript
import { notifySync } from '~/.claude/skills/CORE/Tools/NotificationService.ts';
notifySync(message, {
  voice_id: daidentity.voiceId,
  title: "Proactive Briefing"
});
```

#### Push Notification
```bash
curl -X POST https://ntfy.sh/{topic} \
  -H "Title: Briefing" \
  -d "{message}"
```

#### Discord
```bash
curl -X POST {discord_webhook_url} \
  -H "Content-Type: application/json" \
  -d '{"content": "{message}"}'
```

#### Silent (Display Only)
Simply output the message in the conversation without triggering notifications.

### Step 6: Log Execution

```typescript
const logEntry = {
  timestamp: new Date().toISOString(),
  type: 'manual_proactive_message',
  messageType: 'morning_briefing', // or custom
  outputMethod: 'voice',
  triggered_by: 'user_request'
};

await logToFile(
  `${process.env.HOME}/.claude/MEMORY/daemon/cron/logs/${today}.log`,
  logEntry
);
```

---

## Example Interactions

### Example 1: Immediate Morning Briefing

```
User: "Give me my morning briefing now"

→ Workflow detects: morning briefing request
→ Executes daily-briefing task immediately (ignoring schedule)
→ Gathers:
  - Calendar events
  - Priority tasks
  - Weather
  - Recent context
→ Synthesizes into audio script
→ Sends via voice server
→ User hears briefing immediately
```

### Example 2: Calendar-Only Query

```
User: "What's on my calendar today?"

→ Workflow detects: calendar-specific request
→ Fetches only calendar events
→ Formats response:
  "You have 3 events today:
   - 9 AM: Team standup (Zoom)
   - 11 AM: Client meeting (Conference Room A)
   - 2 PM: Code review with Sarah (Remote)"
→ Sends via voice
```

### Example 3: Task Priority Check

```
User: "Any urgent tasks I should know about?"

→ Workflow detects: task priority query
→ Queries LucidTasks for:
  - priority: urgent OR high
  - status: incomplete
  - dueDate: today OR overdue
→ Formats response:
  "You have 2 urgent tasks:
   1. Review Q1 budget (overdue by 2 days)
   2. Approve marketing copy (due today)"
→ Sends via voice
```

### Example 4: Day Summary Mid-Day

```
User: "Summarize my day so far"

→ Workflow detects: current day summary
→ Scans MEMORY/WORK/ for today's sessions
→ Checks completed tasks from LucidTasks
→ Reviews calendar events that occurred
→ Formats response:
  "So far today you've:
   - Attended morning standup
   - Completed the API integration task
   - Had two work sessions on the dashboard redesign

   Still on deck:
   - Client meeting at 2 PM
   - Review pending PRs"
→ Sends via voice
```

### Example 5: Test Cron Job

```
User: "Test my weekly review cron job"

→ Workflow detects: test execution request
→ Reads MEMORY/daemon/cron/jobs/weekly-review.yaml
→ Executes the task field immediately
→ Sends output to requested channel (default: voice)
→ Reports: "Weekly review executed. Here's what it generated..."
```

---

## Output Routing Logic

```typescript
function determineOutputMethod(userRequest: string): OutputMethod {
  if (userRequest.includes('text') || userRequest.includes('push')) {
    return 'push';
  }
  if (userRequest.includes('discord') || userRequest.includes('team')) {
    return 'discord';
  }
  if (userRequest.includes('silent') || userRequest.includes('just show')) {
    return 'silent';
  }
  return 'voice'; // default
}
```

---

## API Integrations

> **Note:** For actual API implementations, use the existing CLI tools:
> - **Calendar**: `kaya-cli gcal today` (via CalendarAssistant skill)
> - **Tasks**: `kaya-cli tasks` (via UnixCLI skill)
> - **Weather**: Handled by DailyBriefing skill modules
>
> See `IDEAS.md` for planned direct API integration enhancements.

---

## Message Templates

### Morning Briefing Template

```
Good morning, {principal.name}. It's {day}, {date}. Here's your briefing.

CALENDAR:
{events_list}

PRIORITIES:
{top_tasks}

WEATHER:
{weather_summary}

{contextual_reminder}

Have a great day.
```

### Evening Summary Template

```
Good evening, {principal.name}. Here's how your day went.

ACCOMPLISHED:
{completed_items}

STILL PENDING:
{incomplete_items}

TOMORROW:
{next_day_preview}

REFLECTION:
{reflection_prompt}

Rest well.
```

### Quick Status Template

```
{greeting}, {principal.name}.

{specific_answer}

{action_item_if_any}
```

---

## Error Handling

### API Failures

```typescript
try {
  const events = await getCalendarEvents(today);
} catch (error) {
  // Gracefully degrade
  const fallback = "Calendar unavailable. Check manually.";
  // Continue with other sections
}
```

### Missing Context

```
"I couldn't access {source}, so this briefing is incomplete.
You may want to check {source} directly."
```

### No Content

```
"You have no calendar events today."
"No high-priority tasks at the moment."
"Inbox is clear—nice work!"
```

Handle empty states gracefully rather than failing.

---

## Best Practices

### Personalization

- Use {principal.name} from settings.json
- Reference ongoing projects from MEMORY
- Adapt tone based on time of day
- Connect to Telos goals when relevant

### Brevity

- Prioritize information density
- Cut fluff and filler words
- Use bullet points, not paragraphs
- Respect user's time

### Actionability

- Highlight what needs attention
- Suggest next actions
- Flag urgent items clearly
- Provide enough context to decide

### Graceful Degradation

- Work even if some APIs fail
- Provide partial briefings
- Note what's missing
- Don't fail completely

---

## Integration with Cron Jobs

This workflow can execute any cron job's task field manually:

```typescript
async function runCronJobManually(jobId: string) {
  const jobPath = `${process.env.HOME}/.claude/MEMORY/daemon/cron/jobs/${jobId}.yaml`;
  const job = parseYAML(await Bun.file(jobPath).text());

  // Execute the task
  const result = await executeTask(job.task, job.context);

  // Send via specified output method
  await sendMessage(result, job.output);
}
```

---

## Logging

All proactive messages (manual or scheduled) are logged to:

```
~/.claude/MEMORY/daemon/cron/logs/YYYY-MM-DD.log
```

Log format:
```jsonl
{"timestamp":"2026-01-30T08:00:00Z","type":"scheduled","job":"daily-briefing","output":"voice","status":"success"}
{"timestamp":"2026-01-30T14:32:15Z","type":"manual","request":"calendar query","output":"voice","status":"success"}
```

---

## Related Workflows

- `ManageCronJobs.md` - Schedule recurring proactive messages
- `System/IntegrityCheck.md` - Validate API integrations
- `Research/QuickResearch.md` - Gather contextual information

---

**Last Updated:** 2026-02-06
