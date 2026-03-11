# Discover Workflow

**Trigger:** "how does X connect to Y?", "find connections", "bridge notes", "what connects", "path between"

## Steps

1. **Identify the two concepts/areas**
   - Search for each concept separately:
   ```bash
   bun Tools/SemanticIndexer.ts --query "<concept A>" --limit 5 --json
   bun Tools/SemanticIndexer.ts --query "<concept B>" --limit 5 --json
   ```

2. **Find shortest paths**
   - For the top result of each concept, find path:
   ```bash
   bun Tools/GraphBuilder.ts --path "<nodeId A>" "<nodeId B>"
   ```
   - Try multiple pairs if first path is long or nonexistent

3. **Identify bridge notes**
   - Find notes that appear in both search results
   - Find notes that belong to different clusters but link both areas
   - Show cluster memberships:
   ```bash
   bun Tools/ClusterAnalyzer.ts --bridges
   ```

4. **Analyze the connection**
   - For each note in the path, extract key concepts
   - Identify shared tags between the two areas
   - Find common headings/topics

5. **Summarize the connection**
   - Use NoteSummarizer to describe the bridge:
   ```bash
   bun Tools/NoteSummarizer.ts --note "<bridge note id>"
   ```

6. **Format response**
   - Explicit connection path
   - Bridge concepts that link the two areas
   - Shared tags and overlapping themes
   - Suggestions for strengthening the connection

## Output Format

```
Connection: [Concept A] to [Concept B]
===========================================

Path found ([N] steps):
  [Note A] -> [Bridge Note 1] -> [Bridge Note 2] -> [Note B]

Bridge concepts:
- [Bridge Note 1]: Connects [A topic] to [B topic] through [shared concept]
- [Bridge Note 2]: Links [aspect of A] with [aspect of B]

Shared tags: #tag1, #tag2
Shared clusters: [Cluster Name]

How they connect:
[1-2 sentence explanation of the conceptual connection]

Strengthen this connection:
- Create a note about "[missing concept]" that bridges both areas
- Add wikilinks from [Note X] to [Note Y]
- Explore [related topic] that overlaps both areas
```

## Discovery Patterns

When no direct path exists:
1. Check if both concepts belong to the same cluster
2. Look for shared tags as indirect connections
3. Search for semantic similarity between the two areas
4. Suggest creating a bridge note

When multiple paths exist:
1. Show the shortest path first
2. Mention alternative paths if they go through interesting bridge notes
3. Highlight which path traverses the most relevant clusters
