# ReviewSpecs Workflow

**Create and approve spec sheets for queue items awaiting approval.**

This workflow manages the daily spec review process, ensuring items in the approvals queue have proper specifications before they can be promoted to the approved-work queue.

## Trigger

- `/queue review` - Interactive review session
- `/queue review --batch` - Batch generate all drafts
- Daily briefing shows items needing specs

## Prerequisites

- Items in the `approvals` queue (status: pending or awaiting_approval)
- Items should have enrichment metadata (auto-generated on queue intake)

## Process

### Step 1: Load Items Needing Specs

```typescript
import { SpecReviewManager } from "../Tools/SpecReviewManager.ts";

const manager = new SpecReviewManager();
const items = await manager.listItemsNeedingSpecs();
```

Returns items sorted by priority (HIGH first) then age (oldest first).

### Step 2: Present Items Table

Display items with:
- ID (first 8 chars)
- Title
- Priority (HIGH/NORMAL/LOW)
- Complexity indicator (🟢/🟡/🔴)
- Age
- Spec status (❌ NEEDS SPEC / 📝 DRAFT / ✅ APPROVED)

### Step 3: Generate Spec (Complexity-Adaptive)

Generation follows the SpecSheet vision hierarchy, adapting based on item complexity:

| Complexity | Pipeline | Inference Calls | Models |
|------------|----------|-----------------|--------|
| 🟢 Low | CurrentWork only | 1 | fast (Haiku) |
| 🟡 Medium | SpecFromDescription → CurrentWork | 2 | standard (Sonnet) |
| 🔴 High | SFD → GroundedIdeal → CurrentWork | 3 | standard + smart (Opus) |

**For each item:**

1. **Show item details:**
   - Title, description
   - Enrichment metadata if available
   - Clarifying questions from enrichment

2. **Generate draft spec:**
   ```typescript
   const result = await manager.generateDraftSpec(item.id);
   // Complexity routing happens automatically based on enrichment.complexity
   ```

   Output follows the CurrentWork template format with:
   - ISC table: `| # | What Ideal Looks Like | Source | Verify Method |`
   - Source values: EXPLICIT / INFERRED / IMPLICIT / GROUNDED
   - Task-type overlays applied (CodingProject, AITask, etc.)
   - Inferred sections marked with `⚠️ INFERRED - verify`

   For **high complexity** items, two files are created:
   - `{id}-spec.md` — CurrentWork spec (implementation-ready)
   - `{id}-ideal.md` — GroundedIdeal spec (achievable excellence vision)

3. **Refine spec (optional):**
   - Review generated spec
   - Answer clarifying questions
   - Edit spec file directly

4. **Approve spec:**
   ```typescript
   const approved = await manager.approveSpec(item.id, "principal");
   ```

5. **Optionally promote to approved-work:**
   - If spec is approved, item can be promoted
   - Use WorkPromoter for promotion

### Step 4: Summary

Report:
- Specs created
- Specs approved
- Items remaining

## Batch Mode

For `/queue review --batch`:

```typescript
const result = await manager.batchGenerateSpecs();
console.log(`Generated: ${result.generated}, Failed: ${result.failed}`);
```

Generates drafts without interaction. User reviews drafts later.

## Spec Storage

Specs are stored at: `Plans/Specs/Queue/{item-id}-spec.md`

For high-complexity items, an additional ideal spec is generated:
- Main spec: `Plans/Specs/Queue/{item-id}-spec.md` (CurrentWork format)
- Ideal spec: `Plans/Specs/Queue/{item-id}-ideal.md` (GroundedIdeal format)

Naming convention ensures 1:1 mapping between queue items and specs.

## CLI Commands

| Command | Description |
|---------|-------------|
| `bun run SpecReviewManager.ts list` | List items needing specs |
| `bun run SpecReviewManager.ts generate <id>` | Generate draft for item |
| `bun run SpecReviewManager.ts read <id>` | Read spec content |
| `bun run SpecReviewManager.ts approve <id>` | Approve spec and link to item |
| `bun run SpecReviewManager.ts batch` | Generate all drafts |

## Integration Points

### Daily Briefing

ApprovalQueueBlock shows spec status:
```
**Awaiting Approval (3):**
- [ml5x7s98] Add dark mode **HIGH** (2d) **[NEEDS SPEC]**
- [jk2n9r01] Fix auth timeout **[SPEC APPROVED]**

Tip: 2 items need specs. Run `/queue review` to create them.
```

### Work Promotion

Items cannot be promoted to approved-work without an approved spec:
```
approvals → spec review → approved-work → execution
```

The three-layer defense:
1. `QueueManager.addApprovedWork()` validates spec
2. `WorkPromoter.promote()` validates spec
3. `Worker.processOne()` re-validates before execution

## Example Session

```
/queue review

═══════════════════════════════════════════════════════════════════════════
Items Needing Specs
═══════════════════════════════════════════════════════════════════════════

[ml5x7s98] Add dark mode to application
    HIGH   | 🟡 | 2d   | ❌ NEEDS SPEC

[jk2n9r01] Fix authentication timeout issue
    NORMAL | 🟢 | 1d   | 📝 DRAFT

═══════════════════════════════════════════════════════════════════════════

Total: 2 items
  Needs Spec: 1
  Has Draft:  1
  Approved:   0

> Generate spec for ml5x7s98? (Y/n)

Generating spec for: Add dark mode to application...
✓ Generated spec: Plans/Specs/Queue/ml5x7s98-spec.md

> Review and approve? (Y/n)

[Opens spec for review]

> Approve spec? (Y/n)

✓ Spec approved for item: ml5x7s98
Item is now ready for promotion to approved-work queue.

> Promote to approved-work now? (Y/n)

✓ Item promoted to approved-work queue.

> Continue to next item? (Y/n)
```

## Error Handling

| Error | Resolution |
|-------|------------|
| Item not found | Check item ID, verify in approvals queue |
| Inference failed | Check CORE/Tools/Inference.ts is accessible |
| No enrichment | Item may need manual spec creation or run ItemEnricher first |

## Related

- `Tools/SpecReviewManager.ts` - Core implementation
- `Tools/QueueManager.ts` - Queue operations
- `Tools/ItemEnricher.ts` - Enrichment metadata
- `Tools/WorkPromoter.ts` - Promotion workflow
- `skills/SpecSheet/Workflows/SpecFromDescription.md` - Spec generation approach
- `skills/SpecSheet/Workflows/GroundedIdeal.md` - Grounded ideal workflow (high complexity)
- `skills/SpecSheet/Workflows/CurrentWork.md` - ISC generation and implementation spec
- `skills/SpecSheet/Templates/VisionTiers/CurrentWork.md` - CurrentWork template
- `skills/SpecSheet/Templates/VisionTiers/GroundedIdeal.md` - GroundedIdeal template
- `skills/SpecSheet/Templates/Overlays/*.overlay.md` - Task-type overlays
- `skills/CORE/Tools/Inference.ts` - Inference API (fast/standard/smart)
