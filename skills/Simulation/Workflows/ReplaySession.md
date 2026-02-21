# ReplaySession Workflow

Replay a captured session transcript with mutations to test behavioral stability.

## Trigger
"replay session", "replay transcript"

## Steps

1. Load transcript from Evals TranscriptCapture or Transcripts/ directory
2. Apply mutations (prompt rephrasing, fault injection)
3. Re-execute in fresh sandbox
4. Compare replayed behavior against original
5. Detect and report behavioral drift

## Execution

```bash
# Replay a session
bun ~/.claude/skills/Simulation/Tools/ReplayEngine.ts replay Transcripts/session-001.json

# Replay with prompt mutations
bun ~/.claude/skills/Simulation/Tools/ReplayEngine.ts replay session.json --mutate-prompts

# Compare original vs replayed
bun ~/.claude/skills/Simulation/Tools/ReplayEngine.ts compare original.json replayed.json
```

## Notes
- Transcripts can come from Evals TranscriptCapture or manual capture
- Prompt mutations generate synonym variants to test phrasing sensitivity
- Drift score: 0.0 = identical behavior, 1.0 = completely different
