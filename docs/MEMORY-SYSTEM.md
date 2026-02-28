# Memory System Design

This document describes the full memory feedback loop in the Kaya AI assistant. The memory system creates continuity across sessions that would otherwise start from zero — each Claude Code session gets a warm context load derived from previous interactions.

---

## Architecture Overview

The memory system operates as a four-stage feedback loop:

```
[Session] → Capture → Store → Synthesize → Load → [Session]
              ↓           ↓         ↓          ↓
           Hooks      JSONL     Patterns   ContextRouter
```

**Core Principle:** All memory is append-only. Hooks write to JSONL logs. A synthesis pass aggregates logs into patterns. The ContextRouter loads patterns into each new session.

---

## Stage 1: Ratings Captured

The `ExplicitRatingCapture` and `ImplicitSentimentCapture` hooks fire on `UserPromptSubmit` events. They detect explicit ratings (user types "8/10") and implicit sentiment (frustration, satisfaction indicators) and write events to JSONL logs.

### Rating Event Schema

Each explicit rating capture produces one line in `MEMORY/LEARNING/SIGNALS/ratings.jsonl`:

```jsonl
{"timestamp":"2026-02-28T07:00:00Z","session_id":"202602280700_abc123","event_type":"explicit_rating","rating":8,"max_rating":10,"context_summary":"Fixed auth bug in JobEngine skill","category":"code_quality","skill_referenced":"JobEngine","hook":"ExplicitRatingCapture"}
{"timestamp":"2026-02-28T08:15:00Z","session_id":"202602280815_def456","event_type":"explicit_rating","rating":9,"max_rating":10,"context_summary":"Daily briefing was well-organized","category":"briefing_quality","skill_referenced":"DailyBriefing","hook":"ExplicitRatingCapture"}
```

**Schema:**

| Field | Type | Description |
|-------|------|-------------|
| `timestamp` | ISO 8601 string | When the rating was captured |
| `session_id` | string | Unique session identifier |
| `event_type` | `"explicit_rating"` | Always this value for ratings |
| `rating` | integer | The rating value (typically 1-10) |
| `max_rating` | integer | Maximum possible rating (typically 10) |
| `context_summary` | string | What task was being rated |
| `category` | string | Work category (code_quality, briefing, research, etc.) |
| `skill_referenced` | string \| null | Which skill was active, if any |
| `hook` | string | Which hook captured this signal |

### Sentiment Signal Schema

Implicit sentiment is captured in `MEMORY/LEARNING/SIGNALS/context-feedback.jsonl`:

```jsonl
{"timestamp":"2026-02-28T07:30:00Z","session_id":"202602280700_abc123","event_type":"implicit_sentiment","sentiment":"positive","confidence":0.85,"trigger_phrase":"that worked perfectly","inferred_category":"task_completion","context_window_summary":"Deployed new skill successfully","hook":"ImplicitSentimentCapture"}
{"timestamp":"2026-02-28T09:00:00Z","session_id":"202602280900_ghi789","event_type":"implicit_sentiment","sentiment":"negative","confidence":0.72,"trigger_phrase":"this keeps failing","inferred_category":"debugging_friction","context_window_summary":"Type errors in TypeScript build","hook":"ImplicitSentimentCapture"}
```

**Schema:**

| Field | Type | Description |
|-------|------|-------------|
| `timestamp` | ISO 8601 string | When the sentiment was detected |
| `session_id` | string | Unique session identifier |
| `event_type` | `"implicit_sentiment"` | Always this value |
| `sentiment` | `"positive"` \| `"negative"` \| `"neutral"` | Detected sentiment |
| `confidence` | float 0.0–1.0 | Model confidence in sentiment classification |
| `trigger_phrase` | string | The phrase that triggered detection |
| `inferred_category` | string | What domain this sentiment relates to |
| `context_window_summary` | string | Brief summary of what was happening |
| `hook` | string | Which hook captured this signal |

---

## Stage 2: Sentiment Inferred

Between sessions, the `ContinualLearning` skill runs a sentiment inference pass over raw JSONL signals. It reads `ratings.jsonl` and `context-feedback.jsonl` and produces inferred behavioral patterns.

The inference step:
1. Groups signals by `category` and `skill_referenced`
2. Computes rolling average ratings per category (30-day window)
3. Detects sentiment trends (improving, declining, stable)
4. Tags patterns with confidence scores

### Inferred Pattern Schema

Inferred patterns are written to `MEMORY/LEARNING/ALGORITHM/patterns.jsonl`:

```jsonl
{"pattern_id":"ptn_2026022801","created_at":"2026-02-28T06:00:00Z","pattern_type":"preference","category":"code_quality","description":"User rates TypeScript type safety improvements 8-9/10 consistently","supporting_signals":3,"confidence":0.88,"relevance_score":0.91,"tags":["typescript","quality","code"],"actionable_guidance":"Prioritize type safety. Avoid any-casting. Surface type errors proactively."}
{"pattern_id":"ptn_2026022802","created_at":"2026-02-28T06:00:00Z","pattern_type":"friction","category":"debugging_friction","description":"User expresses frustration when debugging takes more than 2 back-and-forth turns","supporting_signals":5,"confidence":0.79,"relevance_score":0.84,"tags":["debugging","efficiency"],"actionable_guidance":"Lead with root cause identification. Provide one targeted fix per response."}
```

**Schema:**

| Field | Type | Description |
|-------|------|-------------|
| `pattern_id` | string | Unique pattern identifier |
| `created_at` | ISO 8601 string | When pattern was synthesized |
| `pattern_type` | `"preference"` \| `"friction"` \| `"workflow"` | Pattern category |
| `category` | string | Domain this pattern applies to |
| `description` | string | Human-readable pattern description |
| `supporting_signals` | integer | Number of JSONL events that support this pattern |
| `confidence` | float 0.0–1.0 | Synthesis confidence |
| `relevance_score` | float 0.0–1.0 | Current relevance (decays over time) |
| `tags` | string[] | Searchable tags |
| `actionable_guidance` | string | What Kaya should do differently based on this pattern |

---

## Stage 3: Patterns Synthesized

The `ContinualLearning` skill synthesizes raw signals into patterns using a multi-pass aggregation:

**Pass 1 — Deduplication:** Merge signals from the same session that reference the same skill and category.

**Pass 2 — Trend Detection:** Compare current 7-day rolling average against the 30-day baseline. Flag categories with >15% delta.

**Pass 3 — Pattern Generation:** For each significant trend or stable preference, generate a pattern record with `actionable_guidance`.

**Pass 4 — Relevance Scoring:** Apply the relevance scoring algorithm (see below) to rank patterns by current usefulness.

**Pass 5 — Pruning:** Remove patterns with `relevance_score < 0.20` and `supporting_signals < 2`.

Synthesis runs:
- Automatically: after sessions that generate 3+ signals
- On demand: `bun run ~/.claude/skills/ContinualLearning/Tools/Synthesize.ts`

---

## Stage 4: Context Loaded per Session

On `SessionStart`, the `LoadContext` hook triggers the ContextRouter to load relevant patterns into the session context window.

### Loading Process

1. Read all patterns from `MEMORY/LEARNING/ALGORITHM/patterns.jsonl`
2. Score each pattern using the relevance scoring algorithm
3. Sort by `relevance_score` descending
4. Select top-N patterns that fit within the context budget (typically 5-8 patterns, ~500 tokens)
5. Format patterns as a "Behavioral Guidance" block injected into `CLAUDE.md` for this session

### Session Context Schema

The loaded context block written to the session:

```jsonl
{"session_id":"202602281000_xyz001","loaded_at":"2026-02-28T10:00:00Z","patterns_available":12,"patterns_loaded":6,"context_tokens_used":487,"patterns":[{"pattern_id":"ptn_2026022801","relevance_score":0.91,"actionable_guidance":"Prioritize type safety. Avoid any-casting."},{"pattern_id":"ptn_2026022802","relevance_score":0.84,"actionable_guidance":"Lead with root cause identification."}]}
```

---

## Relevance Scoring Algorithm

Patterns are scored to determine which ones are most useful to load into the current session.

### Inputs

| Input | Type | Range | Description |
|-------|------|-------|-------------|
| `signal_strength` | float | 0.0–1.0 | Average confidence of supporting signals |
| `frequency_count` | integer | 1–∞ | Number of supporting signals |
| `days_since_last_signal` | integer | 0–∞ | Days since most recent supporting signal |
| `category_match_score` | float | 0.0–1.0 | How well pattern category matches current session intent |
| `pattern_type_weight` | float | 0.0–1.0 | `preference=1.0`, `workflow=0.8`, `friction=0.9` |

### Output

| Output | Type | Range | Description |
|--------|------|-------|-------------|
| `relevance_score` | float | 0.0–1.0 | How relevant this pattern is to load right now |

### Formula

```
recency_decay = exp(-0.05 * days_since_last_signal)

frequency_factor = min(1.0, log(frequency_count + 1) / log(10))

relevance_score = (
    signal_strength * 0.30 +
    recency_decay   * 0.35 +
    frequency_factor * 0.20 +
    category_match_score * 0.15
) * pattern_type_weight
```

**Pseudocode:**

```typescript
function computeRelevanceScore(pattern: Pattern, sessionIntent: string): number {
  const recencyDecay = Math.exp(-0.05 * pattern.daysSinceLastSignal);
  const frequencyFactor = Math.min(1.0, Math.log(pattern.supportingSignals + 1) / Math.log(10));
  const categoryMatch = computeCategoryMatch(pattern.category, sessionIntent);
  const typeWeight = { preference: 1.0, friction: 0.9, workflow: 0.8 }[pattern.patternType];

  return (
    pattern.confidence * 0.30 +
    recencyDecay * 0.35 +
    frequencyFactor * 0.20 +
    categoryMatch * 0.15
  ) * typeWeight;
}
```

**Worked Example:**

Pattern: "User rates TypeScript improvements 8-9/10"
- `signal_strength = 0.88`, `frequency_count = 3`, `days_since_last_signal = 2`, `category_match_score = 0.95`, `pattern_type_weight = 1.0` (preference)
- `recency_decay = exp(-0.05 * 2) = 0.905`
- `frequency_factor = log(4) / log(10) = 0.602`
- `relevance_score = (0.88*0.30 + 0.905*0.35 + 0.602*0.20 + 0.95*0.15) * 1.0`
- `= (0.264 + 0.317 + 0.120 + 0.143) = 0.844`

This pattern scores 0.844 and would be included in the context load.

---

## JSONL vs Database Tradeoffs

### Why JSONL (Chosen Approach)

The memory system uses append-only JSONL files rather than a database. This decision is documented in [ADR-002: Memory Persistence](decisions/002-memory-persistence.md).

**JSONL Advantages:**

| Property | JSONL | SQLite | Redis |
|----------|-------|--------|-------|
| Git-trackable | ✅ Yes — diff shows every signal | ❌ Binary format | ❌ Not git-tracked |
| Zero infrastructure | ✅ Plain files | ✅ Embedded | ❌ Requires server |
| Human-debuggable | ✅ Open in any editor | ⚠️ Requires sqlite3 CLI | ❌ Requires redis-cli |
| Concurrent writes | ✅ Append-only is safe | ⚠️ WAL mode needed | ✅ Atomic operations |
| Schema evolution | ✅ Add fields freely | ⚠️ Migrations required | ⚠️ Key structure changes |
| Query performance | ⚠️ Linear scan | ✅ Indexed queries | ✅ O(1) key lookup |
| Corruption recovery | ✅ Truncate bad line | ⚠️ Backup + restore | ⚠️ AOF replay |

**Key Tradeoff: Query Performance**

JSONL requires linear scans for synthesis. For a system with 1,000+ signals (after months of use), this costs ~50ms per synthesis run. This is acceptable because:
- Synthesis runs infrequently (not in the hot path)
- Signal files are small (<5MB for a year of signals)
- No complex joins are needed

If the system were to support multiple users or real-time analytics, SQLite would be the correct choice.

**Key Tradeoff: Append Safety**

JSONL append operations are atomic at the OS level for files < the OS page size (4KB). Each signal event is a single JSON line, typically < 500 bytes. This means concurrent hooks writing signals will not corrupt each other's writes — they will simply append sequential lines.

**Key Tradeoff: Git Visibility**

The most underrated benefit: when signals are written to JSONL, `git diff` shows exactly what Kaya learned from each session. This makes the memory system fully auditable and reversible — if a bad pattern is learned, it can be removed with a line deletion commit.

### When to Migrate to SQLite

Consider migrating to SQLite when:
1. Synthesis scans exceed 500ms (signals file > 50MB)
2. You need to query patterns by multiple dimensions simultaneously
3. You need full-text search over pattern descriptions
4. You're running multi-user deployments

The migration path is straightforward: import all JSONL lines into a SQLite table, then switch the synthesis script to use SQL queries.
