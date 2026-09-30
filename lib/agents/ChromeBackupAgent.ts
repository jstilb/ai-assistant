#!/usr/bin/env bun
/**
 * ChromeBackupAgent — Backup and restore Chrome's Preferences + Secure Preferences.
 *
 * Two complementary surfaces:
 *   1. Event-driven: hooks/SecurityValidator.hook.ts calls `backupChromeState()`
 *      synchronously when a Bash command matching `isChromeKillCommand()` is about
 *      to execute (backup-before-kill).
 *   2. Schedule-driven: launchd job `com.kaya.chrome-backup` runs `bun ChromeBackupAgent.ts
 *      backup` daily as defense-in-depth against silent Chrome integrity-check wipes.
 *
 * `backupChromeState` is intentionally synchronous — its sole event-driven caller
 * runs inside SecurityValidator's pre-tool-use validation flow before allowing
 * the kill through, so timing guarantees matter.
 *
 * `restoreChromeState` is the operator-driven recovery path: pulls the latest
 * backup's `extensions.settings`, merges it into current Preferences, and resets
 * `profile.exit_type/exited_cleanly` so Chrome's next launch doesn't re-trigger
 * the integrity check that wiped the extensions in the first place.
 *
 * Path resolution is lazy via `kayaHomePath('backups', 'chrome')` so KAYA_HOME
 * overrides take effect inside tests. Profile dir defaults to the real
 * macOS Chrome path but accepts an override for testability.
 *
 * Usage:
 *   import { backupChromeState, restoreChromeState, isChromeKillCommand } from 'lib/agents/ChromeBackupAgent.ts';
 *
 *   bun lib/agents/ChromeBackupAgent.ts backup
 *   bun lib/agents/ChromeBackupAgent.ts restore
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { z } from 'zod';
import { kayaHomePath } from '../core/KayaHome.ts';

const MAX_CHROME_BACKUPS = 3;
const CHROME_KILL_PATTERN = /pkill.*Chrome|kill.*Chrome|killall.*Chrome/i;

function defaultChromeProfileDir(): string {
  return join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'Default');
}

function chromeBackupDir(): string {
  return kayaHomePath('backups', 'chrome');
}

/** Schema for the subset of Chrome's Secure Preferences we read on restore. */
const SecurePreferencesShape = z
  .object({
    extensions: z
      .object({
        settings: z.record(z.string(), z.unknown()).optional(),
      })
      .optional(),
  })
  .passthrough();

/** Schema for the subset of Chrome's Preferences we mutate on restore. */
const PreferencesShape = z
  .object({
    extensions: z
      .object({
        settings: z.record(z.string(), z.unknown()).optional(),
      })
      .optional(),
    profile: z
      .object({
        exit_type: z.string().optional(),
        exited_cleanly: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

type Preferences = z.infer<typeof PreferencesShape>;

export function isChromeKillCommand(command: string): boolean {
  return CHROME_KILL_PATTERN.test(command);
}

export function backupChromeState(
  profileDir: string = defaultChromeProfileDir(),
): { success: boolean; path?: string; error?: string } {
  try {
    const prefsPath = join(profileDir, 'Preferences');
    const securePrefsPath = join(profileDir, 'Secure Preferences');

    if (!existsSync(prefsPath) || !existsSync(securePrefsPath)) {
      return { success: false, error: 'Chrome profile files not found' };
    }

    const backupRoot = chromeBackupDir();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = join(backupRoot, timestamp);
    mkdirSync(backupDir, { recursive: true });

    copyFileSync(prefsPath, join(backupDir, 'Preferences'));
    copyFileSync(securePrefsPath, join(backupDir, 'Secure Preferences'));

    if (existsSync(backupRoot)) {
      const backups = readdirSync(backupRoot)
        .filter((d) => d !== '.DS_Store')
        .sort();
      while (backups.length > MAX_CHROME_BACKUPS) {
        const oldest = backups.shift()!;
        rmSync(join(backupRoot, oldest), { recursive: true, force: true });
      }
    }

    console.error(`[Kaya] Chrome state backed up to ${backupDir}`);
    return { success: true, path: backupDir };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Kaya] Chrome backup failed: ${msg}`);
    return { success: false, error: msg };
  }
}

export function restoreChromeState(
  profileDir: string = defaultChromeProfileDir(),
): void {
  const backupRoot = chromeBackupDir();
  if (!existsSync(backupRoot)) {
    console.log('No Chrome backups found.');
    return;
  }

  const backups = readdirSync(backupRoot)
    .filter((d) => d !== '.DS_Store')
    .sort();

  if (backups.length === 0) {
    console.log('No Chrome backups found.');
    return;
  }

  const latest = backups[backups.length - 1];
  const backupDir = join(backupRoot, latest);
  const backupSecurePrefsPath = join(backupDir, 'Secure Preferences');
  const currentPrefsPath = join(profileDir, 'Preferences');

  if (!existsSync(backupSecurePrefsPath) || !existsSync(currentPrefsPath)) {
    console.log('Backup or current Preferences file missing.');
    return;
  }

  try {
    const backupSecure = SecurePreferencesShape.parse(
      JSON.parse(readFileSync(backupSecurePrefsPath, 'utf-8')),
    );
    const extensionsSettings = backupSecure.extensions?.settings;

    if (!extensionsSettings || Object.keys(extensionsSettings).length === 0) {
      console.log('No extensions.settings found in backup Secure Preferences.');
      return;
    }

    const currentPrefs: Preferences = PreferencesShape.parse(
      JSON.parse(readFileSync(currentPrefsPath, 'utf-8')),
    );

    if (!currentPrefs.extensions) {
      currentPrefs.extensions = {};
    }
    currentPrefs.extensions.settings = extensionsSettings;

    if (currentPrefs.profile) {
      currentPrefs.profile.exit_type = 'Normal';
      currentPrefs.profile.exited_cleanly = true;
    }

    writeFileSync(currentPrefsPath, JSON.stringify(currentPrefs, null, 3));

    const extCount = Object.keys(extensionsSettings).length;
    console.log(`Restored ${extCount} extensions from backup ${latest}`);
    console.log(`Set exit_type: Normal, exited_cleanly: true`);
    console.log(`Backup source: ${backupDir}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Restore failed: ${msg}`);
  }
}

if (import.meta.main) {
  const cmd = process.argv[2];
  switch (cmd) {
    case 'backup': {
      const result = backupChromeState();
      process.exit(result.success ? 0 : 1);
      break;
    }
    case 'restore':
      restoreChromeState();
      break;
    default:
      console.error('Usage: bun lib/agents/ChromeBackupAgent.ts <backup|restore>');
      process.exit(2);
  }
}
