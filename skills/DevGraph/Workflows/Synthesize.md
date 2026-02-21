# Workflow: Synthesize

Generate insights from the DevGraph and export to ContinualLearning.

## Trigger
- `devgraph synthesize`, `graph insights`, `find patterns in graph`
- Automated: Weekly maintenance

## Steps

1. **Ensure graph is fresh**
   ```bash
   bun skills/DevGraph/Tools/GraphQuerier.ts ingest --all
   ```

2. **Run pattern detection**
   ```bash
   bun skills/DevGraph/Tools/ContinualLearningBridge.ts --synthesize
   ```

3. **Review detected patterns**
   - Recurring error clusters
   - Error-prone files (candidates for refactoring/testing)
   - High-error sessions (areas of instability)
   - Hot files (high churn, potential instability)

4. **Report insights**
   - Patterns are automatically captured in MemoryStore with tag `devgraph`
   - ContinualLearning can discover them via tag search
   - High-severity patterns should be flagged for immediate attention

## Pattern Types

| Type | Description | Action |
|------|-------------|--------|
| error_cluster | Same error recurring | Fix root cause |
| error_prone_file | File associated with many errors | Add tests, refactor |
| high_error_session | Session with many errors | Review approach |
| hot_file | Frequently modified file | Stabilize, add tests |

## Integration with ContinualLearning
Patterns are stored as `insight` type in MemoryStore with:
- Tags: `devgraph`, `pattern`, `<specific-type>`
- Tier: `warm` (persistent, indexed)
- Source: `DevGraph/ContinualLearningBridge`

## Voice Notification
```
DevGraph synthesis complete, found N patterns for continuous learning
```
