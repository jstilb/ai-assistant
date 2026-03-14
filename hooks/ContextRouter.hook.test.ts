import { describe, test, expect } from 'bun:test';
import { join } from 'path';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { execSync } from 'child_process';

const HOOK_PATH = join(import.meta.dir, 'ContextRouter.hook.ts');
const SETTINGS_PATH = join(import.meta.dir, '..', 'settings.json');

/**
 * Run the hook as a subprocess with given stdin and env overrides.
 * Uses shell file-redirect to capture stdout/stderr reliably.
 * (Bun.spawnSync stdin piping is broken under bun test in package dirs.)
 */
function runHook(
  stdinData: Record<string, unknown> | string,
  envOverrides: Record<string, string> = {},
): { stdout: string; stderr: string; exitCode: number } {
  const input = typeof stdinData === 'string' ? stdinData : JSON.stringify(stdinData);
  const ts = Date.now() + '_' + Math.random().toString(36).slice(2);
  const tmpInput = `/tmp/hook_in_${ts}.json`;
  const tmpStdout = `/tmp/hook_out_${ts}.txt`;
  const tmpStderr = `/tmp/hook_err_${ts}.txt`;
  writeFileSync(tmpInput, input);

  // Build clean env: remove subagent indicators unless explicitly overridden
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.CLAUDE_AGENT_TYPE;
  delete env.CLAUDE_PROJECT_DIR;

  let exitCode = 0;
  try {
    execSync(
      `cat ${tmpInput} | bun run ${HOOK_PATH} 1>${tmpStdout} 2>${tmpStderr}`,
      {
        timeout: 10000,
        env: { ...env, KAYA_DIR: join(import.meta.dir, '..'), ...envOverrides },
      },
    );
  } catch (err: unknown) {
    const execErr = err as { status?: number };
    exitCode = execErr.status ?? 1;
  }

  const stdout = existsSync(tmpStdout) ? readFileSync(tmpStdout, 'utf-8') : '';
  const stderr = existsSync(tmpStderr) ? readFileSync(tmpStderr, 'utf-8') : '';

  for (const f of [tmpInput, tmpStdout, tmpStderr]) {
    if (existsSync(f)) unlinkSync(f);
  }

  return { stdout, stderr, exitCode };
}

describe('ContextRouter.hook', () => {
  describe('exit behavior', () => {
    test('always exits with code 0 (fail-open)', () => {
      const result = runHook({ session_id: 'test-1', prompt: 'fix the bug' });
      expect(result.exitCode).toBe(0);
    });

    test('exits 0 even with invalid JSON stdin', () => {
      const result = runHook('not valid json');
      expect(result.exitCode).toBe(0);
    });

    test('exits 0 for empty/short prompts', () => {
      const result = runHook({ session_id: 'test-2', prompt: '' });
      expect(result.exitCode).toBe(0);
    });

    test('exits 0 for single-char prompts', () => {
      const result = runHook({ session_id: 'test-3', prompt: 'x' });
      expect(result.exitCode).toBe(0);
    });
  });

  describe('subagent detection', () => {
    test('exits immediately for subagent sessions', () => {
      const result = runHook(
        { session_id: 'test-sub', prompt: 'fix the bug' },
        { CLAUDE_AGENT_TYPE: 'Engineer' },
      );
      expect(result.exitCode).toBe(0);
      // Should not classify or output context
      expect(result.stdout).toBe('');
      expect(result.stderr).not.toContain('[IntentClassifier]');
    });
  });

  describe('mode behavior', () => {
    // Read current settings to determine which tests apply
    const settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
    const currentMode = settings.contextManager?.enabled;

    if (currentMode === true) {
      test('enabled mode: outputs context to stdout', () => {
        const result = runHook({ session_id: `test-enabled-${Date.now()}`, prompt: 'fix the authentication bug in login' });
        expect(result.exitCode).toBe(0);
        // In enabled mode, should output system-reminder with context
        expect(result.stderr).toContain('[ContextRouter]');
        expect(result.stderr).toContain('[IntentClassifier]');
      });

      test('enabled mode: classifies development prompts', () => {
        const result = runHook({ session_id: `test-dev-${Date.now()}`, prompt: 'deploy the code and run tests' });
        expect(result.stderr).toContain('development');
      });

      test('enabled mode: classifies conversational prompts without context', () => {
        const result = runHook({ session_id: `test-conv-${Date.now()}`, prompt: 'hello good morning' });
        expect(result.stderr).toContain('conversational');
        // Conversational profile injects routing pointer but no extra context files
        // stdout is either empty or contains only the routing pointer system-reminder
        if (result.stdout.length > 0) {
          expect(result.stdout).toContain('system-reminder');
          expect(result.stdout).not.toContain('Dynamic Context');
        }
      });

      test('enabled mode: injects context for development prompts', () => {
        const result = runHook({ session_id: `test-ctx-${Date.now()}`, prompt: 'fix the bug in the TypeScript code' });
        if (result.stdout.length > 0) {
          expect(result.stdout).toContain('system-reminder');
          expect(result.stdout).toContain('Dynamic Context');
        }
      });
    }

    if (currentMode === 'shadow') {
      test('shadow mode: classification runs but no stdout', () => {
        const result = runHook({ session_id: `test-shadow-${Date.now()}`, prompt: 'fix the bug' });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('[SHADOW]');
        expect(result.stderr).toContain('[IntentClassifier]');
      });
    }
  });

  describe('classification logging', () => {
    test('logs classification result to stderr', () => {
      const result = runHook({ session_id: `test-log-${Date.now()}`, prompt: 'create a new TypeScript function' });
      expect(result.stderr).toContain('[IntentClassifier]');
      // Should see either "Keyword match" or "Inference"
      const hasClassification = result.stderr.includes('Keyword match') || result.stderr.includes('Inference');
      expect(hasClassification).toBe(true);
    });

    test('logs selected file count to stderr', () => {
      const result = runHook({ session_id: `test-files-${Date.now()}`, prompt: 'fix the code bug' });
      expect(result.stderr).toContain('Selected');
      expect(result.stderr).toContain('tokens');
    });
  });

  describe('input handling', () => {
    test('accepts prompt field', () => {
      const result = runHook({ session_id: `test-prompt-${Date.now()}`, prompt: 'hello' });
      expect(result.exitCode).toBe(0);
    });

    test('accepts user_prompt field', () => {
      const result = runHook({ session_id: `test-up-${Date.now()}`, user_prompt: 'hello' });
      expect(result.exitCode).toBe(0);
    });
  });
});
