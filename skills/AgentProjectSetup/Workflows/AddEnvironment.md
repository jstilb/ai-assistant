# AddEnvironment Workflow

**Add or configure deployment environments (dev, staging, production) for AI agent projects.**

---

## Voice Notification

```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the AddEnvironment workflow from the AgentProjectSetup skill"}' \
  > /dev/null 2>&1 &
```

---

## Prerequisites

Confirm with user:

1. **Project path** - Location of existing agent project
2. **Environment to add**:
   - Development (local, hot-reload)
   - Staging (pre-production, testing)
   - Production (live, monitored)
3. **Deployment target**:
   - Container (Docker/Kubernetes)
   - Serverless (AWS Lambda, Cloud Run, Vercel)
   - Platform (Railway, Render, Fly.io)
   - VM/Bare metal
4. **Secrets management**:
   - Environment variables
   - Cloud secrets manager (AWS Secrets Manager, GCP Secret Manager)
   - Vault (HashiCorp)

---

## Step 1: Create Environment Directory Structure

```bash
mkdir -p envs/{environment}
```

---

## Step 2: Create Environment Configuration

### Development Environment

Create `envs/development/.env`:

```bash
# Environment Identification
ENVIRONMENT=development
NODE_ENV=development
DEBUG=true

# Logging
LOG_LEVEL=DEBUG
LOG_FORMAT=pretty

# API Keys (use development/test keys)
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
OPENAI_API_KEY=${OPENAI_API_KEY}

# Observability
LANGCHAIN_TRACING_V2=true
LANGCHAIN_API_KEY=${LANGCHAIN_API_KEY}
LANGCHAIN_PROJECT=${PROJECT_NAME}-dev

# Agent Configuration
MAX_ITERATIONS=20
TIMEOUT_SECONDS=120
ENABLE_VERBOSE_LOGGING=true

# Development-specific
HOT_RELOAD=true
MOCK_EXTERNAL_SERVICES=false
```

### Staging Environment

Create `envs/staging/.env`:

```bash
# Environment Identification
ENVIRONMENT=staging
NODE_ENV=production
DEBUG=false

# Logging
LOG_LEVEL=INFO
LOG_FORMAT=json

# API Keys (staging keys with lower limits)
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY_STAGING}
OPENAI_API_KEY=${OPENAI_API_KEY_STAGING}

# Observability
LANGCHAIN_TRACING_V2=true
LANGCHAIN_API_KEY=${LANGCHAIN_API_KEY}
LANGCHAIN_PROJECT=${PROJECT_NAME}-staging

# Agent Configuration
MAX_ITERATIONS=10
TIMEOUT_SECONDS=60
ENABLE_VERBOSE_LOGGING=false

# Staging-specific
RATE_LIMIT_REQUESTS_PER_MINUTE=30
ENABLE_SYNTHETIC_MONITORING=true
```

### Production Environment

Create `envs/production/.env.example`:

```bash
# =====================================================
# PRODUCTION ENVIRONMENT - COPY TO .env AND CONFIGURE
# =====================================================

# Environment Identification
ENVIRONMENT=production
NODE_ENV=production
DEBUG=false

# Logging
LOG_LEVEL=WARNING
LOG_FORMAT=json

# API Keys (production keys - NEVER COMMIT)
ANTHROPIC_API_KEY=
OPENAI_API_KEY=

# Observability
LANGCHAIN_TRACING_V2=true
LANGCHAIN_API_KEY=
LANGCHAIN_PROJECT=${PROJECT_NAME}-production

# Agent Configuration
MAX_ITERATIONS=10
TIMEOUT_SECONDS=30
ENABLE_VERBOSE_LOGGING=false

# Production-specific
RATE_LIMIT_REQUESTS_PER_MINUTE=60
ENABLE_HEALTH_CHECKS=true
ENABLE_ALERTING=true

# Security
CORS_ALLOWED_ORIGINS=https://yourdomain.com
SECURE_COOKIES=true
```

---

## Step 3: Create Environment-Specific Docker Compose

### Development

Create `docker/docker-compose.dev.yml`:

```yaml
version: '3.8'

services:
  agent:
    build:
      context: ..
      dockerfile: docker/Dockerfile
      target: development
    env_file:
      - ../envs/development/.env
    volumes:
      - ../src:/app/src:delegated
      - ../tests:/app/tests:delegated
    ports:
      - "8000:8000"
      - "5678:5678"  # Debug port
    environment:
      - WATCHFILES_FORCE_POLLING=true
    command: ["python", "-m", "debugpy", "--listen", "0.0.0.0:5678", "-m", "uvicorn", "src.main:app", "--reload", "--host", "0.0.0.0"]
    networks:
      - agent-dev

networks:
  agent-dev:
    driver: bridge
```

### Staging

Create `docker/docker-compose.staging.yml`:

```yaml
version: '3.8'

services:
  agent:
    build:
      context: ..
      dockerfile: docker/Dockerfile
      target: production
    env_file:
      - ../envs/staging/.env
    ports:
      - "8000:8000"
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 2G
        reservations:
          cpus: '1'
          memory: 1G
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s
    networks:
      - agent-staging
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"

networks:
  agent-staging:
    driver: bridge
```

### Production

Create `docker/docker-compose.prod.yml`:

```yaml
version: '3.8'

services:
  agent:
    image: ghcr.io/${GITHUB_REPOSITORY}:production
    env_file:
      - ../envs/production/.env
    ports:
      - "8000:8000"
    deploy:
      replicas: 2
      resources:
        limits:
          cpus: '4'
          memory: 4G
        reservations:
          cpus: '2'
          memory: 2G
      update_config:
        parallelism: 1
        delay: 10s
        failure_action: rollback
      rollback_config:
        parallelism: 1
        delay: 10s
      restart_policy:
        condition: on-failure
        delay: 5s
        max_attempts: 3
        window: 120s
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8000/health"]
      interval: 15s
      timeout: 5s
      retries: 5
      start_period: 30s
    networks:
      - agent-prod
    logging:
      driver: "json-file"
      options:
        max-size: "50m"
        max-file: "5"

  # Optional: Redis for caching/sessions
  redis:
    image: redis:7-alpine
    command: redis-server --appendonly yes
    volumes:
      - redis-data:/data
    networks:
      - agent-prod
    deploy:
      resources:
        limits:
          memory: 512M

volumes:
  redis-data:

networks:
  agent-prod:
    driver: bridge
```

---

## Step 4: Create Multi-Stage Dockerfile

Create `docker/Dockerfile`:

```dockerfile
# =====================================================
# BASE STAGE
# =====================================================
FROM python:3.11-slim AS base

# Security: Non-root user
RUN groupadd -r agent && useradd -r -g agent agent

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

# =====================================================
# DEPENDENCIES STAGE
# =====================================================
FROM base AS dependencies

COPY pyproject.toml .
RUN pip install --no-cache-dir .

# =====================================================
# DEVELOPMENT STAGE
# =====================================================
FROM dependencies AS development

# Install dev dependencies
RUN pip install --no-cache-dir debugpy watchfiles

# Copy source (will be overwritten by volume mount)
COPY --chown=agent:agent . .

USER agent
EXPOSE 8000 5678

CMD ["python", "-m", "uvicorn", "src.main:app", "--reload", "--host", "0.0.0.0"]

# =====================================================
# PRODUCTION STAGE
# =====================================================
FROM base AS production

# Copy only production dependencies
COPY --from=dependencies /usr/local/lib/python3.11/site-packages /usr/local/lib/python3.11/site-packages
COPY --from=dependencies /usr/local/bin /usr/local/bin

# Copy application code
COPY --chown=agent:agent src/ ./src/

# Security: Read-only filesystem support
RUN chmod -R 555 /app

USER agent
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

CMD ["python", "-m", "uvicorn", "src.main:app", "--host", "0.0.0.0", "--workers", "4"]
```

---

## Step 5: Create Environment Configuration Loader

### Python

Create `src/config/settings.py`:

```python
"""Environment-aware configuration loader."""
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

Environment = Literal["development", "staging", "production"]


class Settings(BaseSettings):
    """Application settings loaded from environment."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
    )

    # Environment
    environment: Environment = "development"
    debug: bool = False

    # Logging
    log_level: str = "INFO"
    log_format: Literal["pretty", "json"] = "pretty"

    # API Keys
    anthropic_api_key: str = Field(..., description="Anthropic API key")
    openai_api_key: str | None = None

    # Observability
    langchain_tracing_v2: bool = False
    langchain_api_key: str | None = None
    langchain_project: str = "default"

    # Agent Configuration
    max_iterations: int = 10
    timeout_seconds: int = 60
    enable_verbose_logging: bool = False

    # Rate Limiting
    rate_limit_requests_per_minute: int = 60

    @property
    def is_production(self) -> bool:
        return self.environment == "production"

    @property
    def is_development(self) -> bool:
        return self.environment == "development"


@lru_cache
def get_settings() -> Settings:
    """Get cached settings instance."""
    return Settings()


# Environment-specific overrides
def get_environment_settings(env: Environment) -> Settings:
    """Load settings for a specific environment."""
    env_file = Path(f"envs/{env}/.env")
    if env_file.exists():
        return Settings(_env_file=str(env_file))
    return Settings(environment=env)
```

### TypeScript

Create `src/config/settings.ts`:

```typescript
import { z } from "zod";
import { config } from "dotenv";
import { resolve } from "path";

const EnvironmentSchema = z.enum(["development", "staging", "production"]);
type Environment = z.infer<typeof EnvironmentSchema>;

const SettingsSchema = z.object({
  // Environment
  environment: EnvironmentSchema.default("development"),
  debug: z.boolean().default(false),

  // Logging
  logLevel: z.enum(["DEBUG", "INFO", "WARNING", "ERROR"]).default("INFO"),
  logFormat: z.enum(["pretty", "json"]).default("pretty"),

  // API Keys
  anthropicApiKey: z.string(),
  openaiApiKey: z.string().optional(),

  // Observability
  langchainTracingV2: z.boolean().default(false),
  langchainApiKey: z.string().optional(),
  langchainProject: z.string().default("default"),

  // Agent Configuration
  maxIterations: z.number().default(10),
  timeoutSeconds: z.number().default(60),
  enableVerboseLogging: z.boolean().default(false),

  // Rate Limiting
  rateLimitRequestsPerMinute: z.number().default(60),
});

type Settings = z.infer<typeof SettingsSchema>;

function loadEnvironment(env?: Environment): void {
  const envPath = env ? resolve(`envs/${env}/.env`) : ".env";
  config({ path: envPath });
}

function getSettings(env?: Environment): Settings {
  loadEnvironment(env);

  return SettingsSchema.parse({
    environment: process.env.ENVIRONMENT,
    debug: process.env.DEBUG === "true",
    logLevel: process.env.LOG_LEVEL,
    logFormat: process.env.LOG_FORMAT,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    openaiApiKey: process.env.OPENAI_API_KEY,
    langchainTracingV2: process.env.LANGCHAIN_TRACING_V2 === "true",
    langchainApiKey: process.env.LANGCHAIN_API_KEY,
    langchainProject: process.env.LANGCHAIN_PROJECT,
    maxIterations: parseInt(process.env.MAX_ITERATIONS ?? "10"),
    timeoutSeconds: parseInt(process.env.TIMEOUT_SECONDS ?? "60"),
    enableVerboseLogging: process.env.ENABLE_VERBOSE_LOGGING === "true",
    rateLimitRequestsPerMinute: parseInt(
      process.env.RATE_LIMIT_REQUESTS_PER_MINUTE ?? "60"
    ),
  });
}

export { getSettings, Settings, Environment };
```

---

## Step 6: Create Make Targets

Add to `Makefile`:

```makefile
# Environment targets
.PHONY: dev staging prod

dev:
	docker compose -f docker/docker-compose.dev.yml up --build

staging:
	docker compose -f docker/docker-compose.staging.yml up --build -d

prod:
	docker compose -f docker/docker-compose.prod.yml up -d

# Environment-specific commands
dev-shell:
	docker compose -f docker/docker-compose.dev.yml exec agent /bin/bash

staging-logs:
	docker compose -f docker/docker-compose.staging.yml logs -f

prod-logs:
	docker compose -f docker/docker-compose.prod.yml logs -f

# Cleanup
clean-dev:
	docker compose -f docker/docker-compose.dev.yml down -v

clean-staging:
	docker compose -f docker/docker-compose.staging.yml down -v

clean-prod:
	docker compose -f docker/docker-compose.prod.yml down
```

---

## Step 7: Update .gitignore

Add environment-specific ignores:

```gitignore
# Environment files
envs/*/.env
envs/production/.env
!envs/*/.env.example

# Local environment
.env
.env.local
.env.*.local

# Docker
docker-compose.override.yml
```

---

## Step 8: Commit Environment Configuration

```bash
git add envs/ docker/ src/config/
git commit -m "Add ${ENVIRONMENT} environment configuration

- Environment-specific .env files
- Docker Compose for ${ENVIRONMENT}
- Multi-stage Dockerfile
- Configuration loader with validation
- Make targets for environment management

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"

git push
```

---

## Output

After completion, provide user with:

1. **Environment files created**:
   ```
   envs/{environment}/.env
   docker/docker-compose.{env}.yml
   ```

2. **Quick start commands**:
   ```bash
   # Development
   make dev

   # Staging
   make staging

   # Production
   make prod
   ```

3. **Next steps**:
   - Configure secrets in `.env` files
   - Set up cloud secrets manager for production
   - Configure CI/CD to deploy to each environment
   - Add environment-specific monitoring

