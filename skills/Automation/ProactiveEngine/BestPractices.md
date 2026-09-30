# ProactiveEngine Best Practices

## Keep Jobs Focused

Each cron job should do ONE thing well. Don't create mega-jobs that do everything.

**Good**: `daily-briefing.yaml`, `evening-summary.yaml`, `weekly-review.yaml`
**Bad**: `everything-check.yaml`

---

## Use Context Files

For complex jobs, store reusable context in separate files:

```yaml
context:
  - USER/TELOS/PURPOSE.md
  - USER/CONTACTS.md
```

---

## Output Routing Strategy

- **voice**: Rich content you want to hear
- **push**: Time-sensitive alerts
- **discord**: Team notifications
- **silent**: Background maintenance

---

## Timing Considerations

- Avoid scheduling multiple heavy jobs simultaneously
- Consider timezone (`settings.json` → `principal.timezone`)
- Space out notifications to avoid overload
- Disable jobs during vacations/off-periods

---

## Error Handling

Cron jobs should fail gracefully:
- Log errors to `MEMORY/daemon/cron/errors/`
- Send failure notification if high priority
- Retry with exponential backoff for transient failures
- Escalate to user if persistent failures

---

## Settings Integration

Jobs use `settings.json` for personalization:

```typescript
const { principal, daidentity } = JSON.parse(
  await Bun.file(`${process.env.HOME}/.claude/settings.json`).text()
);

// Greet by name
const greeting = `Good morning, ${principal.name}...`;
```

---

## Secrets Management

API keys for external services (LucidTasks, Calendar, Weather):

```typescript
const secrets = JSON.parse(
  await Bun.file(`${process.env.HOME}/.claude/secrets.json`).text()
);

const lucidtasksConfig = secrets.lucidtasks;
```

---

## Future Enhancements

### Adaptive Scheduling

Learn optimal briefing times based on user engagement:
- Track when briefings are heard vs ignored
- Adjust timing to maximize value
- Disable low-value automated tasks

### Conditional Execution

Only send briefings when relevant:
- Skip morning briefing if calendar is empty
- Only send evening summary if tasks were completed
- Escalate urgency based on priority

### Multi-Modal Output

Expand beyond voice:
- Generate visual briefing dashboards
- Send markdown summaries to Obsidian
- Create PDF daily reports

### Context-Aware Content

Deeper personalization:
- Reference ongoing projects from MEMORY
- Connect to Telos goals
- Suggest next actions based on The Algorithm
