import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  backupChromeState,
  isChromeKillCommand,
  restoreChromeState,
} from './ChromeBackupAgent.ts';

describe('ChromeBackupAgent', () => {
  const originalKayaHome = process.env.KAYA_HOME;
  let tempRoot: string;
  let profileDir: string;

  function makeProfile(prefs: object, securePrefs: object): void {
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(join(profileDir, 'Preferences'), JSON.stringify(prefs, null, 2));
    writeFileSync(join(profileDir, 'Secure Preferences'), JSON.stringify(securePrefs, null, 2));
  }

  function backupRoot(): string {
    return join(process.env.KAYA_HOME!, 'backups', 'chrome');
  }

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'chrome-backup-test-'));
    process.env.KAYA_HOME = tempRoot;
    profileDir = join(tempRoot, 'profile', 'Default');
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
    if (originalKayaHome !== undefined) {
      process.env.KAYA_HOME = originalKayaHome;
    } else {
      delete process.env.KAYA_HOME;
    }
  });

  describe('isChromeKillCommand', () => {
    it('matches pkill Chrome', () => {
      expect(isChromeKillCommand('pkill -9 Chrome')).toBe(true);
    });
    it('matches kill ... Chrome ...', () => {
      expect(isChromeKillCommand('kill -9 12345 # Chrome process')).toBe(true);
    });
    it('matches killall Chrome', () => {
      expect(isChromeKillCommand('killall "Google Chrome"')).toBe(true);
    });
    it('matches case-insensitively', () => {
      expect(isChromeKillCommand('PKILL CHROME')).toBe(true);
    });
    it('rejects unrelated commands', () => {
      expect(isChromeKillCommand('ls -la /tmp')).toBe(false);
      expect(isChromeKillCommand('git push origin main')).toBe(false);
      expect(isChromeKillCommand('echo "open chrome.app"')).toBe(false);
    });
  });

  describe('backupChromeState', () => {
    it('writes both Preferences files under <KAYA_HOME>/backups/chrome/<timestamp>/', () => {
      makeProfile({ profile: { exit_type: 'Normal' } }, { extensions: { settings: { foo: { id: 'foo' } } } });

      const result = backupChromeState(profileDir);

      expect(result.success).toBe(true);
      expect(result.path).toBeDefined();
      expect(result.path!.startsWith(backupRoot())).toBe(true);
      expect(existsSync(join(result.path!, 'Preferences'))).toBe(true);
      expect(existsSync(join(result.path!, 'Secure Preferences'))).toBe(true);
    });

    it('returns success:false when profile files do not exist', () => {
      const result = backupChromeState(profileDir);
      expect(result.success).toBe(false);
      expect(result.error).toBe('Chrome profile files not found');
    });

    it('rotates to keep at most MAX_CHROME_BACKUPS (3)', async () => {
      makeProfile({ profile: {} }, { extensions: { settings: {} } });

      for (let i = 0; i < 5; i++) {
        const r = backupChromeState(profileDir);
        expect(r.success).toBe(true);
        await new Promise((res) => setTimeout(res, 10));
      }

      const dirs = readdirSync(backupRoot()).filter((d) => d !== '.DS_Store');
      expect(dirs.length).toBe(3);
    });
  });

  describe('restoreChromeState', () => {
    it('merges extensions.settings from latest backup and resets exit flags', () => {
      makeProfile(
        { profile: { exit_type: 'Crashed', exited_cleanly: false }, extensions: { settings: {} } },
        { extensions: { settings: { ext_old: { id: 'old', enabled: true } } } },
      );
      const r1 = backupChromeState(profileDir);
      expect(r1.success).toBe(true);

      writeFileSync(
        join(profileDir, 'Preferences'),
        JSON.stringify({ profile: { exit_type: 'Crashed', exited_cleanly: false }, extensions: { settings: {} } }),
      );

      restoreChromeState(profileDir);

      const after = JSON.parse(readFileSync(join(profileDir, 'Preferences'), 'utf-8'));
      expect(after.profile.exit_type).toBe('Normal');
      expect(after.profile.exited_cleanly).toBe(true);
      expect(after.extensions.settings.ext_old).toEqual({ id: 'old', enabled: true });
    });

    it('does nothing when no backups directory exists', () => {
      makeProfile({ profile: { exit_type: 'Crashed' } }, { extensions: { settings: {} } });
      const beforeContent = readFileSync(join(profileDir, 'Preferences'), 'utf-8');

      expect(() => restoreChromeState(profileDir)).not.toThrow();

      const afterContent = readFileSync(join(profileDir, 'Preferences'), 'utf-8');
      expect(afterContent).toBe(beforeContent);
    });

    it('does nothing when backup has no extensions.settings', () => {
      makeProfile({ profile: { exit_type: 'Crashed' } }, { extensions: { settings: {} } });
      backupChromeState(profileDir);

      const beforeContent = readFileSync(join(profileDir, 'Preferences'), 'utf-8');
      restoreChromeState(profileDir);
      const afterContent = readFileSync(join(profileDir, 'Preferences'), 'utf-8');

      expect(afterContent).toBe(beforeContent);
    });
  });
});
