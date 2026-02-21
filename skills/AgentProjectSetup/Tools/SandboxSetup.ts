#!/usr/bin/env bun
/**
 * SandboxSetup.ts - Sandbox Environment Setup Tool
 *
 * Sets up sandboxed development environments with Docker configurations,
 * environment variable files, and security isolation for AI agent projects.
 *
 * Features:
 *   - Generates secure Dockerfiles (non-root, read-only fs)
 *   - Creates docker-compose configs per environment
 *   - Generates environment-specific .env files
 *   - Supports dev/staging/production/sandbox environments
 *   - Resource limits and network isolation
 *
 * CLI Usage:
 *   bun run SandboxSetup.ts --project-dir /path/to/project
 *   bun run SandboxSetup.ts --project-dir /path/to/project --environments development,staging,production
 *   bun run SandboxSetup.ts --project-dir /path/to/project --language python
 *
 * @module SandboxSetup
 * @version 1.0.0
 */

import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";

// ============================================
// TYPES
// ============================================

export interface SandboxConfig {
  /** Path to the project root */
  projectDir: string;
  /** Programming language */
  language: "typescript" | "python";
  /** Environments to create */
  environments: string[];
}

interface SandboxResult {
  filesCreated: string[];
  projectDir: string;
}

// ============================================
// ARGUMENT PARSING
// ============================================

export function parseSandboxArgs(args: string[]): SandboxConfig {
  const getFlag = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
  };

  const projectDir = getFlag("--project-dir");
  if (!projectDir) {
    throw new Error("--project-dir is required");
  }

  const languageRaw = getFlag("--language") ?? "typescript";
  if (languageRaw !== "typescript" && languageRaw !== "python") {
    throw new Error(`Invalid language: ${languageRaw}. Use 'typescript' or 'python'.`);
  }

  const environmentsRaw = getFlag("--environments") ?? "development";
  const environments = environmentsRaw.split(",").map(e => e.trim());

  return {
    projectDir,
    language: languageRaw,
    environments,
  };
}

// ============================================
// GENERATORS
// ============================================

export function generateDockerfile(language: "typescript" | "python"): string {
  if (language === "typescript") {
    return `# Dockerfile.sandbox - Secure sandbox for TypeScript/Bun agent projects
# Security: non-root user, read-only source, resource limits via compose

FROM oven/bun:1.1-slim AS base

# Security: Create non-root user
RUN useradd -m -s /bin/bash -u 1000 agent && \\
    mkdir -p /app /app/output && \\
    chown -R agent:agent /app

# Install minimal system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \\
    curl \\
    && rm -rf /var/lib/apt/lists/* \\
    && apt-get clean

WORKDIR /app

# Copy dependency files first (cache layer)
COPY package.json bun.lockb* ./

# Install dependencies
RUN bun install --frozen-lockfile 2>/dev/null || bun install

# Copy source code
COPY src/ ./src/

# Security: Make source read-only
RUN chmod -R 555 /app/src

# Create writable output directory
RUN mkdir -p /app/output && chown agent:agent /app/output

# Switch to non-root user
USER agent

ENV NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \\
    CMD curl -f http://localhost:8000/health || exit 1

CMD ["bun", "run", "src/index.ts"]
`;
  }

  return `# Dockerfile.sandbox - Secure sandbox for Python agent projects
# Security: non-root user, read-only source, resource limits via compose

FROM python:3.11-slim AS base

# Security: Create non-root user
RUN useradd -m -s /bin/bash -u 1000 agent && \\
    mkdir -p /app /app/output && \\
    chown -R agent:agent /app

# Install minimal system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \\
    curl \\
    git \\
    && rm -rf /var/lib/apt/lists/* \\
    && apt-get clean

WORKDIR /app

# Copy requirements first (cache layer)
COPY pyproject.toml requirements*.txt* ./

# Install dependencies
RUN pip install --no-cache-dir -e . 2>/dev/null || \\
    ([ -f requirements.txt ] && pip install --no-cache-dir -r requirements.txt) || true

# Copy source code
COPY src/ ./src/

# Security: Make source read-only
RUN chmod -R 555 /app/src

# Create writable output directory
RUN mkdir -p /app/output && chown agent:agent /app/output

# Switch to non-root user
USER agent

ENV PYTHONUNBUFFERED=1 \\
    PYTHONDONTWRITEBYTECODE=1

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \\
    CMD python -c "import sys; sys.exit(0)" || exit 1

CMD ["python", "-m", "src.agent"]
`;
}

export function generateDockerCompose(projectName: string, environment: string): string {
  const serviceName = `${projectName}-${environment}`;

  const resourceLimits: Record<string, { cpus: string; memory: string }> = {
    development: { cpus: "2", memory: "4G" },
    staging: { cpus: "2", memory: "2G" },
    production: { cpus: "4", memory: "4G" },
    sandbox: { cpus: "2", memory: "4G" },
  };

  const limits = resourceLimits[environment] ?? resourceLimits.development;

  return `# docker-compose.${environment}.yml - ${environment} environment for ${projectName}
# Generated by AgentProjectSetup SandboxSetup tool

services:
  ${serviceName}:
    build:
      context: ..
      dockerfile: docker/Dockerfile.sandbox
    container_name: ${serviceName}

    # Security options
    security_opt:
      - no-new-privileges:true

    # Read-only filesystem with tmpfs for temp files
    read_only: true
    tmpfs:
      - /tmp:size=100M,mode=1777
      - /home/agent/.cache:size=50M

    # Resource limits
    deploy:
      resources:
        limits:
          cpus: '${limits.cpus}'
          memory: ${limits.memory}
        reservations:
          cpus: '0.5'
          memory: 512M

    # Network isolation
    networks:
      - sandbox-net

    # Environment from file
    env_file:
      - ../envs/.env.${environment}

    # Volume mounts
    volumes:
      - ../src:/app/src:ro
      - ../sandbox-output:/app/output:rw

    restart: "no"

    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"

networks:
  sandbox-net:
    driver: bridge
    internal: true
`;
}

export function generateEnvFile(projectName: string, environment: string): string {
  const configs: Record<string, string> = {
    development: `# ${projectName} - Development Environment
ENVIRONMENT=development
LOG_LEVEL=DEBUG
LOG_FORMAT=pretty

# API Keys (use dev/test keys)
ANTHROPIC_API_KEY=\${ANTHROPIC_API_KEY}

# Observability
LANGCHAIN_TRACING_V2=true
LANGCHAIN_API_KEY=\${LANGCHAIN_API_KEY}
LANGCHAIN_PROJECT=${projectName}-dev

# Agent Configuration
MAX_ITERATIONS=20
TIMEOUT_SECONDS=120
ENABLE_VERBOSE_LOGGING=true

# Development-specific
HOT_RELOAD=true
`,

    staging: `# ${projectName} - Staging Environment
ENVIRONMENT=staging
LOG_LEVEL=INFO
LOG_FORMAT=json

# API Keys (staging keys with lower limits)
ANTHROPIC_API_KEY=\${ANTHROPIC_API_KEY_STAGING}

# Observability
LANGCHAIN_TRACING_V2=true
LANGCHAIN_API_KEY=\${LANGCHAIN_API_KEY}
LANGCHAIN_PROJECT=${projectName}-staging

# Agent Configuration
MAX_ITERATIONS=10
TIMEOUT_SECONDS=60
ENABLE_VERBOSE_LOGGING=false

# Staging-specific
RATE_LIMIT_REQUESTS_PER_MINUTE=30
`,

    production: `# ${projectName} - Production Environment
# COPY TO .env.production AND FILL IN VALUES - NEVER COMMIT
ENVIRONMENT=production
LOG_LEVEL=WARNING
LOG_FORMAT=json

# API Keys (production - NEVER COMMIT)
ANTHROPIC_API_KEY=

# Observability
LANGCHAIN_TRACING_V2=true
LANGCHAIN_API_KEY=
LANGCHAIN_PROJECT=${projectName}-production

# Agent Configuration
MAX_ITERATIONS=10
TIMEOUT_SECONDS=30
ENABLE_VERBOSE_LOGGING=false

# Production-specific
RATE_LIMIT_REQUESTS_PER_MINUTE=60
ENABLE_HEALTH_CHECKS=true
ENABLE_ALERTING=true
`,

    sandbox: `# ${projectName} - Sandbox Environment (safe for autonomous execution)
ENVIRONMENT=sandbox
LOG_LEVEL=DEBUG
LOG_FORMAT=pretty

# API Keys
ANTHROPIC_API_KEY=\${ANTHROPIC_API_KEY}

# Agent Configuration (restricted)
MAX_ITERATIONS=5
TIMEOUT_SECONDS=300
ENABLE_VERBOSE_LOGGING=true
`,
  };

  return configs[environment] ?? configs.development;
}

// ============================================
// SCAFFOLDING
// ============================================

export function scaffoldSandbox(config: SandboxConfig): SandboxResult {
  const filesCreated: string[] = [];
  const { projectDir, language, environments } = config;

  // Determine project name from directory
  const projectName = projectDir.split("/").pop() ?? "agent-project";

  // Ensure directories exist
  const dockerDir = join(projectDir, "docker");
  const envsDir = join(projectDir, "envs");
  const outputDir = join(projectDir, "sandbox-output");

  for (const dir of [dockerDir, envsDir, outputDir]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  // Generate Dockerfile
  const dockerfilePath = join(dockerDir, "Dockerfile.sandbox");
  writeFileSync(dockerfilePath, generateDockerfile(language));
  filesCreated.push("docker/Dockerfile.sandbox");

  // Generate per-environment files
  for (const env of environments) {
    // Docker compose
    const composePath = join(dockerDir, `docker-compose.${env}.yml`);
    writeFileSync(composePath, generateDockerCompose(projectName, env));
    filesCreated.push(`docker/docker-compose.${env}.yml`);

    // Environment file
    const envPath = join(envsDir, `.env.${env}`);
    writeFileSync(envPath, generateEnvFile(projectName, env));
    filesCreated.push(`envs/.env.${env}`);
  }

  // Always create sandbox env
  if (!environments.includes("sandbox")) {
    const sandboxEnvPath = join(envsDir, ".env.sandbox");
    writeFileSync(sandboxEnvPath, generateEnvFile(projectName, "sandbox"));
    filesCreated.push("envs/.env.sandbox");
  }

  // Create .gitkeep for sandbox-output
  writeFileSync(join(outputDir, ".gitkeep"), "");
  filesCreated.push("sandbox-output/.gitkeep");

  console.log(`[SandboxSetup] Sandbox environment created at ${projectDir}`);
  console.log(`[SandboxSetup] Environments: ${environments.join(", ")}`);
  console.log(`[SandboxSetup] Files created: ${filesCreated.length}`);

  return { filesCreated, projectDir };
}

// ============================================
// CLI
// ============================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
SandboxSetup - Sandbox Environment Setup for Agent Projects

Usage:
  bun run SandboxSetup.ts --project-dir <path> [options]

Required:
  --project-dir <path>              Path to project root

Options:
  --language <lang>                 typescript (default) or python
  --environments <env1,env2,...>    Environments to create (default: development)
  --help                            Show this help

Examples:
  bun run SandboxSetup.ts --project-dir /path/to/project
  bun run SandboxSetup.ts --project-dir . --environments development,staging,production
  bun run SandboxSetup.ts --project-dir . --language python
`);
    process.exit(0);
  }

  try {
    const config = parseSandboxArgs(args);
    const result = scaffoldSandbox(config);
    console.log("\n--- Result ---");
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.error(`Error: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
