# Kaya Hook System

> **Lifecycle event handlers that extend Claude Code with memory, security, and observability.**

This document is the authoritative reference for Kaya's hook system. When modifying any hook, update both the hook's inline documentation AND this README.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Hook Lifecycle Events](#hook-lifecycle-events)
3. [Hook Registry](#hook-registry)
4. [Inter-Hook Dependencies](#inter-hook-dependencies)
5. [Data Flow Diagrams](#data-flow-diagrams)
6. [Shared Libraries](#shared-libraries)
7. [Configuration](#configuration)
8. [Documentation Standards](#documentation-standards)
9. [Maintenance Checklist](#maintenance-checklist)

---

## Architecture Overview

Hooks are TypeScript scripts that execute at specific lifecycle events in Claude Code. They enable:

- **Memory Capture**: Ratings, learnings, subagent outputs
- **Security Validation**: Command filtering, path protection, prompt injection defense
- **Observability**: Sentiment tracking, ratings, failure dumps
- **Context Injection**: Date/time reminder, subagent guidance

> **2026-09-29 simplification:** the hook set was cut to 18 commands. See
> [THEHOOKSYSTEM.md](../docs/system/THEHOOKSYSTEM.md#2026-09-29-simplification) for what was removed and why.

### Design Principles

1. **Non-blocking by default**: Hooks should not delay the user experience
2. **Fail gracefully**: Errors in one hook must not crash the session
3. **Single responsibility**: Each hook does one thing well

### Execution Model

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Claude Code Session                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  SessionStart ──┬──► LoadContext (date/time reminder)               │
│                 └──► SessionEnvGuard (env-contamination guard)      │
│                                                                     │
│  UserPromptSubmit ──► ExplicitRatingCapture (1-10 ratings)          │
│                                                                     │
│  PreToolUse ──► SecurityValidator (Bash/Edit/Write)                 │
│                                                                     │
│  PostToolUse ──┬──► SkillStructureGuard (Write)                     │
│                ├──► TaskCompleted.sh (TaskUpdate)                   │
│                └──► PromptInjectionDefender (Bash/Read/Web*)        │
│                                                                     │
│  SubagentStart ──┬──► BackgroundAgentStarted                        │
│                  └──► SubagentVerbosityHint                         │
│                                                                     │
│  SubagentStop ──► AgentOutputCapture (subagent results)             │
│                                                                     │
│  StopFailure ──► StopFailure (failure dump capture)                 │
│                                                                     │
│  SessionEnd ──► SessionRatingCapture (rating + learnings)           │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Hook Lifecycle Events

| Event | When It Fires | Typical Use Cases |
|-------|---------------|-------------------|
| `SessionStart` | Session begins | Context loading, settings validation, env-contamination guard |
| `UserPromptSubmit` | User sends a message | Rating capture |
| `PreToolUse` | Before a tool executes | Security validation |
| `PostToolUse` | After a tool executes | Prompt-injection scanning, skill-structure guard, task-completion side effects |
| `SubagentStart` | Subagent launches | Inject hints, record background agents |
| `SubagentStop` | Subagent completes | Capture subagent outputs |
| `StopFailure` | Abnormal stop | Failure dump capture |
| `SessionEnd` | Session terminates | Session rating and learning extraction |

### Event Payload Structure

All hooks receive JSON via stdin with event-specific fields:

```typescript
// Common fields
interface BasePayload {
  session_id: string;
  transcript_path: string;
  hook_event_name: string;
}

// UserPromptSubmit
interface UserPromptPayload extends BasePayload {
  prompt: string;
}

// PreToolUse
interface PreToolUsePayload extends BasePayload {
  tool_name: string;
  tool_input: Record<string, any>;
}
```

---

## Hook Registry

> 18 commands registered in `settings.json` (`hooks/*.hook.ts` plus `TaskCompleted.sh`).
> Updated 2026-09-29: the Stop hook (StopOrchestrator and all `hooks/handlers/*`),
> UserPromptOrchestrator, and the other dead hooks were deleted; see
> [THEHOOKSYSTEM.md](../docs/system/THEHOOKSYSTEM.md#2026-09-29-simplification).

### SessionStart Hooks

| Hook | Purpose | Blocking | Dependencies |
|------|---------|----------|--------------|
| `LoadContext.hook.ts` | Inject date/time reminder (plus optional active-progress) at session start | Yes (stdout) | `CLAUDE.md` |
| `SessionEnvGuard.hook.ts` | Detect child-session env contamination (unpersisted sessions) | No | env vars |

### UserPromptSubmit Hooks

| Hook | Purpose | Blocking | Dependencies |
|------|---------|----------|--------------|
| `ExplicitRatingCapture.hook.ts` | Capture 1-10 ratings; ratings < 6 also write an `UNCATEGORIZED` learning file (deferred category — see [Learning Capture Flow](#learning-capture-flow)) | No | `MEMORY/LEARNING/SIGNALS/ratings.jsonl`, `MEMORY/LEARNING/UNCATEGORIZED/` |

### PreToolUse Hooks

| Hook | Matcher | Purpose | Blocking | Dependencies |
|------|---------|---------|----------|--------------|
| `SecurityValidator.hook.ts` | Bash, Edit, Write | Validate tool calls | Yes (decision) | `patterns.yaml`, `MEMORY/SECURITY/` |

### PostToolUse Hooks

| Hook | Matcher | Purpose | Blocking | Dependencies |
|------|---------|---------|----------|--------------|
| `SkillStructureGuard.hook.ts` | Write | Guard skill directory structure on writes | No | skills/ layout |
| `TaskCompleted.sh` | TaskUpdate | (shell) task-completion side effects | No | — |
| `PromptInjectionDefender.hook.ts` | Bash, Read, WebFetch, WebSearch | Scan tool outputs for prompt injection | Yes (decision) | scanner layers (regex/encoding/structural) |

### SubagentStart Hooks

| Hook | Purpose | Blocking | Dependencies |
|------|---------|----------|--------------|
| `BackgroundAgentStarted.hook.ts` | Record background-agent launches | No | `MEMORY/State/` |
| `SubagentVerbosityHint.hook.ts` | Inject verbosity guidance into subagents | Yes (stdout) | None |

### SubagentStop Hooks

| Hook | Purpose | Blocking | Dependencies |
|------|---------|----------|--------------|
| `AgentOutputCapture.hook.ts` | Capture subagent results; debug file log is opt-in via `KAYA_HOOK_DEBUG=1` | No | `MEMORY/STATE/` |

### StopFailure Hooks

| Hook | Purpose | Blocking | Dependencies |
|------|---------|----------|--------------|
| `StopFailure.hook.ts` | Capture failure dumps on abnormal stops | No | `MEMORY/LEARNING/FAILURES/` |

### SessionEnd Hooks

| Hook | Purpose | Blocking | Dependencies |
|------|---------|----------|--------------|
| `SessionRatingCapture.hook.ts` | Infer session rating AND extract categorized learnings at teardown (one combined LLM call, detached worker) | No | Inference API, `ratings.jsonl`, `MEMORY/LEARNING/<SYSTEM\|ALGORITHM>/` |

---

## Inter-Hook Dependencies

### Rating System Flow

```
User Message
    │
    ├─► ExplicitRatingCapture ─── detects "8 - great work" ───┐
    │                                                         ▼
    │                                              ratings.jsonl
    │                                                         │
    │                                                         ▼
    │                                            Status Line Display
    │                                            (statusline-command.sh)
    └─► SessionRatingCapture (SessionEnd) infers a rating at teardown
        when no explicit rating was given
```

**Note**: ImplicitSentimentCapture (mood detection) was de-registered April
2026 and deleted 2026-07-03; its `isExplicitRating()` logic lives on in
`lib/core/RatingUtils.ts`.

### Learning Capture Flow

S8 ("let the model speak") deleted `hooks/lib/learning-utils.ts`'s
regex-indicator classifier (`isLearningCapture()` / `getLearningCategory()`)
— it was provably wrong in both directions (missed genuine learnings phrased
outside its keyword lists, false-positived on frustration text that happened
to hit two indicator categories with nothing resolved; see
`skills/Intelligence/Evals/Data/golden/learning-capture-fixtures.jsonl` and
`docs/decisions/015-let-the-model-speak-s8-learning-inversion.md`). There is
no longer a single "learning capture" hook — three writers now handle it,
each documented at its own seam:

```
SessionEnd
    │
    ├─► SessionRatingCapture ─► ONE inference call rates the session AND
    │       (detached worker)    extracts `learnings: [{summary, category,
    │                            evidence}]` from the SAME call ─► writes
    │                            MEMORY/LEARNING/<SYSTEM|ALGORITHM>/<yearMonth>/*.md
    │                            (zero files is the common case — most
    │                            sessions have no genuine learning)
UserPromptSubmit
    │
    └─► ExplicitRatingCapture ─► rating < 6 ─► writes an UNCATEGORIZED
            learning file synchronously (same deferred-category rationale:
            this hook has a <50ms budget and zero external API calls today;
            a per-turn inference call just to categorize would blow that
            budget on every low-rating turn).

Manual (batch CLI, not a hook)
    │
    └─► lib/core/SessionHarvester.ts ─► retroactively mines arbitrary past
            sessions under ~/.claude/projects/ — makes its OWN inference
            call per session using the SAME LEARNING_JUDGMENT_CRITERIA +
            LearningItemSchema from lib/core/LearningJudgment.ts (not a
            per-turn/per-session hook, so a real per-session LLM call is
            affordable here).
```

`lib/core/LearningJudgment.ts` is the one place the judgment criteria, the
`LearningItem` shape, and the shared `UNCATEGORIZED` literal live, so the two
writers that DO call an LLM (SessionRatingCapture, SessionHarvester) stay
aligned, and the one that deliberately doesn't (ExplicitRatingCapture) writes
the neutral value instead of drifting into a different placeholder string.

### Security Validation Flow

```
PreToolUse (Bash/Edit/Write/Read)
    │
    ▼
SecurityValidator ─► patterns.yaml
    │
    ├─► {continue: true} ──────────────► Tool executes
    │
    ├─► {decision: "ask", message} ────► User prompted
    │
    └─► exit(2) ───────────────────────► Hard block

All events logged to: MEMORY/SECURITY/security-events.jsonl
```

---

## Data Flow Diagrams

### Memory System Integration

```
┌───────────────────────────────────────────────┐
│                   MEMORY/                     │
├────────────────────────┬──────────────────────┤
│      LEARNING/         │      STATE/          │
│  SIGNALS/ratings.jsonl │  (agent outputs,     │
│  UNCATEGORIZED/        │   background agents) │
│  SYSTEM|ALGORITHM/     │                      │
└───────────▲────────────┴──────────▲───────────┘
            │                       │
┌───────────┴───────────────────────┴───────────┐
│                     HOOKS                     │
│                                               │
│  ExplicitRatingCapture ──► ratings.jsonl +    │
│                            LEARNING/UNCATEGORIZED/ │
│  SessionRatingCapture ───► ratings.jsonl +    │
│                            LEARNING/SYSTEM|ALGORITHM/ │
│  AgentOutputCapture ─────► STATE/             │
│  BackgroundAgentStarted ─► STATE/             │
│  StopFailure ────────────► LEARNING/FAILURES/ │
└───────────────────────────────────────────────┘
```

---

## Shared Libraries

Located in `hooks/lib/`:

| Library | Purpose | Used By |
|---------|---------|---------|
| `identity.ts` | Get DA name, principal from settings | Most hooks |
| `time.ts` | PST timestamps, ISO formatting | Rating hooks |
| `paths.ts` | Canonical path construction | Security, rating hooks |
| `notifications.ts` | Voice server + ntfy integration | Alert helpers |
| `observability.ts` | Trace emitting | Future use |
| `metadata-extraction.ts` | Parse assistant responses | Rating hooks |
| `recovery-types.ts` | Recovery journal types | Security system |

`hooks/lib/learning-utils.ts` (regex-based `isLearningCapture()`/
`getLearningCategory()`) was deleted 2026-07 (S8, let-the-model-speak) — see
[Learning Capture Flow](#learning-capture-flow) and
[`lib/core/LearningJudgment.ts`](../lib/core/LearningJudgment.ts), which now
holds the shared LLM judgment criteria and the `UNCATEGORIZED` deferred-category
literal.

---

## Configuration

Hooks are configured in `settings.json` under the `hooks` key:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "${KAYA_DIR}/hooks/LoadContext.hook.ts" }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "${KAYA_DIR}/hooks/SecurityValidator.hook.ts" }
        ]
      }
    ]
  }
}
```

### Matcher Patterns

For `PreToolUse` hooks, matchers filter by tool name:
- `"Bash"` - Matches Bash tool calls
- `"Edit"` - Matches Edit tool calls
- `"Write"` - Matches Write tool calls
- `"Read"` - Matches Read tool calls (PostToolUse only in the current config)

---

## Documentation Standards

### Hook File Structure

Every hook MUST follow this documentation structure:

```typescript
#!/usr/bin/env bun
/**
 * HookName.hook.ts - [Brief Description] ([Event Type])
 *
 * PURPOSE:
 * [2-3 sentences explaining what this hook does and why it exists]
 *
 * TRIGGER: [Event type, e.g., UserPromptSubmit]
 *
 * INPUT:
 * - [Field]: [Description]
 * - [Field]: [Description]
 *
 * OUTPUT:
 * - stdout: [What gets injected into context, if any]
 * - exit(0): [Normal completion]
 * - exit(2): [Hard block, for security hooks]
 *
 * SIDE EFFECTS:
 * - [File writes]
 * - [External calls]
 * - [State changes]
 *
 * INTER-HOOK RELATIONSHIPS:
 * - DEPENDS ON: [Other hooks this requires]
 * - COORDINATES WITH: [Hooks that share data/state]
 * - MUST RUN BEFORE: [Ordering constraints]
 * - MUST RUN AFTER: [Ordering constraints]
 *
 * ERROR HANDLING:
 * - [How errors are handled]
 * - [What happens on failure]
 *
 * PERFORMANCE:
 * - [Blocking vs async]
 * - [Typical execution time]
 * - [Resource usage notes]
 */

// Implementation follows...
```

### Inline Documentation

Functions should have JSDoc comments explaining:
- What the function does
- Parameters and return values
- Any side effects
- Error conditions

### Update Protocol

When modifying ANY hook:

1. Update the hook's header documentation
2. Update this README's Hook Registry section
3. Update Inter-Hook Dependencies if relationships change
4. Update Data Flow Diagrams if data paths change
5. Test the hook in isolation AND with related hooks

---

## Maintenance Checklist

Use this checklist when adding or modifying hooks:

### Adding a New Hook

- [ ] Create hook file with full documentation header
- [ ] Add to `settings.json` under appropriate event
- [ ] Add to Hook Registry table in this README
- [ ] Document inter-hook dependencies
- [ ] Update Data Flow Diagrams if needed
- [ ] Add to shared library imports if using lib/
- [ ] Test hook in isolation
- [ ] Test hook with related hooks
- [ ] Verify no performance regressions

### Modifying an Existing Hook

- [ ] Update inline documentation
- [ ] Update hook header if behavior changes
- [ ] Update this README if interface changes
- [ ] Update inter-hook docs if dependencies change
- [ ] Test modified hook
- [ ] Test hooks that depend on this hook
- [ ] Verify no performance regressions

### Removing a Hook

- [ ] Remove from `settings.json`
- [ ] Remove from Hook Registry in this README
- [ ] Update inter-hook dependencies
- [ ] Update Data Flow Diagrams
- [ ] Check for orphaned shared state files
- [ ] Delete hook file
- [ ] Test related hooks still function

---

## Troubleshooting

### Hook Not Executing

1. Verify hook is in `settings.json` under correct event
2. Check file is executable: `chmod +x hook.ts`
3. Check shebang: `#!/usr/bin/env bun`
4. Run manually: `echo '{"session_id":"test"}' | bun hooks/HookName.hook.ts`

### Hook Blocking Session

1. Check if hook writes to stdout (only hooks documented as "Yes (stdout)" in the registry tables above should)
2. Verify timeouts are set for external calls
3. Check for infinite loops or blocking I/O

### Security Validation Issues

1. Check `patterns.yaml` for matching patterns
2. Review `MEMORY/SECURITY/security-events.jsonl` for logs
3. Test pattern matching: `bun hooks/SecurityValidator.hook.ts < test-input.json`

---

*Last updated: 2026-09-29*
*Hook commands: 18 | Events: 8*
