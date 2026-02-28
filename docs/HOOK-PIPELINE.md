# Hook Pipeline — Technical Deep Dive

> **Audience:** Contributors and engineers who want to understand how Kaya's hook system works at the implementation level, not just how to use it.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Hook Types and Lifecycle Ordering](#hook-types-and-lifecycle-ordering)
3. [Lifecycle Sequence](#lifecycle-sequence)
4. [The Abort Mechanism](#the-abort-mechanism)
5. [PromptInjectionDefender — Internal Architecture](#promptinjectiondefender-internal-architecture)
6. [Security Hooks](#security-hooks)
7. [Worked Example: Tracing a Single Prompt Through All Hooks](#worked-example-tracing-a-single-prompt-through-all-hooks)
8. [Hook Communication Patterns](#hook-communication-patterns)
9. [Performance Budgets](#performance-budgets)

---

## Architecture Overview

The hook pipeline is Kaya's extension layer — a set of TypeScript scripts that Claude Code invokes at specific lifecycle events. Hooks intercept control flow before and after the model acts, enabling security validation, context injection, memory capture, and observability without modifying the core system.

Each hook is:
- A standalone Bun TypeScript script with a `#!/usr/bin/env bun` shebang
- Invoked as a subprocess by Claude Code at the matching lifecycle event
- Communicates via stdin (JSON payload) and stdout (JSON response or system-reminder)
- Designed to fail open — errors in one hook must not crash the session

Claude Code invokes hooks synchronously in registration order for each event. Hooks cannot communicate directly with each other at runtime; they communicate through shared state files in `MEMORY/STATE/`.

---

## Hook Types and Lifecycle Ordering

Kaya registers 23 hooks across 6 lifecycle event types. The ordering within each event matters — hooks within the same event run sequentially in registration order.

### SessionStart Hooks (3 hooks)

| Order | Hook | Purpose |
|-------|------|---------|
| 1 | `ConfigValidator` | Validates settings.json schema before any other hook runs |
| 2 | `StartupGreeting` | Displays the Kaya banner with real-time system stats (hook count, skill count, memory size) |
| 3 | `LoadContext` | Injects CORE skill context as a system-reminder (blocking — stdout injection) |
| 4 | `CheckVersion` | Compares installed Claude Code version against npm registry, notifies if stale |

### UserPromptSubmit Hooks (6 hooks)

| Order | Hook | Purpose |
|-------|------|---------|
| 1 | `ContextRouter` | Classifies user intent, selects context profile, injects budget-aware context |
| 2 | `FormatEnforcer` | Refreshes response format spec in long conversations where rules may drift |
| 3 | `AutoWorkCreation` | Creates or updates the WORK session directory for the current task |
| 4 | `ExplicitRatingCapture` | Detects explicit ratings (e.g., "8 - great work") from user messages |
| 5 | `ImplicitSentimentCapture` | Uses inference to detect emotional sentiment from conversational cues |
| 6 | `UpdateTabTitle` | Summarizes the prompt and updates the terminal tab title + announces via voice |

### PreToolUse Hooks (2 hooks, run per tool call)

| Order | Hook | Purpose |
|-------|------|---------|
| 1 | `SecurityValidator` | Validates Bash commands and file paths against security patterns — blocks or requests confirmation |
| 2 | `SetQuestionTab` | Changes terminal tab color to teal when `AskUserQuestion` tool is called |

### PostToolUse Hooks (4 hooks, run per tool result)

| Order | Hook | Purpose |
|-------|------|---------|
| 1 | `QuestionAnswered` | Resets teal tab state after `AskUserQuestion` completes |
| 2 | `OutputValidator` | Validates tool output integrity (format, schema, size constraints) |
| 3 | `CommitWorkReminder` | Reminds to commit after significant code changes accumulate |
| 4 | `PromptInjectionDefender` | Multi-layer scan of tool output for prompt injection payloads |

### Stop Hooks (1 hook)

| Order | Hook | Purpose |
|-------|------|---------|
| 1 | `StopOrchestrator` | Coordinates all completion activities: response capture, tab reset, voice announcement |

### SubagentStop Hooks (2 hooks)

| Order | Hook | Purpose |
|-------|------|---------|
| 1 | `AgentOutputCapture` | Captures sub-agent results to MEMORY/STATE for the parent session |
| 2 | `WorktreeCleanup` | Removes completed git worktrees to prevent accumulation |

### SessionEnd Hooks (4 hooks)

| Order | Hook | Purpose |
|-------|------|---------|
| 1 | `ContextFeedback` | Captures context relevance feedback for the ContextManager learning loop |
| 2 | `WorkValidator` | Validates that the work directory is complete before session closes |
| 3 | `WorkCompletionLearning` | Extracts learnings and patterns from the session for long-term memory |
| 4 | `SessionSummary` | Writes the final session summary and marks the work item as COMPLETED |

---

## Lifecycle Sequence

A complete Claude Code session with Kaya proceeds through hooks in this order:

```
Session Opens
  │
  ▼
[SessionStart]
  ├─ ConfigValidator      → validates settings schema
  ├─ StartupGreeting      → displays banner (stderr only)
  ├─ LoadContext           → injects CORE context (stdout → system-reminder)
  └─ CheckVersion         → version check (stderr only)
  │
  ▼
User sends first message
  │
  ▼
[UserPromptSubmit]
  ├─ ContextRouter        → classifies intent, injects context (stdout → system-reminder)
  ├─ FormatEnforcer       → injects format refresh if conversation is long (stdout → system-reminder)
  ├─ AutoWorkCreation     → creates WORK/<date>/<session>/ directory
  ├─ ExplicitRatingCapture→ checks for rating patterns (no output)
  ├─ ImplicitSentimentCapture → sentiment inference (no output)
  └─ UpdateTabTitle       → sets terminal tab title + voice announce
  │
  ▼
Model reasons → decides to call a tool
  │
  ▼
[PreToolUse]
  ├─ SecurityValidator    → validates command/path → {"continue": true} or {"decision": "ask", ...} or exit(2)
  └─ SetQuestionTab       → (only for AskUserQuestion) sets teal tab
  │
  ▼
Tool executes
  │
  ▼
[PostToolUse]
  ├─ QuestionAnswered     → resets tab state (if AskUserQuestion)
  ├─ OutputValidator      → validates tool output
  ├─ CommitWorkReminder   → checks if commit reminder is needed
  └─ PromptInjectionDefender → scans output for injection (exit 2 if critical)
  │
  ▼
[PreToolUse → PostToolUse cycles repeat for each tool call]
  │
  ▼
Model completes turn → produces response
  │
  ▼
[Stop]
  └─ StopOrchestrator     → response capture, tab reset, voice announcement
  │
  ▼
Session closes
  │
  ▼
[SessionEnd]
  ├─ ContextFeedback      → context relevance signal capture
  ├─ WorkValidator        → validates work directory completeness
  ├─ WorkCompletionLearning → extracts session learnings
  └─ SessionSummary       → writes summary, marks work COMPLETED
```

---

## The Abort Mechanism

Claude Code's hook protocol supports two abort mechanisms:

### Soft Block (stdout JSON)

A hook can inject a decision into Claude's reasoning by writing JSON to stdout:

```json
{"decision": "block", "reason": "Command blocked: matches catastrophic pattern 'rm -rf /'"}
```

This stops tool execution and presents the reason to the model. The model sees the block reason and can tell the user. This is used by `SecurityValidator` for `confirm`-level operations and by `PromptInjectionDefender` for `warn`-level findings.

### Hard Block (exit code 2)

A hook can unconditionally terminate the tool call by exiting with code 2:

```bash
process.exit(2);  # Hard abort — tool does not execute
```

This is used for catastrophic operations:
- `SecurityValidator`: Commands in the `blocked` category (e.g., `rm -rf /`, format commands, `DROP DATABASE`)
- `PromptInjectionDefender`: When a `critical` severity finding with confidence ≥ 0.8 is detected

**Exit code semantics:**
- `exit(0)` → Continue normally (hook succeeded, tool may proceed)
- `exit(1)` → Hook error (Claude Code treats as non-blocking warning)
- `exit(2)` → Hard block (tool execution is aborted immediately)

### Abort Trigger Path in PromptInjectionDefender

The abort path in `PromptInjectionDefender.hook.ts`:

```typescript
// Early termination: if regex found a critical + high confidence finding
const hasCriticalBlock = regexFindings.some(
  f => f.severity === "critical" && f.confidence >= 0.8
);
if (hasCriticalBlock) {
  // Skip remaining layers — we already know this is bad
  const result = decide(findings, scanTime, layersExecuted, config);
  await handleResult(result, content, toolName, sessionId, scanTime);
  return; // Exits via handleResult → process.exit(2)
}
```

If `RegexScanner` returns a critical finding with high confidence, the pipeline skips `EncodingDetector` and `StructuralAnalyzer` entirely — saving 40ms — and immediately calls `handleResult`, which calls `process.exit(2)`.

The abort path for `SecurityValidator`:

```typescript
// Hard block for catastrophic commands
if (matchesBlockedPattern(command)) {
  console.error(`[SecurityValidator] BLOCKED: ${command}`);
  process.exit(2);
}
```

---

## PromptInjectionDefender — Internal Architecture

`PromptInjectionDefender.hook.ts` is the most architecturally complex hook in the system. It implements a multi-layer scanning pipeline designed to detect prompt injection attempts in tool outputs before they reach the model.

### Design Goals

1. **Speed**: Clean content scanned in <3ms; full scan in <50ms
2. **Defense in depth**: Multiple independent layers — one bypassed layer does not mean undetected injection
3. **False-positive tolerance**: High-confidence threshold for blocks; low-confidence findings logged, not blocked
4. **Early termination**: Critical findings abort remaining layers immediately

### Component Architecture

```
PromptInjectionDefender.hook.ts (orchestrator)
    │
    ├─── ContentExtractor          [hooks/lib/pid/ContentExtractor.ts]
    │    Extracts scannable text from tool output based on tool type.
    │    For Read: file contents. For WebFetch: page body. For Bash: stdout.
    │    Returns: { text, source_type, metadata: { file_path, url } }
    │
    ├─── Layer 1: RegexScanner     [hooks/lib/pid/RegexScanner.ts]
    │    Pre-compiled RegExp patterns for known injection signatures.
    │    Categories: instruction_override, role_play, boundary_escape,
    │               data_exfiltration, system_prompt_reference.
    │    Performance: <5ms. Early-terminates pipeline on critical+high-confidence hits.
    │
    ├─── Layer 2: EncodingDetector [hooks/lib/pid/EncodingDetector.ts]
    │    Detects obfuscation techniques used to evade regex detection:
    │    - Base64-encoded instruction strings
    │    - Zero-width Unicode characters (U+200B, U+FEFF, etc.)
    │    - Homoglyph substitutions (е vs e, а vs a)
    │    - Hex-encoded payloads
    │    - URL-encoded instruction fragments
    │    Performance: <10ms.
    │
    ├─── Layer 3: StructuralAnalyzer [hooks/lib/pid/StructuralAnalyzer.ts]
    │    Analyzes document structure and language patterns:
    │    - Imperative density: ratio of imperative verbs to total words
    │    - Role-play indicators: "pretend you are", "act as", "you are now"
    │    - Boundary escape attempts: "ignore previous", "disregard above"
    │    - Context boundaries: unusual delimiter usage (----, ####, [SYSTEM])
    │    Performance: <30ms.
    │
    ├─── Layer 4: MLClassifier     [hooks/lib/pid/MLClassifier.ts]  ← DISABLED
    │    Stub for Phase 2. Not active in production. Placeholder for
    │    fine-tuned classifier inference.
    │
    └─── DecisionEngine            [hooks/lib/pid/DecisionEngine.ts]
         Aggregates findings from all layers into a single decision.
         Policy: recommended_action = f(max_severity, max_confidence, finding_count)
         Actions: "log" (silent pass), "warn" (JSON to stdout), "block" (exit 2)
```

### Scanning Pipeline Flow

```
stdin → parse JSON → extract tool output
    │
    ▼
ContentExtractor → get { text, source_type, metadata }
    │
    ├─[text.length < min_content_length]→ exit(0) fast path
    │
    ▼
RegexScanner.scan(text, toolName, config, filePath)
    │
    ├─[critical + confidence≥0.8]→ DecisionEngine → handleResult → exit(2)  ← ABORT PATH
    │
    ▼
EncodingDetector.scan(text, toolName, config, filePath)
    │
    ▼
StructuralAnalyzer.scan(text, toolName, config, filePath)
    │
    ▼
DecisionEngine.decide(allFindings, scanTime, layersExecuted, config)
    │
    ├─[block]→ formatBlockMessage → console.error → exit(2)
    ├─[warn] → formatWarning → JSON.stringify → console.log → exit(0)
    └─[log]  → logSecurityEvent → exit(0)
```

### Finding Schema

Each layer returns `ScanFinding[]`:

```typescript
interface ScanFinding {
  layer: "regex" | "encoding" | "structural" | "ml";
  category: "instruction_override" | "role_play" | "boundary_escape"
           | "data_exfiltration" | "system_prompt_reference" | "encoding_obfuscation";
  severity: "info" | "low" | "medium" | "high" | "critical";
  confidence: number;        // 0.0 – 1.0
  matched_text: string;      // The actual text that triggered the finding
  description: string;       // Human-readable explanation
  context: {
    tool: string;            // Which tool produced this output
    position: number;        // Character offset in scanned text
    surrounding: string;     // ±100 chars around the match
  };
}
```

### Decision Policy

The `DecisionEngine` applies this policy matrix:

| Max Severity | Max Confidence | Action |
|-------------|----------------|--------|
| critical    | ≥ 0.8          | block (exit 2) |
| critical    | < 0.8          | warn (JSON stdout) |
| high        | ≥ 0.7          | warn |
| high        | < 0.7          | log |
| medium      | any            | log |
| low / info  | any            | log (or skip if log_clean_scans=false) |

### Configuration

The defender reads from `hooks/prompt-injection-defender/patterns.yaml`:

```yaml
global:
  enabled: true
  min_content_length: 20      # Skip very short outputs
  max_content_length: 50000   # Truncate very long outputs
  log_clean_scans: false      # Whether to log clean results
  enable_ml_layer: false      # ML classifier disabled

tools:
  Read:
    enabled: true
    layers: ["regex", "encoding", "structural"]
    max_content_length: 50000
  Bash:
    enabled: true
    layers: ["regex", "structural"]
    max_content_length: 10000
  WebFetch:
    enabled: true
    layers: ["regex", "encoding", "structural"]
    max_content_length: 30000
```

---

## Security Hooks

### SecurityValidator (PreToolUse)

Validates every `Bash`, `Edit`, `Write`, and `Read` call against `patterns.yaml` before execution.

**Pattern categories:**
- `blocked`: Catastrophic operations — always `exit(2)` (e.g., `rm -rf /`, `dd if=/dev/zero`, `DROP TABLE`)
- `confirm`: Risky operations — `{"decision": "ask", "message": "..."}` to stdout (e.g., `git push --force`, `git reset --hard`)
- `alert`: Noteworthy operations — log and allow (e.g., `sudo`, `curl | bash`)

**File path categories:**
- `zeroAccess`: Never read or write (`~/.ssh/`, credential files)
- `readOnly`: Readable but not writable (system configs)
- `confirmWrite`: Prompt before write (important config files)
- `noDelete`: Cannot be deleted (critical system files)

### OutputValidator (PostToolUse)

Validates tool output structure and size constraints. Catches malformed output that could corrupt downstream processing. Runs before `PromptInjectionDefender` to ensure the content is well-formed before scanning.

---

## Worked Example: Tracing a Single Prompt Through All Hooks

**Scenario:** The user sends the prompt: `"Fix the authentication bug in login.ts"`

### Step 1: UserPromptSubmit fires

**ContextRouter** runs first. It reads `session_id` and the prompt from stdin:

```json
{"session_id": "sess_abc123", "prompt": "Fix the authentication bug in login.ts"}
```

`IntentClassifier` runs keyword matching: detects "fix" + "bug" + ".ts" → classifies as `development/debugging`. `ContextSelector` selects the `development` profile. Budget: 50,000 tokens. It loads `CLAUDE.md`, `hooks/README.md`, and `docs/architecture.md` (totaling ~8,200 tokens). Outputs to stdout:

```
<system-reminder>
## Dynamic Context — Development Profile
[file contents injected here]
</system-reminder>
```

**FormatEnforcer** checks `conversationTurnCount`. If < 20, skips injection (format rules are still fresh). No stdout output.

**AutoWorkCreation** detects this is a new task. Creates `MEMORY/WORK/20260228-120000_fix-auth-bug/`. Writes `META.yaml` with task title and start time. Writes `current-work.json` with the session ID and work directory path. No stdout.

**ExplicitRatingCapture** checks for rating patterns ("8", "9/10", "great: 7"). No match. No output.

**ImplicitSentimentCapture** uses inference to assess sentiment. Detects neutral/task-oriented tone. Logs to `ratings.jsonl` with inferred score. No stdout.

**UpdateTabTitle** calls inference with the prompt. Returns summary: "Fix auth bug". Sets terminal tab title via Kitty OSC sequence. Announces via VoiceServer: "Fixing authentication bug". No stdout to Claude.

### Step 2: Model Reasons and Calls Read Tool

The model decides to read `login.ts`. Claude Code fires **PreToolUse**:

```json
{
  "tool_name": "Read",
  "tool_input": {"file_path": "src/auth/login.ts"},
  "session_id": "sess_abc123"
}
```

**SecurityValidator** receives this. `tool_name` is "Read". File path `src/auth/login.ts` is checked against `zeroAccess`, `readOnly` patterns. No match. Returns `{"continue": true}` to stdout. `exit(0)`.

**SetQuestionTab** only fires for `AskUserQuestion`. Skips for `Read`. `exit(0)`.

Tool executes. `login.ts` contents are returned to the model.

### Step 3: PostToolUse fires for Read result

**QuestionAnswered** only resets state after `AskUserQuestion`. Skips. `exit(0)`.

**OutputValidator** validates the Read output: checks it's a non-empty string, within size limits. Passes. `exit(0)`.

**CommitWorkReminder** checks how many tool calls have happened since the last reminder. Below threshold. No output. `exit(0)`.

**PromptInjectionDefender** receives:

```json
{
  "tool_name": "Read",
  "tool_output": "[contents of login.ts]",
  "session_id": "sess_abc123"
}
```

`ContentExtractor` extracts the file contents and notes `file_path = "src/auth/login.ts"`. `RegexScanner` scans for injection patterns. The file contains TypeScript code — no instruction override patterns, no role-play strings. Returns 0 findings. No critical block triggered. `EncodingDetector` scans for obfuscation. No Base64 instruction strings, no zero-width characters. 0 findings. `StructuralAnalyzer` analyzes imperative density. Code has imperative verbs but in programming context, not injection context. 0 findings above threshold. `DecisionEngine.decide([], 2.1ms, ["regex", "encoding", "structural"], config)` → `{clean: true, recommended_action: "log"}`. `exit(0)` silently.

### Step 4: Model Calls Edit Tool

The model calls `Edit` with a fix. **PreToolUse** fires again. `SecurityValidator` checks the file path `src/auth/login.ts` against `confirmWrite` patterns. Not a sensitive path. Returns `{"continue": true}`. Edit executes.

**PostToolUse** fires again. `PromptInjectionDefender` scans the edit diff for injected instructions. Clean. Silent pass.

### Step 5: Model Produces Response (Stop)

**StopOrchestrator** fires. It spawns three handlers:
1. `ResponseCapture` — extracts the response text and writes to `MEMORY/WORK/20260228-120000_fix-auth-bug/RESPONSE.md`
2. Tab title reset — sets tab back to default blue
3. Voice announcement — "Done. Fixed authentication bug in login."

### Step 6: Session Ends (SessionEnd)

**ContextFeedback** — if the model used context that was injected, logs a positive signal to `context-feedback.jsonl`.

**WorkValidator** — checks `MEMORY/WORK/20260228-120000_fix-auth-bug/` exists, `META.yaml` has required fields, `RESPONSE.md` has content. All pass.

**WorkCompletionLearning** — uses inference to extract key learnings from the session: "Authentication bugs often involve null token checks in middleware". Appends to `MEMORY/LEARNING/`.

**SessionSummary** — writes final summary file, clears `current-work.json`.

**Total hooks executed: 23 hook invocations across 6 event types for a single prompt-to-response cycle.**

---

## Hook Communication Patterns

Hooks cannot call each other directly. They communicate through three mechanisms:

### 1. stdout injection (system-reminder)

Hooks that need to inject context into the model's system prompt write a `<system-reminder>` block to stdout. Claude Code appends this to the model's context before the turn begins. Only hooks registered for `UserPromptSubmit` or `SessionStart` should inject via stdout.

### 2. Shared state files

`MEMORY/STATE/current-work.json` is the canonical shared state file. AutoWorkCreation writes it; ResponseCapture, WorkValidator, and SessionSummary read it. This is the only safe IPC mechanism between hooks.

### 3. Exit codes

Exit code 2 is the universal abort signal. Any hook can abort the current operation by calling `process.exit(2)`. Claude Code respects this across all event types.

---

## Performance Budgets

| Hook | Budget | Blocking? |
|------|--------|-----------|
| ContextRouter | 500ms (inference path) | Yes (stdout) |
| FormatEnforcer | <10ms | Yes (stdout) |
| SecurityValidator | <10ms | Yes (exit code) |
| PromptInjectionDefender | <50ms | Yes (exit code) |
| UpdateTabTitle | 200ms (inference) | No (fire-and-forget) |
| SessionSummary | 1000ms (inference) | No (SessionEnd, async ok) |

Hooks that use inference (ContextRouter, ImplicitSentimentCapture, UpdateTabTitle, WorkCompletionLearning) have higher budgets because they run asynchronously relative to the model's turn.
