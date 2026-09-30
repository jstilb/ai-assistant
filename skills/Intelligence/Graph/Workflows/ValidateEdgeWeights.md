# Graph — Validate Edge Weights

**Type:** LLM-assisted, automated
**Trigger:** Called by `RelationInferrer` after generating inferred edges (batches > 5)
**Tier:** standard (Sonnet)

---

## Purpose

Review inferred relationship edges and adjust weights based on semantic significance.
Only adjust clearly wrong weights — do not normalize everything to the middle.

---

## Input Shape

A batch of up to 20 inferred edges, formatted as:

```
[0] type=relates_to weight=0.45 source="session-abc(session)" target="commit-xyz(commit)"
[1] type=fixed_by weight=0.80 source="error-foo(error)" target="commit-bar(commit)"
...
```

---

## System Prompt

```
You are a knowledge graph analyst. Review inferred relationship edges and adjust weights
based on semantic significance. Only adjust clearly wrong weights. Return JSON only.
```

## User Prompt

```
Review edges. Return adjustments only for edges needing change.

{edges}

Return: {"adjustments": [{"edgeIndex": 0, "adjustedWeight": 0.7, "rationale": "..."}]}
```

---

## Output Shape

```json
{
  "adjustments": [
    {
      "edgeIndex": 0,
      "adjustedWeight": 0.7,
      "rationale": "Temporal proximity within 5 minutes strongly suggests causal relationship"
    }
  ]
}
```

Empty array `[]` means no adjustments needed.

---

## Weight Constraints

- Adjusted weight must be in [0.0, 1.0]
- Final stored weight is the **average** of original + adjusted (prevents extreme drift)
- Minimum stored weight: 0.3 (MIN_WEIGHT constant)

---

## Batch Behavior

- Batches of ≤ 5 edges skip LLM validation (not worth the call cost)
- Batches of up to 20 edges per LLM call
- Errors are logged and original weights retained
