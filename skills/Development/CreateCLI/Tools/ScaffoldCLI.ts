#!/usr/bin/env bun
/**
 * ScaffoldCLI.ts — TypeScript CLI scaffold generator with registry support
 *
 * Generates a production-ready TypeScript CLI file with:
 *   - Correct shebang (#!/usr/bin/env bun)
 *   - secrets.json integration (NEVER .env)
 *   - parseArgs (Tier 1) or Commander.js (Tier 2) pattern
 *   - try/catch around main with process.exit(1) on error
 *   - JSONL audit log at ~/.claude/MEMORY/cli-audit.jsonl
 *   - Help text for all commands
 *
 * Registers the generated CLI in State/registry.json.
 *
 * Usage:
 *   bun ScaffoldCLI.ts --name my-cli --tier 1 --description "My CLI" --api-keys MY_API_KEY
 *   bun ScaffoldCLI.ts --name my-cli --tier 2 --commands "create,list,delete" --api-keys MY_API_KEY --force
 *
 * @module ScaffoldCLI
 * @version 1.0.0
 */

import { parseArgs } from "util";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { z } from "zod";
import { createAppendLog } from "../../../../lib/core/AppendLog.ts";
import { memPath } from "../../../../lib/core/MemoryPaths.ts";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";

// ============================================================================
// Types
// ============================================================================

export interface CommandSpec {
  name: string;
  description: string;
  args: string[];
}

export interface CLISpec {
  name: string;
  tier: 1 | 2;
  description: string;
  commands: CommandSpec[];
  apiKeyNames: string[];
  outputPath: string;
}

const RegistryEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  tier: z.union([z.literal(1), z.literal(2)]),
  description: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  apiKeyNames: z.array(z.string()),
  commands: z.array(z.object({
    name: z.string(),
    description: z.string(),
    args: z.array(z.string()),
  })),
});

export type RegistryEntry = z.infer<typeof RegistryEntrySchema>;

const RegistrySchema = z.array(RegistryEntrySchema);

// ============================================================================
// Registry
// ============================================================================

// Allow test override via env var, otherwise resolve relative to this file
const DEFAULT_REGISTRY_PATH = process.env.SCAFFOLD_REGISTRY_PATH
  ?? join(dirname(import.meta.url.replace("file://", "")), "..", "State", "registry.json");

export function loadRegistry(registryPath = DEFAULT_REGISTRY_PATH): RegistryEntry[] {
  if (!existsSync(registryPath)) {
    // Legitimate first-run case: no registry file yet. Silent [] is correct here.
    return [];
  }
  try {
    const raw = readFileSync(registryPath, "utf-8");
    return RegistrySchema.parse(JSON.parse(raw));
  } catch (err) {
    // fable-audit batch4: this used to be `catch { return []; }` — a genuine
    // corrupt/unparseable registry.json (bad JSON, schema drift) was
    // indistinguishable from the legitimate "no CLIs registered yet" case
    // above, and the next scaffold call's upsertRegistryEntry() would then
    // silently overwrite every prior entry with just the new one. Fix ADDS
    // visibility only — the return contract (never throws, returns []) is
    // unchanged; callers that already treat [] as "no registry" see no
    // behavior change.
    const detail = err instanceof Error ? err.message : String(err);
    console.error(
      `[ScaffoldCLI] loadRegistry(): FAILED to read/parse "${registryPath}" — ` +
        `treating as empty, but this file EXISTS and could not be loaded (not a ` +
        `first-run case). A subsequent scaffold write will silently overwrite ` +
        `any prior entries in it: ${detail}`,
    );
    return [];
  }
}

export function saveRegistry(entries: RegistryEntry[], registryPath = DEFAULT_REGISTRY_PATH): void {
  const dir = dirname(registryPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(registryPath, JSON.stringify(entries, null, 2) + "\n", "utf-8");
}

export function findRegistryEntry(name: string, registryPath = DEFAULT_REGISTRY_PATH): RegistryEntry | undefined {
  return loadRegistry(registryPath).find((e) => e.name === name);
}

export function upsertRegistryEntry(entry: RegistryEntry, registryPath = DEFAULT_REGISTRY_PATH): void {
  const entries = loadRegistry(registryPath);
  const idx = entries.findIndex((e) => e.name === entry.name);
  if (idx >= 0) {
    entries[idx] = entry;
  } else {
    entries.push(entry);
  }
  saveRegistry(entries, registryPath);
}

// ============================================================================
// Audit log
// ============================================================================

const AUDIT_LOG_PATH = memPath("cli-audit.jsonl");
const auditLogSeam = createAppendLog(AUDIT_LOG_PATH);

export function auditLog(event: Record<string, unknown>): void {
  auditLogSeam.append({ ...event, ts: new Date().toISOString() });
}

// ============================================================================
// Code generation
// ============================================================================

export function generateSecretsImport(apiKeyNames: string[]): string {
  if (apiKeyNames.length === 0) return "";
  const fields = apiKeyNames.map((k) => `  ${k}: z.string(),`).join("\n");
  return `
import { createStateManager } from "../../../../lib/core/StateManager";
import { z as zSecrets } from "zod";

const SecretsSchema = zSecrets.object({
${fields}
}).passthrough();

async function loadSecrets(): Promise<Record<string, string>> {
  const mgr = createStateManager({
    path: \`\${homedir()}/.claude/secrets.json\`,
    schema: SecretsSchema,
    defaults: {},
  });
  return mgr.load() as Promise<Record<string, string>>;
}
`;
}

function generateTier1Commands(commands: CommandSpec[]): string {
  if (commands.length === 0) {
    return `
async function run(args: string[]): Promise<void> {
  console.log(JSON.stringify({ args, status: "ok" }, null, 2));
}
`;
  }
  const fns = commands.map((cmd) => {
    const argList = cmd.args.map((a) => `${a}: string`).join(", ");
    return `
async function cmd_${cmd.name}(${argList || "_args: string[]"}): Promise<void> {
  // TODO: implement ${cmd.name}
  console.error("Error: '${cmd.name}' is not yet implemented (generated stub — see TODO above)");
  console.log(JSON.stringify({ command: "${cmd.name}", status: "not_implemented" }, null, 2));
  process.exit(1);
}`;
  }).join("\n");

  const cases = commands.map((cmd) => {
    const argCapture = cmd.args.length > 0
      ? cmd.args.map((a, i) => `  const ${a} = args[${i + 1}] ?? "";`).join("\n") + "\n"
      : "";
    const callArgs = cmd.args.length > 0 ? cmd.args.join(", ") : "args.slice(1)";
    return `    case "${cmd.name}":\n${argCapture}      await cmd_${cmd.name}(${callArgs});\n      break;`;
  }).join("\n");

  return `${fns}

async function run(args: string[]): Promise<void> {
  const command = args[0];
  switch (command) {
${cases}
    default:
      console.error(\`Error: Unknown command '\${command}'\`);
      console.error("Run --help for usage");
      process.exit(1);
  }
}
`;
}

function generateTier2Commands(commands: CommandSpec[], cliName: string): string {
  const commandRegistrations = commands.map((cmd) => {
    const argDefs = cmd.args.map((a) => `.argument("<${a}>", "${a}")`).join("\n    ");
    return `
program
  .command("${cmd.name}")
  .description("${cmd.description}")
  ${argDefs}
  .action(async (${cmd.args.join(", ") || "_opts"}) => {
    // TODO: implement ${cmd.name}
    console.error("Error: '${cmd.name}' is not yet implemented (generated stub — see TODO above)");
    console.log(JSON.stringify({ command: "${cmd.name}", status: "not_implemented" }, null, 2));
    process.exit(1);
  });`;
  }).join("\n");

  return `import { Command } from "commander";

const program = new Command();
program
  .name("${cliName}")
  .description("${cliName} CLI")
  .version("1.0.0");
${commandRegistrations}
`;
}

// EXEMPT (appendFileSync sweep): the `appendFileSync` calls inside the template
// strings below are generated SOURCE CODE for standalone scaffolded CLIs, not
// runtime writes made by ScaffoldCLI.ts itself. Scaffolded CLIs land at an
// arbitrary --output path (e.g. ~/.claude/Bin/<name>/<name>.ts) outside this
// skill's directory tree, so they cannot rely on a fixed relative import path
// to lib/core/AppendLog.ts — keeping their generated audit() self-contained
// (raw appendFileSync, matching Tier 1/2 CLI's "no unnecessary deps" contract)
// is intentional, not a leftover to migrate. ScaffoldCLI.ts's OWN audit log
// (auditLog() above) already uses createAppendLog().
export function generateTier1Main(cliName: string, description: string, commands: CommandSpec[], apiKeyNames: string[]): string {
  const secretsImport = generateSecretsImport(apiKeyNames);
  const commandHelp = commands.map((c) => `  ${c.name.padEnd(20)} ${c.description}`).join("\n");
  const commandSection = commandHelp || "  (no commands defined)";

  return `#!/usr/bin/env bun
/**
 * ${cliName} — ${description}
 * Generated by ScaffoldCLI.ts
 */

import { parseArgs } from "util";
import { homedir } from "os";
import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
${secretsImport}

// ============================================================================
// Audit log
// ============================================================================

function audit(event: Record<string, unknown>): void {
  const logPath = join(homedir(), ".claude", "MEMORY", "cli-audit.jsonl");
  const dir = dirname(logPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(logPath, JSON.stringify({ cli: "${cliName}", ...event, ts: new Date().toISOString() }) + "\\n");
}

// ============================================================================
// Help
// ============================================================================

function showHelp(): void {
  console.log(\`
${cliName} — ${description}

USAGE:
  ${cliName} <command> [options]

COMMANDS:
${commandSection}
  help, --help, -h       Show this help
  version, --version     Show version

OUTPUT:
  JSON to stdout. Errors to stderr. Exit 0 on success, 1 on error.

CONFIGURATION:
  API keys must be in ~/.claude/secrets.json — NEVER use .env files.
\`);
}

// ============================================================================
// Commands
// ============================================================================

${generateTier1Commands(commands)}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
    showHelp();
    return;
  }

  if (args[0] === "--version" || args[0] === "version") {
    console.log("${cliName} 1.0.0");
    return;
  }

  audit({ event: "run", args });
  await run(args);
}

main().catch((err: unknown) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
`;
}

export function generateTier2Main(cliName: string, description: string, commands: CommandSpec[], apiKeyNames: string[]): string {
  const secretsImport = generateSecretsImport(apiKeyNames);
  const commandBody = generateTier2Commands(commands, cliName);

  return `#!/usr/bin/env bun
/**
 * ${cliName} — ${description}
 * Generated by ScaffoldCLI.ts (Tier 2 / Commander.js)
 */

import { homedir } from "os";
import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
${secretsImport}
${commandBody}

// ============================================================================
// Audit log
// ============================================================================

function audit(event: Record<string, unknown>): void {
  const logPath = join(homedir(), ".claude", "MEMORY", "cli-audit.jsonl");
  const dir = dirname(logPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(logPath, JSON.stringify({ cli: "${cliName}", ...event, ts: new Date().toISOString() }) + "\\n");
}

audit({ event: "run", args: process.argv.slice(2) });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
`;
}

export function generateCLI(spec: CLISpec): string {
  if (spec.tier === 1) {
    return generateTier1Main(spec.name, spec.description, spec.commands, spec.apiKeyNames);
  } else {
    return generateTier2Main(spec.name, spec.description, spec.commands, spec.apiKeyNames);
  }
}

export interface ScaffoldResult {
  success: boolean;
  name: string;
  tier: 1 | 2;
  outputPath: string;
  registryUpdated: boolean;
  commands: string[];
  apiKeyNames: string[];
}

export function scaffoldCLI(spec: CLISpec & { force?: boolean; registryPath?: string }): ScaffoldResult {
  const registryPath = spec.registryPath ?? DEFAULT_REGISTRY_PATH;

  // Check registry for existing entry
  const existing = findRegistryEntry(spec.name, registryPath);
  if (existing && !spec.force) {
    throw new Error(`CLI "${spec.name}" already exists in registry at ${existing.path}\nUse --force to overwrite.`);
  }

  // Generate CLI content
  const content = generateCLI(spec);

  // Write to output path
  const outputDir = dirname(spec.outputPath);
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }
  writeFileSync(spec.outputPath, content, "utf-8");

  // Update registry
  const now = new Date().toISOString();
  const entry: RegistryEntry = {
    name: spec.name,
    path: spec.outputPath,
    tier: spec.tier,
    description: spec.description,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    apiKeyNames: spec.apiKeyNames,
    commands: spec.commands,
  };
  upsertRegistryEntry(entry, registryPath);

  return {
    success: true,
    name: spec.name,
    tier: spec.tier,
    outputPath: spec.outputPath,
    registryUpdated: true,
    commands: spec.commands.map((c) => c.name),
    apiKeyNames: spec.apiKeyNames,
  };
}

// ============================================================================
// CLI entry point (only runs when this file is executed directly)
// ============================================================================

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      name: { type: "string" },
      tier: { type: "string", default: "1" },
      description: { type: "string", default: "" },
      commands: { type: "string", default: "" },
      "api-keys": { type: "string", default: "" },
      output: { type: "string" },
      force: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: false,
  });

  if (values.help) {
    console.log(`
ScaffoldCLI.ts — Generate TypeScript CLI from spec

USAGE:
  bun ScaffoldCLI.ts --name <name> [options]

OPTIONS:
  --name         CLI name (kebab-case, required)
  --tier         1 (parseArgs) or 2 (Commander.js) [default: 1]
  --description  One-line description
  --commands     Comma-separated list of command names (e.g. "list,create,delete")
  --api-keys     Comma-separated secrets.json key names (e.g. "MY_API_KEY,OTHER_KEY")
  --output       Output path for generated CLI [default: ~/.claude/Bin/<name>/<name>.ts]
  --force        Overwrite if CLI already registered in registry
  --help         Show this help

NOTES:
  - NEVER generates .env references — all secrets via ~/.claude/secrets.json
  - Registers generated CLI in State/registry.json
  - Fails with "already exists" error if same name registered without --force
`);
    process.exit(0);
  }

  if (!values.name) {
    console.error("Error: --name is required");
    process.exit(1);
  }

  const cliName = values.name as string;
  const tierNum = parseInt(values.tier as string, 10);
  if (tierNum !== 1 && tierNum !== 2) {
    console.error("Error: --tier must be 1 or 2 (Tier 3 is not supported — use Tier 2 as interim)");
    process.exit(1);
  }
  const tier = tierNum as 1 | 2;

  const rawCommands = (values.commands as string) || "";
  const commandNames = rawCommands ? rawCommands.split(",").map((c) => c.trim()).filter(Boolean) : [];
  const commands: CommandSpec[] = commandNames.map((name) => ({
    name,
    description: `${name} command`,
    args: [],
  }));

  const rawApiKeys = (values["api-keys"] as string) || "";
  const apiKeyNames = rawApiKeys ? rawApiKeys.split(",").map((k) => k.trim()).filter(Boolean) : [];

  const defaultOutputPath = join(getKayaHome(), "Bin", cliName, `${cliName}.ts`);
  const outputPath = (values.output as string | undefined) ?? defaultOutputPath;

  try {
    const result = scaffoldCLI({
      name: cliName,
      tier,
      description: (values.description as string) || `${cliName} CLI`,
      commands,
      apiKeyNames,
      outputPath,
      force: values.force as boolean,
      registryPath: DEFAULT_REGISTRY_PATH,
    });

    // Audit
    auditLog({ event: "scaffold", name: cliName, tier, outputPath });

    console.log(JSON.stringify(result, null, 2));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${msg}`);
    process.exit(1);
  }
}
