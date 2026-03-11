# Analyze Workflow

**Trigger:** "knowledge gaps", "what's missing", "gap analysis", "vault health", "where are my gaps"

## Steps

1. **Ensure graph state with clusters**
   - Check `MEMORY/State/knowledge-graph.json` for clusters
   - If no clusters: `bun Tools/ClusterAnalyzer.ts --analyze`

2. **Run gap detection**
   ```bash
   bun Tools/GapDetector.ts --detect --json
   ```
   - Parse all detected gaps

3. **Prioritize by TELOS alignment**
   - Gaps connected to TELOS goals (M2 Creative, M5 Professional) rank higher
   - High severity gaps (broken links referenced by multiple notes) rank highest

4. **Generate cluster overview**
   ```bash
   bun Tools/ClusterAnalyzer.ts --analyze --json
   ```
   - Show cluster distribution and health

5. **Generate suggestions**
   - For actionable gaps, generate note templates:
   ```bash
   bun Tools/GapDetector.ts --suggest
   ```

6. **Format response**
   - Prioritized gap report
   - Cluster health summary
   - TELOS-aligned suggestions
   - Actionable next steps

## Output Format

```
Vault Health Report
==================

Graph: [N] notes, [N] edges, [N] clusters
Built: [timestamp]

Top Priority Gaps:
1. [!!] [Gap description]
   TELOS: [Related goal]
   Action: [Suggestion]

2. [!] [Gap description]
   Action: [Suggestion]

Cluster Health:
- [Cluster Name]: [N] notes, [density]% connected
- [Cluster Name]: [N] notes, [density]% connected

Weak Bridges (areas that should be more connected):
- [Cluster A] <-> [Cluster B]: Only [N] connection(s)

Orphan Notes (top 10 by word count):
- [Note] ([N] words) - consider linking to [cluster]

Suggestions:
1. Create "[Note Title]" to connect [Cluster A] and [Cluster B]
2. Expand "[Stub Note]" with content about [topic]
3. Fix broken link to "[Missing Note]"
```

## TELOS Integration

Cross-reference gaps with:
- **M2 (Creative):** Writing, music, creative notes
- **M5 (Professional):** AI, ML, programming, data science
- **M6 (Self):** Learning, habits, self-improvement
- **G28:** AI proficiency - are AI/ML knowledge areas well-connected?
- **G17:** Writing - are creative writing notes linked to craft notes?
