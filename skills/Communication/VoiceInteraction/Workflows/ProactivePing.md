# ProactivePing Workflow

Send proactive voice messages to the user based on events or schedules.

## Trigger
"ping me", "proactive voice", "voice reminder"

## Steps

1. Determine target channel (desktop if active, else Telegram)
2. Generate voice audio via VoiceResponseGenerator
3. Deliver via appropriate channel
4. Log ping to state

## Execution

```bash
# Send immediate ping (auto-routes to best channel)
bun ~/.claude/skills/Communication/VoiceInteraction/Tools/ProactivePinger.ts send "Meeting in 10 minutes"

# Schedule future ping
bun ~/.claude/skills/Communication/VoiceInteraction/Tools/ProactivePinger.ts schedule \
  --at "2026-02-05T09:00:00" \
  --message "Good morning, Jm"

# Process due pings (called by ProactiveEngine)
bun ~/.claude/skills/Communication/VoiceInteraction/Tools/ProactivePinger.ts process-due
```

## Integration with ProactiveEngine

The ProactiveEngine skill can call ProactivePinger to deliver voice notifications:
- Calendar reminders
- Queue item completion alerts
- Goal check-in prompts
- Weather briefings (via DailyBriefing)

## Notes
- Desktop channel plays through speakers via afplay
- Telegram channel sends OGG voice message or text fallback
- All pings are fire-and-forget (never block execution)
