# Workflow: Query

Interactive querying of the DevGraph knowledge graph.

## Trigger
- `devgraph stats`, `show graph`, `graph status`
- `devgraph list errors`, `show recent commits`
- `devgraph neighbors <id>`

## Steps

1. **Understand the query intent**
   - Stats overview: `bun skills/DevGraph/Tools/GraphQuerier.ts stats`
   - List by type: `bun skills/DevGraph/Tools/GraphQuerier.ts list --type <type> --since <duration>`
   - Neighbors: `bun skills/DevGraph/Tools/GraphQuerier.ts neighbors --node <id> --depth <n>`
   - Path: `bun skills/DevGraph/Tools/GraphQuerier.ts path --from <a> --to <b>`
   - Components: `bun skills/DevGraph/Tools/GraphQuerier.ts components`

2. **Format results for the user**
   - Use `--json` for structured output when needed
   - Summarize large result sets
   - Highlight interesting patterns

## Available Node Types
session, agent_trace, error, commit, learning, skill_change, file, decision, issue

## Available Edge Types
produced, caused, fixed_by, learned_from, references, depends_on, blocks, modifies, spawned, contains, implements, relates_to

## Time Filters
- `--since 1d` - Last 24 hours
- `--since 7d` - Last week
- `--since 30d` - Last month

## Voice Notification
```
DevGraph query returned N results for your request
```
