# CreateProject Workflow

**Create a complete AI agent project with production-grade infrastructure.**

---

## Voice Notification

```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the CreateProject workflow from the AgentProjectSetup skill"}' \
  > /dev/null 2>&1 &
```

---

## Prerequisites

Before starting, gather from user:

1. **Project name** - kebab-case (e.g., `customer-support-agent`)
2. **Project description** - What the agent does
3. **Language** - Python (default) or TypeScript
4. **Agent framework** - LangGraph (default), custom, or none
5. **Repository location** - GitHub org/user
6. **Environments needed** - dev (default), staging, production

---

## Step 1: Create GitHub Repository

```bash
# Create repository with standard settings
gh repo create {org}/{project-name} \
  --description "{description}" \
  --private \
  --clone

cd {project-name}
```

---

## Step 2: Initialize Project Structure

### Python Project

```bash
# Create directory structure
mkdir -p src/agent src/config src/utils tests/unit tests/integration tests/evals tests/fixtures
mkdir -p envs docker .github/workflows .tasks agents

# Create Python project files
touch src/__init__.py src/agent/__init__.py src/config/__init__.py src/utils/__init__.py
```

Create `pyproject.toml`:

```toml
[project]
name = "{project-name}"
version = "0.1.0"
description = "{description}"
requires-python = ">=3.11"
dependencies = [
    "langgraph>=0.2.0",
    "langchain-anthropic>=0.2.0",
    "langsmith>=0.1.0",
    "pydantic>=2.0.0",
    "pydantic-settings>=2.0.0",
    "httpx>=0.27.0",
]

[project.optional-dependencies]
dev = [
    "pytest>=8.0.0",
    "pytest-asyncio>=0.23.0",
    "pytest-cov>=4.0.0",
    "mypy>=1.8.0",
    "ruff>=0.3.0",
    "pre-commit>=3.6.0",
]

[tool.pytest.ini_options]
testpaths = ["tests"]
asyncio_mode = "auto"
markers = [
    "slow: marks tests as slow",
    "integration: integration tests",
    "evals: LLM evaluation tests",
]

[tool.ruff]
line-length = 100
target-version = "py311"

[tool.mypy]
python_version = "3.11"
strict = true
```

### TypeScript Project

```bash
# Create directory structure
mkdir -p src/agent src/config src/utils tests/unit tests/integration tests/evals
mkdir -p envs docker .github/workflows .tasks agents

# Initialize bun project
bun init -y
```

Create `package.json`:

```json
{
  "name": "{project-name}",
  "version": "0.1.0",
  "description": "{description}",
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "dev": "bun run --watch src/index.ts",
    "build": "bun build src/index.ts --outdir dist",
    "test": "bun test",
    "test:unit": "bun test tests/unit",
    "test:integration": "bun test tests/integration",
    "lint": "bunx @biomejs/biome check src tests",
    "typecheck": "bunx tsc --noEmit"
  },
  "dependencies": {
    "@langchain/langgraph": "^0.2.0",
    "@langchain/anthropic": "^0.3.0",
    "langsmith": "^0.1.0",
    "zod": "^3.22.0"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.0.0",
    "@biomejs/biome": "^1.5.0"
  }
}
```

---

## Step 3: Create AGENTS.md and AI Instructions

Create `AGENTS.md` in project root:

```markdown
# AGENTS.md

## Project Overview
{project-name}: {description}

Built with {framework} for AI agent orchestration.

## Architecture
- **Entry:** `src/index.{py|ts}` - Main application entry
- **Graph:** `src/agent/graph.{py|ts}` - Agent orchestration
- **Nodes:** `src/agent/nodes.{py|ts}` - Processing steps
- **Tools:** `src/agent/tools.{py|ts}` - External integrations
- **Config:** `src/config/` - Environment configuration

## Development Commands
- `{package-manager} run dev` - Start development
- `{package-manager} run test` - Run all tests
- `{package-manager} run lint` - Check code style
- `{package-manager} run typecheck` - Verify types

## Testing Requirements
- Every bug fix must include a regression test
- Every new feature must include tests
- Tests must pass before committing
- Integration tests required for tool changes

## Code Style
- Type hints/annotations on all functions
- Docstrings for public APIs
- Follow existing patterns in codebase
- Use async/await for I/O operations

## Security
- NEVER commit credentials or API keys
- All external calls must be validated
- Tool inputs must be sanitized
- Follow prompt injection defense patterns

## Boundaries
- DO NOT commit directly to main
- DO NOT modify production configs without review
- DO NOT add dependencies without justification
- DO NOT disable security checks
```

Create `.github/copilot-instructions.md`:

```markdown
# Copilot Instructions

## Tech Stack
- {Language} with strict types
- {Framework} for agent orchestration
- pytest/vitest for testing
- Docker for deployment

## Patterns
- State via TypedDict/Zod schemas
- Tools use decorator pattern
- Async for all I/O
- Structured logging

## Avoid
- Global mutable state
- Blocking I/O in async
- Hardcoded credentials
- Untested code
```

---

## Step 4: Create Environment Configuration

Create `envs/.env.example`:

```bash
# Required API Keys
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...

# Observability (LangSmith)
LANGCHAIN_TRACING_V2=true
LANGCHAIN_API_KEY=ls-...
LANGCHAIN_PROJECT={project-name}

# Environment
ENVIRONMENT=development
LOG_LEVEL=DEBUG

# Agent Configuration
MAX_ITERATIONS=10
TIMEOUT_SECONDS=60
```

Create `envs/.env.development`:

```bash
ENVIRONMENT=development
LOG_LEVEL=DEBUG
LANGCHAIN_TRACING_V2=true
```

Create `envs/.env.staging`:

```bash
ENVIRONMENT=staging
LOG_LEVEL=INFO
LANGCHAIN_TRACING_V2=true
```

Create `envs/.env.production.example`:

```bash
# COPY TO .env.production and fill in values
ENVIRONMENT=production
LOG_LEVEL=WARNING
LANGCHAIN_TRACING_V2=true
```

---

## Step 5: Create Basic Agent Structure

### Python

Create `src/agent/state.py`:

```python
from typing import Annotated, TypedDict
from langgraph.graph.message import add_messages

class AgentState(TypedDict):
    """State for the agent graph."""
    messages: Annotated[list, add_messages]
    # Add custom state fields here
```

Create `src/agent/graph.py`:

```python
from langgraph.graph import StateGraph, END
from .state import AgentState
from .nodes import process_message

def create_agent_graph():
    """Create the agent graph."""
    graph = StateGraph(AgentState)

    # Add nodes
    graph.add_node("process", process_message)

    # Set entry point
    graph.set_entry_point("process")

    # Add edges
    graph.add_edge("process", END)

    return graph.compile()
```

Create `src/agent/nodes.py`:

```python
from langchain_anthropic import ChatAnthropic
from .state import AgentState

model = ChatAnthropic(model="claude-sonnet-4-20250514")

def process_message(state: AgentState) -> dict:
    """Process incoming message and generate response."""
    response = model.invoke(state["messages"])
    return {"messages": [response]}
```

### TypeScript

Create `src/agent/state.ts`:

```typescript
import { Annotation } from "@langchain/langgraph";

export const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (x, y) => x.concat(y),
  }),
});

export type AgentStateType = typeof AgentState.State;
```

Create `src/agent/graph.ts`:

```typescript
import { StateGraph, END } from "@langchain/langgraph";
import { AgentState } from "./state";
import { processMessage } from "./nodes";

export function createAgentGraph() {
  const graph = new StateGraph(AgentState)
    .addNode("process", processMessage)
    .addEdge("__start__", "process")
    .addEdge("process", END);

  return graph.compile();
}
```

---

## Step 6: Create Docker Configuration

### Production Dockerfile

Create `docker/Dockerfile`:

```dockerfile
FROM python:3.11-slim

# Security: Non-root user
RUN useradd -m -s /bin/bash agent
WORKDIR /app

# Install dependencies
COPY pyproject.toml .
RUN pip install --no-cache-dir .

# Copy source
COPY --chown=agent:agent src/ ./src/

# Security settings
USER agent
ENV PYTHONUNBUFFERED=1

CMD ["python", "-m", "src"]
```

Create `docker/docker-compose.yml`:

```yaml
version: '3.8'

services:
  agent:
    build:
      context: ..
      dockerfile: docker/Dockerfile
    env_file:
      - ../envs/.env.${ENVIRONMENT:-development}
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 2G
    networks:
      - agent-network

networks:
  agent-network:
    driver: bridge
```

### Sandbox Configuration (for Ralph Loop execution)

Create `Dockerfile.sandbox`:

```dockerfile
FROM python:3.11-slim

# Security: Non-root user
RUN useradd -m -s /bin/bash agent
WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy source (read-only in container)
COPY src/ ./src/
RUN chmod -R 555 /app/src

# Create output directory
RUN mkdir -p /app/output && chown agent:agent /app/output

# Switch to non-root
USER agent

CMD ["python", "-m", "src.agent"]
```

Create `docker-compose.sandbox.yml`:

```yaml
version: '3.8'

services:
  agent-sandbox:
    build:
      context: .
      dockerfile: Dockerfile.sandbox
    security_opt:
      - no-new-privileges:true
    read_only: true
    tmpfs:
      - /tmp:size=100M
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 4G
    networks:
      - sandbox-net
    volumes:
      - ./src:/app/src:ro
      - ./sandbox-output:/app/output:rw

networks:
  sandbox-net:
    driver: bridge
    internal: true
```

Create `envs/.env.sandbox`:

```bash
# Sandbox environment - safe for autonomous execution
ENVIRONMENT=sandbox
LOG_LEVEL=DEBUG
MAX_ITERATIONS=5
TIMEOUT_SECONDS=300
```

---

## Step 7: Create .gitignore

```gitignore
# Environment
.env
.env.local
.env.production
envs/.env.production

# Python
__pycache__/
*.py[cod]
.venv/
venv/
.mypy_cache/
.pytest_cache/
.ruff_cache/
dist/
*.egg-info/

# TypeScript/Node
node_modules/
dist/
.turbo/

# IDE
.idea/
.vscode/
*.swp

# OS
.DS_Store
Thumbs.db

# Logs
*.log
logs/

# Testing
coverage/
.coverage
htmlcov/
```

---

## Step 8: Create Initial Test

### Python

Create `tests/unit/test_graph.py`:

```python
import pytest
from src.agent.graph import create_agent_graph

class TestAgentGraph:
    def test_graph_compiles(self):
        """Test that the graph compiles without errors."""
        graph = create_agent_graph()
        assert graph is not None

    @pytest.mark.asyncio
    async def test_simple_message(self):
        """Test basic message processing."""
        graph = create_agent_graph()
        result = await graph.ainvoke({
            "messages": [{"role": "user", "content": "Hello"}]
        })
        assert len(result["messages"]) > 0
```

---

## Step 9: Create Makefile/Scripts

Create `Makefile`:

```makefile
.PHONY: dev test lint typecheck build docker-build docker-run

dev:
	python -m src

test:
	pytest tests/ -v

test-unit:
	pytest tests/unit -v

test-integration:
	pytest tests/integration -v

lint:
	ruff check src tests
	ruff format --check src tests

typecheck:
	mypy src

build:
	pip install -e .

docker-build:
	docker compose -f docker/docker-compose.yml build

docker-run:
	docker compose -f docker/docker-compose.yml up
```

---

## Step 10: Initial Commit

```bash
git add .
git commit -m "Initial project setup

- Agent structure with LangGraph
- Environment configuration (dev/staging/prod)
- Docker containerization
- Test infrastructure
- AGENTS.md for AI coding agents
- CI/CD workflow (pending)

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"

git push -u origin main
```

---

## Output

After completion, provide user with:

1. **Repository URL**: `https://github.com/{org}/{project-name}`
2. **Quick start commands**:
   ```bash
   cd {project-name}
   cp envs/.env.example envs/.env.development
   # Add your ANTHROPIC_API_KEY
   make dev
   ```
3. **Next steps**:
   - Add CI/CD: `Run AddCICD workflow`
   - Add testing: `Run AddTesting workflow`
   - Add observability: `Run AddObservability workflow`
