---
name: IssueTrace
description: Graph-based development & issue tracing. Records bugs/errors/blockers/regressions into the knowledge graph, traces their full cause→fix→learning lifecycle, and feeds the patterns into AgentMetacognition. USE WHEN track an issue, trace a bug, why does this file keep breaking, recurring errors, regression, issue lifecycle, what bugs keep coming back, development health.
---

# IssueTrace

Graph-based tracking for development / issue tracing. IssueTrace turns bugs,
errors, blockers, and regressions into **first-class, traceable nodes** in the
shared Kaya knowledge graph, then mines that subgraph for development-health
patterns and feeds them into **AgentMetacognition** so recurring problems become
durable behavioral wisdom instead of repeated one-off patching.

It activates the graph's dormant issue schema — the `issue` node type and the
`caused` / `fixed_by` / `blocks` / `learned_from` edge types are defined in
`Graph/types.ts` but had **0 nodes/edges** in production. IssueTrace is the
writer that brings them to life. It reuses the existing Graph storage engine
(`GraphPersistence`); it does **not** introduce a second graph store.

## The lifecycle model

```
   error / commit / file ──caused──▶  issue  ──fixed_by──▶ commit
                                        │
                          (blocker) ──blocks──▶ │
                                        └──learned_from──▶ learning (resolution)
```

The store is **append-only** (dedups by id), so issue status is never mutated in
place. Status is *derived* from incident edges at trace time:

| Derived status | Condition |
|----------------|-----------|
| `resolved` | issue has an outgoing `fixed_by` **or** `learned_from` edge |
| `blocked`  | not resolved **and** has an incoming `blocks` edge |
| `open`     | otherwise |

Time-to-resolve is computed from the resolution timestamp minus the open time.

## Tools

| Tool | Purpose | Entry point |
|------|---------|-------------|
| `IssueTracer.ts` | Record + trace + list issues in the graph | `bun skills/Intelligence/IssueTrace/Tools/IssueTracer.ts <cmd>` |
| `IssueLearningBridge.ts` | Detect issue patterns and feed AgentMetacognition | `bun skills/Intelligence/IssueTrace/Tools/IssueLearningBridge.ts --synthesize` |

### IssueTracer CLI

```bash
# Open an issue (auto-links the named file as a cause; optional explicit causes/session)
bun .../IssueTracer.ts open --title "queue list ignores positional arg" \
    --severity high --file skills/Foo/CLI.ts --cause error:e123 --session 20260627-foo

# Resolve it (always records a resolution learning; fixed_by edge when a commit is given)
bun .../IssueTracer.ts resolve <issueId> --commit deadbeef \
    --resolution "honor positional queue arg" \
    --learning "CLI positional args must be parsed before flag fallbacks"

bun .../IssueTracer.ts cause <issueId> --cause file:lib/parser.ts   # add a cause edge
bun .../IssueTracer.ts block <issueId> --by issue:upstream-dep      # mark blocked
bun .../IssueTracer.ts trace <issueId> [--json]                     # full lifecycle trace
bun .../IssueTracer.ts list [--status open|resolved|blocked] [--severity high] \
    [--file path] [--since 7d] [--limit N] [--json]
```

### Library API

```ts
import { IssueTracer } from "skills/Intelligence/IssueTrace/Tools/IssueTracer";
const t = new IssueTracer();
const id = t.openIssue({ title, severity: "high", file, causes: ["error:e1"], session });
t.linkCause(id, "commit:abc");
t.blockIssue(id, "issue:dep");
t.resolveIssue(id, { commit: "abc1234", resolution: "...", learning: "..." });
const trace = t.traceIssue(id);          // { status, severity, timeToResolveMs, causes, fixes, learnings, timeline }
const open  = t.listIssues({ status: "open" });
```

## How it feeds AgentMetacognition

`IssueLearningBridge.synthesize()` detects patterns and feeds **both** of
AgentMetacognition's real intake channels:

1. **MemoryStore insights** — `capture({ type: 'insight', source: 'Intelligence/IssueTrace', ... })`.
   This is the same contract the former `Graph/AgentMetacognitionBridge` used
   (bridge deleted 2026-07-10).
2. **SIGNALS ledger** — appends a `RawSignal` to
   `MEMORY/LEARNING/SIGNALS/dev-issues.jsonl`, durable raw data for LLM
   review. Its scheduled reader, the weekly `learning-weekly-digest` cron,
   was deleted 2026-09-30 per Jm; the file is now read only on demand
   (AgentMetacognition) and by Graph ingesters (behavioral rules still land
   only in CLAUDE.md and auto-memory).
   Signals are emitted with `source:'explicit'` so they always pass the
   `SignalQualityGate`.

Patterns detected:

| Pattern | Trigger |
|---------|---------|
| `recurring_issue`    | same issue (normalized title) reported ≥3 times |
| `issue_prone_file`   | a file accumulating ≥3 issues |
| `slow_resolution`    | resolved issues whose time-to-resolve exceeded 7 days |
| `stale_open_issue`   | high/critical issues open longer than 14 days |
| `regression`         | a file with a new issue opened *after* a prior resolution |
| `unresolved_backlog` | ≥5 open high/critical issues right now |

```bash
bun .../IssueLearningBridge.ts --synthesize            # detect + feed
bun .../IssueLearningBridge.ts --synthesize --json     # JSON output
bun .../IssueLearningBridge.ts --synthesize --since 30d
bun .../IssueLearningBridge.ts --synthesize --dry-run  # detect only, no writes
```

A natural cadence is to run `--synthesize` on the same schedule as (or just
before) the AgentMetacognition weekly synthesis cron so issue patterns are fresh
when frames are written.

## Integration

- **Reads/writes:** the shared knowledge graph via `Graph/Tools/GraphPersistence`
  (`~/.kaya/graph`, fallback `~/.claude/MEMORY/GRAPH`).
- **Feeds:** AgentMetacognition (`MemoryStore` insights + `dev-issues.jsonl`).
- **Composes with:** `Graph/Tools/GraphQuerier.ts` (search/trace/neighbors over
  the same issue nodes) and `Graph/Tools/Visualizers/MermaidVisualizer.ts`.

## Tests

```bash
bun test "$(pwd)/skills/Intelligence/IssueTrace/Tools/__tests__/IssueTracer.test.ts" \
         "$(pwd)/skills/Intelligence/IssueTrace/Tools/__tests__/IssueLearningBridge.test.ts"
```

Tests use real temp graph/memory/signals dirs (no global graph pollution) and
assert the full feed loop, including that emitted signals survive the
`SignalQualityGate`.
