import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { homedir } from 'os';
import { join } from 'path';
import {
  getKayaHome,
  kayaHomePath,
  expandPath,
  assertNotLiveHomeUnderTest,
} from './KayaHome.ts';

describe('KayaHome', () => {
  const originalKayaHome = process.env.KAYA_HOME;
  const originalKayaDir = process.env.KAYA_DIR;

  beforeEach(() => {
    delete process.env.KAYA_HOME;
    delete process.env.KAYA_DIR;
  });

  afterEach(() => {
    if (originalKayaHome !== undefined) {
      process.env.KAYA_HOME = originalKayaHome;
    } else {
      delete process.env.KAYA_HOME;
    }
    if (originalKayaDir !== undefined) {
      process.env.KAYA_DIR = originalKayaDir;
    } else {
      delete process.env.KAYA_DIR;
    }
  });

  describe('getKayaHome()', () => {
    it('returns join(homedir(), .claude) by default', () => {
      const result = getKayaHome();
      expect(result).toBe(join(homedir(), '.claude'));
    });

    it('uses KAYA_HOME env var when set', () => {
      process.env.KAYA_HOME = '/custom/kaya/home';
      const result = getKayaHome();
      expect(result).toBe('/custom/kaya/home');
    });

    it('uses KAYA_DIR as fallback when KAYA_HOME is not set', () => {
      process.env.KAYA_DIR = '/custom/kaya/dir';
      const result = getKayaHome();
      expect(result).toBe('/custom/kaya/dir');
    });

    it('prefers KAYA_HOME over KAYA_DIR when both are set', () => {
      process.env.KAYA_HOME = '/from-kaya-home';
      process.env.KAYA_DIR = '/from-kaya-dir';
      const result = getKayaHome();
      expect(result).toBe('/from-kaya-home');
    });

    it('re-resolves when KAYA_HOME changes after an earlier call (env-keyed cache, no manual reset needed)', () => {
      const first = getKayaHome();
      expect(first).toBe(join(homedir(), '.claude'));
      process.env.KAYA_HOME = '/changed-after-first-call';
      const second = getKayaHome();
      expect(second).toBe('/changed-after-first-call');
    });

    it('returns the same cached value on repeated calls when the env has not changed', () => {
      process.env.KAYA_HOME = '/stable-home';
      const first = getKayaHome();
      const second = getKayaHome();
      expect(second).toBe(first);
      expect(second).toBe('/stable-home');
    });

    it('re-resolves on an undefined-to-set transition even without KAYA_DIR involved', () => {
      const first = getKayaHome();
      expect(first).toBe(join(homedir(), '.claude'));
      process.env.KAYA_HOME = '/now-set';
      expect(getKayaHome()).toBe('/now-set');
      delete process.env.KAYA_HOME;
      expect(getKayaHome()).toBe(join(homedir(), '.claude'));
    });
  });

  describe('kayaHomePath()', () => {
    it('joins segments under getKayaHome()', () => {
      const result = kayaHomePath('settings.json');
      expect(result).toBe(join(homedir(), '.claude', 'settings.json'));
    });

    it('joins multiple segments correctly', () => {
      const result = kayaHomePath('MEMORY', 'State', 'foo.json');
      expect(result).toBe(join(homedir(), '.claude', 'MEMORY', 'State', 'foo.json'));
    });

    it('respects KAYA_HOME env var', () => {
      process.env.KAYA_HOME = '/test-home';
      const result = kayaHomePath('foo', 'bar');
      expect(result).toBe(join('/test-home', 'foo', 'bar'));
    });
  });

  describe('assertNotLiveHomeUnderTest()', () => {
    const originalNodeEnv = process.env.NODE_ENV;

    afterEach(() => {
      if (originalNodeEnv !== undefined) {
        process.env.NODE_ENV = originalNodeEnv;
      } else {
        delete process.env.NODE_ENV;
      }
    });

    it('throws under NODE_ENV=test when KAYA_HOME is unset (resolves to the live default)', () => {
      process.env.NODE_ENV = 'test';
      expect(() => assertNotLiveHomeUnderTest('SomeComponent')).toThrow(/\[hermetic-guard\] SomeComponent/);
    });

    it('does not throw under NODE_ENV=test when KAYA_HOME points at a sandbox', () => {
      process.env.NODE_ENV = 'test';
      process.env.KAYA_HOME = '/some/sandbox/dir';
      expect(() => assertNotLiveHomeUnderTest('SomeComponent')).not.toThrow();
    });

    it('does not throw when NODE_ENV is not "test", even with KAYA_HOME unset', () => {
      process.env.NODE_ENV = 'production';
      expect(() => assertNotLiveHomeUnderTest('SomeComponent')).not.toThrow();
    });
  });

  describe('expandPath()', () => {
    it('expands $HOME at start of path', () => {
      const result = expandPath('$HOME/.claude');
      expect(result).toBe(join(homedir(), '.claude'));
    });

    it('expands ${HOME} at start of path', () => {
      const result = expandPath('${HOME}/.claude');
      expect(result).toBe(join(homedir(), '.claude'));
    });

    it('expands ~ at start of path', () => {
      const result = expandPath('~/.claude');
      expect(result).toBe(join(homedir(), '.claude'));
    });

    it('does not expand $HOME in the middle of a path', () => {
      const result = expandPath('/some/$HOME/path');
      expect(result).toBe('/some/$HOME/path');
    });

    it('returns absolute paths unchanged', () => {
      const result = expandPath('/absolute/path');
      expect(result).toBe('/absolute/path');
    });
  });
});
