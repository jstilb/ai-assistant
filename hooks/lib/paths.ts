/**
 * Centralized Path Resolution
 *
 * Handles environment variable expansion for portable Kaya configuration.
 * Claude Code doesn't expand $HOME in settings.json env values, so we do it here.
 *
 * Usage:
 *   import { getKayaDir, getSettingsPath } from './lib/paths';
 *   const kayaDir = getKayaDir(); // Always returns expanded absolute path
 */

import { homedir } from 'os';
import { join } from 'path';

/**
 * Expand shell variables in a path string
 * Supports: $HOME, ${HOME}, ~
 */
export function expandPath(path: string): string {
  const home = homedir();

  return path
    .replace(/^\$HOME(?=\/|$)/, home)
    .replace(/^\$\{HOME\}(?=\/|$)/, home)
    .replace(/^~(?=\/|$)/, home);
}

/**
 * Get the Kaya directory (expanded)
 * Priority: KAYA_DIR env var (expanded) → ~/.claude
 */
export function getKayaDir(): string {
  const envKayaDir = process.env.KAYA_DIR;

  if (envKayaDir) {
    return expandPath(envKayaDir);
  }

  return join(homedir(), '.claude');
}

/**
 * Get the settings.json path
 */
export function getSettingsPath(): string {
  return join(getKayaDir(), 'settings.json');
}

/**
 * Get a path relative to KAYA_DIR
 */
export function kayaPath(...segments: string[]): string {
  return join(getKayaDir(), ...segments);
}

/**
 * Get the hooks directory
 */
export function getHooksDir(): string {
  return kayaPath('hooks');
}

/**
 * Get the skills directory
 */
export function getSkillsDir(): string {
  return kayaPath('skills');
}

/**
 * Get the MEMORY directory
 */
export function getMemoryDir(): string {
  return kayaPath('MEMORY');
}
