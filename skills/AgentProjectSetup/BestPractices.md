# Best Practices for AI Agent Development

**Industry-proven patterns for building production-grade AI agents in 2025-2026.**

Synthesized from GitHub's analysis of 2,500+ AGENTS.md repositories, Anthropic's deployment guides, LangChain patterns, and AgentOps observability frameworks.

---

## Spec-Driven Development

### The New Paradigm

In the age of AI coding agents, **specifications become the primary source of truth**, not the code itself.

```
┌─────────────────────────────────────────────────┐
│                 SPECIFICATION                   │
│  "What the feature should do"                   │
├─────────────────────────────────────────────────┤
│                    CODE                         │
│  "Implementation detail to realize the spec"   │
└─────────────────────────────────────────────────┘
```

### Task Specifications (`.tasks/` Directory)

```markdown
<!-- .tasks/feature-001.md -->
# Feature: User Authentication

## Intent
Allow users to securely authenticate using email/password or OAuth.

## Constraints
- Passwords must be hashed with bcrypt (cost factor 12)
- Sessions expire after 24 hours of inactivity
- Maximum 5 failed login attempts before lockout

## Acceptance Criteria
- [ ] User can register with email/password
- [ ] User can login with valid credentials
- [ ] User receives error on invalid credentials
- [ ] OAuth flow works with Google and GitHub
- [ ] Session tokens are securely generated

## Non-Goals
- Social login beyond Google/GitHub
- Biometric authentication
- Multi-factor authentication (future feature)
```

### Why Specs Matter

1. **Alignment** - AI agents know exactly what to build
2. **Verifiability** - Acceptance criteria are testable
3. **Maintainability** - Specs alongside code improve traceability
4. **Predictability** - Reduces hallucination/drift in AI-generated code

---

## Repository Readiness Checklist

### Essential Files for AI Coding Agents

| File | Purpose | Priority |
|------|---------|----------|
| `AGENTS.md` | Root instructions for all coding agents | Required |
| `.github/copilot-instructions.md` | GitHub Copilot specific | Recommended |
| `CLAUDE.md` | Claude Code specific | If using Claude |
| `GEMINI.md` | Gemini specific | If using Gemini |
| `.tasks/` | Task specifications | Recommended |
| `.gitignore` | Exclude secrets, env files | Required |
| `CHANGELOG.md` | Track changes | Required |

### AGENTS.md Best Practices

**DO:**
- Keep instructions concise and actionable
- Include build/test commands
- Specify code style preferences
- Set clear boundaries (what NOT to do)
- Use nested AGENTS.md for subprojects

**DON'T:**
- Duplicate README content
- Include sensitive information
- Over-specify (trust the AI)
- Forget to update when project evolves

---

## Code Review & Quality Gates

### Automated Pre-Commit Checks

```yaml
# .pre-commit-config.yaml
repos:
  - repo: https://github.com/pre-commit/pre-commit-hooks
    rev: v4.5.0
    hooks:
      - id: trailing-whitespace
      - id: end-of-file-fixer
      - id: check-yaml
      - id: check-added-large-files

  - repo: https://github.com/astral-sh/ruff-pre-commit
    rev: v0.3.0
    hooks:
      - id: ruff
      - id: ruff-format

  - repo: https://github.com/pre-commit/mirrors-mypy
    rev: v1.8.0
    hooks:
      - id: mypy
        additional_dependencies: [types-all]
```

### PR Review Checklist

```markdown
## Code Review Checklist

### Security
- [ ] No hardcoded credentials
- [ ] Input validation present
- [ ] Output sanitization for user-facing content
- [ ] No prompt injection vulnerabilities

### Quality
- [ ] Type hints on all functions
- [ ] Tests for new functionality
- [ ] Tests pass locally
- [ ] Documentation updated

### Agent-Specific
- [ ] Tool calls properly validated
- [ ] Error handling for LLM failures
- [ ] Token usage within budget
- [ ] Observability (logging/tracing) present
```

### AI-Assisted Pre-Review

Use AI agents for initial code review before human review:

```markdown
<!-- agents/code-review-agent.agents.md -->
# Code Review Agent

## Role
Pre-review code changes before human reviewers.

## Tasks
1. Check for security vulnerabilities
2. Verify test coverage
3. Identify code smells
4. Suggest improvements

## Output Format
Provide structured feedback:
- 🔴 Blockers (must fix)
- 🟡 Suggestions (should consider)
- 🟢 Approved aspects
```

---

## Versioning & Deployment

### Semantic Versioning for Agents

```
MAJOR.MINOR.PATCH

MAJOR - Breaking changes to agent behavior/API
MINOR - New capabilities, backward compatible
PATCH - Bug fixes, prompt improvements
```

### Changelog Format

```markdown
# Changelog

## [1.2.0] - 2026-01-21

### Added
- New tool: `search_documents` for RAG queries
- Support for streaming responses

### Changed
- Improved intent classification accuracy (87% → 94%)
- Reduced average response latency by 200ms

### Fixed
- Tool calling error when API returns empty response
- Memory leak in long-running conversations

### Security
- Updated to Claude Opus 4.5 (improved prompt injection resistance)
```

### Deployment Strategy

```
┌─────────────────────────────────────────────────┐
│             Deployment Pipeline                 │
├─────────────────────────────────────────────────┤
│  1. Code Change (PR)                            │
│        ↓                                        │
│  2. Automated Tests (unit + integration)        │
│        ↓                                        │
│  3. LLM Evaluations (quality + safety)          │
│        ↓                                        │
│  4. Staging Deployment (5% traffic)             │
│        ↓                                        │
│  5. Monitoring (24-48 hours)                    │
│        ↓                                        │
│  6. Production Rollout (gradual)                │
└─────────────────────────────────────────────────┘
```

---

## Prompt Management

### Prompt Versioning

```python
# src/prompts/system_prompts.py
from dataclasses import dataclass
from datetime import datetime

@dataclass
class VersionedPrompt:
    version: str
    created_at: datetime
    content: str
    changelog: str

SYSTEM_PROMPT_V1_0 = VersionedPrompt(
    version="1.0.0",
    created_at=datetime(2026, 1, 1),
    content="""You are a helpful assistant...""",
    changelog="Initial version"
)

SYSTEM_PROMPT_V1_1 = VersionedPrompt(
    version="1.1.0",
    created_at=datetime(2026, 1, 15),
    content="""You are a helpful assistant that...""",
    changelog="Added safety guidelines"
)

# Always use the latest
CURRENT_SYSTEM_PROMPT = SYSTEM_PROMPT_V1_1
```

### Prompt Testing

```python
# tests/evals/test_prompts.py
import pytest
from src.prompts.system_prompts import CURRENT_SYSTEM_PROMPT

def test_prompt_contains_safety_guidelines():
    """Verify safety guidelines are present."""
    assert "never" in CURRENT_SYSTEM_PROMPT.content.lower()
    assert any(phrase in CURRENT_SYSTEM_PROMPT.content.lower()
               for phrase in ["harmful", "dangerous", "illegal"])

def test_prompt_length_within_budget():
    """Ensure prompt doesn't exceed token budget."""
    # Rough estimate: 1 token ≈ 4 characters
    estimated_tokens = len(CURRENT_SYSTEM_PROMPT.content) / 4
    assert estimated_tokens < 2000  # Leave room for user messages
```

---

## Error Handling Patterns

### Graceful Degradation

```python
from enum import Enum
from typing import Optional

class ErrorRecoveryStrategy(Enum):
    RETRY = "retry"
    FALLBACK = "fallback"
    ESCALATE = "escalate"
    ABORT = "abort"

async def execute_with_recovery(
    func,
    max_retries: int = 3,
    fallback_func: Optional[callable] = None
) -> tuple[Any, ErrorRecoveryStrategy]:
    """Execute with automatic error recovery."""
    for attempt in range(max_retries):
        try:
            result = await func()
            return result, ErrorRecoveryStrategy.RETRY if attempt > 0 else None
        except RateLimitError:
            await asyncio.sleep(2 ** attempt)  # Exponential backoff
        except APIError as e:
            if fallback_func:
                return await fallback_func(), ErrorRecoveryStrategy.FALLBACK
            raise

    # All retries exhausted
    if fallback_func:
        return await fallback_func(), ErrorRecoveryStrategy.FALLBACK
    raise MaxRetriesExceeded()
```

### User-Facing Error Messages

```python
ERROR_MESSAGES = {
    "rate_limit": "I'm receiving too many requests right now. Please try again in a moment.",
    "api_error": "I encountered a technical issue. Let me try a different approach.",
    "tool_error": "I couldn't complete that action. Here's what I can tell you instead...",
    "context_overflow": "That's a lot of information! Let me break this into smaller parts.",
}

def get_user_friendly_error(error_type: str, technical_details: str) -> str:
    """Convert technical errors to user-friendly messages."""
    base_message = ERROR_MESSAGES.get(error_type, "Something went wrong.")

    # Log technical details for debugging
    logger.error(f"{error_type}: {technical_details}")

    # Return friendly message
    return base_message
```

---

## Cost Management

### Token Budget Controls

```python
from dataclasses import dataclass

@dataclass
class TokenBudget:
    max_input_tokens: int = 100_000
    max_output_tokens: int = 4_096
    max_total_per_request: int = 110_000
    daily_budget_usd: float = 50.0

    def check_request(self, estimated_tokens: int) -> bool:
        """Verify request is within budget."""
        return estimated_tokens <= self.max_total_per_request

    def estimate_cost(self, input_tokens: int, output_tokens: int) -> float:
        """Estimate cost based on Claude pricing."""
        # Claude Opus 4.5 pricing (example)
        input_cost = (input_tokens / 1_000_000) * 15.00
        output_cost = (output_tokens / 1_000_000) * 75.00
        return input_cost + output_cost
```

### Caching Strategy

```python
from functools import lru_cache
import hashlib

def cache_key(prompt: str, model: str) -> str:
    """Generate cache key for LLM request."""
    content = f"{model}:{prompt}"
    return hashlib.sha256(content.encode()).hexdigest()

# In-memory cache for identical requests
@lru_cache(maxsize=1000)
def cached_completion(cache_key: str) -> str:
    """Cache wrapper - actual implementation stores the response."""
    pass

# Usage
async def get_completion(prompt: str, model: str) -> str:
    key = cache_key(prompt, model)
    cached = cached_completion(key)
    if cached:
        return cached

    response = await client.messages.create(...)
    # Store in cache
    cached_completion.cache_info()  # Update cache
    return response.content
```

---

## Monitoring & Alerting

### Key Metrics Dashboard

```python
# src/utils/metrics.py
from prometheus_client import Counter, Histogram, Gauge

# Request metrics
REQUESTS_TOTAL = Counter(
    'agent_requests_total',
    'Total agent requests',
    ['status', 'intent']
)

REQUEST_LATENCY = Histogram(
    'agent_request_latency_seconds',
    'Request latency in seconds',
    buckets=[0.1, 0.5, 1.0, 2.0, 5.0, 10.0, 30.0]
)

# Token metrics
TOKENS_USED = Counter(
    'agent_tokens_total',
    'Total tokens used',
    ['type']  # input/output
)

# Error metrics
ERRORS_TOTAL = Counter(
    'agent_errors_total',
    'Total errors',
    ['error_type']
)

# Quality metrics (from evals)
QUALITY_SCORE = Gauge(
    'agent_quality_score',
    'Latest quality evaluation score',
    ['metric']  # accuracy/relevance/safety
)
```

### Alert Rules

```yaml
# alerts/agent-alerts.yml
groups:
  - name: agent-alerts
    rules:
      - alert: HighErrorRate
        expr: rate(agent_errors_total[5m]) > 0.05
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Agent error rate above 5%"

      - alert: HighLatency
        expr: histogram_quantile(0.95, rate(agent_request_latency_seconds_bucket[5m])) > 10
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "P95 latency above 10 seconds"

      - alert: QualityDegradation
        expr: agent_quality_score{metric="accuracy"} < 0.8
        for: 1h
        labels:
          severity: critical
        annotations:
          summary: "Agent accuracy dropped below 80%"
```

---

## Sources

- [GitHub Blog: Agentic AI and spec-driven development](https://github.blog/developer-skills/agentic-ai-mcp-and-spec-driven-development-top-blog-posts-of-2025/)
- [Medium: Is your repo ready for the AI Agents revolution?](https://domizajac.medium.com/is-your-repo-ready-for-the-ai-agents-revolution-926e548da528)
- [MLOps, LLMOps, & AgentOps Guide](https://www.covasant.com/blogs/mlops-llmops-agentops-the-essential-ai-pipeline-guide)
- [GitHub: Onboarding your AI peer programmer](https://github.blog/ai-and-ml/github-copilot/onboarding-your-ai-peer-programmer-setting-up-github-copilot-coding-agent-for-success/)
- [Medium: From Zero to Production: CI/CD for LangGraph Agents](https://medium.com/algomart/from-zero-to-production-a-ci-cd-pipeline-for-langgraph-agents-on-aws-9e2492fb2e5f)
