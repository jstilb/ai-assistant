# Explore Workflow

**Trigger:** "what do I know about X?", "explore topic", "find notes about", "search vault for"

## Steps

1. **Ensure graph state is current**
   - Check if `MEMORY/State/knowledge-graph.json` exists and is < 24h old
   - If stale or missing: `bun Tools/GraphBuilder.ts --rebuild`
   - Check if `MEMORY/State/semantic-index.json` exists
   - If missing: `bun Tools/SemanticIndexer.ts --build`

2. **Run semantic search**
   ```bash
   bun Tools/SemanticIndexer.ts --query "<user query>" --limit 10 --json
   ```
   - Parse results to get top matching notes

3. **Expand via graph traversal**
   - For top 3-5 results, find neighbors:
   ```bash
   bun Tools/GraphBuilder.ts --neighbors "<nodeId>"
   ```
   - Find connections between results using shortest path

4. **Summarize findings**
   - For top results, get note summaries:
   ```bash
   bun Tools/NoteSummarizer.ts --note "<nodeId>"
   ```
   - Or use local summary with `--no-ai` for speed

5. **Format response**
   - Structure as concept-first text (no visual metaphors)
   - List relevant notes with relevance scores
   - Show connections between them
   - Identify which cluster(s) they belong to
   - Suggest related areas to explore

## Output Format

```
What you know about [topic]:

Core notes:
1. [Note Title] (folder) - [relevance%]
   [1-sentence summary]
   Connected to: [linked notes]

2. [Note Title] ...

Knowledge clusters involved:
- [Cluster Name] (N notes) - [how it relates]

Related areas to explore:
- [Suggestion 1]
- [Suggestion 2]

Gaps:
- [Any broken links or missing topics detected]
```

## Aphantasia Note

All output must be:
- Text-based and structured (lists, not descriptions of visual layouts)
- Concept-first (what the idea IS, not what it looks like)
- Explicit about connections (state them, do not imply spatial relationships)
