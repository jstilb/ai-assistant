# CompareSkill Workflow

Blind A/B comparison — an independent agent judges two skill versions without knowing which is which.

## Steps

### 1. Identify Versions
- Determine what to compare: two skill paths, current vs proposed, two descriptions, etc.
- Load both versions' content

### 2. Strip Identifying Labels
- Present versions as "Option A" and "Option B" only
- Remove any metadata that reveals which is which (file paths, version numbers, dates)

### 3. Generate Test Scenarios
Spawn analyzer subagent using:
```
~/.claude/skills/Development/CreateSkill/EvalAnalyzer.md
```
Generate 10 realistic test scenarios that exercise differences between the versions.

### 4. Blind Comparison
Spawn comparator subagent with instructions from:
```
~/.claude/skills/Development/CreateSkill/EvalComparator.md
```
Feed it:
- Option A content (anonymized)
- Option B content (anonymized)
- The 10 test scenarios

Comparator judges each scenario independently, selecting a winner with rationale.

### 5. Aggregate Judgments
```bash
python3 ~/.claude/skills/Development/CreateSkill/Tools/AggregateBenchmark.py \
  --comparison-mode --results <comparator-output>
```

### 6. Explain Results
Spawn analyzer subagent (`EvalAnalyzer.md`) to explain WHY the winner won — not just that it did. Identify specific strengths and weaknesses per scenario.

### 7. Reveal and Report
- Reveal mapping: Option A = X, Option B = Y
- Report per-scenario breakdown with winner, rationale, and confidence
- Summarize overall recommendation
