#!/usr/bin/env bun

/**
 * AgentFactory - Dynamic Agent Composition from Traits
 *
 * Composes specialized agents on-the-fly by combining traits from Traits.yaml.
 * Part of Kaya's hybrid agent system (named agents + dynamic composition).
 *
 * Usage:
 *   # Infer traits from task description
 *   bun run AgentFactory.ts --task "Review this security architecture"
 *
 *   # Specify traits explicitly
 *   bun run AgentFactory.ts --traits "security,skeptical,thorough"
 *
 *   # Combine both (explicit traits + inferred from task)
 *   bun run AgentFactory.ts --task "Check this contract" --traits "cautious"
 *
 *   # Output formats
 *   bun run AgentFactory.ts --task "..." --output json
 *   bun run AgentFactory.ts --task "..." --output yaml
 *   bun run AgentFactory.ts --task "..." --output prompt (default)
 *
 *   # List available traits
 *   bun run AgentFactory.ts --list
 *
 * @version 1.0.0
 */

import { parseArgs } from "util";
import { existsSync, readFileSync } from "fs";
import { parse as parseYaml } from "yaml";
import Handlebars from "handlebars";
import { loadTieredConfig } from "../../CORE/Tools/ConfigLoader.ts";
import { z } from "zod";
import { registerHelpers } from "../../Prompting/Tools/helpers";

// Paths
const HOME = process.env.HOME || "~";
const TEMPLATE_PATH = `${HOME}/.claude/skills/Agents/Templates/DynamicAgent.hbs`;
registerHelpers();

// Types
interface TraitDefinition {
  name: string;
  description: string;
  prompt_fragment?: string;
  keywords?: string[];
}

interface VoiceMapping {
  traits: string[];
  voice: string;
  voice_id?: string;
  reason?: string;
}

interface VoiceRegistryEntry {
  voice_id: string;
  characteristics: string[];
  description: string;
  stability: number;
  similarity_boost: number;
}

export interface TraitsData {
  expertise: Record<string, TraitDefinition>;
  personality: Record<string, TraitDefinition>;
  approach: Record<string, TraitDefinition>;
  voice_mappings: {
    default: string;
    default_voice_id: string;
    voice_registry: Record<string, VoiceRegistryEntry>;
    mappings: VoiceMapping[];
    fallbacks: Record<string, string>;
  };
  examples: Record<string, { description: string; traits: string[] }>;
}

// Zod schema for Traits.yaml validation
const TraitDefinitionSchema = z.object({
  name: z.string(),
  description: z.string(),
  prompt_fragment: z.string().optional(),
  keywords: z.array(z.string()).optional(),
});

const VoiceRegistryEntrySchema = z.object({
  voice_id: z.string(),
  characteristics: z.array(z.string()),
  description: z.string(),
  stability: z.number(),
  similarity_boost: z.number(),
});

const VoiceMappingSchema = z.object({
  traits: z.array(z.string()),
  voice: z.string(),
  voice_id: z.string().optional(),
  reason: z.string().optional(),
});

export const TraitsDataSchema = z.object({
  expertise: z.record(z.string(), TraitDefinitionSchema),
  personality: z.record(z.string(), TraitDefinitionSchema),
  approach: z.record(z.string(), TraitDefinitionSchema),
  voice_mappings: z.object({
    default: z.string(),
    default_voice_id: z.string(),
    voice_registry: z.record(z.string(), VoiceRegistryEntrySchema),
    mappings: z.array(VoiceMappingSchema),
    fallbacks: z.record(z.string(), z.string()),
  }),
  examples: z.record(z.string(), z.object({
    description: z.string(),
    traits: z.array(z.string()),
  })),
});

export interface ComposedAgent {
  name: string;
  traits: string[];
  expertise: TraitDefinition[];
  personality: TraitDefinition[];
  approach: TraitDefinition[];
  voice: string;
  voiceId: string;
  voiceReason: string;
  prompt: string;
}

/**
 * Load traits from YAML file with tiered config support
 *
 * Tiering: USER → SYSTEM → Legacy fallback
 * Looks for: ~/.claude/skills/CORE/USER/config/agents-traits.yaml
 *           ~/.claude/skills/CORE/SYSTEM/config/agents-traits.yaml
 *           ~/.claude/skills/Agents/Data/Traits.yaml (legacy fallback)
 */
export function loadTraits(): TraitsData {
  // Try tiered config first (USER → SYSTEM)
  try {
    const config = loadTieredConfig('agents-traits', TraitsDataSchema, {} as TraitsData, {
      envPrefix: 'KAYA_AGENTS',
    });

    // If we got valid config from USER or SYSTEM, use it
    if (Object.keys(config).length > 0) {
      return config;
    }
  } catch (error) {
    // Tiered config not found, fall through to legacy path
  }

  // Legacy fallback: Load from original location
  const legacyPath = `${HOME}/.claude/skills/Agents/Data/Traits.yaml`;
  if (!existsSync(legacyPath)) {
    console.error(`Error: Traits file not found at ${legacyPath}`);
    console.error(`Consider migrating to: ~/.claude/skills/CORE/SYSTEM/config/agents-traits.yaml`);
    process.exit(1);
  }

  try {
    const content = readFileSync(legacyPath, "utf-8");
    const parsed = parseYaml(content) as TraitsData;

    // Validate against schema
    const validated = TraitsDataSchema.safeParse(parsed);
    if (!validated.success) {
      console.error(`Error: Invalid Traits.yaml structure:`, validated.error);
      process.exit(1);
    }

    return validated.data;
  } catch (error) {
    console.error(`Error loading traits from ${legacyPath}:`, error);
    process.exit(1);
  }
}

/**
 * Load and compile the agent template
 */
export function loadTemplate(): HandlebarsTemplateDelegate {
  if (!existsSync(TEMPLATE_PATH)) {
    console.error(`Error: Template file not found at ${TEMPLATE_PATH}`);
    process.exit(1);
  }
  const content = readFileSync(TEMPLATE_PATH, "utf-8");
  return Handlebars.compile(content);
}

/**
 * Infer appropriate traits from a task description
 */
export function inferTraitsFromTask(task: string, traits: TraitsData): string[] {
  const inferred: string[] = [];
  const taskLower = task.toLowerCase();

  // Check expertise keywords
  for (const [key, def] of Object.entries(traits.expertise)) {
    if (def.keywords?.some((kw) => taskLower.includes(kw.toLowerCase()))) {
      inferred.push(key);
    }
  }

  // Check personality keywords (less common, but possible)
  for (const [key, def] of Object.entries(traits.personality)) {
    if (def.keywords?.some((kw) => taskLower.includes(kw.toLowerCase()))) {
      inferred.push(key);
    }
  }

  // Check approach keywords
  for (const [key, def] of Object.entries(traits.approach)) {
    if (def.keywords?.some((kw) => taskLower.includes(kw.toLowerCase()))) {
      inferred.push(key);
    }
  }

  // Apply smart defaults if categories are missing
  const hasExpertise = inferred.some((t) => traits.expertise[t]);
  const hasPersonality = inferred.some((t) => traits.personality[t]);
  const hasApproach = inferred.some((t) => traits.approach[t]);

  // Default personality: analytical (balanced, professional)
  if (!hasPersonality) {
    inferred.push("analytical");
  }

  // Default approach: thorough (comprehensive coverage)
  if (!hasApproach) {
    inferred.push("thorough");
  }

  // If no expertise was inferred, add 'research' as general-purpose
  if (!hasExpertise) {
    inferred.push("research");
  }

  return [...new Set(inferred)]; // Deduplicate
}

/**
 * Resolve voice based on trait combination
 */
export function resolveVoice(
  traitKeys: string[],
  traits: TraitsData
): { voice: string; voiceId: string; reason: string } {
  const mappings = traits.voice_mappings;
  const registry = mappings.voice_registry || {};

  // Helper to get voice_id from registry or fallback
  const getVoiceId = (voiceName: string, fallbackId?: string): string => {
    if (registry[voiceName]?.voice_id) {
      return registry[voiceName].voice_id;
    }
    return fallbackId || mappings.default_voice_id || "";
  };

  // Check explicit combination mappings first (more specific = higher priority)
  // Sort by number of matching traits (descending) for best match
  const matchedMappings = mappings.mappings
    .map((m) => ({
      ...m,
      matchCount: m.traits.filter((t) => traitKeys.includes(t)).length,
      isFullMatch: m.traits.every((t) => traitKeys.includes(t)),
    }))
    .filter((m) => m.isFullMatch)
    .sort((a, b) => b.matchCount - a.matchCount);

  if (matchedMappings.length > 0) {
    const best = matchedMappings[0];
    return {
      voice: best.voice,
      voiceId: best.voice_id || getVoiceId(best.voice),
      reason: best.reason || `Matched traits: ${best.traits.join(", ")}`,
    };
  }

  // Check fallbacks by primary trait (first personality trait found)
  for (const trait of traitKeys) {
    if (mappings.fallbacks[trait]) {
      const voiceName = mappings.fallbacks[trait];
      // Look for corresponding voice_id key (e.g., skeptical_voice_id)
      const voiceIdKey = `${trait}_voice_id`;
      const fallbackVoiceId = mappings.fallbacks[voiceIdKey] as string | undefined;
      return {
        voice: voiceName,
        voiceId: fallbackVoiceId || getVoiceId(voiceName),
        reason: `Fallback for trait: ${trait}`,
      };
    }
  }

  // Default
  return {
    voice: mappings.default,
    voiceId: mappings.default_voice_id || "",
    reason: "Default voice (no specific mapping matched)",
  };
}

/**
 * Compose an agent from traits
 */
export function composeAgent(
  traitKeys: string[],
  task: string,
  traits: TraitsData
): ComposedAgent {
  const expertise: TraitDefinition[] = [];
  const personality: TraitDefinition[] = [];
  const approach: TraitDefinition[] = [];

  // Categorize traits
  for (const key of traitKeys) {
    if (traits.expertise[key]) {
      expertise.push(traits.expertise[key]);
    }
    if (traits.personality[key]) {
      personality.push(traits.personality[key]);
    }
    if (traits.approach[key]) {
      approach.push(traits.approach[key]);
    }
  }

  // Generate name from traits
  const nameParts: string[] = [];
  if (expertise.length) nameParts.push(expertise[0].name);
  if (personality.length) nameParts.push(personality[0].name);
  if (approach.length) nameParts.push(approach[0].name);
  const name = nameParts.length > 0 ? nameParts.join(" ") : "Dynamic Agent";

  // Resolve voice
  const { voice, voiceId, reason: voiceReason } = resolveVoice(traitKeys, traits);

  // Render prompt from template
  const template = loadTemplate();
  const prompt = template({
    name,
    task,
    expertise,
    personality,
    approach,
    voice,
    voiceId,
  });

  return {
    name,
    traits: traitKeys,
    expertise,
    personality,
    approach,
    voice,
    voiceId,
    voiceReason,
    prompt,
  };
}

/**
 * List all available traits
 */
export function listTraits(traits: TraitsData): void {
  console.log("AVAILABLE TRAITS\n");

  console.log("EXPERTISE (domain knowledge):");
  for (const [key, def] of Object.entries(traits.expertise)) {
    console.log(`  ${key.padEnd(15)} - ${def.name}`);
  }

  console.log("\nPERSONALITY (behavior style):");
  for (const [key, def] of Object.entries(traits.personality)) {
    console.log(`  ${key.padEnd(15)} - ${def.name}`);
  }

  console.log("\nAPPROACH (work style):");
  for (const [key, def] of Object.entries(traits.approach)) {
    console.log(`  ${key.padEnd(15)} - ${def.name}`);
  }

  console.log("\nEXAMPLE COMPOSITIONS:");
  for (const [key, example] of Object.entries(traits.examples)) {
    console.log(`  ${key.padEnd(18)} - ${example.description}`);
    console.log(`                      traits: ${example.traits.join(", ")}`);
  }
}

/**
 * Validate trait keys against known traits, returns invalid ones
 */
export function validateTraitKeys(
  traitKeys: string[],
  traits: TraitsData,
): string[] {
  const allTraitKeys = [
    ...Object.keys(traits.expertise),
    ...Object.keys(traits.personality),
    ...Object.keys(traits.approach),
  ];
  return traitKeys.filter((t) => !allTraitKeys.includes(t));
}

/**
 * Format a composed agent for output
 */
export function formatAgentOutput(
  agent: ComposedAgent,
  format: string,
  task: string,
  includeTeam: boolean,
): string {
  switch (format) {
    case "json": {
      const jsonOutput: Record<string, unknown> = {
        name: agent.name,
        traits: agent.traits,
        voice: agent.voice,
        voice_id: agent.voiceId,
        voiceReason: agent.voiceReason,
        expertise: agent.expertise.map((e) => e.name),
        personality: agent.personality.map((p) => p.name),
        approach: agent.approach.map((a) => a.name),
        prompt: agent.prompt,
      };

      if (includeTeam) {
        const slugifiedRole = agent.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "");
        jsonOutput.teamMemberSpec = {
          role: slugifiedRole,
          task: task,
          model: agent.traits.includes("opus")
            ? "opus"
            : agent.traits.includes("haiku")
              ? "haiku"
              : "sonnet",
          context: agent.prompt,
        };
      }

      return JSON.stringify(jsonOutput, null, 2);
    }

    case "yaml": {
      const lines = [
        `name: "${agent.name}"`,
        `voice: "${agent.voice}"`,
        `voice_id: "${agent.voiceId}"`,
        `voice_reason: "${agent.voiceReason}"`,
        `traits: [${agent.traits.join(", ")}]`,
        `expertise: [${agent.expertise.map((e) => e.name).join(", ")}]`,
        `personality: [${agent.personality.map((p) => p.name).join(", ")}]`,
        `approach: [${agent.approach.map((a) => a.name).join(", ")}]`,
      ];
      return lines.join("\n");
    }

    case "summary": {
      const lines = [
        `COMPOSED AGENT: ${agent.name}`,
        `─────────────────────────────────────`,
        `Traits:      ${agent.traits.join(", ")}`,
        `Expertise:   ${agent.expertise.map((e) => e.name).join(", ") || "General"}`,
        `Personality: ${agent.personality.map((p) => p.name).join(", ")}`,
        `Approach:    ${agent.approach.map((a) => a.name).join(", ")}`,
        `Voice:       ${agent.voice} [${agent.voiceId}]`,
        `             (${agent.voiceReason})`,
      ];
      return lines.join("\n");
    }

    default:
      return agent.prompt;
  }
}

/**
 * Collect and merge trait keys from explicit list and task inference
 */
export function collectTraitKeys(
  explicitTraits: string | undefined,
  task: string | undefined,
  traits: TraitsData,
): string[] {
  let traitKeys: string[] = [];

  if (explicitTraits) {
    traitKeys = explicitTraits.split(",").map((t) => t.trim().toLowerCase());
  }

  if (task) {
    const inferred = inferTraitsFromTask(task, traits);
    traitKeys = [...new Set([...traitKeys, ...inferred])];
  }

  return traitKeys;
}

const HELP_TEXT = `
AgentFactory - Compose dynamic agents from traits

USAGE:
  bun run AgentFactory.ts [options]

OPTIONS:
  -t, --task <desc>    Task description (traits will be inferred)
  -r, --traits <list>  Comma-separated trait keys (security,skeptical,thorough)
  -o, --output <fmt>   Output format: prompt (default), json, yaml, summary
  --team               Include teamMemberSpec in JSON output (for Agent Teams integration)
  -l, --list           List all available traits
  -h, --help           Show this help

EXAMPLES:
  # Infer traits from task
  bun run AgentFactory.ts -t "Review this security architecture"

  # Specify traits explicitly
  bun run AgentFactory.ts -r "security,skeptical,adversarial,thorough"

  # Combine explicit and inferred
  bun run AgentFactory.ts -t "Check this contract" -r "cautious,meticulous"

  # Get JSON output for programmatic use
  bun run AgentFactory.ts -t "Analyze competitors" -o json

  # Get JSON with TeamMemberSpec for Agent Teams integration
  bun run AgentFactory.ts -t "Analyze competitors" -o json --team

  # See what's available
  bun run AgentFactory.ts --list

TRAIT CATEGORIES:
  - expertise:    Domain knowledge (security, legal, finance, technical, etc.)
  - personality:  Behavior style (skeptical, enthusiastic, cautious, etc.)
  - approach:     Work style (thorough, rapid, systematic, exploratory, etc.)

The factory automatically:
  - Infers relevant traits from task keywords
  - Applies sensible defaults for missing categories
  - Maps traits to appropriate voice output
  - Generates a complete agent prompt
`;

interface CliOptions {
  task?: string;
  traits?: string;
  output?: string;
  team?: boolean;
  list?: boolean;
  help?: boolean;
}

/**
 * Run the agent factory with parsed options (testable without CLI args)
 */
export function run(values: CliOptions): string | null {
  if (values.help) {
    return HELP_TEXT;
  }

  const traits = loadTraits();
  if (values.list) {
    listTraits(traits);
    return null;
  }

  const traitKeys = collectTraitKeys(values.traits, values.task, traits);

  if (traitKeys.length === 0) {
    console.error("Error: Provide --task or --traits to compose an agent");
    console.error("Use --help for usage information");
    process.exit(1);
  }

  const invalidTraits = validateTraitKeys(traitKeys, traits);
  if (invalidTraits.length > 0) {
    console.error(`Error: Unknown traits: ${invalidTraits.join(", ")}`);
    console.error("Use --list to see available traits");
    process.exit(1);
  }

  const agent = composeAgent(traitKeys, values.task || "", traits);
  return formatAgentOutput(
    agent,
    values.output || "prompt",
    values.task || "",
    values.team || false,
  );
}

/**
 * Main entry point - parses CLI args and delegates to run()
 */
async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      task: { type: "string", short: "t" },
      traits: { type: "string", short: "r" },
      output: { type: "string", short: "o", default: "prompt" },
      team: { type: "boolean", default: false },
      list: { type: "boolean", short: "l" },
      help: { type: "boolean", short: "h" },
    },
  });

  const output = run(values);
  if (output !== null) {
    console.log(output);
  }
}

// Only run main when executed directly (not when imported for testing)
const isDirectExecution = import.meta.path === Bun.main;
if (isDirectExecution) {
  main().catch(console.error);
}
