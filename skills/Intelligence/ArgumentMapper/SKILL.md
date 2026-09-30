---
name: ArgumentMapper
description: Map, verify, and track public arguments for any person+topic combination, and trace corporate ownership lineage and funding for any brand or organization. USE WHEN argument mapping, verify claims, track stance, debate analysis, position tracking, who owns X, parent company, ultimate owner, subsidiaries, corporate structure, who funds X, political donations, conflict of interest.
---
# ArgumentMapper

Map, verify, and track public arguments for any person + topic combination — and trace **who owns and funds** any brand or organization.

USE WHEN argument mapping, map arguments, verify claims, track stance, argument analysis, claim verification, debate analysis, position tracking, what does person argue about topic, how has person's position changed, who owns X, who is the parent company of X, what is X a subsidiary of, ultimate owner, corporate ownership, corporate structure, sister companies, what brands does X own, who funds X, political donations, PAC, who funds this lawsuit, who funds this research, conflict of interest, is X independent.

## Description

ArgumentMapper is a standalone TypeScript application that systematically maps how someone argues about a topic - their claims, evidence, debate patterns, and position evolution - then verifies those claims against original sources.

It also contains an **ownership lineage engine**: given a brand or organization, it traces parent companies, ultimate owners, subsidiaries and sister companies from public registries (GLEIF LEI, SEC EDGAR EX-21, Wikidata), flags the well-known entities in that lineage, and optionally surfaces political donations, 990 filings and litigation. Ownership is deliberately opaque — a "grassroots" advocacy group or an amicus brief looks independent until you trace the holding structure — so **every edge carries a source URL** and output is citable rather than merely plausible.

**No ownership fact originates from an LLM.** Entities, edges, jurisdictions, notability and money findings come only from registry retrieval.

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

### Ownership Lineage

Resolve a name to candidate entities (CIK / LEI / Wikidata QID). **Ambiguity is surfaced, never guessed** — exits non-zero and picks nothing when a name is ambiguous:
```bash
bun /Users/[user]/Desktop/projects/argumentmapper/src/cli.ts ownership resolve "Coca-Cola"
```

Full lineage — parents, subsidiaries and sister companies in one graph:
```bash
bun /Users/[user]/Desktop/projects/argumentmapper/src/cli.ts ownership "Instagram" --markdown
```

One direction at a time:
```bash
bun .../src/cli.ts ownership "Instagram" --up --markdown        # -> Meta -> Zuckerberg [PERSON]
bun .../src/cli.ts ownership "Nestlé S.A." --down               # subsidiaries
bun .../src/cli.ts ownership "Instagram" --siblings             # co-subsidiaries of the parent
```

Disambiguate explicitly when a name is ambiguous:
```bash
bun .../src/cli.ts ownership "The Coca-Cola Company" --down --pick cik:0000021344
```

Money trail — political donations, 990 filings, litigation (opt-in):
```bash
bun .../src/cli.ts ownership "The Coca-Cola Company" --money --pick cik:0000021344 --markdown
```

## Flags

| Flag | Description |
|------|-------------|
| `--markdown` | Human-readable output (default: JSON) |
| `--depth quick\|standard\|deep` | Search/analysis depth |
| `--input <file>` | Input file for verify |
| `--since <date>` | Start date for tracking |
| `--periods yearly\|quarterly\|monthly` | Tracking granularity |
| `--up` / `--down` / `--siblings` | Ownership direction; omit all three for the combined graph |
| `--pick <id>` | Disambiguate: `cik:0000021344`, `lei:...`, `wd:Q...` |
| `--max-depth N` / `--max-nodes N` | Traversal caps (default 3 / 250); truncation is always disclosed |
| `--no-enrich` | Skip Wikidata notability enrichment |
| `--money` | Add FEC / ProPublica 990 / CourtListener findings (opt-in; no extra calls without it) |

## Reading ownership output — the rules that matter

These are not caveats to skim; they are what makes the output trustworthy.

- **A failed lookup is never a negative finding.** `undefined`/`null` means *not assessed*. A root with no LEI and no Wikidata id reports "could not determine upward parents", explicitly **NOT** a confirmed top-of-chain.
- **Every edge carries at least one `provenance.sourceUrl`**, and `coverage.knownIncomplete` is non-empty on every result.
- **Coverage is partial by construction.** GLEIF covers only LEI-registered entities, and Regulation S-K 601(b)(21)(ii) lets any filer omit subsidiaries that are not in aggregate significant — an EX-21 list is never guaranteed complete.
- **Conflicts are recorded, not reconciled** (`conflicting: true`), including rows that may be the filer's own self-listing.
- **`--money` findings carry an explicit attribution basis.** Confirmed findings require an exact shared identifier; everything else is a labelled `name-match-unconfirmed` candidate and is never silently attached to a node. This matters: of the 9 FEC committees matching "coca cola", only one is The Coca-Cola Company's — the rest are independent bottlers plus Coca-Cola Consolidated, a *separate public company*.
- **`isNotable: false` means "few language Wikipedias cover this"**, not "unimportant". National subsidiaries are frequently folded into a parent brand's article.

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

### Ownership Tracing
When a user asks who owns, controls or funds something:
1. Run `ownership "<name>"` (combined) or a specific direction
2. If it exits non-zero with ranked candidates, **present them and ask** — never auto-pick
3. Present the graph in markdown; every edge shows its source
4. Report `coverage.knownIncomplete` — the result is never a complete census
5. Offer `--money` for donations / 990s / litigation

## Workflow Routing

| Trigger | Workflow | Description |
|---------|----------|-------------|
| "map arguments", "argument map" | Map | Build ArgumentProfile for person+topic |
| "verify claims", "fact check" | Verify | Verify claims against original sources |
| "track stance", "position changed" | Track | Track position evolution over time |
| "search arguments", "find arguments" | Search | Search for person+topic content |
| "who owns X", "parent company", "ultimate owner", "is X owned by" | Ownership (`--up`) | Trace upward to parents and ultimate owner |
| "subsidiaries of X", "what does X own", "what brands does X own" | Ownership (`--down`) | Trace downward to subsidiaries |
| "sister companies", "co-subsidiaries", "what else does X's parent own" | Ownership (`--siblings`) | Co-subsidiaries of the parent |
| "corporate structure of X", "ownership lineage" | Ownership (combined) | Parents + subsidiaries + siblings in one graph |
| "who funds X", "political donations", "who funds this lawsuit/research", "conflict of interest", "is X independent" | Ownership (`--money`) | Donations, 990 grants, litigation — with explicit attribution basis |

## Examples

```
User: "Map Sam Harris's arguments about free will"
-> bun /Users/[user]/Desktop/projects/argumentmapper/src/cli.ts map "Sam Harris" "free will" --depth standard --markdown

User: "Has Paul Graham's position on startups changed?"
-> bun /Users/[user]/Desktop/projects/argumentmapper/src/cli.ts track "Paul Graham" "startups" --since 2010 --markdown

User: "Verify these claims"
-> bun /Users/[user]/Desktop/projects/argumentmapper/src/cli.ts verify --input profile.json --markdown

User: "Who actually owns Instagram?"
-> bun .../src/cli.ts ownership "Instagram" --up --markdown
   (-> Meta via Wikidata P749, then Mark Zuckerberg [PERSON] at 52.9% voting interest)

User: "What does Nestlé own?"
-> bun .../src/cli.ts ownership "Nestlé S.A." --down --markdown

User: "Who owns Coca-Cola?"
-> bun .../src/cli.ts ownership resolve "Coca-Cola"
   (ambiguous — The Coca-Cola Company vs Coca-Cola Consolidated vs Coca-Cola Europacific.
    Present the candidates and ask; do NOT pick one.)

User: "Who funds Coca-Cola politically?"
-> bun .../src/cli.ts ownership "The Coca-Cola Company" --money --pick cik:0000021344 --markdown
   (9 FEC committees match the name; only C00012468 is theirs. Report the attribution
    basis — do not present the other 8 as Coca-Cola's donations.)
```

## Integration

This skill wraps the standalone application at `/Users/[user]/Desktop/projects/argumentmapper/`.

## Customization

- Depth levels control search breadth and inference cost
- Period granularity affects temporal tracking resolution
- Source classification uses weighted scoring (configurable in classify.ts)

## Voice Notification

After completing operations, notify with results summary.
