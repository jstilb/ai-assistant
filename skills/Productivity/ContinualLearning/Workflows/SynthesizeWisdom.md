# SynthesizeWisdom Workflow

Synthesize crystallized behavioral Wisdom Frames from the feedback corpus and failure packages.

**Trigger:** `synthesize-wisdom`, weekly AutoInfoManager run
**Schedule:** Weekly (via AutoInfoManager weekly tier)
**Duration:** < 5 minutes (best-effort, runs offline)
**CLI:** `invoke ContinualLearning synthesize-wisdom`

## Purpose

Read all feedback signals and failure packages, extract recurring behavioral patterns,
score confidence, and write/update Wisdom Frames in `MEMORY/WISDOM/FRAMES/`.

Frames are injected at session start via `LoadContext.hook.ts` when `settings.wisdom.enabled: true`.

## Input Sources

| Source | Path | Format |
|--------|------|--------|
| Session ratings | `MEMORY/LEARNING/SIGNALS/ratings.jsonl` | JSONL |
| Context feedback | `MEMORY/LEARNING/SIGNALS/context-feedback.jsonl` | JSONL |
| Failure packages | `MEMORY/LEARNING/FAILURES/**/*.md` | Markdown |
| Estimation accuracy | `MEMORY/LEARNING/SIGNALS/estimation-accuracy.jsonl` | JSONL |
| Existing frames | `MEMORY/WISDOM/FRAMES/*.md` | Markdown with YAML frontmatter |
| CLAUDE.md rules | `CLAUDE.md` | Markdown |

## Execution Steps

### Step 1: Load Corpus

1. Read all entries from `ratings.jsonl` and `context-feedback.jsonl`
2. Read all `analysis.md` files from `MEMORY/LEARNING/FAILURES/` subdirectories
3. Load existing frames from `MEMORY/WISDOM/FRAMES/` (for incremental merge)
4. Count total sessions for percentage calculations

### Step 2: Pattern Extraction

- Use `KnowledgeSynthesizer.ts` to identify recurring signals
- Minimum threshold: pattern appears in ≥5% of total sessions
- Recency weighting: sessions from last 30 days count 2x

**Estimation accuracy sub-step:**
- Read `estimation-accuracy.jsonl` and calculate current median ratio across all entries
- If count >= 10 entries, update the `estimation-calibration` Wisdom Frame with:
  - The actual median ratio (e.g., "Kaya overestimates by 1.7x on average")
  - Updated guidance based on the ratio (e.g., if ratio is 1.7x, add "Divide your initial estimate by 1.7 before presenting")
  - Updated `source_count` and `confidence` (increases as data accumulates, capped at 95)

```
raw_confidence = (occurrence_count / total_sessions) * 100
recency_factor = (recent_count / occurrence_count) * 0.5 + 0.5
final_confidence = raw_confidence * recency_factor
```

### Step 3: CLAUDE.md Conflict Check

Before writing any frame, verify it does NOT contradict CLAUDE.md explicit rules:
- Read `CLAUDE.md` and extract explicit behavioral rules
- If a candidate frame body contradicts an explicit rule: log warning, skip frame
- If frame is redundant with CLAUDE.md (already stated): skip frame

**This guard ensures Wisdom Frames only extend, never contradict, CLAUDE.md.**

### Step 4: Frame Generation / Update

For each pattern with `final_confidence >= 85`:
1. Generate frame body via `echo "prompt" | bun ~/.claude/tools/Inference.ts standard`
2. Create or overwrite `MEMORY/WISDOM/FRAMES/{slug}.md` with proper frontmatter
3. Frame format:
   ```
   ---
   pattern: "{Pattern Name}"
   confidence: {N}
   first_seen: {YYYY-MM-DD}
   last_updated: {YYYY-MM-DD}
   source_count: {N}
   category: {user-preferences|failure-patterns|tool-usage|context-loading}
   ---

   ### {Pattern Name} [CRYSTAL: {N}%]

   {1-3 sentence behavioral rule, declarative, present tense}

   **Evidence:** {N} sessions, avg rating X.X when adhered to; avg rating Y.Y when violated.
   **Applies to:** {profile list or "All profiles"}.
   ```

For patterns with `70 <= final_confidence < 85`:
- Create frame file but mark header as `[CANDIDATE: N%]` (not loaded at session start)

For patterns with `final_confidence < 70` where a frame file exists:
- Delete frame file (pattern demoted below threshold)

### Step 5: Log Synthesis Report

Write summary to stderr:
```
[ContinualLearning:synthesize-wisdom] N frames created, N updated, N demoted, N skipped (conflict)
```

## Output

| Output | Path | Format |
|--------|------|--------|
| Wisdom Frame files | `MEMORY/WISDOM/FRAMES/{slug}.md` | Markdown with YAML frontmatter |

## Guards & Safety

- **Never write frames that contradict CLAUDE.md** — conflict check is mandatory (Step 3)
- **Confidence gate (85%)** — only high-signal patterns become injectable frames
- **Non-blocking** — synthesis failure never blocks sessions
- **Incremental** — only updates frames whose confidence changed; doesn't rewrite unchanged frames

## Integration

- Weekly AutoInfoManager run: `invoke ContinualLearning synthesize-wisdom`
- AutoInfoManager schedule entry:
  ```yaml
  weekly:
    - name: "Wisdom Frame Synthesis"
      command: "invoke ContinualLearning synthesize-wisdom"
      timeout: 300s
  ```
- Synthesized frames are immediately available at next session start (loaded by `LoadContext.hook.ts`)
