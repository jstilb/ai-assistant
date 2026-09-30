# SignalClassification Workflow Prompt

Classify the sentiment category of a mid-band implicit signal (rating 4–7) to determine if it qualifies as a learning signal.

## Context

Called by `SignalQualityGate.evaluate()` when a signal is:
- `source === "implicit"` AND `rating` between 4 and 7 (inclusive)

Deterministic paths (explicit ratings, rating ≤ 3, rating ≥ 8) bypass this prompt entirely.

## Inference Parameters

| Parameter      | Value       |
|----------------|-------------|
| `level`        | `standard`  |
| `expectJson`   | `true`      |
| Timeout        | default     |
| Fallback       | keyword-based `_classifySignalFallback()` |

## System Prompt

```
Classify the sentiment of this user interaction summary. Return JSON.
```

## User Prompt Template

```
Sentiment summary: "{sentiment_summary}"

Classify as: "correction" (user corrected/fixed something, expressed frustration), "praise" (user expressed satisfaction/approval), or "neutral" (routine interaction, no clear sentiment).
```

**Variables:**
- `{sentiment_summary}` — the `sentiment_summary` field from the `RawSignal`

## Response Schema

```json
{
  "category": "correction" | "praise" | "neutral",
  "reasoning": "string"
}
```

Validated via `SignalClassificationSchema` (Zod):
```typescript
z.object({
  category: z.enum(["correction", "praise", "neutral"]),
  reasoning: z.string(),
})
```

## Routing Logic

| `category`    | Signal qualifies? |
|---------------|-------------------|
| `"correction"` | YES — passes through as `QualifiedSignal` |
| `"praise"`     | YES — passes through as `QualifiedSignal` |
| `"neutral"`    | NO — returns `null` (rejected as noise) |

## Fallback Behavior

If inference fails (exception, parse error, or schema mismatch), `_classifySignalFallback()` runs keyword matching:
- Correction keywords: `corrected, correction, corrects, wrong, mistake, error, fix, fixed, redo, retry, incorrect, bad, worse`
- Praise keywords: `praised, praise, great, excellent, perfect, love, loved, amazing, awesome, well done, nice, quick, helpful`
- Neutral patterns (regex): `neutral command`, `no sentiment`, `direct task`, `baseline capture`
- Default if no match: `"neutral"` (rejected)

## Implementation Location

`skills/Productivity/ContinualLearning/Tools/SignalQualityGate.ts` — `SignalQualityGate.evaluate()`, mid-band branch (~line 93)
