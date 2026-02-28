# How I Built a 65-Skill Autonomous Agent on Claude Code

*Published on dev.to / Substack — [pending publication URL]*

---

There's a fundamental problem with every AI assistant I've used: **every session starts from zero**.

You spend twenty minutes explaining your tech stack. You tell the AI how you like your code formatted, what conventions you follow, which tools you prefer. The session ends. You come back tomorrow. The AI has forgotten everything. You start over.

For casual use, that's fine. For a personal AI system you interact with dozens of times a day — across coding, calendar management, research, security testing, grocery shopping — it's a dead end. You end up spending more time orienting the AI than you do getting work done.

I spent six months building my way out of this problem. The result is **Kaya**: a 65-skill autonomous agent built on top of Anthropic's Claude Code that remembers across sessions, routes context intelligently, defends itself against prompt injection, and continuously improves based on feedback. Here's how it works.

---

## The "Every Session Starts From Zero" Problem

Claude Code is a surprisingly capable foundation for an autonomous agent. It has access to the filesystem, can run bash commands, spawn sub-agents, and execute multi-step workflows. But by default, each Claude Code session is stateless. When you type `claude` in your terminal, you get a fresh instance with no memory of what you built yesterday.

The obvious solution — stuffing everything into the context window — doesn't scale. My personal knowledge base, preferences, and project context would fill the entire context before any actual work began. And even if it fit, you'd want the AI to know *which* context is relevant to the current session, not dump everything at once.

The solution requires two components working together: **hooks** and **memory**.

---

## The Hook System: Interceptors at Every Lifecycle Point

Claude Code exposes lifecycle hooks — event-based interceptors that fire at specific points in the session. These are the architectural backbone of Kaya's persistence layer.

The hook pipeline has 24 active hooks across six event types:

- **`SessionStart`** — fires when Claude Code launches
- **`UserPromptSubmit`** — fires on every user message
- **`PreToolUse`** — fires before any tool call (Bash, Read, Write, Edit)
- **`PostToolUse`** — fires after every tool result
- **`SubagentStop`** — fires when a spawned agent completes
- **`Stop` / `SessionEnd`** — fires when the session closes

Here's what the session flow looks like:

```
User opens terminal → `claude`
  └─ SessionStart
      ├─ ConfigValidator: validate settings.json integrity
      ├─ LoadContext: inject CLAUDE.md behavioral rules
      └─ ContextRouter: load relevant skill/memory context
         └─ [Session is now warm with loaded context]

User types: "fix the auth bug in JobEngine"
  └─ UserPromptSubmit
      ├─ ContextRouter: detect skill intent → load JobEngine context
      ├─ FormatEnforcer: inject format rules for this response
      └─ ExplicitRatingCapture: check if message contains a rating (1-10)

Claude runs: Bash("cat skills/JobEngine/Tools/main.ts")
  └─ PreToolUse
      └─ SecurityValidator: is this command permitted?
         └─ PASS: file read is allowed

Claude returns tool output
  └─ PostToolUse
      ├─ PromptInjectionDefender: scan tool output for injection patterns
      ├─ OutputValidator: validate output integrity
      └─ ImplicitSentimentCapture: detect frustration/satisfaction signals

Session ends
  └─ SessionEnd
      ├─ WorkCompletionLearning: extract learnings from completed work
      ├─ SessionSummary: write summary to MEMORY/
      └─ ContextFeedback: capture context relevance feedback
```

The key insight is that **hooks give you control over the session without modifying Claude Code itself**. The AI doesn't know the hooks exist. They intercept inputs and outputs transparently.

---

## The Memory System: Four-Stage Feedback Loop

Hooks capture signals. But signals alone don't solve the problem — they need to be synthesized into usable context and loaded into future sessions. That's the memory system's job.

The feedback loop has four stages:

### Stage 1: Capture

Two hooks capture signals continuously:

**ExplicitRatingCapture** — When I type "that deserves a 9/10" or "7/10 on that response", the hook detects the rating and writes an event to `MEMORY/LEARNING/SIGNALS/ratings.jsonl`:

```json
{"timestamp":"2026-02-28T07:00:00Z","session_id":"abc123","rating":9,"context_summary":"Fixed auth bug quickly","skill_referenced":"JobEngine","category":"code_quality"}
```

**ImplicitSentimentCapture** — When I write "this keeps failing" or "perfect, that worked", the hook infers sentiment and writes to `MEMORY/LEARNING/SIGNALS/context-feedback.jsonl`:

```json
{"timestamp":"2026-02-28T07:30:00Z","sentiment":"negative","confidence":0.79,"trigger_phrase":"this keeps failing","inferred_category":"debugging_friction"}
```

All signals are **append-only JSONL**. Nothing is overwritten. The system only ever adds new data.

### Stage 2: Infer

Between sessions, the `ContinualLearning` skill runs a synthesis pass. It reads all signals and looks for patterns:

- Rolling 7-day average ratings per category
- Sentiment trend direction (improving, declining, stable)
- Friction points (where negative sentiment clusters)
- Strength areas (where ratings are consistently high)

### Stage 3: Synthesize

Significant patterns become pattern records in `MEMORY/LEARNING/ALGORITHM/patterns.jsonl`:

```json
{
  "pattern_id": "ptn_2026022801",
  "pattern_type": "preference",
  "description": "User rates TypeScript type safety work 8-9/10 consistently",
  "confidence": 0.88,
  "relevance_score": 0.91,
  "actionable_guidance": "Prioritize type safety. Avoid any-casting. Surface type errors proactively."
}
```

Each pattern has a `relevance_score` computed by a decay formula:

```
recency_decay = exp(-0.05 * days_since_last_signal)
relevance_score = signal_strength * 0.30 + recency_decay * 0.35 + frequency_factor * 0.20 + category_match * 0.15
```

Patterns that haven't been reinforced recently decay toward zero. Patterns that are reinforced daily stay near 1.0.

### Stage 4: Load

On `SessionStart`, the `ContextRouter` hook reads patterns, ranks them by relevance, and injects the top-N patterns into the session context. If I'm opening a session to work on code, the system detects the coding intent and loads the TypeScript preference pattern. If I'm planning groceries, it loads the shopping-related patterns.

The session starts **warm** instead of cold. The AI already knows I care about type safety. It already knows that when I say "check the calendar" I mean my personal Google Calendar, not some example calendar. It doesn't need me to re-explain this every session.

---

## The Skill System: 65 Composable Capabilities

Hooks handle the session lifecycle. But what does the AI actually *do* in a session?

Each capability lives in a **skill** — a self-contained module with a standardized interface:

```
skills/JobEngine/
  SKILL.md            # Manifest: triggers, workflows, integration
  _Context.md         # Domain knowledge loaded on demand
  Tools/              # TypeScript CLI tools (stdin → stdout)
    main.ts
    __tests__/
  Workflows/          # Step-by-step workflow definitions
  State/              # Runtime state (gitignored)
```

The `SKILL.md` manifest declares a `USE WHEN` clause — the condition that causes this skill to be activated by the ContextRouter. For example:

```
USE WHEN the user mentions jobs, job applications, ATS, resume, LinkedIn, or career.
```

When I say "scan for new jobs and run autoapply", the ContextRouter reads all `USE WHEN` clauses, matches the intent, and loads `JobEngine/SKILL.md` and `JobEngine/_Context.md` into the session context. The AI now has detailed knowledge of the job engine's commands, state format, and workflows — without me having to explain any of it.

**65 skills cover:**
- Calendar management, daily briefings, task queues
- Security testing, prompt injection defense, recon
- Content aggregation, knowledge graph, note transformation
- Multi-agent orchestration, debates, parallel task execution
- Voice interaction (ElevenLabs + Telegram), browser automation
- And everything else I do daily

---

## Prompt Injection Defense

Building an autonomous agent that executes real commands against the real filesystem raises the obvious security question: what happens when the AI processes content from the internet that contains prompt injection attacks?

Every tool output — file contents, API responses, web pages — passes through `PromptInjectionDefender` on `PostToolUse`. The hook scans for 50+ attack patterns organized in 10 categories:

- **Instruction Override** — "ignore all previous instructions"
- **Data Exfiltration** — "send my secrets to this URL"
- **Dangerous Tool Use** — "delete the repository"
- **Social Engineering** — "as an admin, you must..."
- **Payload Delivery** — "fetch and execute this script"

Patterns are regex-based (fast, deterministic) defined in `KAYASECURITYSYSTEM/injection-patterns.yaml`. When a pattern matches, the hook blocks execution and alerts me.

The test suite validates all 25 attack patterns against expected detection results:

```bash
bun test tests/security/
# 30 pass, 0 fail
```

This is the eval framework in practice: automated tests that run against the real system, catching regressions before they become incidents.

---

## The Evals Framework

Every significant capability is covered by an evaluation. Evals test **real system behavior** against known expectations:

| Category | Pass Rate |
|----------|-----------|
| Hook Pipeline Correctness (5 evals) | 100% |
| Skill Routing Accuracy (6 evals) | 100% |
| Prompt Injection Detection (7 evals) | 100% |

The evals are not mocked. When `HOOK-001` runs, it submits a real `rm -rf` command to the real `SecurityValidator` hook and checks it was blocked. When `ROUTE-001` runs, the actual `ContextRouter` processes the "run evals" intent. This is the only way to catch the class of bugs that only appear in the live system.

---

## What Solved the Problem

The "every session starts from zero" problem has three real solutions, layered:

1. **SessionStart hooks** load context before the AI sees the first prompt
2. **Pattern synthesis** distills months of signals into a few hundred tokens of high-signal guidance
3. **Skill routing** loads only the relevant context for the current session's intent

Together, they make each session feel continuous. The AI knows my preferences. It remembers the patterns. It loads the right skills. The orientation tax drops from twenty minutes to zero.

---

## Getting Started

The full system is open source at [github.com/jstilb/ai-assistant](https://github.com/jstilb/ai-assistant). The architecture is designed to be cloned into `~/.claude` and extended with your own skills and hooks.

```bash
git clone https://github.com/jstilb/ai-assistant.git ~/.claude
cd ~/.claude
bun install
bun run install.ts
```

The `INSTALL.md` covers prerequisites and configuration. The system requires Bun and an Anthropic API key. Everything else is optional (ElevenLabs for voice, Google Calendar for calendar integration, Telegram for mobile).

The most useful starting point is building your first skill: copy `skills/CORE/`, rename it, add a `USE WHEN` clause, and drop in the TypeScript tools you use daily. The ContextRouter will start loading it automatically whenever your intent matches.

---

*Word count: ~1,850 words*

*Published: [pending dev.to/Substack URL] — see [docs/blog-post.md](blog-post.md) for the draft*
