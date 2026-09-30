#!/usr/bin/env bun
/**
 * SkillStructureGuard.hook.ts - PostToolUse hook for Write
 *
 * PURPOSE:
 * When a SKILL.md is written under a category directory, auto-regenerates
 * the parent category's routing table to keep it in sync with the filesystem.
 *
 * TRIGGER: PostToolUse (matcher: Write)
 *
 * INPUT:
 * - tool_input.file_path: The file that was written
 *
 * BEHAVIOR:
 * - If file_path matches skills/Category/SubSkill/SKILL.md, regenerate that category
 * - Non-blocking: logs warnings to stderr, never exits non-zero
 * - Fast: single-category generation takes <100ms
 */

import { spawnSync } from 'child_process';
import { join } from 'path';
import { readObservabilityHookInputSync } from '../lib/hook-utils.ts';
import { getKayaHome } from '../lib/core/KayaHome.ts';

const KAYA_DIR = getKayaHome();
const SKILLS_DIR = join(KAYA_DIR, 'skills');
const GENERATOR_PATH = join(KAYA_DIR, 'lib', 'core', 'GenerateRoutingTables.ts');

interface HookInput {
  tool_name: string;
  tool_input: { file_path?: string } | string;
}

function main(): void {
  try {
    const input = readObservabilityHookInputSync<HookInput>();
    if (!input) return;

    const toolInput = typeof input.tool_input === 'string'
      ? JSON.parse(input.tool_input) as { file_path?: string }
      : input.tool_input;

    const filePath = toolInput?.file_path;
    if (!filePath) return;

    // Only care about SKILL.md files
    if (!filePath.endsWith('/SKILL.md') && !filePath.endsWith('\\SKILL.md')) return;

    // Extract path relative to skills dir
    const skillsIndex = filePath.indexOf(SKILLS_DIR);
    if (skillsIndex === -1) return;

    const relativePath = filePath.slice(SKILLS_DIR.length + 1); // e.g. "Intelligence/Research/SKILL.md"
    const parts = relativePath.split('/');

    // Must be exactly Category/SubSkill/SKILL.md (3 parts)
    if (parts.length !== 3) return;

    const categoryName = parts[0];

    // Run generator for this category
    const result = spawnSync('bun', [GENERATOR_PATH, '--category', categoryName], {
      cwd: KAYA_DIR,
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (result.status !== 0) {
      const stderr = result.stderr?.toString().trim();
      if (stderr) {
        process.stderr.write(`[SkillStructureGuard] Generator failed for ${categoryName}: ${stderr}\n`);
      }
    }
  } catch (err) {
    // Fail silently — hooks must never block
    console.error(`[SkillStructureGuard] routing-table regeneration failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

if (import.meta.main) {
  main();
}
