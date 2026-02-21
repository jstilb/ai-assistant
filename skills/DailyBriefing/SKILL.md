---
name: DailyBriefing
description: Personalized morning briefings with modular sections. USE WHEN morning briefing, daily briefing, start my day, what's on my schedule, daily summary.
---

# DailyBriefing

Modular, YAML-configurable morning briefings delivered via Telegram, written logs, and push notifications.

## Voice Notification

Use `notifySync()` from `skills/CORE/Tools/NotificationService.ts`

## Workflow Routing

| Trigger | Workflow |
|---------|----------|
| "morning briefing", "daily briefing" | `Workflows/GenerateBriefing.md` |
| "weather message", "send weather" | `bun Tools/WeatherMessenger.ts` |
| "configure briefing" | Edit `BriefingConfig.yaml` |

## Quick Reference

- **Config:** `BriefingConfig.yaml` - enable/disable sections, set priorities
- **Blocks:** Goals, ApprovalQueue, Weather, Calendar, LucidTasks, News, MissionGrouped, StaleItems
- **Delivery:** Telegram, written log (MEMORY/BRIEFINGS), push notification, voice
- **Weather CLI:** `bun Tools/WeatherMessenger.ts [--dry-run] [--text-only] [--voice-only] [--json]`
- **Briefing CLI:** `bun Tools/BriefingGenerator.ts [--dry-run] [--json]`

## Tools

| Tool | Purpose |
|------|----------|
| `Tools/WeatherService.ts` | Rich weather data layer (wttr.in + NWS alerts) |
| `Tools/WeatherRecommender.ts` | AI clothing/activity recommendations with rule-based fallback |
| `Tools/WeatherBlock.ts` | Weather section for the briefing generator |
| `Tools/WeatherMessenger.ts` | Standalone weather delivery (Telegram + voice) |
| `Tools/BriefingGenerator.ts` | Full briefing orchestrator |
| `Tools/MissionGroupedBlock.ts` | Re-groups events/tasks by TELOS mission |
| `Tools/StaleItemBlock.ts` | Detects stale tasks and forgotten items |

## Customization

Edit `BriefingConfig.yaml` to customize the briefing:

```yaml
# Enable/disable individual sections
sections:
  goals:
    enabled: true
    priority: 1
  weather:
    enabled: true
    priority: 3
    settings:
      location: "San Diego, CA"
      includeRecommendations: true

# Configure delivery channels
delivery:
  telegram:
    enabled: true
  writtenLog:
    enabled: true
    path: "MEMORY/BRIEFINGS"
  push:
    enabled: true
  voice:
    enabled: true
```

- **Add/remove blocks:** Set `enabled: true/false` for any section
- **Reorder blocks:** Change `priority` values (lower = earlier)
- **News topics:** Pass custom topics via `sections.news.settings.topics`
- **Weather location:** Override via `sections.weather.settings.location`
- **Stale thresholds:** Tune `staleDays` and `memoryDays` in staleItems settings

## Examples

```bash
# Generate full briefing with all delivery channels
bun Tools/BriefingGenerator.ts

# Preview briefing without sending anything
bun Tools/BriefingGenerator.ts --dry-run

# JSON output for programmatic consumption
bun Tools/BriefingGenerator.ts --json

# Skip specific delivery channels
bun Tools/BriefingGenerator.ts --skip-voice --skip-telegram

# Standalone weather message
bun Tools/WeatherMessenger.ts --dry-run

# Test individual blocks
bun Tools/WeatherBlock.ts --test
bun Tools/NewsBlock.ts --test
bun Tools/GoalsBlock.ts --test
bun Tools/CalendarBlock.ts --test
bun Tools/StaleItemBlock.ts --test
```

## Integration

### Uses
- `CORE/Tools/NotificationService.ts` - Voice delivery
- `CORE/Tools/CachedHTTPClient.ts` - HTTP requests (wttr.in, NWS)
- `CORE/Tools/Inference.ts` - Weather recommendations, news summarization
- `Telegram/Tools/TelegramClient.ts` - Telegram delivery
- `kaya-cli gcal` - Calendar data
- `kaya-cli tasks` - Task data (LucidTasks)

### Feeds Into
- `MEMORY/BRIEFINGS/` - Written briefing logs
- `MEMORY/WEATHER/` - Daily weather data logs
- Voice server - Spoken summaries
