# MEMORY/LEARNING -- Learning Signal Pipeline

> This directory stores the learning feedback loop data. Excluded from the
> public repository as it contains personal interaction patterns.

## Purpose

The learning subsystem captures explicit ratings (user says "8/10") and implicit sentiment (detected from conversation tone), then synthesizes these into actionable patterns that improve future responses.

## Structure

```
LEARNING/
  SIGNALS/
    ratings.jsonl              # Explicit user ratings (1-10 scale)
    context-feedback.jsonl     # Context relevance feedback
  ALGORITHM/
    2026-02/                   # Monthly synthesis output
      2026-02-15_LEARNING_improved-code-review.md
      2026-02-18_LEARNING_sentiment-rating-8.md
  SYSTEM/
    2026-02/                   # System-level learnings
      2026-02-20_LEARNING_hook-performance.md
```

## Signal Flow

```
User Interaction
  |
  v
ExplicitRatingCapture.hook.ts  -->  ratings.jsonl
ImplicitSentimentCapture.hook.ts  -->  ratings.jsonl
ContextFeedback.hook.ts  -->  context-feedback.jsonl
  |
  v
ContinualLearning skill  -->  ALGORITHM/2026-02/*.md
  |
  v
ContextRouter loads patterns into next session
```

## Example Rating Signal

```json
{
  "timestamp": "2026-02-20T14:30:00Z",
  "rating": 8,
  "type": "explicit",
  "context": "code-review",
  "session_id": "abc-123",
  "message_index": 5
}
```

## Example Synthesized Learning

```markdown
# Learning: Improved Code Review Approach

**Date:** 2026-02-15
**Signal Count:** 12
**Average Rating:** 8.5

## Pattern
When reviewing TypeScript code, providing inline suggestions with
before/after comparisons receives higher ratings than abstract feedback.

## Recommended Action
Always include concrete code examples in review feedback.
```
