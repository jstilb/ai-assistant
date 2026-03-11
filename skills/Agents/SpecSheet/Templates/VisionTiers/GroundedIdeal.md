# {{DOMAIN}} - Grounded Ideal Specification

> **Version:** 1.0.0
> **Status:** Grounded | Implementation-Ready
> **Owner:** {{OWNER}}
> **Created:** {{DATE}}
> **Domain:** {{DOMAIN}}
> **Solarpunk Vision:** {{LINK_TO_SOLARPUNK_VISION}}

---

## 1. Executive Summary

### 1.1 Vision Gap Summary

**Solarpunk North Star:** {{ONE_SENTENCE_SOLARPUNK_VISION}}

**Grounded Ideal:** {{ONE_SENTENCE_GROUNDED_IDEAL}}

**Gap Analysis:**
- Preserved from Solarpunk: {{PERCENTAGE}}%
- Consciously Deferred: {{PERCENTAGE}}%
- Blocked by Current Tech: {{PERCENTAGE}}%

### 1.2 Key Compromises

| Solarpunk Ideal | Grounded Reality | Rationale |
|-----------------|------------------|-----------|
| {{IDEAL_1}} | {{REALITY_1}} | {{WHY}} |
| {{IDEAL_2}} | {{REALITY_2}} | {{WHY}} |
| {{IDEAL_3}} | {{REALITY_3}} | {{WHY}} |

---

## 2. User Stories & Requirements

### 2.1 User Story Overview

| ID | Story (As a... I want... So that...) | Priority | Justification |
|----|--------------------------------------|----------|---------------|
| US-001 | As a {{PERSONA}}, I want {{GOAL}} so that {{BENEFIT}} | P1 | {{JUSTIFICATION}} |
| US-002 | As a {{PERSONA}}, I want {{GOAL}} so that {{BENEFIT}} | P1 | {{JUSTIFICATION}} |
| US-003 | As a {{PERSONA}}, I want {{GOAL}} so that {{BENEFIT}} | P2 | {{JUSTIFICATION}} |
| US-004 | As a {{PERSONA}}, I want {{GOAL}} so that {{BENEFIT}} | P2 | {{JUSTIFICATION}} |
| US-005 | As a {{PERSONA}}, I want {{GOAL}} so that {{BENEFIT}} | P3 | {{JUSTIFICATION}} |

*Priority: P1 = Non-negotiable, P2 = Degraded-but-present, P3 = Consciously deferred*

### 2.2 Story Details

**US-001: {{STORY_TITLE}}**

*Acceptance Criteria:*
```gherkin
Given {{PRECONDITION}}
When {{ACTION}}
Then {{EXPECTED_OUTCOME}}
And {{ADDITIONAL_VERIFICATION}}
```

*Independent Testability:* {{HOW_THIS_STORY_CAN_BE_TESTED_IN_ISOLATION}}

*Edge Cases:*
- {{EDGE_CASE_1}}
- {{EDGE_CASE_2}}

---

**US-002: {{STORY_TITLE}}**

*Acceptance Criteria:*
```gherkin
Given {{PRECONDITION}}
When {{ACTION}}
Then {{EXPECTED_OUTCOME}}
```

*Independent Testability:* {{HOW_THIS_STORY_CAN_BE_TESTED_IN_ISOLATION}}

*Edge Cases:*
- {{EDGE_CASE_1}}
- {{EDGE_CASE_2}}

---

**US-003: {{STORY_TITLE}}**

*Acceptance Criteria:*
```gherkin
Given {{PRECONDITION}}
When {{ACTION}}
Then {{EXPECTED_OUTCOME}}
```

*Independent Testability:* {{HOW_THIS_STORY_CAN_BE_TESTED_IN_ISOLATION}}

*Edge Cases:*
- {{EDGE_CASE_1}}
- {{EDGE_CASE_2}}

### 2.3 Functional Requirements

| ID | Requirement | User Story | Testable? |
|----|-------------|------------|-----------|
| FR-001 | {{REQUIREMENT_DESCRIPTION}} | US-001 | Yes |
| FR-002 | {{REQUIREMENT_DESCRIPTION}} | US-001 | Yes |
| FR-003 | {{REQUIREMENT_DESCRIPTION}} | US-002 | Yes |
| FR-004 | {{REQUIREMENT_DESCRIPTION}} | US-002 | Yes |
| FR-005 | {{REQUIREMENT_DESCRIPTION}} | US-003 | Yes |

### 2.4 Success Criteria (Technology-Agnostic)

| Criterion | Measurement | Target |
|-----------|-------------|--------|
| {{CRITERION_1}} | {{MEASUREMENT_METHOD}} | {{TARGET_VALUE}} |
| {{CRITERION_2}} | {{MEASUREMENT_METHOD}} | {{TARGET_VALUE}} |
| {{CRITERION_3}} | {{MEASUREMENT_METHOD}} | {{TARGET_VALUE}} |
| {{CRITERION_4}} | {{MEASUREMENT_METHOD}} | {{TARGET_VALUE}} |

---

## 3. Practical Architecture

### 3.0 Technology Stack Assessment

```yaml
models:
  primary: {{MODEL_NAME}}
  capabilities: {{CAPABILITIES}}
  limitations: {{LIMITATIONS}}

infrastructure:
  compute: {{COMPUTE_REQUIREMENTS}}
  storage: {{STORAGE_REQUIREMENTS}}
  latency_target: {{LATENCY_MS}}ms

integrations:
  required:
    - name: {{INTEGRATION_1}}
      maturity: {{PROVEN|EMERGING|EXPERIMENTAL}}
      risk: {{LOW|MEDIUM|HIGH}}
    - name: {{INTEGRATION_2}}
      maturity: {{MATURITY}}
      risk: {{RISK}}
  optional:
    - name: {{INTEGRATION_3}}
      benefit: {{BENEFIT}}
```

### 3.1 System Components

| Component | Purpose | Maturity | Status |
|-----------|---------|----------|--------|
| {{COMPONENT_1}} | {{PURPOSE}} | Proven | ✅ Ready |
| {{COMPONENT_2}} | {{PURPOSE}} | Proven | ✅ Ready |
| {{COMPONENT_3}} | {{PURPOSE}} | Emerging | ⚠️ Needs validation |
| {{COMPONENT_4}} | {{PURPOSE}} | Experimental | 🔬 Research needed |

### 3.2 Integration Points

| Integration | Purpose | SLA | Fallback |
|-------------|---------|-----|----------|
| {{INTEGRATION_1}} | {{PURPOSE}} | {{SLA}} | {{FALLBACK}} |
| {{INTEGRATION_2}} | {{PURPOSE}} | {{SLA}} | {{FALLBACK}} |
| {{INTEGRATION_3}} | {{PURPOSE}} | {{SLA}} | {{FALLBACK}} |

### 3.3 Data Flow

```
{{DATA_SOURCE}} → {{PROCESSING_STEP_1}} → {{PROCESSING_STEP_2}} → {{OUTPUT}}
                         ↓                        ↓
                    {{STORAGE}}              {{CACHE}}
```

---

## 4. Constraints Applied

### 4.1 Solarpunk → Grounded Mapping

| # | Solarpunk Feature | Grounded Implementation | Constraint Type |
|---|-------------------|-------------------------|-----------------|
| 1 | {{FEATURE_1}} | {{IMPLEMENTATION}} | {{TECH|COST|TIME|LEGAL}} |
| 2 | {{FEATURE_2}} | {{IMPLEMENTATION}} | {{CONSTRAINT}} |
| 3 | {{FEATURE_3}} | {{IMPLEMENTATION}} | {{CONSTRAINT}} |
| 4 | {{FEATURE_4}} | {{IMPLEMENTATION}} | {{CONSTRAINT}} |
| 5 | {{FEATURE_5}} | {{IMPLEMENTATION}} | {{CONSTRAINT}} |

### 4.2 Non-Negotiables

*These aspects of the Solarpunk vision MUST be preserved:*

1. **{{NON_NEGOTIABLE_1}}**
   - Solarpunk: {{IDEAL_DESCRIPTION}}
   - Grounded: {{HOW_PRESERVED}}
   - Verification: {{HOW_TO_VERIFY}}

2. **{{NON_NEGOTIABLE_2}}**
   - Solarpunk: {{IDEAL_DESCRIPTION}}
   - Grounded: {{HOW_PRESERVED}}
   - Verification: {{HOW_TO_VERIFY}}

3. **{{NON_NEGOTIABLE_3}}**
   - Solarpunk: {{IDEAL_DESCRIPTION}}
   - Grounded: {{HOW_PRESERVED}}
   - Verification: {{HOW_TO_VERIFY}}

### 4.3 Conscious Deferrals

*These features are intentionally deferred to future iterations:*

| Feature | Why Deferred | Dependency | Revisit When |
|---------|--------------|------------|--------------|
| {{FEATURE_1}} | {{REASON}} | {{DEPENDENCY}} | {{TRIGGER}} |
| {{FEATURE_2}} | {{REASON}} | {{DEPENDENCY}} | {{TRIGGER}} |
| {{FEATURE_3}} | {{REASON}} | {{DEPENDENCY}} | {{TRIGGER}} |

---

## 5. Milestone Path

### 5.1 Current → Grounded Ideal Journey

```
CURRENT STATE                    MILESTONE 1                MILESTONE 2                GROUNDED IDEAL
┌─────────────┐                  ┌─────────────┐            ┌─────────────┐            ┌─────────────┐
│ {{CURRENT}} │  ─── M1 ───────> │ {{MILE_1}}  │ ── M2 ──> │ {{MILE_2}}  │ ── M3 ──> │ {{GROUNDED}}│
└─────────────┘                  └─────────────┘            └─────────────┘            └─────────────┘
```

### 5.2 Milestone Definitions

**Milestone 1: {{MILESTONE_1_NAME}}**
- Objectives: {{OBJECTIVES}}
- Deliverables: {{DELIVERABLES}}
- Success Criteria: {{CRITERIA}}
- Dependencies: {{DEPENDENCIES}}

**Milestone 2: {{MILESTONE_2_NAME}}**
- Objectives: {{OBJECTIVES}}
- Deliverables: {{DELIVERABLES}}
- Success Criteria: {{CRITERIA}}
- Dependencies: {{DEPENDENCIES}}

**Milestone 3: {{MILESTONE_3_NAME}} (Grounded Ideal Achieved)**
- Objectives: {{OBJECTIVES}}
- Deliverables: {{DELIVERABLES}}
- Success Criteria: {{CRITERIA}}
- Dependencies: {{DEPENDENCIES}}

### 5.3 Risk Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| {{RISK_1}} | {{PROB}} | {{IMPACT}} | {{MITIGATION}} |
| {{RISK_2}} | {{PROB}} | {{IMPACT}} | {{MITIGATION}} |
| {{RISK_3}} | {{PROB}} | {{IMPACT}} | {{MITIGATION}} |

---

## 6. Verification Strategy

### 6.0 Realistic Performance Targets

| Metric | Solarpunk Ideal | Grounded Target | Industry Standard |
|--------|-----------------|-----------------|-------------------|
| Response Time | Instantaneous | <{{TIME}}s | <{{STANDARD}}s |
| Accuracy | Perfect | ≥{{PERCENTAGE}}% | ≥{{STANDARD}}% |
| Availability | 100% | {{PERCENTAGE}}% | {{STANDARD}}% |
| Error Rate | 0% | <{{PERCENTAGE}}% | <{{STANDARD}}% |

### 6.1 Acceptance Criteria

#### US-001: {{STORY_TITLE}}

```gherkin
Given {{PRECONDITION}}
When {{ACTION}}
Then {{EXPECTED_OUTCOME}}
And {{ADDITIONAL_VERIFICATION}}
```

#### US-002: {{STORY_TITLE}}

```gherkin
Given {{PRECONDITION}}
When {{ACTION}}
Then {{EXPECTED_OUTCOME}}
```

#### US-003: {{STORY_TITLE}}

```gherkin
Given {{PRECONDITION}}
When {{ACTION}}
Then {{EXPECTED_OUTCOME}}
```

### 6.2 Test Strategy

| Test Type | Scope | Automation | Frequency |
|-----------|-------|------------|-----------|
| Unit | {{SCOPE}} | ✅ Automated | Every commit |
| Integration | {{SCOPE}} | ✅ Automated | Every PR |
| E2E | {{SCOPE}} | ✅ Automated | Daily |
| Performance | {{SCOPE}} | ✅ Automated | Weekly |
| User Acceptance | {{SCOPE}} | 👤 Manual | Per milestone |

### 6.3 Quality Gates

| Gate | Criteria | Blocker? |
|------|----------|----------|
| Code Review | 2 approvals | ✅ Yes |
| Test Coverage | ≥{{PERCENTAGE}}% | ✅ Yes |
| Performance | <{{LATENCY}}ms P95 | ✅ Yes |
| Security Scan | No critical/high | ✅ Yes |
| Accessibility | WCAG 2.1 AA | ⚠️ Warning |

---

## 7. Architecture Diagram

```mermaid
flowchart TB
    subgraph User["User Layer"]
        UI[User Interface]
        Voice[Voice Interface]
    end

    subgraph Core["Core System"]
        API[API Gateway]
        Logic[Business Logic]
        AI[AI Processing]
    end

    subgraph Data["Data Layer"]
        DB[(Database)]
        Cache[(Cache)]
        Storage[(Storage)]
    end

    subgraph External["External Services"]
        Ext1[{{EXTERNAL_1}}]
        Ext2[{{EXTERNAL_2}}]
    end

    UI --> API
    Voice --> API
    API --> Logic
    Logic --> AI
    Logic --> DB
    AI --> Cache
    Logic --> Ext1
    Logic --> Ext2

    classDef critical fill:#4A148C,color:white
    classDef secondary fill:#00796B,color:white

    class API,Logic critical
    class AI,DB secondary
```

*[PLACEHOLDER: Generate via Art skill's Mermaid workflow with Excalidraw aesthetic]*

---

## 8. Resource Requirements

### 8.1 Technical Resources

| Resource | Specification | Cost Estimate |
|----------|---------------|---------------|
| Compute | {{SPEC}} | {{COST}}/month |
| Storage | {{SPEC}} | {{COST}}/month |
| AI/ML | {{SPEC}} | {{COST}}/month |
| Third-party APIs | {{SPEC}} | {{COST}}/month |

### 8.2 Human Resources

| Role | Effort | Phase |
|------|--------|-------|
| {{ROLE_1}} | {{EFFORT}} | {{PHASE}} |
| {{ROLE_2}} | {{EFFORT}} | {{PHASE}} |
| {{ROLE_3}} | {{EFFORT}} | {{PHASE}} |

---

## Next Steps

After completing this Grounded Ideal:

1. **→ Create Current Work Spec** — Specific implementation spec for next deliverable
2. **→ Generate Architecture Diagram** — Visual representation via Art skill
3. **→ Set Up Project** — Repository, CI/CD, monitoring
4. **→ Begin Milestone 1** — Start implementation

---

*This specification represents achievable excellence with today's technology. It preserves the essence of the Solarpunk Vision while applying practical constraints. All compromises are conscious and documented for future reconsideration.*

**Generated:** {{GENERATION_DATE}}
**Problem Domain:** {{DOMAIN}}
**Solarpunk Alignment:** {{PERCENTAGE}}%
**Technology Readiness:** Grounded
