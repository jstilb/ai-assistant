# Classify-And-Load Workflow

**Trigger:** Automatic via ContextRouter.hook.ts on UserPromptSubmit

## Flow

1. **ContextRouter.hook.ts** fires on every user prompt
2. **First message:** Full classification via IntentClassifier
   - Stage A: Keyword match against routing.json rules
   - Stage B (if ambiguous): Haiku inference fallback
3. **Profile selected** based on classification result
4. **ContextSelector** loads files within token budget
   - Priority: required > recommended > optional
   - Falls back to .compressed.md if file exceeds remaining budget
5. **Output** injected as `<system-reminder>` to Claude
6. **State** tracked in MEMORY/STATE/context-session.json

## Subsequent Messages

- Lightweight keyword-only topic-change detection
- If profile changes significantly, delta context loads
- No inference needed for continuation messages
