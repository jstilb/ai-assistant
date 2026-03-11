# AI Task Overlay

> *Apply this overlay to Current Work specs for AI agent/automation tasks*

---

## A. Agent Configuration

```yaml
agent:
  type: {{AUTONOMOUS|ASSISTANT|PIPELINE_COMPONENT}}
  trigger: {{TRIGGER_DESCRIPTION}}
  model_preference: {{haiku|sonnet|opus}}
  model_rationale: {{WHY_THIS_MODEL}}

execution:
  mode: {{SINGLE_SHOT|ITERATIVE|CONTINUOUS}}
  max_iterations: {{NUMBER}}
  timeout_seconds: {{SECONDS}}
  retry_policy: {{RETRY_COUNT}} with {{BACKOFF_STRATEGY}}

observability:
  logging_level: {{DEBUG|INFO|WARN|ERROR}}
  metrics_enabled: {{true|false}}
  trace_enabled: {{true|false}}
```

---

## B. Autonomy Boundaries

### Always (No Approval Required)

*Actions the agent can take autonomously:*

| Action | Rationale | Scope Limit |
|--------|-----------|-------------|
| {{ACTION_1}} | {{WHY_SAFE}} | {{LIMIT}} |
| {{ACTION_2}} | {{WHY_SAFE}} | {{LIMIT}} |
| {{ACTION_3}} | {{WHY_SAFE}} | {{LIMIT}} |

### Ask (Requires Human Approval)

*Actions that need explicit confirmation:*

| Action | Why Ask | Approval Method |
|--------|---------|-----------------|
| {{ACTION_1}} | {{WHY_ASK}} | {{AskUserQuestion|Notification|Queue}} |
| {{ACTION_2}} | {{WHY_ASK}} | {{APPROVAL_METHOD}} |
| {{ACTION_3}} | {{WHY_ASK}} | {{APPROVAL_METHOD}} |

**Approval Template:**
```
⚠️ APPROVAL REQUIRED
Action: {{ACTION_DESCRIPTION}}
Context: {{RELEVANT_CONTEXT}}
Impact: {{POTENTIAL_IMPACT}}
Alternatives: {{IF_ANY}}
[Approve] [Deny] [Modify]
```

### Never (Absolutely Prohibited)

*Actions the agent must NEVER take:*

| Prohibition | Why | Enforcement |
|-------------|-----|-------------|
| {{PROHIBITION_1}} | {{RATIONALE}} | Hard-coded block |
| {{PROHIBITION_2}} | {{RATIONALE}} | Hard-coded block |
| {{PROHIBITION_3}} | {{RATIONALE}} | Hard-coded block |

---

## C. Observability Requirements

### Logging Specification

```yaml
logs:
  format: json
  fields:
    - timestamp
    - agent_id
    - action
    - input_summary
    - output_summary
    - duration_ms
    - tokens_used
    - cost_estimate

  retention: {{DAYS}} days
  destination: {{PATH_OR_SERVICE}}
```

### Metrics to Track

| Metric | Type | Alert Threshold |
|--------|------|-----------------|
| Task completion rate | Gauge | <{{THRESHOLD}}% |
| Average execution time | Histogram | >{{SECONDS}}s P95 |
| Error rate | Counter | >{{THRESHOLD}}% |
| Token usage | Counter | >{{LIMIT}}/day |
| Cost | Counter | >${{AMOUNT}}/day |

### Tracing

- Trace ID propagation: {{ENABLED|DISABLED}}
- Parent span: {{PARENT_CONTEXT}}
- Child spans: {{LIST_OF_CHILD_SPANS}}

---

## D. Escalation Triggers

| Condition | Threshold | Action |
|-----------|-----------|--------|
| Confidence below threshold | <{{PERCENTAGE}}% | {{ESCALATION_ACTION}} |
| Repeated failures | >{{COUNT}} consecutive | {{ESCALATION_ACTION}} |
| Unusual input | {{PATTERN_DESCRIPTION}} | {{ESCALATION_ACTION}} |
| High-impact decision | {{CRITERIA}} | {{ESCALATION_ACTION}} |
| Rate limit approaching | >{{PERCENTAGE}}% | {{ESCALATION_ACTION}} |

### Escalation Methods

1. **Queue to Human:** Add to approval queue with full context
2. **Notify:** Send notification but continue
3. **Pause:** Stop and wait for human input
4. **Fallback:** Execute safe fallback behavior
5. **Abort:** Stop execution entirely

---

## E. Error Handling

### Error Categories

| Category | Examples | Handling |
|----------|----------|----------|
| Transient | Rate limits, timeouts | Retry with backoff |
| Recoverable | Invalid input, missing data | Request correction |
| Critical | Security violation, data corruption | Abort + alert |

### Recovery Patterns

```yaml
retry:
  max_attempts: {{COUNT}}
  initial_delay_ms: {{MS}}
  max_delay_ms: {{MS}}
  backoff_multiplier: {{MULTIPLIER}}

fallback:
  enabled: {{true|false}}
  behavior: {{FALLBACK_DESCRIPTION}}

circuit_breaker:
  enabled: {{true|false}}
  failure_threshold: {{COUNT}}
  recovery_timeout_seconds: {{SECONDS}}
```

---

## F. Integration Points

### Upstream (Receives From)

| Source | Data | Format |
|--------|------|--------|
| {{SOURCE_1}} | {{DATA_DESCRIPTION}} | {{FORMAT}} |
| {{SOURCE_2}} | {{DATA_DESCRIPTION}} | {{FORMAT}} |

### Downstream (Sends To)

| Destination | Data | Format | Failure Handling |
|-------------|------|--------|------------------|
| {{DEST_1}} | {{DATA_DESCRIPTION}} | {{FORMAT}} | {{HANDLING}} |
| {{DEST_2}} | {{DATA_DESCRIPTION}} | {{FORMAT}} | {{HANDLING}} |

---

*This overlay extends the Current Work spec with AI-specific considerations. Apply by filling in the placeholders above and appending to Section 8 of the Current Work template.*
