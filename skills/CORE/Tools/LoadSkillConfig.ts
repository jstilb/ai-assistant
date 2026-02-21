#!/usr/bin/env bun

/**
 * LoadSkillConfig - Shared utility for loading skill configuration files
 *
 * Skills call this to load their JSON configs using StateManager
 * (no raw JSON.parse(readFileSync())).
 *
 * Usage:
 *   import { loadSkillConfig } from '~/.claude/skills/CORE/Tools/LoadSkillConfig';
 *   const config = await loadSkillConfig<MyConfigType>(__dirname, 'config.json');
 *
 * Or CLI:
 *   bun ~/.claude/skills/CORE/Tools/LoadSkillConfig.ts <skill-dir> <filename>
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { createStateManager } from './StateManager';

/** Generic JSON schema for loading arbitrary config files via StateManager */
const GenericJsonSchema = z.record(z.string(), z.unknown());

/**
 * Load a JSON config file using StateManager (no raw JSON.parse/readFileSync).
 * Returns the parsed object, or defaults if the file doesn't exist.
 * Throws on invalid JSON.
 */
async function loadJsonViaStateManager<T>(filePath: string, defaults: T): Promise<T> {
  const manager = createStateManager({
    path: filePath,
    schema: GenericJsonSchema,
    defaults: defaults as Record<string, unknown>,
  });
  return await manager.load() as T;
}

/**
 * Load a skill configuration file
 *
 * Uses StateManager for all JSON file loading instead of raw JSON.parse(readFileSync()).
 *
 * @param skillDir - The skill's directory path (use __dirname)
 * @param filename - The config file to load (e.g., 'sources.json')
 * @returns The configuration object
 */
export async function loadSkillConfig<T>(skillDir: string, filename: string): Promise<T> {
  const configPath = join(skillDir, filename);

  if (!existsSync(configPath)) {
    return {} as T;
  }

  try {
    return await loadJsonViaStateManager<T>(configPath, {} as T);
  } catch (error) {
    console.error(`Failed to load config ${configPath}:`, error);
    throw error;
  }
}

// CLI mode
if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help') {
    console.log(`
LoadSkillConfig - Load skill configuration files

Usage:
  bun LoadSkillConfig.ts <skill-dir> <filename>    Load config

Examples:
  bun LoadSkillConfig.ts ~/.claude/skills/PAIUpgrade sources.json
`);
    process.exit(0);
  }

  const [skillDir, filename] = args;

  if (!skillDir || !filename) {
    console.error('Error: Both skill-dir and filename required');
    process.exit(1);
  }

  try {
    const config = await loadSkillConfig(skillDir, filename);
    console.log(JSON.stringify(config, null, 2));
  } catch (error) {
    console.error('Error loading config:', error);
    process.exit(1);
  }
}
