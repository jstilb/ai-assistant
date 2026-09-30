---
name: KnowledgeGraph
description: Interactive knowledge graph navigation and exploration of Obsidian vault. USE WHEN knowledge graph, obsidian graph, vault navigation, what I know about, knowledge gaps, concept clusters, related notes, graph analysis, vault exploration, visualize vault graph, show vault graph, interactive graph.
---

# KnowledgeGraph

Navigate and explore the Obsidian vault as a connected knowledge graph rather than a flat file system. Answers questions like "what do I know about transformers?", "how does NLP connect to Writing?", and "where are my knowledge gaps?"

Built on a general-purpose graph abstraction that Obsidian sits on top of. All outputs are text-based and concept-first.

> **STALE STATE FILES — ACTION REQUIRED (flagged 2026-03-24 by pipeline-eval):**
> - `MEMORY/State/knowledge-graph.json` (1.9MB) — built 2026-02-12, TTL=24h, **40+ days stale**. Regenerate via KnowledgeGraph build workflow.
> - `MEMORY/State/semantic-index.json` (6.9MB) — built 2026-02-07, no TTL field, **45+ days stale**. Regenerate via SemanticIndexer.ts rebuild.
## Setup

Configure the Obsidian vault path before using any KnowledgeGraph tools. Use one of the following methods:

**Option 1: Environment variable (recommended for CI/scripts)**
```bash
export OBSIDIAN_VAULT="/absolute/path/to/your/obsidian/vault"
```

**Option 2: secrets.json (recommended for daily use)**

Add to `~/.claude/secrets.json`:
```json
{
  "obsidian_vault": "/absolute/path/to/your/obsidian/vault"
}
```

The `obsidian_vault` key in `secrets.json` is the preferred method. The `OBSIDIAN_VAULT` environment variable takes precedence if both are set. If neither is configured, all tools will fail with a clear error message.

## Workflow Routing

| Workflow | Trigger | File |
|----------|---------|------|
| **Explore** | "what do I know about X?", "explore topic", "find notes about" | `Workflows/Explore.md` |
| **Analyze** | "knowledge gaps", "what's missing", "gap analysis", "vault health" | `Workflows/Analyze.md` |
| **Discover** | "how does X connect to Y?", "find connections", "bridge notes" | `Workflows/Discover.md` |
| **Visualize** | "visualize graph", "show graph", "interactive graph", "see my vault" | `Workflows/Visualize.md` |

## Examples

**Example 1: Explore a topic**
```
User: "What do I know about machine learning?"
-> Invokes Explore workflow
-> Builds graph from vault, searches for ML-related notes
-> Returns concept map with related notes, tags, and connections
```

**Example 2: Find knowledge gaps**
```
User: "Where are the gaps in my programming knowledge?"
-> Invokes Analyze workflow
-> Analyzes graph clusters for programming-related notes
-> Identifies weakly connected areas and orphan notes
-> Suggests topics to strengthen
```

**Example 3: Discover hidden connections**
```
User: "How does NLP connect to my writing notes?"
-> Invokes Discover workflow
-> Traces connection paths between NLP and writing note clusters
-> Surfaces bridge notes that link the two domains
```

## Tools

| Tool | Purpose | CLI |
|------|---------|-----|
| **GraphBuilder.ts** | Parse vault into node/edge graph | `bun Tools/GraphBuilder.ts --rebuild` |
| **SemanticIndexer.ts** | TF-IDF keyword search across vault | `bun Tools/SemanticIndexer.ts --query "..."` |
| **ClusterAnalyzer.ts** | Label propagation community detection | `bun Tools/ClusterAnalyzer.ts --analyze` |
| **GapDetector.ts** | Find orphans, broken links, stubs, gaps | `bun Tools/GapDetector.ts --detect` |
| **NoteSummarizer.ts** | AI-powered note/cluster summarization | `bun Tools/NoteSummarizer.ts --note <id>` |
| **GraphVisualizer.ts** | Interactive D3.js Canvas force-directed graph | `bun Tools/GraphVisualizer.ts` |

## Quick Reference

- **Graph Build:** `bun Tools/GraphBuilder.ts --rebuild`
- **Graph Stats:** `bun Tools/GraphBuilder.ts --stats`
- **Semantic Search:** `bun Tools/SemanticIndexer.ts --query "transformers attention"`
- **Build Index:** `bun Tools/SemanticIndexer.ts --build`
- **Run Clustering:** `bun Tools/ClusterAnalyzer.ts --analyze`
- **Detect Gaps:** `bun Tools/GapDetector.ts --detect`
- **Summarize Note:** `bun Tools/NoteSummarizer.ts --note <nodeId>`
- **Summarize Cluster:** `bun Tools/NoteSummarizer.ts --cluster <clusterId>`
- **Visualize Graph:** `bun Tools/GraphVisualizer.ts`
- **Visualize Filtered:** `bun Tools/GraphVisualizer.ts --folder "Statistics" --max-nodes 100`

## Data Model

The graph uses general-purpose types defined in `Tools/types.ts`:
- **GraphNode**: Notes with tags, headings, word counts, links
- **GraphEdge**: Connections (wikilink, tag, folder, semantic, embed)
- **ConceptCluster**: Community-detected groups of related notes
- **KnowledgeGap**: Detected gaps with severity and TELOS alignment

## State

| File | Contents |
|------|----------|
| `MEMORY/State/knowledge-graph.json` | Full graph state (nodes, edges, clusters, stats) |
| `MEMORY/State/semantic-index.json` | TF-IDF keyword index for semantic search |

Graph state managed via StateManager. 24-hour TTL. Rebuild with `--rebuild` when vault changes significantly.

## Integration

### Uses
- **StateManager** - Persists graph state to `MEMORY/State/knowledge-graph.json`
- **tools/Inference.ts** - AI-powered summarization (no raw API keys)
- **TELOS Goals** - Cross-references gaps with life goals
- **Obsidian Vault** - READ ONLY access

### Feeds Into
- **AgentMetacognition** - Graph insights for session intelligence
- **DailyBriefing** - Knowledge gap summaries for morning briefings
- **InformationManager** - Gap-filling notes written to vault

### MCPs Used
- None (pure filesystem and inference)
