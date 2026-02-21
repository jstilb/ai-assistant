#!/usr/bin/env bun
/**
 * RepoSetup.ts - GitHub Repository Creation Tool
 *
 * Creates GitHub repositories via `gh` CLI with proper .gitignore,
 * license, README template, and AGENTS.md for AI agent projects.
 *
 * Features:
 *   - Creates repos via gh CLI (public or private)
 *   - Generates language-appropriate .gitignore
 *   - Creates README.md with quickstart guide
 *   - Creates AGENTS.md with coding agent instructions
 *   - Supports TypeScript (bun) and Python projects
 *   - Optional org/owner specification
 *
 * CLI Usage:
 *   bun run RepoSetup.ts --name my-agent --description "My AI agent"
 *   bun run RepoSetup.ts --name my-agent --description "My AI agent" --org my-org --public
 *   bun run RepoSetup.ts --name my-agent --description "My AI agent" --language python
 *   bun run RepoSetup.ts --dry-run --name my-agent --description "Test"
 *
 * @module RepoSetup
 * @version 1.0.0
 */

import { execSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";

// ============================================
// TYPES
// ============================================

export interface RepoConfig {
  /** Project name in kebab-case */
  name: string;
  /** Short description of the project */
  description: string;
  /** Programming language: typescript (default) or python */
  language: "typescript" | "python";
  /** Agent framework to use */
  framework: "langgraph" | "custom" | "none";
  /** Repository visibility */
  visibility: "public" | "private";
  /** GitHub organization (optional, uses personal account if omitted) */
  org?: string;
  /** Target directory for cloning (optional, defaults to cwd) */
  targetDir?: string;
}

// ============================================
// ARGUMENT PARSING
// ============================================

export function parseRepoArgs(args: string[]): RepoConfig {
  const getFlag = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
  };

  const hasFlag = (flag: string): boolean => args.includes(flag);

  const name = getFlag("--name");
  const description = getFlag("--description");

  if (!name) {
    throw new Error("--name is required (e.g., --name my-agent)");
  }
  if (!description) {
    throw new Error("--description is required (e.g., --description \"My AI agent\")");
  }

  const languageRaw = getFlag("--language") ?? "typescript";
  if (languageRaw !== "typescript" && languageRaw !== "python") {
    throw new Error(`Invalid language: ${languageRaw}. Use 'typescript' or 'python'.`);
  }

  const frameworkRaw = getFlag("--framework") ?? "langgraph";
  if (frameworkRaw !== "langgraph" && frameworkRaw !== "custom" && frameworkRaw !== "none") {
    throw new Error(`Invalid framework: ${frameworkRaw}. Use 'langgraph', 'custom', or 'none'.`);
  }

  return {
    name,
    description,
    language: languageRaw,
    framework: frameworkRaw,
    visibility: hasFlag("--public") ? "public" : "private",
    org: getFlag("--org"),
    targetDir: getFlag("--target-dir"),
  };
}

// ============================================
// GENERATORS
// ============================================

export function generateGitignore(language: "typescript" | "python"): string {
  const common = `# Environment
.env
.env.local
.env.production
envs/.env.production

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
htmlcov/
`;

  if (language === "typescript") {
    return `${common}
# TypeScript / Node
node_modules/
dist/
.turbo/
*.tsbuildinfo

# Bun
bun.lockb
`;
  }

  return `${common}
# Python
__pycache__/
*.py[cod]
*$py.class
.venv/
venv/
.mypy_cache/
.pytest_cache/
.ruff_cache/
dist/
*.egg-info/
.coverage
`;
}

export function generateReadme(config: RepoConfig): string {
  const langCommands = config.language === "typescript"
    ? `\`\`\`bash
# Install dependencies
bun install

# Run development
bun run dev

# Run tests
bun test

# Type check
bun run typecheck

# Lint
bun run lint
\`\`\``
    : `\`\`\`bash
# Create virtual environment
python -m venv .venv
source .venv/bin/activate

# Install dependencies
pip install -e ".[dev]"

# Run tests
pytest tests/ -v

# Type check
mypy src

# Lint
ruff check src tests
\`\`\``;

  return `# ${config.name}

${config.description}

## Quick Start

${langCommands}

## Project Structure

\`\`\`
${config.name}/
├── src/
│   ├── agent/          # Agent logic (graph, nodes, tools)
│   ├── config/         # Environment configuration
│   └── utils/          # Shared utilities
├── tests/
│   ├── unit/           # Unit tests
│   ├── integration/    # Integration tests
│   └── evals/          # LLM evaluation tests
├── envs/               # Environment configurations
├── docker/             # Docker configurations
├── .github/            # CI/CD workflows
└── AGENTS.md           # AI coding agent instructions
\`\`\`

## Architecture

Built with ${config.framework === "langgraph" ? "LangGraph" : config.framework} for AI agent orchestration.

- **Entry:** \`src/index.${config.language === "typescript" ? "ts" : "py"}\` - Main application entry
- **Graph:** \`src/agent/graph.${config.language === "typescript" ? "ts" : "py"}\` - Agent orchestration
- **Nodes:** \`src/agent/nodes.${config.language === "typescript" ? "ts" : "py"}\` - Processing steps
- **Tools:** \`src/agent/tools.${config.language === "typescript" ? "ts" : "py"}\` - External integrations

## Testing

This project uses a multi-layer testing strategy:

- **Unit tests** - Individual component tests
- **Integration tests** - Full graph execution tests
- **LLM evaluations** - Response quality benchmarks

## Environment Setup

1. Copy \`envs/.env.example\` to \`envs/.env.development\`
2. Add your API keys
3. Run the development server

## License

MIT
`;
}

export function generateAgentsMd(config: RepoConfig): string {
  const ext = config.language === "typescript" ? "ts" : "py";
  const testCmd = config.language === "typescript" ? "bun test" : "pytest tests/ -v";
  const lintCmd = config.language === "typescript" ? "bun run lint" : "ruff check src tests";
  const typeCmd = config.language === "typescript" ? "bun run typecheck" : "mypy src";

  return `# AGENTS.md

## Project Overview
${config.name}: ${config.description}

Built with ${config.framework === "langgraph" ? "LangGraph" : config.framework} for AI agent orchestration.

## Architecture
- **Entry:** \`src/index.${ext}\` - Main application entry
- **Graph:** \`src/agent/graph.${ext}\` - Agent orchestration
- **Nodes:** \`src/agent/nodes.${ext}\` - Processing steps
- **Tools:** \`src/agent/tools.${ext}\` - External integrations
- **Config:** \`src/config/\` - Environment configuration

## Development Commands
- \`${config.language === "typescript" ? "bun run dev" : "make dev"}\` - Start development
- \`${testCmd}\` - Run all tests
- \`${lintCmd}\` - Check code style
- \`${typeCmd}\` - Verify types

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
`;
}

// ============================================
// GH COMMAND BUILDER
// ============================================

export function buildGhCommand(config: RepoConfig): string {
  const repoName = config.org ? `${config.org}/${config.name}` : config.name;
  const visibilityFlag = config.visibility === "public" ? "--public" : "--private";
  const descriptionEscaped = config.description.replace(/"/g, '\\"');

  return `gh repo create ${repoName} --description "${descriptionEscaped}" ${visibilityFlag} --clone`;
}

// ============================================
// EXECUTION
// ============================================

interface SetupResult {
  repoUrl: string;
  localPath: string;
  filesCreated: string[];
}

export async function setupRepo(config: RepoConfig, dryRun = false): Promise<SetupResult> {
  const filesCreated: string[] = [];
  const targetDir = config.targetDir || process.cwd();
  const localPath = join(targetDir, config.name);

  // Step 1: Create GitHub repo via gh CLI
  const ghCmd = buildGhCommand(config);
  console.log(`[RepoSetup] Creating repository: ${config.org ? config.org + "/" : ""}${config.name}`);

  if (!dryRun) {
    try {
      execSync(ghCmd, { cwd: targetDir, stdio: "pipe" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Failed to create repo via gh CLI: ${msg}`);
    }
  } else {
    console.log(`[DRY RUN] Would execute: ${ghCmd}`);
    // Create dir for dry run so we can still generate files
    if (!existsSync(localPath)) {
      mkdirSync(localPath, { recursive: true });
    }
  }

  if (!existsSync(localPath)) {
    throw new Error(`Expected cloned repo at ${localPath} but directory not found`);
  }

  // Step 2: Create directory structure
  const dirs = [
    "src/agent",
    "src/config",
    "src/utils",
    "tests/unit",
    "tests/integration",
    "tests/evals",
    "tests/fixtures",
    "envs",
    "docker",
    ".github/workflows",
    ".tasks",
    "agents",
  ];

  for (const dir of dirs) {
    const fullPath = join(localPath, dir);
    if (!existsSync(fullPath)) {
      mkdirSync(fullPath, { recursive: true });
    }
  }

  // Step 3: Write .gitignore
  const gitignorePath = join(localPath, ".gitignore");
  writeFileSync(gitignorePath, generateGitignore(config.language));
  filesCreated.push(".gitignore");

  // Step 4: Write README.md
  const readmePath = join(localPath, "README.md");
  writeFileSync(readmePath, generateReadme(config));
  filesCreated.push("README.md");

  // Step 5: Write AGENTS.md
  const agentsMdPath = join(localPath, "AGENTS.md");
  writeFileSync(agentsMdPath, generateAgentsMd(config));
  filesCreated.push("AGENTS.md");

  // Step 6: Write .env.example
  const envExamplePath = join(localPath, "envs", ".env.example");
  writeFileSync(envExamplePath, `# Required API Keys
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...

# Observability (LangSmith)
LANGCHAIN_TRACING_V2=true
LANGCHAIN_API_KEY=ls-...
LANGCHAIN_PROJECT=${config.name}

# Environment
ENVIRONMENT=development
LOG_LEVEL=DEBUG

# Agent Configuration
MAX_ITERATIONS=10
TIMEOUT_SECONDS=60
`);
  filesCreated.push("envs/.env.example");

  // Step 7: Write copilot-instructions.md
  const copilotPath = join(localPath, ".github", "copilot-instructions.md");
  writeFileSync(copilotPath, `# Copilot Instructions

## Tech Stack
- ${config.language === "typescript" ? "TypeScript with strict types" : "Python 3.11+ with type hints"}
- ${config.framework === "langgraph" ? "LangGraph" : config.framework} for agent orchestration
- ${config.language === "typescript" ? "bun:test" : "pytest"} for testing
- Docker for deployment

## Patterns
- State via ${config.language === "typescript" ? "Zod schemas" : "TypedDict"}
- Tools use ${config.language === "typescript" ? "function definitions" : "decorator pattern"}
- Async for all I/O
- Structured logging

## Avoid
- Global mutable state
- Blocking I/O in async
- Hardcoded credentials
- Untested code
`);
  filesCreated.push(".github/copilot-instructions.md");

  // Determine repo URL
  const repoUrl = config.org
    ? `https://github.com/${config.org}/${config.name}`
    : `https://github.com/${getGhUser()}/${config.name}`;

  console.log(`[RepoSetup] Repository created successfully`);
  console.log(`[RepoSetup] Local path: ${localPath}`);
  console.log(`[RepoSetup] Files created: ${filesCreated.join(", ")}`);

  return { repoUrl, localPath, filesCreated };
}

function getGhUser(): string {
  try {
    return execSync("gh api user --jq .login", { encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
}

// ============================================
// CLI
// ============================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
RepoSetup - GitHub Repository Creation for Agent Projects

Usage:
  bun run RepoSetup.ts --name <name> --description <desc> [options]

Required:
  --name <name>           Project name (kebab-case)
  --description <desc>    Project description

Options:
  --org <org>             GitHub organization
  --language <lang>       typescript (default) or python
  --framework <fw>        langgraph (default), custom, or none
  --public                Make repository public (default: private)
  --target-dir <dir>      Clone target directory (default: cwd)
  --dry-run               Preview without executing
  --help                  Show this help

Examples:
  bun run RepoSetup.ts --name my-agent --description "Customer support bot"
  bun run RepoSetup.ts --name my-agent --description "Agent" --org my-org --public
  bun run RepoSetup.ts --name my-agent --description "Agent" --language python
`);
    process.exit(0);
  }

  const dryRun = args.includes("--dry-run");

  try {
    const config = parseRepoArgs(args);
    const result = await setupRepo(config, dryRun);
    console.log("\n--- Result ---");
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.error(`Error: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
