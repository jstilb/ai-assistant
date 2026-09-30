# OptimizeDescription Workflow

Trigger accuracy optimization via train/test split, up to 5 iteration rounds.

## Steps

### 1. Generate Eval Queries
Create 20 trigger eval queries for the target skill:
- **10 should-trigger**: diverse phrasings, edge cases, queries where competing skills exist
- **10 should-not-trigger**: near-misses, adjacent domains, ambiguous phrasing
- Queries must be realistic and detailed — not generic like "format this data"

### 2. Review with Jm
Present the 20 queries for review. Jm may edit, add, or remove queries.

### 3. Run Optimization Loop
Save final eval set, then run:
```bash
python3 ~/.claude/skills/Development/CreateSkill/Tools/RunLoop.py \
  --eval-set <eval-queries.json> \
  --skill-path <skill-path> \
  --model <current-model-id> \
  --max-iterations 5 --verbose
```

The script:
1. Splits 60% train / 40% test
2. Evaluates current description (3 runs per query)
3. Uses Claude with extended thinking to propose improvements
4. Re-evaluates on both splits
5. Selects best description by test score (not train) to prevent overfitting

### 4. Present Results
Show Jm:
- `best_description` (selected by test score) vs original description
- Per-query accuracy breakdown (train and test splits)
- Iteration history showing score progression

### 5. Apply (if accepted)
If Jm accepts the new description:
1. Update the target skill's SKILL.md description field
2. Verify description is still under 1024 characters
3. Verify description contains `USE WHEN`
4. Run `validate skill <SkillName>` to confirm structural compliance
