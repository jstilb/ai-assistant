#!/usr/bin/env bun
/**
 * TemplateManager — Phase 5: Generative UI and Templates
 *
 * Template CRUD operations with intent-based matching for Canvas layouts.
 * Manages built-in templates (Config/templates/) and user-saved templates
 * (State/templates/) with StateManager-backed persistence.
 *
 * Features:
 *   - Save, load, list, delete, search templates
 *   - findBestTemplate(intent) — keyword matching against names/tags/descriptions
 *   - Built-in templates are read-only; user templates are mutable
 *   - Template name validation (slug-friendly: lowercase, hyphens, no spaces)
 *   - Zod schema validation on all template operations
 *
 * CLI:
 *   bun TemplateManager.ts list                          # List all templates
 *   bun TemplateManager.ts find "morning"                # Find best match
 *   bun TemplateManager.ts save "my-layout" --description "My custom layout" --layout '{"columns":2,...}'
 *   bun TemplateManager.ts load "morning-briefing"       # Load template by ID
 *   bun TemplateManager.ts delete "my-layout"            # Delete user template
 *
 * @module TemplateManager
 * @version 1.0.0
 */

import { z } from "zod";
import { join, dirname } from "path";
import { existsSync, readdirSync, readFileSync, unlinkSync, mkdirSync } from "fs";
import { createStateManager, type StateManager } from "../../../../lib/core/StateManager.ts";

// ============================================================================
// Constants
// ============================================================================

const SKILL_ROOT = dirname(dirname(import.meta.path));
const BUILTIN_DIR = join(SKILL_ROOT, "Config", "templates");
const USER_DIR = join(SKILL_ROOT, "State", "templates");
const TEMPLATE_NAME_REGEX = /^[a-z0-9][a-z0-9-]*$/;

// ============================================================================
// Schemas
// ============================================================================

const ContainerPositionSchema = z.object({
  col: z.number().int().min(0),
  row: z.number().int().min(0),
  colSpan: z.number().int().min(1).optional(),
  rowSpan: z.number().int().min(1).optional(),
});

const DeclarativeSchemaTypeSchema = z.enum(["form", "list", "detail", "metric", "status"]);

const DeclarativeSchemaSchema = z.object({
  type: DeclarativeSchemaTypeSchema,
  title: z.string().optional(),
  data: z.record(z.string(), z.unknown()),
  actions: z
    .array(
      z.object({
        label: z.string(),
        method: z.string().optional(),
        variant: z.enum(["primary", "secondary", "destructive"]).optional(),
      })
    )
    .optional(),
  style: z.record(z.string(), z.unknown()).optional(),
});

const SandpackPayloadSchema = z.object({
  code: z.string(),
  dependencies: z.record(z.string(), z.string()).optional(),
  files: z.record(z.string(), z.string()).optional(),
  entry: z.string().optional(),
});

const ContainerPlacementSchema = z.object({
  type: z.string(),
  props: z.record(z.string(), z.unknown()).optional(),
  schema: DeclarativeSchemaSchema.optional(),
  sandpack: SandpackPayloadSchema.optional(),
  position: ContainerPositionSchema,
  title: z.string().optional(),
});

export const LayoutConfigSchema = z.object({
  columns: z.number().int().min(1).max(12),
  rows: z.number().int().min(1).optional(),
  gap: z.number().min(0).optional(),
  containers: z.array(ContainerPlacementSchema),
});

// Phase 3: Template variable schema
const TemplateVariableSchema = z.object({
  name: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(["string", "path", "url", "number"]),
  default: z.string().optional(),
  placeholder: z.string().optional(),
  required: z.boolean(),
});

// Phase 3: Template tab group schema (index-based, for serialization)
const TemplateTabGroupSchema = z.object({
  containerIndices: z.array(z.number().int().min(0)),
  activeIndex: z.number().int().min(0),
});

export const TemplateConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  version: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  layout: LayoutConfigSchema,
  tags: z.array(z.string()).optional(),
  // Phase 3: new optional fields (backward compatible — undefined treated as defaults)
  source: z.enum(["system", "user"]).optional(),
  variables: z.array(TemplateVariableSchema).optional(),
  tabGroups: z.array(TemplateTabGroupSchema).optional(),
});

export type TemplateConfig = z.infer<typeof TemplateConfigSchema>;
export type LayoutConfig = z.infer<typeof LayoutConfigSchema>;
export type ContainerPlacement = z.infer<typeof ContainerPlacementSchema>;
export type DeclarativeSchema = z.infer<typeof DeclarativeSchemaSchema>;
export type SandpackPayload = z.infer<typeof SandpackPayloadSchema>;
export type TemplateVariable = z.infer<typeof TemplateVariableSchema>;
export type TemplateTabGroup = z.infer<typeof TemplateTabGroupSchema>;

export interface TemplateSummary {
  id: string;
  name: string;
  description: string;
  containerCount: number;
  tags: string[];
  builtin: boolean;
  /** Phase 3: 'system' for builtin templates, 'user' for saved templates */
  source: 'system' | 'user';
  updatedAt: string;
  /** Phase 3: number of defined variables */
  variableCount: number;
}

// ============================================================================
// Template Manager
// ============================================================================

export interface TemplateManagerInstance {
  /** List all available templates (built-in + user) */
  list(search?: string): TemplateSummary[];

  /** Load a template by ID or name */
  load(idOrName: string): TemplateConfig | null;

  /** Save a user template. Returns the saved template's ID. */
  save(
    name: string,
    description: string,
    layout: LayoutConfig,
    tags?: string[],
    /** Phase 3: optional variables and tabGroups to capture with the template */
    options?: {
      variables?: TemplateVariable[];
      tabGroups?: TemplateTabGroup[];
    }
  ): Promise<string>;

  /** Delete a user template. Built-in templates cannot be deleted. Returns true if deleted. */
  delete(id: string): boolean;

  /** Find the best matching template for a given intent string */
  findBestTemplate(intent: string): TemplateConfig | null;
}

/**
 * Create a TemplateManager instance.
 * Optionally override directories for testing.
 */
export function createTemplateManager(options?: {
  builtinDir?: string;
  userDir?: string;
}): TemplateManagerInstance {
  const builtinDir = options?.builtinDir ?? BUILTIN_DIR;
  const userDir = options?.userDir ?? USER_DIR;

  // Ensure directories exist
  mkdirSync(builtinDir, { recursive: true });
  mkdirSync(userDir, { recursive: true });

  function loadTemplatesFromDir(
    dir: string,
    builtin: boolean
  ): TemplateConfig[] {
    if (!existsSync(dir)) return [];

    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    const templates: TemplateConfig[] = [];

    for (const file of files) {
      try {
        const raw = readFileSync(join(dir, file), "utf-8");
        const parsed = JSON.parse(raw);
        const result = TemplateConfigSchema.safeParse(parsed);
        if (result.success) {
          templates.push(result.data);
        }
      } catch {
        // Skip corrupted files
      }
    }

    return templates;
  }

  function getAllTemplates(): Array<TemplateConfig & { builtin: boolean }> {
    const builtins = loadTemplatesFromDir(builtinDir, true).map((t) => ({
      ...t,
      builtin: true as const,
    }));
    const userTemplates = loadTemplatesFromDir(userDir, false).map((t) => ({
      ...t,
      builtin: false as const,
    }));
    return [...builtins, ...userTemplates];
  }

  function toSummary(
    t: TemplateConfig & { builtin: boolean }
  ): TemplateSummary {
    return {
      id: t.id,
      name: t.name,
      description: t.description,
      containerCount: t.layout.containers.length,
      tags: t.tags ?? [],
      builtin: t.builtin,
      source: t.builtin ? 'system' : (t.source ?? 'user'),
      updatedAt: t.updatedAt,
      variableCount: (t.variables ?? []).length,
    };
  }

  function matchScore(template: TemplateConfig, intent: string): number {
    const lower = intent.toLowerCase();
    const words = lower.split(/\s+/).filter((w) => w.length > 1);
    let score = 0;

    // Check name match
    const nameLower = template.name.toLowerCase();
    if (nameLower === lower) score += 100;
    else if (nameLower.includes(lower)) score += 50;

    // Check ID match
    const idLower = template.id.toLowerCase();
    if (idLower === lower) score += 100;
    else if (idLower.includes(lower)) score += 50;

    // Check individual words against name, description, tags
    for (const word of words) {
      if (nameLower.includes(word)) score += 20;
      if (idLower.includes(word)) score += 20;
      if (template.description.toLowerCase().includes(word)) score += 10;
      if (template.tags?.some((tag) => tag.toLowerCase().includes(word)))
        score += 15;
    }

    return score;
  }

  return {
    list(search?: string): TemplateSummary[] {
      const all = getAllTemplates();
      let summaries = all.map(toSummary);

      if (search && search.trim().length > 0) {
        const lower = search.toLowerCase();
        summaries = summaries.filter(
          (s) =>
            s.name.toLowerCase().includes(lower) ||
            s.id.toLowerCase().includes(lower) ||
            s.description.toLowerCase().includes(lower) ||
            s.tags.some((tag) => tag.toLowerCase().includes(lower))
        );
      }

      return summaries;
    },

    load(idOrName: string): TemplateConfig | null {
      const all = getAllTemplates();
      return (
        all.find(
          (t) =>
            t.id === idOrName ||
            t.name.toLowerCase() === idOrName.toLowerCase()
        ) ?? null
      );
    },

    async save(
      name: string,
      description: string,
      layout: LayoutConfig,
      tags?: string[],
      options?: {
        variables?: TemplateVariable[];
        tabGroups?: TemplateTabGroup[];
      }
    ): Promise<string> {
      // Validate name format
      const slug = name
        .toLowerCase()
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9-]/g, "");

      if (!TEMPLATE_NAME_REGEX.test(slug)) {
        throw new Error(
          `Invalid template name "${name}". Must be lowercase alphanumeric with hyphens.`
        );
      }

      // Validate layout
      const layoutResult = LayoutConfigSchema.safeParse(layout);
      if (!layoutResult.success) {
        throw new Error(
          `Invalid layout: ${layoutResult.error.message}`
        );
      }

      const now = new Date().toISOString();
      const template: TemplateConfig = {
        id: slug,
        name,
        description,
        version: "1.0.0",
        createdAt: now,
        updatedAt: now,
        layout: layoutResult.data,
        tags: tags ?? [],
        source: "user",
        variables: options?.variables ?? [],
        tabGroups: options?.tabGroups ?? [],
      };

      // Check if template already exists (update updatedAt)
      const existingPath = join(userDir, `${slug}.json`);
      if (existsSync(existingPath)) {
        try {
          const existing = JSON.parse(readFileSync(existingPath, "utf-8"));
          const existingResult = TemplateConfigSchema.safeParse(existing);
          if (existingResult.success) {
            template.createdAt = existingResult.data.createdAt;
          }
        } catch {
          // Overwrite corrupted file
        }
      }

      // Use StateManager for atomic write
      const manager = createStateManager({
        path: existingPath,
        schema: TemplateConfigSchema,
        defaults: template,
      });

      await manager.save(template);
      return slug;
    },

    delete(id: string): boolean {
      // Check if it's a built-in template
      const builtinPath = join(builtinDir, `${id}.json`);
      if (existsSync(builtinPath)) {
        throw new Error(
          `Cannot delete built-in template "${id}". Only user templates can be deleted.`
        );
      }

      const userPath = join(userDir, `${id}.json`);
      if (!existsSync(userPath)) {
        return false;
      }

      unlinkSync(userPath);
      return true;
    },

    findBestTemplate(intent: string): TemplateConfig | null {
      if (!intent || intent.trim().length === 0) return null;

      const all = getAllTemplates();
      let bestScore = 0;
      let bestTemplate: TemplateConfig | null = null;

      for (const template of all) {
        const score = matchScore(template, intent);
        if (score > bestScore) {
          bestScore = score;
          bestTemplate = template;
        }
      }

      // Minimum threshold to avoid returning garbage matches
      if (bestScore < 10) return null;

      return bestTemplate;
    },
  };
}

// ============================================================================
// CLI
// ============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    console.log(`
TemplateManager — Canvas Template CRUD

Usage:
  bun TemplateManager.ts list [search]                    List templates (optionally filtered)
  bun TemplateManager.ts find "intent"                    Find best template for intent
  bun TemplateManager.ts load "id-or-name"                Load template by ID or name
  bun TemplateManager.ts save "name" --description "..."  Save a new template
  bun TemplateManager.ts delete "id"                      Delete a user template
  bun TemplateManager.ts --help                           Show this help
`);
    process.exit(0);
  }

  const manager = createTemplateManager();

  switch (command) {
    case "list": {
      const search = args[1];
      const templates = manager.list(search);
      if (templates.length === 0) {
        console.log(search ? `No templates matching "${search}"` : "No templates found");
      } else {
        console.log(JSON.stringify(templates, null, 2));
      }
      break;
    }

    case "find": {
      const intent = args[1];
      if (!intent) {
        console.error("Usage: bun TemplateManager.ts find \"intent\"");
        process.exit(1);
      }
      const result = manager.findBestTemplate(intent);
      if (result) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`No template matched intent: "${intent}"`);
      }
      break;
    }

    case "load": {
      const id = args[1];
      if (!id) {
        console.error("Usage: bun TemplateManager.ts load \"id\"");
        process.exit(1);
      }
      const template = manager.load(id);
      if (template) {
        console.log(JSON.stringify(template, null, 2));
      } else {
        console.log(`Template not found: "${id}"`);
      }
      break;
    }

    case "save": {
      const name = args[1];
      if (!name) {
        console.error("Usage: bun TemplateManager.ts save \"name\" --description \"...\" --layout '{...}'");
        process.exit(1);
      }

      const descIdx = args.indexOf("--description");
      const description = descIdx >= 0 ? args[descIdx + 1] ?? "" : "";

      const layoutIdx = args.indexOf("--layout");
      const layoutStr = layoutIdx >= 0 ? args[layoutIdx + 1] : undefined;

      let layout: LayoutConfig;
      if (layoutStr) {
        try {
          layout = JSON.parse(layoutStr);
        } catch {
          console.error("Invalid --layout JSON");
          process.exit(1);
        }
      } else {
        // Default empty layout
        layout = { columns: 2, containers: [] };
      }

      const tagsIdx = args.indexOf("--tags");
      const tagsStr = tagsIdx >= 0 ? args[tagsIdx + 1] : undefined;
      const tags = tagsStr ? tagsStr.split(",").map((t) => t.trim()) : undefined;

      const id = await manager.save(name, description, layout, tags);
      console.log(`Saved template: ${id}`);
      break;
    }

    case "delete": {
      const id = args[1];
      if (!id) {
        console.error("Usage: bun TemplateManager.ts delete \"id\"");
        process.exit(1);
      }
      try {
        const deleted = manager.delete(id);
        console.log(deleted ? `Deleted template: ${id}` : `Template not found: ${id}`);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.error("Use --help for usage information.");
      process.exit(1);
  }
}
