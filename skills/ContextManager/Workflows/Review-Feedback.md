# Review-Feedback Workflow

**Trigger:** Periodic (weekly recommended)

## Usage

```bash
# Analyze feedback and generate learnings
bun skills/ContextManager/Tools/ContextLearner.ts --analyze

# View feedback summary
bun skills/ContextManager/Tools/FeedbackCollector.ts --summary

# View all feedback entries
bun skills/ContextManager/Tools/FeedbackCollector.ts --list
```

## What It Analyzes

1. Which profiles are used most frequently
2. Files that get manually loaded (not in profile) -- candidates to add
3. Recommended files that are never loaded -- candidates to remove
4. Sessions with high manual context load counts -- profile may need expansion
5. Classification confidence -- low confidence means routing.json needs more keywords

## Output

- Updates MEMORY/STATE/context-learnings.json
- Generates actionable recommendations for profiles.json tuning
