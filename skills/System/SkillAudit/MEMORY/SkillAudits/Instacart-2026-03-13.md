---
skill: Commerce/Instacart
date: 2026-03-13
overallScore: 6.0
overallHealth: YELLOW
auditor: ComprehensiveAudit v1
duration: ~8 min
checksRun: 7
evaluationsRun: 4
priorAuditDate: null
priorOverallScore: null
priorOverallHealth: null
p1Count: 1
p2Count: 3
p3Count: 4
---

# Skill Audit: Commerce/Instacart

**Date:** 2026-03-13
**Overall Score:** 6.0 / 10
**Health:** YELLOW
**P1 Findings:** 1 | **P2 Findings:** 3 | **P3 Findings:** 4

---

## Executive Summary

Instacart is a well-implemented browser automation skill with solid code quality, clean architecture, and meaningful test coverage. The core automation logic (Playwright stealth, selector engine, quantity parsing, store matching) is production-grade — the refactor completed 2026-02-10 paid dividends. The skill scores **YELLOW** primarily because it lacks workflow documentation files (Workflows/*.md), has no learning/memory integration despite having rich execution data, and the ValidityAssessor detects no cross-skill references (though MEMORY/WORK confirms 2 recent sessions today). One P1 finding: the absence of Workflows/ directory means agent routing cannot discover behavioral contracts for this skill.

No trigger overlaps with other skills exist (TriggerAnalyzer threshold 40% — clean). Code conventions are largely sound with two minor config-read patterns flagged (resolved as acceptable per Phase 2.5 review). Agent balance is excellent: 203 deterministic ops, 0 inferential ops.

---

## Dimension Scores

| # | Dimension | Score | Health | Key Finding |
|---|-----------|-------|--------|-------------|
| 1 | Behavioral Fidelity | 4 | YELLOW | No Workflows/ directory — 8 commands undocumented as .md files |
| 2 | Implementation Quality | 8 | GREEN | Strong SKILL.md; missing workflow routing table (SKILL.md has command table but StructuralScorer looks for Workflows/) |
| 3 | Integration Fitness | 5 | YELLOW | Playwright/NotificationService/SelectorEngine wired in code; 0 hook integrations; usedBy list is empty |
| 4 | Skill Validity | 5 | YELLOW | 2 recent MEMORY/WORK sessions today; no cross-skill references; ValidityAssessor scored low due to reference absence |
| 5 | Context Efficiency | 8 | GREEN | 8 triggers, 2 ambiguous (add, list) — LOW risk; description 7 chars over 200-char threshold |
| 6 | Code Hygiene | 9 | GREEN | IDEAS.md at skill root (false positive — intentional planning doc). No stale refs, no TODOs, no dead exports |
| 7 | Refactoring Need | 7 | GREEN | 2 config readFileSync calls (read-only static config — downgraded from P1 to LOW per Phase 2.5); no `any`, no ts-ignore |
| 8 | Context Routing | 9 | GREEN | Zero trigger overlap with any other skill at 40% threshold |
| 9 | Complexity | 9 | GREEN | Clean architecture; one 6-param function candidate for options-object refactor |
| 10 | Learning & Memory | 2 | RED | Execution metrics written to JSONL (good); zero learning integration — success rates, selector failures, frequently-failing stores never feed MEMORY/LEARNING |
| 11 | Agent Balance | 10 | GREEN | 203 deterministic / 0 inferential — exactly right for automation skill |

**Weighted Overall Score: 6.0**

> Health determination: Learning & Memory scores 2 (RED). Two additional dimensions below 6 (Behavioral Fidelity: 4, Validity: 5). This meets YELLOW threshold (>=2 dims below 6) but avoids RED (only 1 dim is <3). Result: **YELLOW**.

---

## Phase 2.5 False Positive Corrections

| Finding | Original Severity | Disposition | Rationale |
|---------|------------------|-------------|-----------|
| IDEAS.md orphaned file | MEDIUM | FALSE POSITIVE | Intentional planning document at skill root; not dead code |
| rawJsonParse in Instacart.ts:68 | HIGH (P1) | DOWNGRADED to LOW | Reads `known-stores.json` — static read-only config, not mutable state |
| rawJsonParse in stealth.ts:20 | HIGH (P1) | DOWNGRADED to LOW | Reads `ua-pool.json` — static read-only config, not mutable state |
| Integration implementation "none" in BehaviorVerifier | MEDIUM | FALSE POSITIVE | Verifier scans Workflows/*.md for imports; code in Instacart.ts clearly imports all 3 integrations |

---

## Findings Detail

### P1 Findings

**P1-001: No Workflows/ Directory**
- **Dimension:** #1 Behavioral Fidelity
- **Description:** The skill documents 8 commands in SKILL.md but has zero `Workflows/*.md` files. Agent routing and BehaviorVerifier cannot discover behavioral contracts. Skill cannot be composed with orchestration patterns.
- **Evidence:** `ls Instacart/` shows no Workflows/ directory; BehaviorVerifier found 0 workflow implementations.
- **Recommendation:** Create `Workflows/` directory with at minimum: `AddItems.md`, `Login.md`, `CartView.md`, `StatusCheck.md`
- **Effort:** M | **Impact:** HIGH

---

### P2 Findings

**P2-001: No Learning Integration Despite Rich Execution Data**
- **Dimension:** #10 Learning & Memory
- **Description:** The skill writes detailed `metrics.jsonl` (selector hit rates, success rates, per-item durations, bot detection events) but never pushes any of this to `MEMORY/LEARNING/`. Over time, selector degradation patterns, frequently-failing stores, and common CAPTCHA triggers are lost between sessions.
- **Recommendation:** After each `add` run, write a learning entry with success rate trend + any selector failures to `MEMORY/LEARNING/SYSTEM/` so future sessions can pre-warn about degraded selectors.
- **Effort:** S | **Impact:** HIGH

**P2-002: Validity Signal — No Cross-Skill References**
- **Dimension:** #4 Skill Validity
- **Description:** No other skills, hooks, or orchestration layers reference this skill. Two MEMORY/WORK sessions today confirm recent usage, but the skill is not composable (no usedBy connections). A Life/Cooking skill integrating with Instacart for automated ingredient ordering would be high value.
- **Recommendation:** Connect to Life/Cooking skill for recipe-driven shopping lists. Consider a meal-plan-to-cart workflow.
- **Effort:** M | **Impact:** MEDIUM

**P2-003: Ambiguous Triggers ("add", "list")**
- **Dimension:** #5 Context Efficiency
- **Description:** Two triggers ("add" and "list") are single-word, high-ambiguity terms that could fire the skill incorrectly on unrelated tasks.
- **Recommendation:** Replace "add" with "add to instacart" or "add groceries"; replace "list" (if present in description) with "grocery list".
- **Effort:** S | **Impact:** MEDIUM

---

### P3 Findings

**P3-001: Workflow Routing Table Uses Command Format, Not Workflow-File Format**
- **Dimension:** #2 Implementation Quality
- **Description:** SKILL.md has a "Workflow Routing" table mapping commands to actions — but StructuralScorer expects it to map trigger phrases to Workflows/*.md files. This is a documentation gap, not a code defect.
- **Effort:** S | **Impact:** LOW

**P3-002: addItems() Has 4 Parameters — Consider Options Object**
- **Dimension:** #9 Complexity
- **Description:** `addItems(rawItems, globalQuantity, headless, storeName)` has 4 parameters. TypeScript callers can silently misorder arguments. An `AddItemsOptions` interface would be safer.
- **Effort:** S | **Impact:** LOW

**P3-003: No Simulation Scenario**
- **Dimension:** #1 Behavioral Fidelity (secondary)
- **Description:** No chaos/resilience scenario in `System/Simulation/Scenarios/` for CAPTCHA handling, session expiry, or selector failure paths.
- **Effort:** S | **Impact:** LOW

**P3-004: Description Length 207 chars (threshold: 200)**
- **Dimension:** #5 Context Efficiency
- **Description:** Minor — 7 characters over the 200-char guideline. Tighten description slightly.
- **Effort:** XS | **Impact:** LOW

---

## Action Items

| Priority | Action | Dimension | Effort | Impact |
|----------|--------|-----------|--------|--------|
| P1 | Create Workflows/ directory with AddItems.md, Login.md, CartView.md, StatusCheck.md | #1 Behavioral Fidelity | M | HIGH |
| P2 | Add learning write on each run: success rate + selector failure data to MEMORY/LEARNING/SYSTEM/ | #10 Learning & Memory | S | HIGH |
| P2 | Connect to Life/Cooking skill — recipe-driven ingredient cart creation | #4 Skill Validity | M | MEDIUM |
| P2 | Remove/replace ambiguous triggers: "add" -> "add groceries", review "list" | #5 Context Efficiency | S | MEDIUM |
| P3 | Refactor workflow routing table in SKILL.md to reference Workflows/*.md files | #2 Implementation Quality | S | LOW |
| P3 | Refactor addItems() to accept AddItemsOptions object | #9 Complexity | S | LOW |
| P3 | Create Simulation scenario for CAPTCHA and session-expiry resilience | #1 Behavioral Fidelity | S | LOW |
| P3 | Trim description to <=200 chars | #5 Context Efficiency | XS | LOW |

---

## Strengths

- **Excellent stealth implementation**: Playwright stealth patches (webdriver removal, plugin spoofing, permissions API override) are production-quality anti-detection.
- **Selector resilience**: SelectorEngine with exponential backoff + fallback array is the right pattern for UI automation against a frequently-changing site.
- **Metrics instrumentation**: `metrics.jsonl` with per-selector hit rates and success rates is exactly the data needed for proactive maintenance. Just needs to flow into MEMORY/LEARNING.
- **Clean module boundaries**: `item-utils.ts`, `selector-engine.ts`, `stealth.ts`, `store-matcher.ts` are all well-separated with unit tests. 44 tests confirmed passing (per 2026-02-10 refactor commit).
- **Guardrails documented**: No checkout/payment, no CAPTCHA solving, 50-item cap — clear safety constraints in SKILL.md.
- **Zero trigger overlap**: Unique trigger space — no routing confusion with any other skill.

---

## Prior Context

No prior audit report found (first audit for this skill).

Prior learning signals from MEMORY (informational only):
- 2026-02-05: Previous audit by batch agent rated skill 5/10
- 2026-02-10: Major refactor completed (44 tests, 1991 insertions, 13 files changed, commit 300645e6) — significant quality improvement
- 2026-03-13: Two MEMORY/WORK sessions ("help-with-instacart-order", "set-up-or-use-instacart") confirming active use today

---

## Metadata

- **Duration:** ~8 min
- **Checks run:** 7 (StructuralScorer, DeadCodeDetector, ContextCostAnalyzer, ConventionChecker, RedundancyDetector, TriggerAnalyzer, DependencyMapper)
- **Evaluations run:** 4 (BehaviorVerifier, IntegrationOpportunityFinder, ValidityAssessor, ComplexityEvaluator)
- **False positives discarded:** 4
- **Tool count:** 8 files (5 implementation + 3 test files)
- **Total LOC:** ~1,899 (across all tools)
- **Last skill update:** 2026-02-10
