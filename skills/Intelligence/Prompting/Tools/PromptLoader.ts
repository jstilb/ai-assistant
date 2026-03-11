#!/usr/bin/env bun
/**
 * PromptLoader.ts - Load prompts by registry ID with data injection
 *
 * Central interface for loading managed prompts from the PromptRegistry.
 * Supports both CLI usage and programmatic imports.
 *
 * Usage:
 *   bun PromptLoader.ts --prompt <registry_id> [--data <path>] [--validate]
 *
 * Examples:
 *   bun PromptLoader.ts --prompt sentiment_analysis --data ./context.yaml
 *   bun PromptLoader.ts -p tab_title
 *   bun PromptLoader.ts --prompt agent_context --data ./agent.json --validate
 */

import Handlebars from 'handlebars';
import { parse as parseYaml } from 'yaml';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { parseArgs } from 'util';

// =============================================================================
// Types
// =============================================================================

export interface PromptLoaderOptions {
  /** Registry key for the prompt */
  promptId: string;
  /** Data to inject into the template */
  data?: Record<string, unknown>;
  /** Path to YAML/JSON data file (alternative to data object) */
  dataPath?: string;
  /** Validate required data fields */
  validate?: boolean;
}

export interface PromptEntry {
  template: string;
  version: string;
  description: string;
  used_by: string[];
  model_hint: 'fast' | 'standard' | 'smart' | null;
  required_data?: string[];
  output_format: 'json' | 'text';
}

export interface PromptRegistry {
  version: string;
  last_updated: string;
  prompts: Record<string, PromptEntry>;
  categories: Record<string, { description: string; prompts: string[] }>;
  model_hints: Record<string, string>;
}

export interface LoadedPrompt {
  /** Rendered prompt content */
  content: string;
  /** Registry entry metadata */
  meta: PromptEntry;
  /** Registry ID */
  promptId: string;
}

// =============================================================================
// Constants
// =============================================================================

const PROMPTING_DIR = dirname(dirname(import.meta.path));
const TEMPLATES_DIR = join(PROMPTING_DIR, 'Templates');
const REGISTRY_PATH = join(TEMPLATES_DIR, 'PromptRegistry.yaml');

// =============================================================================
// Registry Loading
// =============================================================================

let _cachedRegistry: PromptRegistry | null = null;

/**
 * Load the prompt registry (cached)
 */
export function getRegistry(): PromptRegistry {
  if (_cachedRegistry) return _cachedRegistry;

  if (!existsSync(REGISTRY_PATH)) {
    throw new Error(`PromptRegistry not found at: ${REGISTRY_PATH}`);
  }

  const content = readFileSync(REGISTRY_PATH, 'utf-8');
  _cachedRegistry = parseYaml(content) as PromptRegistry;
  return _cachedRegistry;
}

/**
 * Get a prompt entry from the registry
 */
export function getPromptEntry(promptId: string): PromptEntry {
  const registry = getRegistry();
  const entry = registry.prompts[promptId];

  if (!entry) {
    const available = Object.keys(registry.prompts).join(', ');
    throw new Error(`Unknown prompt ID: "${promptId}". Available: ${available}`);
  }

  return entry;
}

/**
 * List all available prompts
 */
export function listPrompts(): Array<{ id: string; description: string; model_hint: string | null }> {
  const registry = getRegistry();
  return Object.entries(registry.prompts).map(([id, entry]) => ({
    id,
    description: entry.description,
    model_hint: entry.model_hint,
  }));
}

/**
 * List prompts by category
 */
export function listByCategory(): Record<string, Array<{ id: string; description: string }>> {
  const registry = getRegistry();
  const result: Record<string, Array<{ id: string; description: string }>> = {};

  for (const [category, info] of Object.entries(registry.categories)) {
    result[category] = info.prompts.map((id) => ({
      id,
      description: registry.prompts[id]?.description || 'Unknown',
    }));
  }

  return result;
}

// =============================================================================
// Template Loading (helpers from shared module)
// =============================================================================

import { registerHelpers } from './helpers';

/**
 * Load data from a file path
 */
function loadDataFile(dataPath: string): Record<string, unknown> {
  const fullPath = dataPath.startsWith('/') ? dataPath : resolve(process.cwd(), dataPath);

  if (!existsSync(fullPath)) {
    throw new Error(`Data file not found: ${fullPath}`);
  }

  const content = readFileSync(fullPath, 'utf-8');

  if (dataPath.endsWith('.json')) {
    return JSON.parse(content);
  }

  return parseYaml(content) as Record<string, unknown>;
}

/**
 * Validate that required data fields are present
 */
function validateData(data: Record<string, unknown>, required: string[]): string[] {
  const missing: string[] = [];

  for (const field of required) {
    const parts = field.split('.');
    let value: unknown = data;

    for (const part of parts) {
      if (value === null || value === undefined || typeof value !== 'object') {
        missing.push(field);
        break;
      }
      value = (value as Record<string, unknown>)[part];
    }

    if (value === undefined) {
      missing.push(field);
    }
  }

  return missing;
}

// =============================================================================
// Core Function
// =============================================================================

/**
 * Load a prompt by registry ID with optional data injection
 *
 * @example
 * // Load with inline data
 * const prompt = await loadPrompt({
 *   promptId: 'sentiment_analysis',
 *   data: { principal: { name: 'Jm' }, assistant: { name: 'Kaya' } }
 * });
 *
 * @example
 * // Load with data file
 * const prompt = await loadPrompt({
 *   promptId: 'agent_context',
 *   dataPath: './agent-data.yaml',
 *   validate: true
 * });
 */
export async function loadPrompt(options: PromptLoaderOptions): Promise<LoadedPrompt> {
  const { promptId, data = {}, dataPath, validate = false } = options;

  // Get registry entry
  const entry = getPromptEntry(promptId);

  // Load data from file if provided
  let mergedData = { ...data };
  if (dataPath) {
    const fileData = loadDataFile(dataPath);
    mergedData = { ...fileData, ...data };
  }

  // Validate required fields
  if (validate && entry.required_data && entry.required_data.length > 0) {
    const missing = validateData(mergedData, entry.required_data);
    if (missing.length > 0) {
      throw new Error(`Missing required data fields: ${missing.join(', ')}`);
    }
  }

  // Load template
  const templatePath = join(TEMPLATES_DIR, entry.template);

  if (!existsSync(templatePath)) {
    throw new Error(`Template not found: ${templatePath}`);
  }

  const templateSource = readFileSync(templatePath, 'utf-8');

  // Register helpers and compile
  registerHelpers();
  const template = Handlebars.compile(templateSource);

  // Render
  const content = template(mergedData);

  return {
    content,
    meta: entry,
    promptId,
  };
}

/**
 * Synchronous version for simple use cases
 */
export function loadPromptSync(options: PromptLoaderOptions): LoadedPrompt {
  const { promptId, data = {}, dataPath, validate = false } = options;

  // Get registry entry
  const entry = getPromptEntry(promptId);

  // Load data from file if provided
  let mergedData = { ...data };
  if (dataPath) {
    const fileData = loadDataFile(dataPath);
    mergedData = { ...fileData, ...data };
  }

  // Validate required fields
  if (validate && entry.required_data && entry.required_data.length > 0) {
    const missing = validateData(mergedData, entry.required_data);
    if (missing.length > 0) {
      throw new Error(`Missing required data fields: ${missing.join(', ')}`);
    }
  }

  // Load template
  const templatePath = join(TEMPLATES_DIR, entry.template);

  if (!existsSync(templatePath)) {
    throw new Error(`Template not found: ${templatePath}`);
  }

  const templateSource = readFileSync(templatePath, 'utf-8');

  // Register helpers and compile
  registerHelpers();
  const template = Handlebars.compile(templateSource);

  // Render
  const content = template(mergedData);

  return {
    content,
    meta: entry,
    promptId,
  };
}

// =============================================================================
// CLI
// =============================================================================

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      prompt: { type: 'string', short: 'p' },
      data: { type: 'string', short: 'd' },
      validate: { type: 'boolean', short: 'v', default: false },
      list: { type: 'boolean', short: 'l', default: false },
      'list-categories': { type: 'boolean', default: false },
      json: { type: 'boolean', short: 'j', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`
PromptLoader - Load prompts by registry ID

USAGE:
  bun PromptLoader.ts --prompt <id> [options]
  bun PromptLoader.ts --list
  bun PromptLoader.ts --list-categories

OPTIONS:
  -p, --prompt <id>     Prompt registry ID (e.g., sentiment_analysis)
  -d, --data <path>     Path to data file (YAML or JSON)
  -v, --validate        Validate required data fields
  -l, --list            List all available prompts
  --list-categories     List prompts by category
  -j, --json            Output as JSON (includes metadata)
  -h, --help            Show this help

EXAMPLES:
  # Load sentiment analysis prompt with context
  bun PromptLoader.ts -p sentiment_analysis -d ./context.yaml

  # Load tab title prompt (no data needed)
  bun PromptLoader.ts -p tab_title

  # List all available prompts
  bun PromptLoader.ts --list

  # Load with validation
  bun PromptLoader.ts -p agent_context -d ./agent.json --validate

  # Output as JSON with metadata
  bun PromptLoader.ts -p sentiment_analysis -d ./ctx.yaml --json
`);
    process.exit(0);
  }

  // List modes
  if (values.list) {
    const prompts = listPrompts();
    if (values.json) {
      console.log(JSON.stringify(prompts, null, 2));
    } else {
      console.log('Available prompts:\n');
      for (const p of prompts) {
        const hint = p.model_hint ? ` [${p.model_hint}]` : '';
        console.log(`  ${p.id}${hint}`);
        console.log(`    ${p.description}\n`);
      }
    }
    process.exit(0);
  }

  if (values['list-categories']) {
    const categories = listByCategory();
    if (values.json) {
      console.log(JSON.stringify(categories, null, 2));
    } else {
      console.log('Prompts by category:\n');
      for (const [category, prompts] of Object.entries(categories)) {
        console.log(`${category}:`);
        for (const p of prompts) {
          console.log(`  - ${p.id}: ${p.description}`);
        }
        console.log();
      }
    }
    process.exit(0);
  }

  // Load mode
  if (!values.prompt) {
    console.error('Error: --prompt is required (use --list to see available prompts)');
    process.exit(1);
  }

  try {
    const result = await loadPrompt({
      promptId: values.prompt,
      dataPath: values.data,
      validate: values.validate,
    });

    if (values.json) {
      console.log(
        JSON.stringify(
          {
            promptId: result.promptId,
            version: result.meta.version,
            model_hint: result.meta.model_hint,
            output_format: result.meta.output_format,
            content: result.content,
          },
          null,
          2
        )
      );
    } else {
      console.log(result.content);
    }
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
}

// Run CLI if executed directly
if (import.meta.main) {
  main();
}
