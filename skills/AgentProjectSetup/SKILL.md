---
name: AgentProjectSetup
description: Complete infrastructure setup for AI agent coding projects. USE WHEN setting up agent project, agent infrastructure, ai agent repo, agent testing, agent sandbox, OR agent CI/CD. Creates GitHub repos, sandbox environments, test infrastructure, and production-grade tooling.
---
# AgentProjectSetup

**Production-grade infrastructure for AI agent development projects.**

Sets up complete project infrastructure including GitHub repository, sandbox environments (dev/staging/prod), test infrastructure, CI/CD pipelines, and agent-specific tooling following 2025/2026 best practices.

---

## Voice Notification

-> Use `notifySync()` from `skills/CORE/Tools/NotificationService.ts`

## Workflow Routing

| Workflow | Trigger | File |
|----------|---------|------|
| **CreateProject** | "set up agent project", "new agent repo" | `Workflows/CreateProject.md` |
| **AddEnvironment** | "add staging", "add production env" | `Workflows/AddEnvironment.md` |
| **AddTesting** | "add agent tests", "test infrastructure" | `Workflows/AddTesting.md` |
| **AddCICD** | "add CI/CD", "github actions for agent" | `Workflows/AddCICD.md` |
| **AddObservability** | "add monitoring", "add tracing", "langsmith" | `Workflows/AddObservability.md` |

## Examples

**Example 1: Full project setup from scratch**
```
User: "Set up an AI agent project for a customer support chatbot"
→ Invokes CreateProject workflow
→ Creates GitHub repo with AGENTS.md, copilot-instructions.md
→ Sets up dev/staging/prod environments
→ Configures test infrastructure (unit + integration)
→ Adds CI/CD pipeline with quality gates
→ Returns project URL and quickstart guide
```

**Example 2: Add testing to existing project**
```
User: "Add comprehensive testing to my agent project"
→ Invokes AddTesting workflow
→ Adds pytest with async support
→ Creates unit tests for agent nodes
→ Creates integration tests for full flows
→ Adds LLM evaluation framework
→ Configures CI test runner
```

**Example 3: Add production environment**
```
User: "Set up production deployment for my agent"
→ Invokes AddEnvironment workflow
→ Creates containerized sandbox environment
→ Configures security isolation
→ Sets up credential management
→ Adds deployment scripts
```

## Quick Reference

**Core Components Created:**
- Repository structure with AGENTS.md
- Environment configurations (dev/staging/prod)
- Test infrastructure (unit + integration + evals)
- CI/CD pipeline with quality gates
- Observability (tracing, monitoring)
- Security isolation (sandboxing)

**Tech Stack:**
- **Runtime:** Python 3.11+ or TypeScript/Bun
- **Agent Framework:** LangGraph/LangChain (default) or custom
- **Testing:** pytest/Vitest + LLM evaluations
- **CI/CD:** GitHub Actions
- **Observability:** LangSmith or OpenTelemetry

**Full Documentation:**
- Infrastructure guide: `InfrastructureGuide.md`
- Best practices: `BestPractices.md`
- Security patterns: `SecurityPatterns.md`
- Testing strategies: `TestingStrategies.md`

---

## Integration

### Uses
- **GitHub CLI (gh)** - Repository creation and management
- **Docker** - Container-based sandbox environments
- **Tech Stack Preferences** - Follows Kaya standards

### Feeds Into
- **Development** - Projects created here are developed further
- **Browser** - For testing web-based agent UIs
- **System** - Integrity checks for agent projects

### MCPs Used
- None (direct CLI and filesystem operations)

---

**Last Updated:** 2026-01-21
