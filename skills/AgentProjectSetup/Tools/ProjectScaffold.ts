#!/usr/bin/env bun
/**
 * ProjectScaffold.ts - Complete Project Scaffolding Orchestrator
 *
 * Orchestrates all setup tools (RepoSetup, SandboxSetup, TestInfraSetup,
 * CISetup) to scaffold a complete AI agent project in one command.
 *
 * Features:
 *   - One-command project setup from zero to production-ready
 *   - Orchestrates repo creation, sandbox, tests, and CI/CD
 *   - Generates execution plan before running
 *   - Supports dry-run mode for previewing
 *   - Skip individual phases with flags
 *   - TypeScript and Python support
 *
 * CLI Usage:
 *   bun run ProjectScaffold.ts --name my-agent --description "My AI agent"
 *   bun run ProjectScaffold.ts --name my-agent --description "Agent" --skip-repo --skip-ci
 *   bun run ProjectScaffold.ts --name my-agent --description "Agent" --dry-run
 *   bun run ProjectScaffold.ts --name my-agent --description "Agent" --language python
 *
 * @module ProjectScaffold
 * @version 1.0.0
 */

import { join } from "path";
import { existsSync, mkdirSync } from "fs";

import { setupRepo, type RepoConfig } from "./RepoSetup";
import { scaffoldSandbox, type SandboxConfig } from "./SandboxSetup";
import { scaffoldTestInfra, type TestInfraConfig } from "./TestInfraSetup";
import { scaffoldCI, type CIConfig } from "./CISetup";

// ============================================
// TYPES
// ============================================

export interface ScaffoldConfig {
  /** Project name in kebab-case */
  name: string;
  /** Short project description */
  description: string;
  /** Programming language */
  language: "typescript" | "python";
  /** Agent framework */
  framework: "langgraph" | "custom" | "none";
  /** Environments to create */
  environments: string[];
  /** Test levels to generate */
  testLevels: ("unit" | "integration" | "evals" | "e2e")[];
  /** CI workflows to generate */
  ciWorkflows: ("ci" | "staging" | "production")[];
  /** Skip GitHub repo creation */
  skipRepo: boolean;
  /** Skip CI/CD setup */
  skipCI: boolean;
  /** GitHub organization (optional) */
  org?: string;
  /** Target directory (optional, defaults to cwd) */
  targetDir?: string;
}

export interface ScaffoldPhase {
  name: string;
  description: string;
  filesEstimate: number;
}

export interface ScaffoldPlan {
  config: ScaffoldConfig;
  phases: ScaffoldPhase[];
  estimatedFiles: number;
}

interface ScaffoldResult {
  projectDir: string;
  repoUrl: string | null;
  totalFilesCreated: number;
  phases: { name: string; filesCreated: string[] }[];
}

// ============================================
// ARGUMENT PARSING
// ============================================

export function parseScaffoldArgs(args: string[]): ScaffoldConfig {
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
    throw new Error(`Invalid language: ${languageRaw}`);
  }

  const frameworkRaw = getFlag("--framework") ?? "langgraph";
  if (frameworkRaw !== "langgraph" && frameworkRaw !== "custom" && frameworkRaw !== "none") {
    throw new Error(`Invalid framework: ${frameworkRaw}`);
  }

  const environmentsRaw = getFlag("--environments") ?? "development";
  const testLevelsRaw = getFlag("--test-levels") ?? "unit,integration,evals";
  const ciWorkflowsRaw = getFlag("--ci-workflows") ?? "ci,staging,production";

  return {
    name,
    description,
    language: languageRaw,
    framework: frameworkRaw,
    environments: environmentsRaw.split(",").map(e => e.trim()),
    testLevels: testLevelsRaw.split(",").map(l => l.trim()) as ScaffoldConfig["testLevels"],
    ciWorkflows: ciWorkflowsRaw.split(",").map(w => w.trim()) as ScaffoldConfig["ciWorkflows"],
    skipRepo: hasFlag("--skip-repo"),
    skipCI: hasFlag("--skip-ci"),
    org: getFlag("--org"),
    targetDir: getFlag("--target-dir"),
  };
}

// ============================================
// PLAN BUILDER
// ============================================

export function buildScaffoldPlan(config: ScaffoldConfig): ScaffoldPlan {
  const phases: ScaffoldPhase[] = [];

  if (!config.skipRepo) {
    phases.push({
      name: "Repository Setup",
      description: `Create GitHub repo '${config.name}' with .gitignore, README, AGENTS.md`,
      filesEstimate: 5,
    });
  }

  phases.push({
    name: "Sandbox Setup",
    description: `Docker sandbox with environments: ${config.environments.join(", ")}`,
    filesEstimate: 2 + config.environments.length * 2, // Dockerfile + compose + env per environment
  });

  phases.push({
    name: "Test Infrastructure",
    description: `Test framework with levels: ${config.testLevels.join(", ")}`,
    filesEstimate: 2 + config.testLevels.length * 2, // config + template per level + fixtures
  });

  if (!config.skipCI) {
    phases.push({
      name: "CI/CD Setup",
      description: `GitHub Actions workflows: ${config.ciWorkflows.join(", ")}`,
      filesEstimate: config.ciWorkflows.length + 1, // workflow per type + CODEOWNERS
    });
  }

  const estimatedFiles = phases.reduce((sum, p) => sum + p.filesEstimate, 0);

  return { config, phases, estimatedFiles };
}

// ============================================
// ORCHESTRATION
// ============================================

async function executeScaffold(config: ScaffoldConfig, dryRun = false): Promise<ScaffoldResult> {
  const targetDir = config.targetDir || process.cwd();
  const phases: { name: string; filesCreated: string[] }[] = [];
  let repoUrl: string | null = null;
  let projectDir: string;

  console.log("=".repeat(60));
  console.log(`ProjectScaffold: Setting up '${config.name}'`);
  console.log(`Language: ${config.language} | Framework: ${config.framework}`);
  console.log("=".repeat(60));

  // Phase 1: Repository Setup
  if (!config.skipRepo) {
    console.log("\n--- Phase 1: Repository Setup ---");
    const repoConfig: RepoConfig = {
      name: config.name,
      description: config.description,
      language: config.language,
      framework: config.framework,
      visibility: "private",
      org: config.org,
      targetDir,
    };

    const repoResult = await setupRepo(repoConfig, dryRun);
    repoUrl = repoResult.repoUrl;
    projectDir = repoResult.localPath;
    phases.push({ name: "Repository Setup", filesCreated: repoResult.filesCreated });
  } else {
    console.log("\n--- Phase 1: Repository Setup (SKIPPED) ---");
    projectDir = join(targetDir, config.name);
    if (!existsSync(projectDir)) {
      mkdirSync(projectDir, { recursive: true });
    }
  }

  // Phase 2: Sandbox Setup
  console.log("\n--- Phase 2: Sandbox Setup ---");
  const sandboxConfig: SandboxConfig = {
    projectDir,
    language: config.language,
    environments: config.environments,
  };
  const sandboxResult = scaffoldSandbox(sandboxConfig);
  phases.push({ name: "Sandbox Setup", filesCreated: sandboxResult.filesCreated });

  // Phase 3: Test Infrastructure
  console.log("\n--- Phase 3: Test Infrastructure ---");
  const testConfig: TestInfraConfig = {
    projectDir,
    language: config.language,
    levels: config.testLevels,
  };
  const testResult = scaffoldTestInfra(testConfig);
  phases.push({ name: "Test Infrastructure", filesCreated: testResult.filesCreated });

  // Phase 4: CI/CD Setup
  if (!config.skipCI) {
    console.log("\n--- Phase 4: CI/CD Setup ---");
    const ciConfig: CIConfig = {
      projectDir,
      language: config.language,
      workflows: config.ciWorkflows,
      owner: config.org ?? "your-username",
    };
    const ciResult = scaffoldCI(ciConfig);
    phases.push({ name: "CI/CD Setup", filesCreated: ciResult.filesCreated });
  } else {
    console.log("\n--- Phase 4: CI/CD Setup (SKIPPED) ---");
  }

  const totalFilesCreated = phases.reduce((sum, p) => sum + p.filesCreated.length, 0);

  console.log("\n" + "=".repeat(60));
  console.log(`Project '${config.name}' scaffolded successfully!`);
  console.log(`Total files created: ${totalFilesCreated}`);
  console.log(`Project directory: ${projectDir}`);
  if (repoUrl) console.log(`Repository URL: ${repoUrl}`);
  console.log("=".repeat(60));

  return { projectDir, repoUrl, totalFilesCreated, phases };
}

// ============================================
// CLI
// ============================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
ProjectScaffold - Complete Agent Project Scaffolding

Orchestrates RepoSetup + SandboxSetup + TestInfraSetup + CISetup
into a single command for scaffolding production-ready agent projects.

Usage:
  bun run ProjectScaffold.ts --name <name> --description <desc> [options]

Required:
  --name <name>                     Project name (kebab-case)
  --description <desc>              Project description

Options:
  --language <lang>                 typescript (default) or python
  --framework <fw>                  langgraph (default), custom, or none
  --org <org>                       GitHub organization
  --environments <env1,env2,...>    Environments (default: development)
  --test-levels <l1,l2,...>         Test levels (default: unit,integration,evals)
  --ci-workflows <w1,w2,...>        CI workflows (default: ci,staging,production)
  --target-dir <dir>                Where to create the project (default: cwd)
  --skip-repo                       Skip GitHub repository creation
  --skip-ci                         Skip CI/CD workflow generation
  --dry-run                         Preview without executing
  --plan                            Show execution plan only
  --help                            Show this help

Examples:
  # Full project setup
  bun run ProjectScaffold.ts --name my-agent --description "Customer support bot"

  # Skip GitHub repo (local only)
  bun run ProjectScaffold.ts --name my-agent --description "Agent" --skip-repo

  # Python project with all environments
  bun run ProjectScaffold.ts --name my-agent --description "Agent" \\
    --language python --environments development,staging,production

  # Preview what would be created
  bun run ProjectScaffold.ts --name my-agent --description "Agent" --plan
`);
    process.exit(0);
  }

  const dryRun = args.includes("--dry-run");
  const planOnly = args.includes("--plan");

  try {
    const config = parseScaffoldArgs(args);

    if (planOnly) {
      const plan = buildScaffoldPlan(config);
      console.log("\n--- Scaffold Plan ---");
      console.log(`Project: ${config.name}`);
      console.log(`Language: ${config.language} | Framework: ${config.framework}`);
      console.log(`\nPhases (${plan.phases.length}):`);
      for (const phase of plan.phases) {
        console.log(`  [${phase.filesEstimate} files] ${phase.name}: ${phase.description}`);
      }
      console.log(`\nEstimated total files: ${plan.estimatedFiles}`);
      process.exit(0);
    }

    const result = await executeScaffold(config, dryRun);
    console.log("\n--- Final Result ---");
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.error(`Error: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
