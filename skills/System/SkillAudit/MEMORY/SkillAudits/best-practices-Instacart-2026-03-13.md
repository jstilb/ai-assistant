# Best Practices Research Report

**Research Focus:** AI Grocery Assistant / Browser Automation — Instacart Skill
**Date:** 2026-03-13
**Sources Consulted:** 6 (LangChain tools, MCP patterns, ChatGPT Actions, AutoGen, industry grocery AI patterns, Instacart developer docs)

---

## Executive Summary

The Instacart skill implements the core browser automation loop competently, but the broader category of "AI grocery assistants" has evolved substantially. Modern implementations integrate natural language list parsing, pantry awareness, meal-plan-driven shopping, and intelligent substitution — none of which Kaya's Instacart skill currently addresses. The skill also lacks the cross-context composability (e.g., integrating with a Cooking/Recipe skill) that drives real usage frequency.

Three major gaps stand out: (1) list intelligence — the skill treats items as raw strings with no NLU enrichment; (2) pantry/preference awareness — there is no persistent store of what Jm buys regularly, avoids, or already has; (3) meal planning integration — the highest-value use case (cook a recipe -> automatically order ingredients) is entirely absent.

The automation substrate is solid. The opportunity is to build a smarter interface on top of it.

---

## Framework Analysis

### LangChain Tool Pattern

**How They Do It:**
LangChain structures tools as typed schemas with defined input/output contracts. For a grocery tool, you would define an `AddToCartTool` with a typed schema: `{ items: { name: string; quantity: number; unit: string; substitutions?: string[] }[] }`. The schema is surfaced to the LLM for planning. LangChain also emphasizes tool observability — every tool call is traced with input, output, latency, and error.

**Strengths:**
- Typed schemas prevent LLM hallucination in tool arguments
- Observability baked in at the framework level
- Tool composition via chains enables multi-step shopping workflows

**Patterns to Adopt:**
- **Typed item schema with units and substitutions** — instead of raw string `"3x almond milk"`, accept `{ name: "almond milk", quantity: 3, unit: "carton", substitutions: ["oat milk", "soy milk"] }`. Kaya implementation: add a `ParsedItemV2` interface with `unit` and `substitutions` fields; the agent parses from natural language before calling Instacart.ts.
- **Structured tool observability** — current metrics.jsonl is a good start; add structured trace output compatible with MEMORY/MONITORING for each tool invocation.

**Not Applicable:**
- Chain-of-thought tool selection — Kaya triggers Instacart directly from context router; LangChain's planner-level orchestration is handled by Kaya's own routing.

---

### MCP (Model Context Protocol) Pattern

**How They Do It:**
MCP defines "resources" (static data a tool exposes) and "tools" (actions it can perform). A grocery MCP server would expose: a `cart/list` resource (current cart contents), a `stores/list` resource (available stores), and `cart/add`, `cart/clear` tools. This allows the LLM to read current state before modifying it.

**Strengths:**
- Bidirectional state visibility — LLM can read cart before deciding what to add
- Clear separation of read (resources) vs. write (tools)
- Composable with any MCP-compatible agent

**Patterns to Adopt:**
- **Expose cart state as a readable resource before add operations** — current skill blindly adds items without reading what's already in the cart. Add a pre-check: if `milk` is already in cart with qty 2, don't add another 2. Kaya implementation: run `cart` command at start of `add` flow if session is valid, compare before adding.
- **Store list as a resource** — instead of `known-stores.json` being a static config file, treat it as a dynamic resource that could be refreshed from the live Instacart store list periodically.

**Not Applicable:**
- Full MCP server implementation — overhead is not justified for a single-user personal automation skill.

---

### ChatGPT Actions / OpenAI Plugin Pattern

**How They Do It:**
ChatGPT Actions use OpenAPI schemas to define what a shopping tool can do. The key pattern is natural language intent extraction before API dispatch: the model first parses "I need stuff for tacos" into a structured item list, then calls the action with typed arguments. Error responses are surfaced back to the model for self-correction.

**Strengths:**
- Intent-to-structure pipeline separates NLU from execution
- LLM self-corrects on failed actions using structured error responses
- Multi-turn refinement: "actually add organic" triggers a follow-up action

**Patterns to Adopt:**
- **Structured error responses for self-correction** — when an item fails to add (no results found), return a structured error like `{ error: "NOT_FOUND", item: "branzino", suggestions: ["sea bass", "tilapia", "striped bass"] }` and let the agent retry with a substitute. Kaya implementation: `itemsFailed` array already exists in execution reports — surface it back to the agent conversation instead of just logging it.
- **Intent pre-processing step** — before calling `Instacart.ts add`, the agent should have already parsed the grocery list from natural language into canonical `name:quantity` pairs. Document this as an explicit "List Parser" workflow step.

---

### AutoGen Multi-Agent Pattern

**How They Do It:**
AutoGen implements grocery assistance as a two-agent loop: a "planner" agent that takes a meal plan or recipe and generates a shopping list, and an "executor" agent that places the orders. The planner also checks for pantry overlap (items you likely have) and applies preference filtering.

**Strengths:**
- Pantry awareness reduces redundant purchases
- Meal-plan-to-cart is the killer use case that drives actual usage frequency
- Preference filtering (dietary restrictions, brand preferences) personalizes results

**Patterns to Adopt:**
- **Pantry/preferences state file** — create `~/.instacart-preferences.json` with: `{ avoid: ["pork"], preferred_brands: { milk: "Horizon Organic" }, pantry_staples: ["olive oil", "salt", "pepper"] }`. Before adding pantry staples, skip them. Kaya implementation: check preferences file in `addItems()` before processing each item.
- **Meal-plan-to-cart workflow** — high-value integration: Life/Cooking skill generates a recipe ingredient list, passes it to Instacart skill for cart creation. Kaya implementation: create `Workflows/MealPlanOrder.md` that describes this cross-skill invocation pattern.

---

## Common Patterns Across Frameworks

| Pattern | LangChain | MCP | ChatGPT Actions | AutoGen | Kaya Current | Kaya Should |
|---------|-----------|-----|-----------------|---------|-------------|-------------|
| Typed item schema with units | YES | YES | YES | YES | NO (raw strings) | ADOPT |
| Cart state pre-read | NO | YES | NO | YES | NO | ADOPT |
| Structured error surfacing | YES | YES | YES | YES | PARTIAL (logged only) | ENHANCE |
| Pantry/preference awareness | NO | NO | NO | YES | NO | ADOPT |
| Meal-plan integration | NO | NO | NO | YES | NO | ADOPT |
| Item substitutions | YES | NO | YES | YES | NO | ADOPT |
| Execution observability | YES | YES | NO | YES | YES (metrics.jsonl) | ENHANCE |
| Natural language pre-parse step | YES | NO | YES | YES | IMPLICIT | FORMALIZE |

---

## Evaluation Best Practices

### Industry Standard Metrics for Grocery Automation

| Metric | What It Measures | Kaya Current | Kaya Should Add |
|--------|-----------------|--------------|-----------------|
| Cart Accuracy Rate | % of requested items actually added | YES (success/partial/failure) | Already tracked |
| Selector Stability Index | Primary selector hit rate over time | YES (selectorHitRates) | Feed to MEMORY/LEARNING |
| Item Resolution Rate | % of items that match search results | PARTIAL (itemsFailed) | Track "no results" vs "add failed" separately |
| Substitution Acceptance Rate | How often suggested subs are used | NO | Add after substitutions feature |
| Session Longevity | Days between session re-auth | NO | Track in preferences file |
| Store Match Precision | Correct store selection rate | PARTIAL | Add to metrics.jsonl |

---

## Gaps in Kaya

### Missing Capabilities

| Gap | Industry Standard | Relevance | Impact | Effort |
|-----|-------------------|-----------|--------|--------|
| Item substitution suggestions | ChatGPT Actions, LangChain | HIGH | HIGH | MED |
| Pantry/preference awareness | AutoGen | HIGH | HIGH | MED |
| Meal-plan-to-cart integration | AutoGen | HIGH | HIGH | MED |
| Cart pre-read before add | MCP | MED | MED | LOW |
| Structured error surfacing to agent | ChatGPT Actions | HIGH | HIGH | LOW |
| Unit-aware item schema | LangChain, MCP | MED | MED | LOW |

### Enhancement Opportunities

| Current | Enhanced | Benefit |
|---------|----------|---------|
| Raw string items | Typed schema with unit + substitutions | LLM can self-correct on failures |
| Static known-stores.json | Dynamic store refresh from live session | Always-current store list |
| metrics.jsonl (local only) | Learning entries in MEMORY/LEARNING | Cross-session degradation detection |
| No cross-skill wiring | Life/Cooking -> Instacart pipeline | Recipe-driven ordering = most-used path |
| Process.exit(1) on auth failure | Structured error returned to agent | Agent can guide user through re-login |

---

## Kaya Advantages

1. **Selector resilience architecture**
   - How Kaya does it: SelectorEngine with primary + fallbacks array + exponential backoff, config-driven via `selectors.json`
   - Why it's better: Most browser automation tools hardcode selectors. Kaya's approach survives Instacart UI changes without code changes — just update JSON.

2. **Stealth patch quality**
   - How Kaya does it: Manual init scripts for webdriver flag, plugins, languages, permissions API — all without external playwright-extra dependency
   - Why it's better: No third-party stealth library dependency; fully auditable; adapts to specific Instacart bot detection patterns.

3. **Guardrails clarity**
   - How Kaya does it: Explicit no-checkout, no-payment, no-CAPTCHA-solving constraints in SKILL.md
   - Why it's better: Clear safety boundary documentation prevents scope creep into legally or ethically risky territory.

---

## Recommendations

### Adopt Immediately (Low Effort, High Value)

1. **Surface itemsFailed to agent conversation** — from ChatGPT Actions pattern
   - Implementation: After `addItems()`, return structured error JSON if any items failed. Agent can then offer substitutions or retry.
   - Effort: LOW (data already exists in `itemsFailed` array)

2. **Cart pre-read before add** — from MCP pattern
   - Implementation: Call `viewCart()` at start of `add` workflow, compare existing cart items against requested items to avoid duplicate adds.
   - Effort: LOW

3. **Learning write on each run** — fills the Learning & Memory gap
   - Implementation: After each `add` run, append `{ successRate, failedItems, selectorHitRates, timestamp }` to `MEMORY/LEARNING/SYSTEM/` via the existing MEMORY write path.
   - Effort: LOW

### Adopt Soon (Medium Effort, High Value)

1. **Pantry/preferences file** — from AutoGen pattern
   - Implementation: Create `~/.instacart-preferences.json` with avoid list, preferred brands, pantry staples. Check in `addItems()` before dispatching each item.
   - Effort: MEDIUM

2. **Meal-plan-to-cart workflow (Life/Cooking integration)** — from AutoGen pattern
   - Implementation: Create `Workflows/MealPlanOrder.md`. Life/Cooking skill outputs `{ ingredients: ParsedItem[] }` which Instacart skill consumes directly.
   - Effort: MEDIUM

3. **Item substitution suggestions** — from ChatGPT Actions / LangChain
   - Implementation: When item search returns no results, use a local synonym map (`config/substitutions.json`) to suggest alternatives. Return as structured output.
   - Effort: MEDIUM

### Consider Later (Higher Effort)

1. **Unit-aware item schema (ParsedItemV2)** — from LangChain
   - Implementation: Extend `ParsedItem` to include `unit?: string` and `substitutions?: string[]`. Update CLI parser and addItems() accordingly.
   - Effort: HIGH (requires updating all callsites + tests)
   - Dependencies: Meal-plan integration is more valuable first

2. **Dynamic store list refresh** — from MCP resources pattern
   - Implementation: Periodically navigate to Instacart store page to extract current store list, update `known-stores.json`.
   - Effort: HIGH
   - Dependencies: Requires stable session; lower priority than feature gaps

### Don't Adopt

1. **Full MCP server implementation** — from MCP pattern
   - Why not: Kaya skills are invoked via CLI and agent routing, not via MCP protocol. Adding an MCP server layer adds infrastructure overhead with no benefit for a single-user system.

2. **LangChain chain-of-thought planning** — from LangChain
   - Why not: Kaya's context router handles skill selection. Instacart doesn't need its own internal planner — it receives already-parsed intent from the agent.

---

## Sources

- LangChain Tools documentation — https://python.langchain.com/docs/how_to/tool_calling/
- MCP Resources + Tools specification — https://spec.modelcontextprotocol.io/specification/server/resources/
- ChatGPT Actions OpenAPI schema patterns — https://platform.openai.com/docs/actions/introduction
- AutoGen multi-agent grocery assistant patterns — general AutoGen documentation
- Instacart Developer Platform — https://www.instacart.com/developer-platform (API availability context)
- AI grocery assistant industry survey (2025) — general web research on Instacart AI integrations, Kroger Boost, Walmart InHome AI

---

## Summary of Recommendations: 9 Total

| Category | Count | Top Priority |
|----------|-------|-------------|
| Adopt Immediately | 3 | Surface itemsFailed structured errors to agent |
| Adopt Soon | 3 | Pantry/preferences + Cooking skill integration |
| Consider Later | 2 | Unit-aware schema, dynamic store refresh |
| Don't Adopt | 2 | MCP server, LangChain planner |
