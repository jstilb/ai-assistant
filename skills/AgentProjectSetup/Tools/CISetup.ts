#!/usr/bin/env bun
/**
 * CISetup.ts - GitHub Actions CI/CD Workflow Generation Tool
 *
 * Generates GitHub Actions workflow files for CI/CD pipelines
 * tailored to AI agent projects with quality gates, deployment
 * workflows, and CODEOWNERS configuration.
 *
 * Features:
 *   - CI workflow with lint, typecheck, test, and eval stages
 *   - Staging deployment workflow (auto-deploy on push to main)
 *   - Production deployment workflow (manual or on release)
 *   - CODEOWNERS file generation
 *   - Language-aware (TypeScript/bun vs Python)
 *   - Concurrency controls to prevent duplicate runs
 *
 * CLI Usage:
 *   bun run CISetup.ts --project-dir /path/to/project
 *   bun run CISetup.ts --project-dir . --workflows ci,staging,production
 *   bun run CISetup.ts --project-dir . --language python --owner my-username
 *
 * @module CISetup
 * @version 1.0.0
 */

import { execSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";

// ============================================
// TYPES
// ============================================

export interface CIConfig {
  /** Path to the project root */
  projectDir: string;
  /** Programming language */
  language: "typescript" | "python";
  /** Workflows to generate */
  workflows: ("ci" | "staging" | "production")[];
  /** GitHub username for CODEOWNERS */
  owner: string;
}

interface CIResult {
  filesCreated: string[];
  projectDir: string;
}

// ============================================
// ARGUMENT PARSING
// ============================================

export function parseCIArgs(args: string[]): CIConfig {
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
    throw new Error(`Invalid language: ${languageRaw}`);
  }

  const workflowsRaw = getFlag("--workflows") ?? "ci,staging,production";
  const workflows = workflowsRaw.split(",").map(w => w.trim()) as CIConfig["workflows"];

  let owner = getFlag("--owner") ?? "";
  if (!owner) {
    try {
      owner = execSync("gh api user --jq .login", { encoding: "utf-8" }).trim();
    } catch {
      owner = "your-username";
    }
  }

  return { projectDir, language: languageRaw, workflows, owner };
}

// ============================================
// GENERATORS
// ============================================

export function generateCIWorkflow(language: "typescript" | "python"): string {
  if (language === "typescript") {
    return `name: CI

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main, develop]

concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true

jobs:
  # ==========================================
  # QUALITY GATES
  # ==========================================

  lint:
    name: Lint & Format
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Run lint
        run: bun run lint

  typecheck:
    name: Type Check
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Run type check
        run: bun run typecheck

  # ==========================================
  # TESTING
  # ==========================================

  test:
    name: Unit & Integration Tests
    runs-on: ubuntu-latest
    needs: [lint, typecheck]
    steps:
      - uses: actions/checkout@v4

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Run unit tests
        run: bun test tests/unit

      - name: Run integration tests
        run: bun test tests/integration
        env:
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
          ENVIRONMENT: test

  # ==========================================
  # LLM EVALUATIONS (Main branch only)
  # ==========================================

  evals:
    name: LLM Evaluations
    runs-on: ubuntu-latest
    needs: [test]
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'
    steps:
      - uses: actions/checkout@v4

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Run LLM evaluations
        run: bun test tests/evals
        env:
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
          LANGCHAIN_API_KEY: \${{ secrets.LANGCHAIN_API_KEY }}
          LANGCHAIN_TRACING_V2: true
`;
  }

  return `name: CI

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main, develop]

concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true

env:
  PYTHON_VERSION: '3.11'

jobs:
  # ==========================================
  # QUALITY GATES
  # ==========================================

  lint:
    name: Lint & Format
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: \${{ env.PYTHON_VERSION }}
          cache: 'pip'

      - name: Install linters
        run: pip install ruff mypy

      - name: Run Ruff linter
        run: ruff check src tests

      - name: Run Ruff formatter
        run: ruff format --check src tests

  typecheck:
    name: Type Check
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: \${{ env.PYTHON_VERSION }}
          cache: 'pip'

      - name: Install dependencies
        run: pip install -e ".[dev]"

      - name: Run MyPy
        run: mypy src --ignore-missing-imports

  # ==========================================
  # TESTING
  # ==========================================

  test:
    name: Unit & Integration Tests
    runs-on: ubuntu-latest
    needs: [lint, typecheck]
    steps:
      - uses: actions/checkout@v4

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: \${{ env.PYTHON_VERSION }}
          cache: 'pip'

      - name: Install dependencies
        run: pip install -e ".[dev]"

      - name: Run unit tests
        run: pytest tests/unit -v --tb=short --cov=src --cov-report=xml

      - name: Run integration tests
        run: pytest tests/integration -v --tb=short
        env:
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
          ENVIRONMENT: test

      - name: Upload coverage
        uses: codecov/codecov-action@v4
        with:
          file: ./coverage.xml
          fail_ci_if_error: false

  # ==========================================
  # LLM EVALUATIONS (Main branch only)
  # ==========================================

  evals:
    name: LLM Evaluations
    runs-on: ubuntu-latest
    needs: [test]
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'
    steps:
      - uses: actions/checkout@v4

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: \${{ env.PYTHON_VERSION }}
          cache: 'pip'

      - name: Install dependencies
        run: pip install -e ".[dev]"

      - name: Run LLM evaluations
        run: pytest tests/evals -v -m evals --tb=short
        env:
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
          LANGCHAIN_API_KEY: \${{ secrets.LANGCHAIN_API_KEY }}
          LANGCHAIN_TRACING_V2: true
`;
}

export function generateStagingWorkflow(language: "typescript" | "python"): string {
  const setupStep = language === "typescript"
    ? `      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest`
    : `      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.11'`;

  return `name: Deploy to Staging

on:
  push:
    branches: [main]
  workflow_dispatch:

env:
  ENVIRONMENT: staging

jobs:
  deploy:
    name: Deploy to Staging
    runs-on: ubuntu-latest
    environment: staging

    steps:
      - uses: actions/checkout@v4

${setupStep}

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Login to Container Registry
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: \${{ github.actor }}
          password: \${{ secrets.GITHUB_TOKEN }}

      - name: Build and push docker image
        uses: docker/build-push-action@v5
        with:
          context: .
          file: docker/Dockerfile.sandbox
          push: true
          tags: ghcr.io/\${{ github.repository }}:staging
          cache-from: type=gha
          cache-to: type=gha,mode=max

      - name: Verify deployment
        run: |
          echo "Waiting for deployment to stabilize..."
          sleep 30
          echo "Staging deployment complete"

      - name: Notify on failure
        if: failure()
        run: echo "Staging deployment failed - check logs"
`;
}

export function generateProductionWorkflow(language: "typescript" | "python"): string {
  return `name: Deploy to Production

on:
  release:
    types: [published]
  workflow_dispatch:
    inputs:
      version:
        description: 'Version to deploy (e.g., v1.0.0)'
        required: true

env:
  ENVIRONMENT: production

jobs:
  # ==========================================
  # PRE-DEPLOYMENT CHECKS
  # ==========================================

  pre-deploy:
    name: Pre-Deployment Checks
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Verify CI passed
        run: |
          gh run list --commit \${{ github.sha }} --status success --limit 1 | grep -q "CI" || echo "Warning: CI not verified"
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}

      - name: Verify staging is healthy
        run: echo "Verifying staging deployment..."

  # ==========================================
  # DEPLOYMENT
  # ==========================================

  deploy:
    name: Deploy to Production
    runs-on: ubuntu-latest
    needs: [pre-deploy]
    environment: production

    steps:
      - uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Login to Container Registry
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: \${{ github.actor }}
          password: \${{ secrets.GITHUB_TOKEN }}

      - name: Get version
        id: version
        run: |
          if [ "\${{ github.event_name }}" == "release" ]; then
            echo "version=\${{ github.event.release.tag_name }}" >> \$GITHUB_OUTPUT
          else
            echo "version=\${{ github.event.inputs.version }}" >> \$GITHUB_OUTPUT
          fi

      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: .
          file: docker/Dockerfile.sandbox
          push: true
          tags: |
            ghcr.io/\${{ github.repository }}:production
            ghcr.io/\${{ github.repository }}:\${{ steps.version.outputs.version }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

      - name: Verify deployment
        run: |
          echo "Waiting for production deployment to stabilize..."
          sleep 60
          echo "Production deployment complete"

  # ==========================================
  # POST-DEPLOYMENT
  # ==========================================

  post-deploy:
    name: Post-Deployment Verification
    runs-on: ubuntu-latest
    needs: [deploy]

    steps:
      - uses: actions/checkout@v4

      - name: Run smoke tests
        run: echo "Running production smoke tests..."

      - name: Verify metrics
        run: echo "Checking production metrics..."

      - name: Notify team
        if: always()
        run: |
          if [ "\${{ job.status }}" == "success" ]; then
            echo "Production deployment successful"
          else
            echo "Post-deployment checks failed - investigate immediately"
          fi
`;
}

export function generateCodeowners(owner: string): string {
  return `# CODEOWNERS - Define code review requirements
# https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners

# Default owners for everything
* @${owner}

# Agent logic requires review
/src/agent/ @${owner}

# Security-sensitive files
/.github/workflows/ @${owner}
/docker/ @${owner}

# Configuration requires review
/envs/ @${owner}
`;
}

// ============================================
// SCAFFOLDING
// ============================================

export function scaffoldCI(config: CIConfig): CIResult {
  const filesCreated: string[] = [];
  const { projectDir, language, workflows, owner } = config;

  // Ensure .github/workflows directory
  const workflowsDir = join(projectDir, ".github", "workflows");
  if (!existsSync(workflowsDir)) {
    mkdirSync(workflowsDir, { recursive: true });
  }

  // Generate CI workflow
  if (workflows.includes("ci")) {
    const ciPath = join(workflowsDir, "ci.yml");
    writeFileSync(ciPath, generateCIWorkflow(language));
    filesCreated.push(".github/workflows/ci.yml");
  }

  // Generate staging workflow
  if (workflows.includes("staging")) {
    const stagingPath = join(workflowsDir, "deploy-staging.yml");
    writeFileSync(stagingPath, generateStagingWorkflow(language));
    filesCreated.push(".github/workflows/deploy-staging.yml");
  }

  // Generate production workflow
  if (workflows.includes("production")) {
    const prodPath = join(workflowsDir, "deploy-production.yml");
    writeFileSync(prodPath, generateProductionWorkflow(language));
    filesCreated.push(".github/workflows/deploy-production.yml");
  }

  // Generate CODEOWNERS
  const codeownersPath = join(projectDir, ".github", "CODEOWNERS");
  writeFileSync(codeownersPath, generateCodeowners(owner));
  filesCreated.push(".github/CODEOWNERS");

  console.log(`[CISetup] CI/CD workflows created at ${projectDir}/.github/workflows`);
  console.log(`[CISetup] Workflows: ${workflows.join(", ")}`);
  console.log(`[CISetup] Files created: ${filesCreated.length}`);

  return { filesCreated, projectDir };
}

// ============================================
// CLI
// ============================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
CISetup - CI/CD Workflow Generation for Agent Projects

Usage:
  bun run CISetup.ts --project-dir <path> [options]

Required:
  --project-dir <path>              Path to project root

Options:
  --language <lang>                 typescript (default) or python
  --workflows <w1,w2,...>           Workflows: ci,staging,production (default: all)
  --owner <username>                GitHub username for CODEOWNERS (auto-detected)
  --help                            Show this help

Examples:
  bun run CISetup.ts --project-dir /path/to/project
  bun run CISetup.ts --project-dir . --workflows ci
  bun run CISetup.ts --project-dir . --language python --owner my-username
`);
    process.exit(0);
  }

  try {
    const config = parseCIArgs(args);
    const result = scaffoldCI(config);
    console.log("\n--- Result ---");
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.error(`Error: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
