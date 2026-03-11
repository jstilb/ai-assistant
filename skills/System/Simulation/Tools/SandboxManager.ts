#!/usr/bin/env bun
/**
 * SandboxManager.ts - Isolated execution environment management
 *
 * Creates ephemeral sandbox directories via git worktree (primary) or
 * directory copy (fallback). Enforces path whitelisting and tracks all
 * writes for isolation validation. All state via StateManager.
 *
 * Usage:
 *   bun SandboxManager.ts create [--copy-skills=Browser,CORE] [--ttl=3600]
 *   bun SandboxManager.ts destroy <sandbox-id>
 *   bun SandboxManager.ts list
 *   bun SandboxManager.ts cleanup
 *   bun SandboxManager.ts validate <sandbox-id>
 */

import { existsSync, mkdirSync, rmSync, cpSync, statSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { randomUUID } from "crypto";
import { getOrCreateWorktree, removeWorktree } from "../../../../lib/core/WorktreeManager.ts";
import { z } from "zod";
import { createStateManager } from "../../../../lib/core/StateManager.ts";

const KAYA_HOME = process.env.HOME + "/.claude";
const SANDBOXES_DIR = join(KAYA_HOME, "skills/System/Simulation/Sandboxes");
const STATE_PATH = join(KAYA_HOME, "skills/System/Simulation/state/sandbox-state.json");
const DEFAULT_TTL = 3600;

// Allowed write directories (relative to KAYA_HOME/skills/System/Simulation/)
const ALLOWED_WRITE_DIRS = ["Sandboxes", "Reports", "Transcripts"];

// --- Types ---

interface SandboxManifest {
  id: string;
  createdAt: string;
  expiresAt: string;
  ttlSeconds: number;
  copiedSkills: string[];
  mockFiles: Array<{ path: string; content: string }>;
  status: "active" | "expired" | "destroyed";
  writeLog: string[];
  isolationMethod: "git_worktree" | "directory_copy";
  sandboxPath: string;
}

interface SandboxRegistryState {
  sandboxes: Record<string, SandboxManifest>;
}

interface CreateOptions {
  copySkills?: string[];
  mockFiles?: Array<{ path: string; content: string }>;
  ttlSeconds?: number;
}

// --- Schema ---

const ManifestSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  ttlSeconds: z.number(),
  copiedSkills: z.array(z.string()),
  mockFiles: z.array(z.object({ path: z.string(), content: z.string() })),
  status: z.enum(["active", "expired", "destroyed"]),
  writeLog: z.array(z.string()),
  isolationMethod: z.enum(["git_worktree", "directory_copy"]),
  sandboxPath: z.string(),
});

const SandboxRegistrySchema = z.object({
  sandboxes: z.record(z.string(), ManifestSchema),
});

const stateManager = createStateManager<SandboxRegistryState>({
  path: STATE_PATH,
  schema: SandboxRegistrySchema,
  defaults: { sandboxes: {} },
});

// --- Path validation ---

function isAllowedPath(targetPath: string): boolean {
  const resolved = resolve(targetPath);
  const simDir = resolve(KAYA_HOME, "skills/Simulation");

  for (const dir of ALLOWED_WRITE_DIRS) {
    const allowedPath = resolve(simDir, dir);
    if (resolved.startsWith(allowedPath + "/") || resolved === allowedPath) {
      return true;
    }
  }

  // Also allow /tmp/simulation-sandbox-* paths for backward compat
  if (resolved.startsWith("/tmp/simulation-sandbox-")) {
    return true;
  }

  return false;
}

// --- Git worktree helpers (delegated to WorktreeManager) ---

async function tryGitWorktreeAsync(sandboxDir: string): Promise<boolean> {
  try {
    const entry = await getOrCreateWorktree({
      repoRoot: KAYA_HOME,
      branch: `sim-sandbox-${Date.now()}`,
      createdBy: 'Simulation:SandboxManager',
    });
    // WorktreeManager creates at its own path; if different from sandboxDir, we note the path
    return !!entry.path;
  } catch {
    return false;
  }
}

async function removeGitWorktreeAsync(sandboxDir: string): Promise<void> {
  try {
    await removeWorktree(sandboxDir);
  } catch {
    // Fallback: directory removal handled by caller
  }
}

// --- Core functions ---

async function createSandbox(options: CreateOptions = {}): Promise<SandboxManifest> {
  const id = `sim-${randomUUID().slice(0, 8)}`;
  const sandboxDir = join(SANDBOXES_DIR, id);
  const ttl = options.ttlSeconds || DEFAULT_TTL;
  let isolationMethod: "git_worktree" | "directory_copy" = "directory_copy";

  // Try git worktree first
  if (await tryGitWorktreeAsync(sandboxDir)) {
    isolationMethod = "git_worktree";
  } else {
    // Fallback: create directory structure
    mkdirSync(join(sandboxDir, "MEMORY"), { recursive: true });
    mkdirSync(join(sandboxDir, "skills"), { recursive: true });
    mkdirSync(join(sandboxDir, "state"), { recursive: true });
    mkdirSync(join(sandboxDir, "artifacts"), { recursive: true });
  }

  // Copy selected skills into sandbox
  const copiedSkills = options.copySkills || [];
  for (const skill of copiedSkills) {
    const srcDir = join(KAYA_HOME, "skills", skill);
    const destDir = join(sandboxDir, "skills", skill);
    if (existsSync(srcDir)) {
      cpSync(srcDir, destDir, { recursive: true });
    }
  }

  // Create mock files
  const mockFiles = options.mockFiles || [];
  for (const mock of mockFiles) {
    const resolvedPath = mock.path.startsWith("~")
      ? join(sandboxDir, mock.path.slice(2))
      : join(sandboxDir, "artifacts", mock.path);
    const dir = resolve(resolvedPath, "..");
    mkdirSync(dir, { recursive: true });
    const { writeFileSync } = await import("fs");
    writeFileSync(resolvedPath, mock.content);
  }

  const manifest: SandboxManifest = {
    id,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
    ttlSeconds: ttl,
    copiedSkills,
    mockFiles,
    status: "active",
    writeLog: [],
    isolationMethod,
    sandboxPath: sandboxDir,
  };

  // Persist to StateManager registry
  await stateManager.update((s) => ({
    sandboxes: { ...s.sandboxes, [id]: manifest },
  }));

  return manifest;
}

async function destroySandbox(sandboxId: string): Promise<boolean> {
  const state = await stateManager.load();
  const manifest = state.sandboxes[sandboxId];
  if (!manifest) return false;

  const sandboxDir = manifest.sandboxPath;

  // Remove git worktree if applicable
  if (manifest.isolationMethod === "git_worktree") {
    await removeGitWorktreeAsync(sandboxDir);
  }

  // Remove directory
  if (existsSync(sandboxDir)) {
    rmSync(sandboxDir, { recursive: true, force: true });
  }

  // Update registry
  await stateManager.update((s) => {
    const updated = { ...s.sandboxes };
    updated[sandboxId] = { ...updated[sandboxId], status: "destroyed" as const };
    return { sandboxes: updated };
  });

  return true;
}

async function listSandboxes(): Promise<SandboxManifest[]> {
  const state = await stateManager.load();
  const sandboxes: SandboxManifest[] = [];

  for (const manifest of Object.values(state.sandboxes)) {
    if (manifest.status === "destroyed") continue;

    // Update status based on TTL
    if (manifest.status === "active" && new Date(manifest.expiresAt) < new Date()) {
      manifest.status = "expired";
    }
    sandboxes.push(manifest);
  }

  return sandboxes;
}

async function cleanupExpired(): Promise<{ removed: string[]; errors: string[] }> {
  const sandboxes = await listSandboxes();
  const removed: string[] = [];
  const errors: string[] = [];

  for (const sandbox of sandboxes) {
    if (sandbox.status === "expired" || new Date(sandbox.expiresAt) < new Date()) {
      try {
        await destroySandbox(sandbox.id);
        removed.push(sandbox.id);
      } catch (err: unknown) {
        errors.push(`${sandbox.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return { removed, errors };
}

async function validateIsolation(sandboxId: string): Promise<{
  valid: boolean;
  violations: string[];
}> {
  const state = await stateManager.load();
  const manifest = state.sandboxes[sandboxId];

  if (!manifest) {
    return { valid: false, violations: ["Sandbox not found"] };
  }

  const violations: string[] = [];
  const sandboxResolved = resolve(manifest.sandboxPath);

  for (const writePath of manifest.writeLog) {
    const resolved = resolve(writePath);
    if (!resolved.startsWith(sandboxResolved) && !isAllowedPath(resolved)) {
      violations.push(`Write escaped sandbox: ${writePath}`);
    }
  }

  return { valid: violations.length === 0, violations };
}

async function getSandboxPath(sandboxId: string): Promise<string | null> {
  const state = await stateManager.load();
  const manifest = state.sandboxes[sandboxId];
  if (!manifest) return null;
  return existsSync(manifest.sandboxPath) ? manifest.sandboxPath : null;
}

async function logWrite(sandboxId: string, writePath: string): Promise<void> {
  await stateManager.update((s) => {
    const manifest = s.sandboxes[sandboxId];
    if (!manifest) return s;
    return {
      sandboxes: {
        ...s.sandboxes,
        [sandboxId]: {
          ...manifest,
          writeLog: [...manifest.writeLog, writePath],
        },
      },
    };
  });
}

function getSandboxSize(sandboxPath: string): number {
  if (!existsSync(sandboxPath)) return 0;

  let totalSize = 0;
  function walkDir(dir: string) {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          walkDir(fullPath);
        } else {
          try { totalSize += statSync(fullPath).size; } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  }
  walkDir(sandboxPath);
  return totalSize;
}

// --- CLI ---

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (!existsSync(SANDBOXES_DIR)) {
    mkdirSync(SANDBOXES_DIR, { recursive: true });
  }

  switch (command) {
    case "create": {
      const skillsArg = args.find((a) => a.startsWith("--copy-skills="));
      const ttlArg = args.find((a) => a.startsWith("--ttl="));
      const copySkills = skillsArg ? skillsArg.split("=")[1].split(",").filter(Boolean) : [];
      const ttl = ttlArg ? parseInt(ttlArg.split("=")[1]) : DEFAULT_TTL;

      const manifest = await createSandbox({ copySkills, ttlSeconds: ttl });
      console.log(JSON.stringify(manifest, null, 2));
      break;
    }

    case "destroy": {
      const id = args[0];
      if (!id) { console.error("Usage: destroy <sandbox-id>"); process.exit(1); }
      const destroyed = await destroySandbox(id);
      console.log(JSON.stringify({ destroyed, id }));
      break;
    }

    case "list": {
      const sandboxes = await listSandboxes();
      console.log(JSON.stringify(sandboxes, null, 2));
      break;
    }

    case "cleanup": {
      const result = await cleanupExpired();
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case "validate": {
      const id = args[0];
      if (!id) { console.error("Usage: validate <sandbox-id>"); process.exit(1); }
      const result = await validateIsolation(id);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    default:
      console.log(`SandboxManager - Isolated execution environments

Commands:
  create [--copy-skills=A,B] [--ttl=3600]   Create sandbox (git worktree + dir fallback)
  destroy <sandbox-id>                        Destroy sandbox
  list                                        List all sandboxes
  cleanup                                     Remove expired sandboxes
  validate <sandbox-id>                       Verify isolation`);
      break;
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});

export {
  createSandbox,
  destroySandbox,
  listSandboxes,
  cleanupExpired,
  validateIsolation,
  getSandboxPath,
  logWrite,
  getSandboxSize,
  isAllowedPath,
  ALLOWED_WRITE_DIRS,
};
export type { SandboxManifest, CreateOptions };
