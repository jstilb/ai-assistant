#!/usr/bin/env bun
/**
 * SkillStructureGuard.hook.ts - PostToolUse hook for Write, Edit and MultiEdit
 *
 * PURPOSE:
 * When a SKILL.md is written under a category directory, auto-regenerates
 * the parent category's routing table to keep it in sync with the filesystem.
 *
 * TRIGGER: PostToolUse (matcher: Write|Edit|MultiEdit)
 *
 * INPUT:
 * - tool_input.file_path: The file that was written or edited
 *
 * BEHAVIOR:
 * - If file_path matches <root>/skills/Category/SubSkill/SKILL.md, regenerate that category
 * - <root> is the live Kaya home OR a worktree of it (<repo>/.claude/worktrees/<name>);
 *   the generator then runs against that worktree, so the worktree's own tables stay in sync
 * - Non-blocking: logs warnings to stderr, never exits non-zero
 * - Fast: single-category generation takes <100ms
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readObservabilityHookInputSync } from "../lib/hook-utils.ts";
import { getKayaHome } from "../lib/core/KayaHome.ts";

interface HookInput {
  tool_name: string;
  tool_input: { file_path?: string } | string;
}

/** A worktree root: <repo>/.claude/worktrees/<name>. */
const WORKTREE_ROOT = /\/\.claude\/worktrees\/[^/]+$/;

export interface SkillTarget {
  /** Tree that owns the SKILL.md: the Kaya home or one of its worktrees. */
  root: string;
  category: string;
}

/**
 * Map a written file path to the tree and category whose routing table needs a refresh.
 * Returns null unless the path is exactly <root>/skills/Category/SubSkill/SKILL.md and
 * <root> is the Kaya home or a worktree. Pure: no file system access.
 */
export function resolveSkillTarget(filePath: string, kayaDir: string): SkillTarget | null {
  const normalized = filePath.replace(/\\/g, "/");
  const match = /^(.*)\/skills\/([^/]+)\/([^/]+)\/SKILL\.md$/.exec(normalized);
  if (!match) return null;
  const root = match[1];
  const category = match[2];
  if (!root || !category) return null;
  const home = kayaDir.replace(/\\/g, "/").replace(/\/+$/, "");
  if (root !== home && !WORKTREE_ROOT.test(root)) return null;
  return { root, category };
}

function main(): void {
  try {
    const input = readObservabilityHookInputSync<HookInput>();
    if (!input) return;

    const toolInput =
      typeof input.tool_input === "string"
        ? (JSON.parse(input.tool_input) as { file_path?: string })
        : input.tool_input;

    const filePath = toolInput?.file_path;
    if (!filePath) return;

    const target = resolveSkillTarget(filePath, getKayaHome());
    if (!target) return;

    const generator = join(target.root, "lib", "core", "GenerateRoutingTables.ts");
    if (!existsSync(generator)) {
      process.stderr.write(`[SkillStructureGuard] No generator at ${generator}; routing table not refreshed\n`);
      return;
    }

    // Run the generator of the tree that owns the file, with that tree as its home.
    const result = spawnSync(process.execPath, [generator, "--category", target.category], {
      cwd: target.root,
      env: { ...process.env, KAYA_HOME: target.root, KAYA_DIR: target.root },
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (result.status !== 0) {
      const stderr = result.stderr?.toString().trim();
      const why = result.error
        ? result.error.message
        : result.signal
          ? `killed by ${result.signal}`
          : `exit ${result.status}`;
      process.stderr.write(
        `[SkillStructureGuard] Generator failed for ${target.category} (${why})${stderr ? `: ${stderr}` : ""}\n`,
      );
    }
  } catch (err) {
    // Hooks must never block: report on stderr and exit 0.
    console.error(
      `[SkillStructureGuard] routing-table regeneration failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

if (import.meta.main) {
  main();
}
