# Graph Visualize Workflow

**Frequency:** On-demand

## Modes

### Trace
Decision chain flowchart from a node

```bash
bun skills/Intelligence/Graph/Tools/Visualizers/MermaidVisualizer.ts --trace <node-id>
```

### Overview
High-level summary of graph structure

```bash
bun skills/Intelligence/Graph/Tools/Visualizers/MermaidVisualizer.ts --overview --period month
```

### Timeline
Nodes grouped by day

```bash
bun skills/Intelligence/Graph/Tools/Visualizers/MermaidVisualizer.ts --timeline --since 7d
```

### Goal
All decisions linked to a TELOS goal

```bash
bun skills/Intelligence/Graph/Tools/Visualizers/MermaidVisualizer.ts --goal G25
```

### Session
Deep-dive into session artifacts

```bash
bun skills/Intelligence/Graph/Tools/Visualizers/MermaidVisualizer.ts --session <session-id>
```

### File
History of all changes to a file

```bash
bun skills/Intelligence/Graph/Tools/Visualizers/MermaidVisualizer.ts --file <file-id>
```

### Errors
Error landscape with clusters

```bash
bun skills/Intelligence/Graph/Tools/Visualizers/MermaidVisualizer.ts --errors --since 7d
```

## Output

- Mermaid diagram syntax
- Can be rendered in Obsidian, GitHub, or online Mermaid Live Editor
