# Visualize Workflow

**Trigger:** "visualize graph", "show graph", "interactive graph", "see my vault", "graph visualization"

## Steps

1. **Ensure graph state is current**
   - Check if `MEMORY/State/knowledge-graph.json` exists and is < 24h old
   - If stale or missing: `bun Tools/GraphBuilder.ts --rebuild`
   - If clusters are needed but missing: `bun Tools/ClusterAnalyzer.ts --analyze`

2. **Determine scope and filters**
   - If user specifies a folder: use `--folder "<name>"`
   - If user specifies a tag: use `--tag "<name>"`
   - If user specifies a cluster: use `--cluster "<id>"`
   - If user wants more/fewer nodes: use `--max-nodes <n>`
   - If user wants cluster coloring: use `--color-by cluster`

3. **Run GraphVisualizer**
   ```bash
   bun Tools/GraphVisualizer.ts [options]
   ```
   - Tool writes a standalone HTML file to `~/Downloads/knowledge-graph-viz.html`
   - Auto-opens in the preferred browser (from settings.json)

4. **Report results**
   - Confirm file location and node/edge/cluster counts
   - Note any filters applied
   - Reference interactive controls available in the visualization

## Output Format

```
Visualization generated:
- Location: ~/Downloads/knowledge-graph-viz.html
- Nodes: [N] (of [total] in graph)
- Edges: [N]
- Clusters: [N]
- Filters: [folder/tag/cluster or "none"]
- Colored by: [folder/cluster]

Interactive controls:
- Zoom/pan: scroll wheel + drag on empty space
- Drag nodes: click and drag any node
- Inspect: hover for tooltip (title, folder, tags, word count, connections)
- Focus: click a node to highlight its connections
- Search: type in search box to highlight matching nodes
- Filter: click legend items to toggle category visibility
```

## CLI Reference

```bash
bun Tools/GraphVisualizer.ts                              # Full graph, default 300 nodes
bun Tools/GraphVisualizer.ts --folder "Statistics"        # Filter to folder
bun Tools/GraphVisualizer.ts --tag "programming"          # Filter to tag
bun Tools/GraphVisualizer.ts --cluster "cluster-id"       # Filter to cluster
bun Tools/GraphVisualizer.ts --max-nodes 500              # Override node cap
bun Tools/GraphVisualizer.ts --color-by cluster           # Color by cluster (default: folder)
bun Tools/GraphVisualizer.ts --output /path/to/file.html  # Custom output path
bun Tools/GraphVisualizer.ts --no-open                    # Don't auto-open browser
bun Tools/GraphVisualizer.ts --include-tag-edges          # Include tag co-occurrence edges
bun Tools/GraphVisualizer.ts --include-folder-edges       # Include folder co-membership edges
```
