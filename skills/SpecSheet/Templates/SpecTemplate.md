# {{AGENT_NAME}} Specification

> **Version:** 1.0.0
> **Status:** Draft | Review | Approved
> **Owner:** {{OWNER}}
> **Created:** {{DATE}}
> **Last Updated:** {{DATE}}

---

## Overview

**Purpose:** {{PURPOSE_ONE_SENTENCE}}

**Type:** {{AGENT_TYPE}}
- [ ] Autonomous Agent
- [ ] Task Executor
- [ ] Assistant/Copilot
- [ ] Pipeline Component

**Summary:** {{2_3_SENTENCE_DESCRIPTION}}

---

## 1. Commands & Capabilities

### 1.1 Primary Capability

{{PRIMARY_CAPABILITY_DESCRIPTION}}

**Core Operation:**
```
Input: {{INPUT_DESCRIPTION}}
Process: {{PROCESS_DESCRIPTION}}
Output: {{OUTPUT_DESCRIPTION}}
```

### 1.2 Supporting Capabilities

| Capability | Purpose | Priority |
|------------|---------|----------|
| {{CAPABILITY_1}} | {{PURPOSE}} | Critical / Important / Nice-to-have |
| {{CAPABILITY_2}} | {{PURPOSE}} | Critical / Important / Nice-to-have |
| {{CAPABILITY_3}} | {{PURPOSE}} | Critical / Important / Nice-to-have |

### 1.3 Required Tools & APIs

| Tool/API | Purpose | Access Level |
|----------|---------|--------------|
| {{TOOL_1}} | {{PURPOSE}} | Read / Write / Execute |
| {{TOOL_2}} | {{PURPOSE}} | Read / Write / Execute |

### 1.4 Capability Boundaries

**In Scope:**
- {{IN_SCOPE_1}}
- {{IN_SCOPE_2}}

**Out of Scope:**
- {{OUT_OF_SCOPE_1}}
- {{OUT_OF_SCOPE_2}}

---

## 2. Testing & Validation

### 2.1 Success Criteria

| Criterion | Measurement | Target |
|-----------|-------------|--------|
| Accuracy | {{HOW_MEASURED}} | ≥{{PERCENTAGE}}% |
| Completion Rate | Tasks completed successfully | ≥{{PERCENTAGE}}% |
| Response Time | End-to-end latency | <{{TIME}}s |
| Error Rate | Failed operations | <{{PERCENTAGE}}% |

### 2.2 Test Cases

**Critical Path Tests** (must always pass):

```
TEST 1: {{TEST_NAME}}
Given: {{PRECONDITIONS}}
When: {{ACTION}}
Then: {{EXPECTED_RESULT}}
```

```
TEST 2: {{TEST_NAME}}
Given: {{PRECONDITIONS}}
When: {{ACTION}}
Then: {{EXPECTED_RESULT}}
```

**Edge Cases:**

```
EDGE 1: {{EDGE_CASE_NAME}}
Input: {{UNUSUAL_INPUT}}
Expected: {{EXPECTED_HANDLING}}
```

### 2.3 Failure Modes

| Failure Type | Detection | Recovery |
|--------------|-----------|----------|
| {{FAILURE_1}} | {{HOW_DETECTED}} | {{RECOVERY_ACTION}} |
| {{FAILURE_2}} | {{HOW_DETECTED}} | {{RECOVERY_ACTION}} |

### 2.4 Quality Metrics

- **Hallucination Rate:** <{{PERCENTAGE}}% (fabricated information)
- **Consistency:** Same input → same output class
- **Explainability:** Reasoning is traceable

---

## 3. Structure & Context

### 3.1 Required Context

| Context Type | Source | Refresh Rate |
|--------------|--------|--------------|
| {{CONTEXT_1}} | {{SOURCE}} | Static / Session / Real-time |
| {{CONTEXT_2}} | {{SOURCE}} | Static / Session / Real-time |

### 3.2 Input Specification

**Format:** {{FORMAT}} (Natural Language / JSON / YAML / Files / Mixed)

**Schema:**
```{{SCHEMA_FORMAT}}
{{INPUT_SCHEMA}}
```

**Validation Rules:**
- {{VALIDATION_RULE_1}}
- {{VALIDATION_RULE_2}}

**Example Input:**
```{{EXAMPLE_FORMAT}}
{{EXAMPLE_INPUT}}
```

### 3.3 Output Specification

**Format:** {{FORMAT}}

**Schema:**
```{{SCHEMA_FORMAT}}
{{OUTPUT_SCHEMA}}
```

**Example Output:**
```{{EXAMPLE_FORMAT}}
{{EXAMPLE_OUTPUT}}
```

### 3.4 Domain Knowledge

**Required Understanding:**
- {{DOMAIN_KNOWLEDGE_1}}
- {{DOMAIN_KNOWLEDGE_2}}

**Reference Materials:**
- {{REFERENCE_1}}
- {{REFERENCE_2}}

---

## 4. Style & Behavior

### 4.1 Communication Style

**Tone:** {{TONE}} (Professional / Friendly / Technical / Concise / Thorough)

**Voice Characteristics:**
- {{CHARACTERISTIC_1}}
- {{CHARACTERISTIC_2}}

**Verbosity Level:** {{VERBOSITY}} (Silent / Minimal / Standard / Verbose)

### 4.2 Formatting Requirements

**Structure:**
```
{{OUTPUT_STRUCTURE_TEMPLATE}}
```

**Constraints:**
- Max response length: {{LENGTH}}
- Required sections: {{REQUIRED_SECTIONS}}
- Forbidden patterns: {{FORBIDDEN_PATTERNS}}

### 4.3 Persona (if applicable)

**Identity:** {{PERSONA_NAME}}
**Background:** {{BACKGROUND}}
**Personality Traits:** {{TRAITS}}

---

## 5. Workflow & Process

### 5.1 Execution Pattern

**Type:** {{EXECUTION_TYPE}} (Single-shot / Iterative / Multi-step / Parallel / Interactive)

**Flow Diagram:**
```
┌─────────────┐
│   INPUT     │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  {{STEP_1}} │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  {{STEP_2}} │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│   OUTPUT    │
└─────────────┘
```

### 5.2 Step-by-Step Process

1. **{{STEP_1_NAME}}**
   - Action: {{ACTION}}
   - Input: {{INPUT}}
   - Output: {{OUTPUT}}
   - Duration: {{EXPECTED_TIME}}

2. **{{STEP_2_NAME}}**
   - Action: {{ACTION}}
   - Input: {{INPUT}}
   - Output: {{OUTPUT}}
   - Duration: {{EXPECTED_TIME}}

### 5.3 Decision Points

| Decision Point | Condition | Action A | Action B |
|----------------|-----------|----------|----------|
| {{DECISION_1}} | {{CONDITION}} | {{ACTION_A}} | {{ACTION_B}} |
| {{DECISION_2}} | {{CONDITION}} | {{ACTION_A}} | {{ACTION_B}} |

### 5.4 Ambiguity Handling

**Strategy:** {{STRATEGY}} (Ask / Best Judgment / Conservative / Multiple Attempts)

**Confidence Threshold:** {{THRESHOLD}}% - below this, escalate or ask

### 5.5 Escalation Triggers

| Trigger | Condition | Action |
|---------|-----------|--------|
| Uncertainty | Confidence < {{THRESHOLD}}% | {{ACTION}} |
| High Impact | {{CRITERIA}} | {{ACTION}} |
| Error | {{ERROR_TYPE}} | {{ACTION}} |

---

## 6. Boundaries & Guardrails

### 6.1 ✅ Always (No Approval Required)

Actions the agent can take autonomously:

- {{ALWAYS_1}}
- {{ALWAYS_2}}
- {{ALWAYS_3}}

### 6.2 ⚠️ Ask First (Requires Confirmation)

Actions that need human approval before proceeding:

- {{ASK_FIRST_1}}
- {{ASK_FIRST_2}}
- {{ASK_FIRST_3}}

**Approval Format:**
```
⚠️ APPROVAL REQUIRED
Action: {{ACTION_DESCRIPTION}}
Reason: {{WHY_APPROVAL_NEEDED}}
Impact: {{POTENTIAL_IMPACT}}
[Approve] [Deny] [Modify]
```

### 6.3 🚫 Never (Absolutely Prohibited)

Actions that must NEVER occur under any circumstances:

- {{NEVER_1}}
- {{NEVER_2}}
- {{NEVER_3}}

**Enforcement:** Hard-coded blocks, no override possible

### 6.4 Safety Mechanisms

| Mechanism | Purpose | Implementation |
|-----------|---------|----------------|
| Input Validation | Prevent injection | {{HOW}} |
| Output Filtering | Prevent leakage | {{HOW}} |
| Rate Limiting | Prevent abuse | {{LIMITS}} |
| Audit Logging | Traceability | {{WHAT_LOGGED}} |

---

## 7. Integration

### 7.1 Dependencies

| Dependency | Type | Required | Fallback |
|------------|------|----------|----------|
| {{DEP_1}} | Service / Library / API | Yes/No | {{FALLBACK}} |
| {{DEP_2}} | Service / Library / API | Yes/No | {{FALLBACK}} |

### 7.2 Feeds Into

| Consumer | Data Provided | Format |
|----------|---------------|--------|
| {{CONSUMER_1}} | {{DATA}} | {{FORMAT}} |
| {{CONSUMER_2}} | {{DATA}} | {{FORMAT}} |

### 7.3 MCPs & External Systems

| System | Purpose | Auth Method |
|--------|---------|-------------|
| {{SYSTEM_1}} | {{PURPOSE}} | {{AUTH}} |
| {{SYSTEM_2}} | {{PURPOSE}} | {{AUTH}} |

---

## 8. Operational

### 8.1 Model Requirements

**Primary Model:** {{MODEL}} (Haiku / Sonnet / Opus)
**Reasoning:** {{WHY_THIS_MODEL}}

**Model Selection Matrix:**
| Subtask | Model | Reason |
|---------|-------|--------|
| {{SUBTASK_1}} | {{MODEL}} | {{REASON}} |
| {{SUBTASK_2}} | {{MODEL}} | {{REASON}} |

### 8.2 Performance Expectations

| Metric | Target | Acceptable | Unacceptable |
|--------|--------|------------|--------------|
| Latency | <{{TARGET}}s | <{{ACCEPTABLE}}s | >{{UNACCEPTABLE}}s |
| Throughput | {{TARGET}}/min | {{ACCEPTABLE}}/min | <{{UNACCEPTABLE}}/min |
| Cost | ${{TARGET}}/1K | ${{ACCEPTABLE}}/1K | >${{UNACCEPTABLE}}/1K |

### 8.3 Monitoring & Observability

**Metrics to Track:**
- {{METRIC_1}}
- {{METRIC_2}}
- {{METRIC_3}}

**Alerting Thresholds:**
| Condition | Severity | Action |
|-----------|----------|--------|
| {{CONDITION_1}} | Warning / Critical | {{ACTION}} |
| {{CONDITION_2}} | Warning / Critical | {{ACTION}} |

### 8.4 Maintenance

**Update Frequency:** {{FREQUENCY}}
**Review Cycle:** {{CYCLE}}
**Deprecation Policy:** {{POLICY}}

---

## 9. Ideal State Criteria (ISC)

Every "must", "should", or "required" statement in this spec maps to an ISC row. The AutonomousWork pipeline uses this table to generate verifiable criteria — specs without this section fall back to generic template rows, which reduces verification accuracy.

| # | Criterion | Source | Verify Method |
|---|-----------|--------|---------------|
| 1 | {{CRITERION_1}} | EXPLICIT | test / existence / runtime / manual |
| 2 | {{CRITERION_2}} | EXPLICIT | test / existence / runtime / manual |
| 3 | {{CRITERION_3}} | EXPLICIT | test / existence / runtime / manual |

**Source values:** EXPLICIT (directly stated in spec), INFERRED (derived from context), IMPLICIT (industry standard).
**Verify methods:** `test` (run test suite), `existence` (file exists), `runtime` (check running process), `manual` (human review).

---

## Appendix

### A. Glossary

| Term | Definition |
|------|------------|
| {{TERM_1}} | {{DEFINITION}} |
| {{TERM_2}} | {{DEFINITION}} |

### B. Change Log

| Version | Date | Changes | Author |
|---------|------|---------|--------|
| 1.0.0 | {{DATE}} | Initial specification | {{AUTHOR}} |

### C. References

- {{REFERENCE_1}}
- {{REFERENCE_2}}

---

**Spec Generated By:** SpecSheet Skill
**Generation Date:** {{GENERATION_DATE}}
