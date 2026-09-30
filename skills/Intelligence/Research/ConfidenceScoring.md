# Confidence Scoring Framework

**Required for all research outputs.** Every research answer must include a confidence assessment and source tier attribution.

---

## Confidence Levels

| Level | Badge | Criteria | Meaning |
|-------|-------|----------|---------|
| **High** | `🟢 HIGH` | 3+ independent sources agree, verified data, authoritative sources | Strong consensus, safe to act on |
| **Medium** | `🟡 MEDIUM` | 1-2 sources, some verification, or sources partially agree | Reasonable confidence, verify for high-stakes decisions |
| **Low** | `🔴 LOW` | Single source, unverified, or sources disagree significantly | Treat as preliminary, needs more research |

## Determining Confidence

### Scoring Factors

1. **Source Count** — How many independent sources support this finding?
   - 3+ sources = +2 points
   - 2 sources = +1 point
   - 1 source = 0 points

2. **Source Authority** — What tier are the sources? (see Source Tiers below)
   - Majority Tier 1-2 = +2 points
   - Mix of tiers = +1 point
   - Majority Tier 3-4 = 0 points

3. **Source Agreement** — Do sources agree or conflict?
   - Strong agreement = +2 points
   - Partial agreement = +1 point
   - Disagreement = -1 point (flag as conflict)

4. **Freshness** — How recent is the information?
   - Within 30 days = +1 point
   - Within 1 year = 0 points
   - Older than 1 year = -1 point (for time-sensitive topics)

### Score → Confidence Mapping

| Total Points | Confidence Level |
|-------------|-----------------|
| 5+ | HIGH |
| 3-4 | MEDIUM |
| 0-2 | LOW |

---

## Source Tiers

### Tier 1: Verified/Authoritative
Primary sources with institutional backing. Highest trust.

| Domain | Tier 1 Sources |
|--------|---------------|
| Health | Peer-reviewed journals, NIH, WHO, Mayo Clinic, CDC |
| Technology | Official documentation, vendor specs, RFC standards |
| Finance | SEC filings, Federal Reserve, official company reports |
| Legal | Court rulings, statutory text, bar associations |
| Science | Nature, Science, PNAS, ArXiv (with peer review) |
| Products | Manufacturer specs, FCC/UL certifications |

### Tier 2: Reputable/Editorial
Professional journalism and expert analysis. High trust with editorial oversight.

| Domain | Tier 2 Sources |
|--------|---------------|
| Health | WebMD, Cleveland Clinic, medical textbooks |
| Technology | Ars Technica, The Verge, Wired, TechCrunch |
| Finance | Bloomberg, Reuters, WSJ, Financial Times |
| General | AP, Reuters, NYT, WaPo, BBC |
| Products | Consumer Reports, Wirecutter, professional reviews |
| Science | Scientific American, New Scientist |

### Tier 3: Community/Forum
User-generated content with reputation systems. Moderate trust.

| Domain | Tier 3 Sources |
|--------|---------------|
| Technology | Stack Overflow, GitHub discussions, HN |
| Products | Amazon verified purchases, Reddit reviews |
| Health | Patient forums, health communities |
| General | Reddit, Quora, specialist forums |
| Travel | TripAdvisor, Google Reviews |

### Tier 4: Inferred/AI-Generated
AI synthesis, inference, or unverifiable claims. Low trust.

| Domain | Tier 4 Sources |
|--------|---------------|
| Any | AI model responses without citations |
| Any | Unattributed blog posts |
| Any | Social media posts without verification |
| Any | SEO content farms |

---

## Conflict Detection

When sources disagree, flag it explicitly:

```markdown
⚠️ **Source Conflict:** Reviews say battery lasts 8hrs but manufacturer specs say 6hrs.
Tier 1 (specs) vs Tier 3 (reviews) — specs likely measure differently. Verify usage conditions.
```

### Conflict Severity

| Severity | When | Action |
|----------|------|--------|
| **Minor** | Tier 3-4 disagrees with Tier 1-2 | Note it, defer to higher tier |
| **Notable** | Two Tier 2 sources disagree | Flag both perspectives, let user decide |
| **Major** | Tier 1 sources contradict each other | Highlight prominently, investigate further |

---

## Output Format

### Per-Finding Confidence

```markdown
**[Finding statement]**
- Confidence: 🟢 HIGH — 4 sources agree (2× Tier 1, 2× Tier 2)
- Sources: [Nature 2025], [NIH Database], [Scientific American], [Reuters]
```

### Research Summary Confidence

At the end of every research output, include:

```markdown
## Confidence Assessment

| Finding | Confidence | Sources | Notes |
|---------|-----------|---------|-------|
| [Finding 1] | 🟢 HIGH | 4 sources (T1-T2) | Strong consensus |
| [Finding 2] | 🟡 MEDIUM | 2 sources (T2-T3) | Limited data |
| [Finding 3] | 🔴 LOW | 1 source (T3) | Needs verification |

**Overall Confidence:** 🟡 MEDIUM — Most findings have 2+ sources but some gaps remain.
**Source Conflicts:** 1 notable conflict flagged above.
```

---

## Integration with Research Modes

### Quick Research (1 agent)
- Default confidence cap: MEDIUM (single source type)
- Exception: Can be HIGH if finding is from Tier 1 with clear data

### Standard Research (2-3 agents)
- Can achieve HIGH confidence through cross-validation
- Flag when agents disagree as a signal

### Extensive Research (9 agents)
- Best chance for HIGH confidence
- Cross-validate across researcher types (Claude/Gemini/Grok)
- Disagreements between researcher types are notable signals

---

## Domain-Specific Source Hierarchies

When researching in these domains, apply the domain-specific tier ordering:

### Shopping/Products
1. Verified purchase reviews (Amazon, Best Buy)
2. Professional reviewers (Wirecutter, RTINGS, Consumer Reports)
3. YouTube reviewers with hands-on testing
4. Forum discussions and Reddit threads
5. SEO comparison sites (lowest trust)

### Health/Medical
1. Peer-reviewed journals, systematic reviews
2. NIH, WHO, CDC guidelines
3. Medical institution sites (Mayo, Cleveland Clinic)
4. Health journalism (Stat News, medical sections of major papers)
5. Patient forums and anecdotal reports

### Travel
1. Official tourism boards, embassy info
2. Reputable travel publications (Lonely Planet, Condé Nast Traveler)
3. Recent traveler reviews (TripAdvisor, Google Maps)
4. Travel blogs with recent dates
5. Social media posts

### Technology/Software
1. Official documentation, changelogs, specs
2. Technical journalism with testing methodology
3. GitHub issues, Stack Overflow with accepted answers
4. Blog posts from recognized engineers
5. Tutorial sites and aggregators
