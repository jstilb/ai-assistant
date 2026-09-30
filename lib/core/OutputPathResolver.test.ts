/**
 * OutputPathResolver.test.ts - Smoke tests for OutputPathResolver
 */
import { describe, it, expect } from 'bun:test';
import { resolveOutputPath, prepareOutputPath, ensureOutputDir } from './OutputPathResolver';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import os from 'os';

const TMP = join(os.tmpdir(), `opr-test-${Date.now()}`);

describe('OutputPathResolver', () => {
  it('exports expected functions', () => {
    expect(typeof resolveOutputPath).toBe('function');
    expect(typeof prepareOutputPath).toBe('function');
    expect(typeof ensureOutputDir).toBe('function');
  });

  it('resolveOutputPath returns path, directory, filename, directoryExisted', async () => {
    const result = await resolveOutputPath({
      skill: 'TestSkill',
      title: 'hello world',
      type: 'custom',
      customPath: TMP,
      extension: 'md',
      includeTimestamp: false,
    });
    expect(typeof result.path).toBe('string');
    expect(typeof result.directory).toBe('string');
    expect(typeof result.filename).toBe('string');
    expect(typeof result.directoryExisted).toBe('boolean');
    expect(result.path).toContain('hello-world');
    expect(result.filename).toContain('.md');
  });

  it('prepareOutputPath creates directory and returns path', async () => {
    const result = await prepareOutputPath({
      skill: 'TestSkill',
      title: 'prepare-test',
      type: 'custom',
      customPath: TMP,
      extension: 'txt',
      includeTimestamp: false,
    });
    expect(typeof result.path).toBe('string');
    expect(existsSync(result.directory)).toBe(true);
  });

  it('ensureOutputDir creates parent directory for a file path', () => {
    // ensureOutputDir takes a FILE path and creates its parent directory
    const testFile = join(TMP, 'ensure-test', 'subdir', 'output.md');
    ensureOutputDir(testFile);
    // The PARENT directory should now exist
    expect(existsSync(join(TMP, 'ensure-test', 'subdir'))).toBe(true);
  });

  it('resolveOutputPath slugifies title correctly', async () => {
    const result = await resolveOutputPath({
      skill: 'Foo',
      title: 'Hello World -- Test!',
      type: 'custom',
      customPath: TMP,
      includeTimestamp: false,
    });
    // Filename should not contain spaces or special chars
    expect(result.filename).not.toContain(' ');
    expect(result.filename).not.toContain('!');
  });
});
