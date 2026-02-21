# RespondToFeedback Workflow

> **Trigger:** `canvas.layout.feedback` event received with LayoutDelta[]
> **Owner:** LayoutIntelligence
> **Priority:** P1

---

## Purpose

Process user rearrangement feedback to update learned layout preferences. When a user moves, resizes, or changes containers, the feedback-encoder on the frontend generates LayoutDelta[] that this workflow processes to strengthen or create preference entries.

---

## Steps

### 1. Receive Feedback Deltas
- Listen for `canvas.layout.feedback` events via CanvasClient
- Payload: `{ deltas: LayoutDelta[] }`
- Each delta: `{ containerId, field, from, to, timestamp }`

### 2. Determine Intent Context
- Look up the current layout's intent category (dashboard, briefing, etc.)
- Map containerId to containerType from the current layout snapshot

### 3. Process Each Delta
For each `LayoutDelta`:

- **position**: Store/reinforce position preference
  - `LayoutIntelligence.store(intentPattern, containerType, delta)`
  - New preference gets confidence 0.3
  - Existing preference gets reinforced: `conf += (1 - conf) * 0.3`

- **size**: Store/reinforce size preference
  - Same confidence math as position

- **type**: Store/reinforce type preference
  - Records that user prefers a different container type for this data

- **removed**: Log removal signal
  - Does not create a preference (removing is destructive, not a position preference)
  - May be used in future for "don't include this container" learning

- **added**: Log addition signal
  - Does not create a preference directly
  - May inform future "include this container type" learning

### 4. Apply Decay to All Preferences
- After processing new deltas, decay is applied on next `consult()` call
- Formula: `decayedConf = conf * 2^(-daysSinceReinforced / 14)`

### 5. Prune Stale Preferences
- Preferences below 0.2 confidence threshold are pruned during consult
- Cap at 200 total preferences (remove lowest confidence when exceeded)

---

## Confidence Lifecycle

```
First rearrangement:     0.30
Second (day 2):          0.51
Third (day 5):           0.66
Fourth (day 7):          0.76 (auto-applied from here)
No reinforcement +14d:   0.38 (decayed by half-life)
No reinforcement +28d:   0.19 (below prune threshold)
```

---

## Error Handling

| Error | Recovery |
|-------|----------|
| Invalid delta (unknown containerId) | Skip delta, log warning |
| StateManager write failure | Retry once, then log to LEARNING/FAILURES |
| Preferences file corrupt | Reset to empty preferences, log corruption |

---

## Integration

- **Input:** `canvas.layout.feedback` WebSocket event from frontend
- **Processing:** `LayoutIntelligence.store()` for each valid delta
- **Output:** Updated `layout-preferences.json` via StateManager
- **Consumer:** `ContainerBuilder` on next `buildLayout()` call
