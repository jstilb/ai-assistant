#!/usr/bin/env bun
/**
 * RenderTemplate.ts - Kaya Templating Engine
 *
 * Renders Handlebars templates with YAML data sources.
 *
 * Usage:
 *   bun run RenderTemplate.ts --template <path> --data <path> [--output <path>] [--preview]
 *
 * Examples:
 *   bun run RenderTemplate.ts --template Primitives/Roster.hbs --data Data/Agents.yaml
 *   bun run RenderTemplate.ts -t Evals/Judge.hbs -d Data/JudgeConfig.yaml -o Compiled/judge.md
 *   bun run RenderTemplate.ts --template Primitives/Gate.hbs --data Data/Gates.yaml --preview
 */

import Handlebars from 'handlebars';
import { parse as parseYaml } from 'yaml';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { parseArgs } from 'util';

// ============================================================================
// Custom Handlebars Helpers (shared module)
// ============================================================================

import { registerHelpers } from './helpers';
registerHelpers();


// ============================================================================
// Template Engine
// ============================================================================

interface RenderOptions {
  templatePath: string;
  dataPath: string;
  outputPath?: string;
  preview?: boolean;
}

function resolveTemplatePath(path: string): string {
  // If absolute, use as-is
  if (path.startsWith('/')) return path;

  // Resolve relative to Templates directory
  const templatesDir = dirname(dirname(import.meta.path));
  return resolve(templatesDir, path);
}

function loadTemplate(templatePath: string): HandlebarsTemplateDelegate {
  const fullPath = resolveTemplatePath(templatePath);

  if (!existsSync(fullPath)) {
    throw new Error(`Template not found: ${fullPath}`);
  }

  const templateSource = readFileSync(fullPath, 'utf-8');
  return Handlebars.compile(templateSource);
}

function loadData(dataPath: string): Record<string, unknown> {
  const fullPath = resolveTemplatePath(dataPath);

  if (!existsSync(fullPath)) {
    throw new Error(`Data file not found: ${fullPath}`);
  }

  const dataSource = readFileSync(fullPath, 'utf-8');

  // Support both YAML and JSON
  if (dataPath.endsWith('.json')) {
    return JSON.parse(dataSource);
  }

  return parseYaml(dataSource) as Record<string, unknown>;
}

function registerPartials(templatesDir: string): void {
  // Register partials from both Partials/ and Decorators/ directories
  const partialsDirs = [
    { path: resolve(templatesDir, 'Templates', 'Partials'), prefix: '' },
    { path: resolve(templatesDir, 'Templates', 'Decorators'), prefix: 'Decorators/' }
  ];

  for (const { path: dir, prefix } of partialsDirs) {
    if (!existsSync(dir)) continue;

    const files = Bun.spawnSync(['ls', dir]).stdout.toString().trim().split('\n');

    for (const file of files) {
      if (file.endsWith('.hbs')) {
        const partialName = prefix + basename(file, '.hbs');
        const partialPath = resolve(dir, file);
        const partialSource = readFileSync(partialPath, 'utf-8');
        Handlebars.registerPartial(partialName, partialSource);
      }
    }
  }
}

export function renderTemplate(options: RenderOptions): string {
  const templatesDir = dirname(dirname(import.meta.path));

  // Register any partials
  registerPartials(templatesDir);

  // Load and compile template
  const template = loadTemplate(options.templatePath);

  // Load data
  const data = loadData(options.dataPath);

  // Render
  const rendered = template(data);

  // Output
  if (options.preview) {
    console.log('\n=== PREVIEW ===\n');
    console.log(rendered);
    console.log('\n=== END PREVIEW ===\n');
  }

  if (options.outputPath) {
    const outputFullPath = resolveTemplatePath(options.outputPath);
    writeFileSync(outputFullPath, rendered);
    console.log(`✓ Rendered to: ${outputFullPath}`);
  }

  return rendered;
}

// ============================================================================
// CLI Interface
// ============================================================================

function main(): void {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      template: { type: 'string', short: 't' },
      data: { type: 'string', short: 'd' },
      output: { type: 'string', short: 'o' },
      preview: { type: 'boolean', short: 'p' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help || !values.template || !values.data) {
    console.log(`
Kaya Template Renderer

Usage:
  bun run RenderTemplate.ts --template <path> --data <path> [options]

Options:
  -t, --template <path>  Template file (.hbs)
  -d, --data <path>      Data file (.yaml or .json)
  -o, --output <path>    Output file (optional, prints to stdout if omitted)
  -p, --preview          Show preview in console
  -h, --help             Show this help

Examples:
  bun run RenderTemplate.ts -t Primitives/Roster.hbs -d Data/Agents.yaml -p
  bun run RenderTemplate.ts -t Evals/Judge.hbs -d Data/JudgeConfig.yaml -o Compiled/judge.md

Available Helpers:
  {{uppercase str}}           - Convert to uppercase
  {{lowercase str}}           - Convert to lowercase
  {{titlecase str}}           - Convert to title case
  {{indent str spaces}}       - Indent text by N spaces
  {{join arr separator}}      - Join array with separator
  {{eq a b}}                  - Check equality
  {{gt a b}} / {{lt a b}}     - Greater/less than
  {{includes arr value}}      - Check if array includes value
  {{now format}}              - Current date/time
  {{pluralize count word}}    - Pluralize based on count
  {{formatNumber num}}        - Format with commas
  {{percent value total}}     - Calculate percentage
  {{truncate str length}}     - Truncate to length
  {{default value fallback}}  - Default value if undefined
  {{json obj pretty}}         - JSON stringify
  {{codeblock code lang}}     - Markdown code block
  {{repeat count}}...{{/repeat}} - Repeat content N times
`);
    process.exit(values.help ? 0 : 1);
  }

  try {
    renderTemplate({
      templatePath: values.template,
      dataPath: values.data,
      outputPath: values.output,
      preview: values.preview,
    });
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.main) {
  main();
}
