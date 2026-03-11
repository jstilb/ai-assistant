---
name: ArgumentMapper
description: Map, verify, and track public arguments for any person+topic combination. USE WHEN argument mapping, verify claims, track stance, debate analysis, position tracking.
---
# ArgumentMapper

Map, verify, and track public arguments for any person + topic combination.

USE WHEN argument mapping, map arguments, verify claims, track stance, argument analysis, claim verification, debate analysis, position tracking, what does person argue about topic, how has person's position changed.

## Description

ArgumentMapper is a standalone TypeScript application that systematically maps how someone argues about a topic - their claims, evidence, debate patterns, and position evolution - then verifies those claims against original sources.

## Commands

### Map Arguments
```bash
bun /Users/[user]/Desktop/projects/argumentmapper/src/cli.ts map "Person Name" "Topic" --depth standard
```

### Verify Claims
```bash
bun /Users/[user]/Desktop/projects/argumentmapper/src/cli.ts verify --input profile.json
```

### Track Evolution
```bash
bun /Users/[user]/Desktop/projects/argumentmapper/src/cli.ts track "Person Name" "Topic" --since 2020
```

### Search Only
```bash
bun /Users/[user]/Desktop/projects/argumentmapper/src/cli.ts search "Person Name" "Topic"
```

### List Tracked Pairs
```bash
bun /Users/[user]/Desktop/projects/argumentmapper/src/cli.ts list
```

## Flags

| Flag | Description |
|------|-------------|
| `--markdown` | Human-readable output (default: JSON) |
| `--depth quick\|standard\|deep` | Search/analysis depth |
| `--input <file>` | Input file for verify |
| `--since <date>` | Start date for tracking |
| `--periods yearly\|quarterly\|monthly` | Tracking granularity |

## Workflow

### Conversational Mapping
When a user asks about someone's arguments:
1. Run `map` with appropriate depth
2. Present the ArgumentProfile in markdown
3. Offer to verify specific claims or track evolution

### Verification Pipeline
When a user wants fact-checking:
1. Run `map` first if no existing profile
2. Pipe to `verify` or run `verify --input`
3. Present VerificationReport with evidence links

### Evolution Tracking
When a user asks how positions changed:
1. Run `track` (stores snapshots automatically)
2. On re-run, shows diff against previous analysis
3. Present StanceEvolution with timeline and shifts

## Workflow Routing

| Trigger | Workflow | Description |
|---------|----------|-------------|
| "map arguments", "argument map" | Map | Build ArgumentProfile for person+topic |
| "verify claims", "fact check" | Verify | Verify claims against original sources |
| "track stance", "position changed" | Track | Track position evolution over time |
| "search arguments", "find arguments" | Search | Search for person+topic content |

## Examples

```
User: "Map Sam Harris's arguments about free will"
-> bun /Users/[user]/Desktop/projects/argumentmapper/src/cli.ts map "Sam Harris" "free will" --depth standard --markdown

User: "Has Paul Graham's position on startups changed?"
-> bun /Users/[user]/Desktop/projects/argumentmapper/src/cli.ts track "Paul Graham" "startups" --since 2010 --markdown

User: "Verify these claims"
-> bun /Users/[user]/Desktop/projects/argumentmapper/src/cli.ts verify --input profile.json --markdown
```

## Integration

This skill wraps the standalone application at `/Users/[user]/Desktop/projects/argumentmapper/`.

## Customization

- Depth levels control search breadth and inference cost
- Period granularity affects temporal tracking resolution
- Source classification uses weighted scoring (configurable in classify.ts)

## Voice Notification

After completing operations, notify with results summary.
