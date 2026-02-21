#!/usr/bin/env bun
/**
 * ProjectRegistry.ts - Project path management for AutonomousWork
 *
 * Manages project registry for autonomous work execution:
 * - Looks up project paths by name
 * - Creates new project directories
 * - Validates project existence
 * - Auto-registers new projects
 *
 * Usage:
 *   bun run ProjectRegistry.ts get <name>           # Get project path
 *   bun run ProjectRegistry.ts add <name> [--path]  # Add/register project
 *   bun run ProjectRegistry.ts list                 # List all projects
 *   bun run ProjectRegistry.ts resolve <work-item>  # Resolve project for work item
 */

import { parseArgs } from "util";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, basename } from "path";
import { z } from "zod";

// ============================================================================
// Configuration
// ============================================================================

const KAYA_HOME = process.env.KAYA_HOME || join(process.env.HOME || "", ".claude");
const REGISTRY_FILE = join(KAYA_HOME, "MEMORY/PROJECTS/registry.json");
const DEFAULT_PROJECTS_PATH = "~/Desktop/projects";

// ============================================================================
// Types
// ============================================================================

export interface ProjectEntry {
  name: string;
  path: string;
  gitRemote?: string;
  description?: string;
  createdAt?: string;
}

interface ProjectRegistry {
  version: number;
  defaultPath: string;
  kayaPath: string;
  projects: Record<string, ProjectEntry>;
  lastUpdated: string;
}

// ============================================================================
// Zod Schema
// ============================================================================

const ProjectEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  gitRemote: z.string().optional(),
  description: z.string().optional(),
  createdAt: z.string().optional(),
});

const ProjectRegistrySchema = z.object({
  version: z.number(),
  defaultPath: z.string(),
  kayaPath: z.string(),
  projects: z.record(z.string(), ProjectEntrySchema),
  lastUpdated: z.string(),
});

// ============================================================================
// ProjectRegistry Class
// ============================================================================

export class ProjectRegistry {
  private registry: ProjectRegistry;

  constructor() {
    this.registry = this.loadRegistry();
  }

  private loadRegistry(): ProjectRegistry {
    if (existsSync(REGISTRY_FILE)) {
      try {
        const content = readFileSync(REGISTRY_FILE, "utf-8");
        return ProjectRegistrySchema.parse(JSON.parse(content));
      } catch (e) {
        console.warn(`Failed to load registry, using defaults: ${e}`);
      }
    }

    // Create default registry
    const defaultRegistry: ProjectRegistry = {
      version: 1,
      defaultPath: DEFAULT_PROJECTS_PATH,
      kayaPath: KAYA_HOME,
      projects: {
        kaya: {
          name: "kaya",
          path: KAYA_HOME,
          description: "Kaya personal AI infrastructure",
        },
      },
      lastUpdated: new Date().toISOString(),
    };

    this.saveRegistry(defaultRegistry);
    return defaultRegistry;
  }

  private saveRegistry(registry?: ProjectRegistry): void {
    const toSave = registry || this.registry;
    toSave.lastUpdated = new Date().toISOString();

    const dir = join(KAYA_HOME, "MEMORY/PROJECTS");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(REGISTRY_FILE, JSON.stringify(toSave, null, 2));
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Get a project by name
   */
  getProject(name: string): ProjectEntry | undefined {
    return this.registry.projects[name.toLowerCase()];
  }

  /**
   * Get project path by name, returns undefined if not found
   */
  getPath(name: string): string | undefined {
    const project = this.getProject(name);
    return project?.path;
  }

  /**
   * Add a new project to the registry
   */
  addProject(entry: ProjectEntry): void {
    const key = entry.name.toLowerCase();
    entry.createdAt = entry.createdAt || new Date().toISOString();
    this.registry.projects[key] = entry;
    this.saveRegistry();
  }

  /**
   * List all projects
   */
  listProjects(): ProjectEntry[] {
    return Object.values(this.registry.projects);
  }

  /**
   * Get the default projects directory path
   */
  getDefaultPath(): string {
    return this.registry.defaultPath;
  }

  /**
   * Get the Kaya home path (for Kaya-specific work)
   */
  getPAIPath(): string {
    return this.registry.kayaPath;
  }

  /**
   * Resolve project path for a work item
   * - If project is specified, use it
   * - If work mentions a known project, use it
   * - If work type is Kaya skill/system, use KAYA_HOME
   * - Otherwise, return undefined (needs to be set)
   */
  resolveProjectForWork(workItem: {
    title: string;
    description: string;
    type?: string;
    project?: { name?: string; path?: string };
  }): ProjectEntry | undefined {
    // If project is explicitly set, use it
    if (workItem.project?.path) {
      return {
        name: workItem.project.name || basename(workItem.project.path),
        path: workItem.project.path,
      };
    }

    if (workItem.project?.name) {
      const project = this.getProject(workItem.project.name);
      if (project) return project;
    }

    // Check if title/description mentions a known project
    const text = `${workItem.title} ${workItem.description}`.toLowerCase();

    for (const [key, project] of Object.entries(this.registry.projects)) {
      if (text.includes(key)) {
        return project;
      }
    }

    // Check for Kaya-specific keywords
    const kayaKeywords = [
      "skill",
      "pai",
      "kaya",
      "hook",
      "workflow",
      "queue",
      "memory",
    ];
    if (kayaKeywords.some((kw) => text.includes(kw))) {
      return this.registry.projects["kaya"];
    }

    // No project found - needs to be specified
    return undefined;
  }

  /**
   * Create a new project directory and register it
   */
  createProject(name: string, options?: {
    description?: string;
    gitRemote?: string;
    initGit?: boolean;
  }): ProjectEntry {
    const slug = name.toLowerCase().replace(/\s+/g, "-");
    const path = join(this.registry.defaultPath, slug);

    // Create directory if it doesn't exist
    if (!existsSync(path)) {
      mkdirSync(path, { recursive: true });
    }

    const entry: ProjectEntry = {
      name: slug,
      path,
      description: options?.description,
      gitRemote: options?.gitRemote,
      createdAt: new Date().toISOString(),
    };

    this.addProject(entry);
    return entry;
  }

  /**
   * Check if a project path exists
   */
  validateProjectPath(path: string): boolean {
    return existsSync(path);
  }
}

// ============================================================================
// CLI Interface
// ============================================================================

async function main() {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      help: { type: "boolean", short: "h" },
      path: { type: "string", short: "p" },
      description: { type: "string", short: "d" },
      "git-remote": { type: "string", short: "g" },
      output: { type: "string", short: "o", default: "text" },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(`
ProjectRegistry - Project path management for AutonomousWork

Commands:
  get <name>           Get project path by name
  add <name>           Add/register a project
  list                 List all registered projects
  create <name>        Create new project directory and register it
  resolve <json>       Resolve project for work item (JSON input)

Options:
  -p, --path <path>         Project path (for add)
  -d, --description <desc>  Project description
  -g, --git-remote <url>    Git remote URL
  -o, --output <fmt>        Output format: text (default), json
  -h, --help                Show this help

Examples:
  bun run ProjectRegistry.ts get lucidview
  bun run ProjectRegistry.ts add myapp --path /path/to/myapp
  bun run ProjectRegistry.ts create "My New App" --description "Cool app"
  bun run ProjectRegistry.ts list --output json
`);
    return;
  }

  const registry = new ProjectRegistry();
  const command = positionals[0];

  switch (command) {
    case "get": {
      const name = positionals[1];
      if (!name) {
        console.error("Error: project name required");
        process.exit(1);
      }
      const project = registry.getProject(name);
      if (project) {
        if (values.output === "json") {
          console.log(JSON.stringify(project, null, 2));
        } else {
          console.log(project.path);
        }
      } else {
        console.error(`Project not found: ${name}`);
        process.exit(1);
      }
      break;
    }

    case "add": {
      const name = positionals[1];
      if (!name) {
        console.error("Error: project name required");
        process.exit(1);
      }
      const path = values.path || join(registry.getDefaultPath(), name);
      registry.addProject({
        name,
        path,
        description: values.description,
        gitRemote: values["git-remote"],
      });
      console.log(`Added project: ${name} -> ${path}`);
      break;
    }

    case "create": {
      const name = positionals[1];
      if (!name) {
        console.error("Error: project name required");
        process.exit(1);
      }
      const project = registry.createProject(name, {
        description: values.description,
        gitRemote: values["git-remote"],
      });
      if (values.output === "json") {
        console.log(JSON.stringify(project, null, 2));
      } else {
        console.log(`Created project: ${project.name} -> ${project.path}`);
      }
      break;
    }

    case "list": {
      const projects = registry.listProjects();
      if (values.output === "json") {
        console.log(JSON.stringify(projects, null, 2));
      } else {
        console.log("Registered Projects:");
        console.log("─".repeat(60));
        for (const p of projects) {
          console.log(`  ${p.name.padEnd(20)} ${p.path}`);
          if (p.description) {
            console.log(`  ${"".padEnd(20)} ${p.description}`);
          }
        }
      }
      break;
    }

    case "resolve": {
      const json = positionals[1];
      if (!json) {
        console.error("Error: work item JSON required");
        process.exit(1);
      }
      try {
        const workItem = JSON.parse(json);
        const project = registry.resolveProjectForWork(workItem);
        if (project) {
          if (values.output === "json") {
            console.log(JSON.stringify(project, null, 2));
          } else {
            console.log(project.path);
          }
        } else {
          console.error("Could not resolve project for work item");
          process.exit(1);
        }
      } catch (e) {
        console.error(`Invalid JSON: ${e}`);
        process.exit(1);
      }
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.error("Use --help for usage.");
      process.exit(1);
  }
}

if (import.meta.main) {
  main().catch(console.error);
}

export { ProjectRegistry as ProjectRegistryClass };
