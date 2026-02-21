---
name: ContextManager
description: Dynamic context loading with progressive disclosure and token budgets. USE WHEN context loading, context profile, token budget, dynamic context, context management, reduce context, context optimization, what context is loaded.
---

# ContextManager - Dynamic Context Loading

**Progressive context disclosure for Kaya.** Loads the right context at the right time within strict token budgets.

## Problem

Kaya loads ~2,000 lines of static context at every session start regardless of task type. A CSS bug fix gets the same TELOS goals, strategies, and challenges as a life-coaching session. This wastes tokens, degrades performance (context rot), and buries relevant information in noise.

## Architecture: Three-Tier Progressive Disclosure

### Tier 1: Boot Context (SessionStart, ~200 tokens)
Always loaded. Identity, response format, compressed steering rules. Just enough for Claude to function and classify intent.

### Tier 2: Profile Context (UserPromptSubmit, first message, ~800-1500 tokens)
Intent classification on first user message selects a profile. Profile-appropriate files load within a token budget.

### Tier 3: On-Demand Context (mid-session, as needed)
Topic changes trigger delta loading. Claude reads files directly or uses `ContextLoadTool` when deeper context is needed.

## Context Profiles

| Profile | Budget | When Used |
|---------|--------|-----------|
| `boot` | 200 | Always (Tier 1) |
| `development` | 3200 | Code, projects, bugs, features |
| `life-coaching` | 1500 | Goals, challenges, strategies, progress |
| `scheduling` | 800 | Calendar, meetings, availability |
| `task-management` | 1000 | Asana, tasks, deadlines, queues |
| `knowledge-lookup` | 1000 | Obsidian, notes, research |
| `general` | 2500 | Ambiguous or mixed-intent requests |
| `conversational` | 200 | Greetings, simple Q&A |

## Classification

Two-stage intent classification:
1. **Fast keyword match** (<1ms) -- Handles 80%+ of cases
2. **Haiku inference fallback** (~2-5s) -- For ambiguous prompts

## Tools

| Tool | Purpose | CLI |
|------|---------|-----|
| `IntentClassifier.ts` | Classify user intent into profile | `bun IntentClassifier.ts "prompt"` |
| `ContextSelector.ts` | Budget-aware file selection | `bun ContextSelector.ts development` |
| `ContextCompressor.ts` | Generate compressed file summaries | `bun ContextCompressor.ts --all` |
| `ContextLoadTool.ts` | Active context loading (Claude calls) | `bun ContextLoadTool.ts load scheduling` |
| `TokenEstimator.ts` | Estimate token count | `bun TokenEstimator.ts <file>` |
| `FreshnessChecker.ts` | Check context staleness | `bun FreshnessChecker.ts <file>` |
| `FeedbackCollector.ts` | Capture session effectiveness | `bun FeedbackCollector.ts --capture` |
| `ContextLearner.ts` | Learn from usage patterns | `bun ContextLearner.ts --analyze` |

## Workflows

### Classify-And-Load (automatic via hook)
1. ContextRouter.hook.ts fires on UserPromptSubmit
2. IntentClassifier determines profile
3. ContextSelector loads files within budget
4. Content injected as `<system-reminder>`

### Compress-Context (manual)
```bash
bun skills/ContextManager/Tools/ContextCompressor.ts --all
```
Pre-computes `.compressed.md` versions of large context files.

### Review-Feedback (periodic)
```bash
bun skills/ContextManager/Tools/ContextLearner.ts --analyze
```
Analyzes session feedback to recommend profile tuning.

## Configuration

Feature-flagged in `settings.json`:
```json
{
  "contextManager": {
    "enabled": false      // Full static loading (default, safe)
    // "enabled": "shadow" // Classification runs + logs to stderr, static loading continues
    // "enabled": true     // Full dynamic three-tier loading (boot + profile)
  }
}
```

| Mode | Boot Context | Classification | Context Injection | Use Case |
|------|-------------|----------------|-------------------|----------|
| `false` | Full static (~2000 lines) | None | None | Default, safe |
| `"shadow"` | Full static (~2000 lines) | Runs, logs to stderr | None (shadow only) | Validation phase |
| `true` | Boot-only (~200 tokens) | Runs, selects profile | Profile context injected | Production |

Rollback: Set `enabled: false` — next session instantly reverts to full static loading.

## Customization

Profiles are defined in `config/profiles.json`. Add new profiles by:
1. Adding a profile entry with token budget and file lists
2. Adding keyword rules in `config/routing.json`

## Voice Notification

Context profile changes are logged to stderr for observability. No voice notifications (context loading is silent infrastructure).

## Integration

### Uses
- `Inference.ts` -- Haiku classification fallback and compression
- `StateManager` -- Session state persistence
- `ConfigLoader` -- Tiered config loading
- `MemoryStore` -- Feedback signal capture
- InformationManager configs -- `loadWhen`/`skipWhen` keyword derivation

### Feeds Into
- `LoadContext.hook.ts` -- Boot-only mode when enabled
- `ContextRouter.hook.ts` -- Profile-based dynamic loading
- All sessions -- Reduced, relevant context

### MCPs Used
- None

## Examples

### Example 1: Development session
```
User: "Fix the authentication bug in login.ts"
→ Profile: development (keyword match: "fix", "bug")
→ Loads: SKILL-INDEX, CLI-INDEX, ProjectsContext
→ Skips: TELOS/*, Calendar, Obsidian
→ Tokens: ~1100/1200 budget
```

### Example 2: Life coaching
```
User: "How am I doing on my goals this week?"
→ Profile: life-coaching (keyword match: "goals", "doing", "week")
→ Loads: TELOS files (Missions, Goals, Challenges, Status, Strategies)
→ Skips: Projects, Skills, CLI tools
→ Tokens: ~1400/1500 budget
```

### Example 3: Quick conversation
```
User: "Hey, good morning"
→ Profile: conversational (keyword match: "hey", "morning")
→ Loads: Nothing beyond boot context
→ Tokens: ~200 (boot only)
```

## Rollout

| Phase | Action |
|-------|--------|
| **0 - Build** | Create skill, tools, configs. No hook changes. |
| **1 - Shadow** | Register ContextRouter, log-only. Validate classifications. |
| **2 - Enable** | Set `contextManager.enabled: true`. Full dynamic loading. |
| **Rollback** | Set `enabled: false`. Instant revert to static loading. |
