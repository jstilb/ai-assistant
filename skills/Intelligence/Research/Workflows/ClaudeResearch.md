# Claude WebSearch Research Workflow

Single-agent research using Claude's built-in WebSearch tool. Free, no API keys required.

## When to Use

- Simple, focused research questions
- When external APIs are unavailable
- Quick fact-checking
- When you want Claude-only sources

## Execution

### Step 1: Query Decomposition (Optional)

For complex questions, use the query decomposition tool:

```bash
bun ~/.claude/skills/Intelligence/Research/Tools/ClaudeResearch.ts "your research question"
```

This generates 4-8 targeted sub-queries for comprehensive coverage.

### Step 2: Execute WebSearch

**Simple Query:**
```typescript
// Single focused search
WebSearch({ query: "your research question" })
```

**Multi-Query Pattern:**
```typescript
// Execute multiple angles in parallel
const queries = [
  "topic overview background",
  "topic latest developments 2026",
  "topic expert analysis",
  "topic practical implications"
];

// Use Task tool for parallel execution
queries.forEach(q => {
  Task({
    subagent_type: "ClaudeResearcher",
    prompt: `WebSearch for: "${q}". Return key findings.`
  })
})
```

### Step 3: URL Verification

**MANDATORY** before including any URLs in output:

```bash
bun ~/.claude/skills/Intelligence/Research/Tools/UrlVerifier.ts "https://example.com"
```

Or batch verify:
```bash
echo '["url1", "url2"]' | bun ~/.claude/skills/Intelligence/Research/Tools/UrlVerifier.ts --batch
```

### Step 4: Synthesize Results

Combine findings into structured output following Examples/QuickResearchOutput.md format.

## Output Format

```markdown
## Research Findings: [Topic]

### Key Points
1. [Finding with source]
2. [Finding with source]
...

### Sources
- [Title](verified-url) ✓
- [Title](verified-url) ✓

---
**Verification:** All URLs verified
**Duration:** Xs
**Agent:** ClaudeResearcher
```

## Advantages

- **Free:** Uses Claude's built-in WebSearch
- **Fast:** Single agent, minimal overhead
- **Integrated:** Leverages Claude's reasoning
- **No API keys:** Works out of the box

## Limitations

- Single perspective (Claude only)
- May miss specialized sources
- No parallel multi-model coverage

For deeper research, use `StandardResearch.md` or `ExtensiveResearch.md`.
