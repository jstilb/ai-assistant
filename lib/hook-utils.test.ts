import { describe, it, expect } from 'bun:test';
import {
  readHookInput,
  readHookInputSync,
  readSecurityHookInput,
  readObservabilityHookInput,
  readSecurityHookInputSync,
  readObservabilityHookInputSync,
  SecurityHookInputError,
  SECURITY_HOOK_INPUT_TIMEOUT_MS,
  OBSERVABILITY_HOOK_INPUT_TIMEOUT_MS,
} from './hook-utils.ts';

// Subprocess-spawning harnesses are unreliable inside the test runner
// (child stdin sometimes does not get the piped input from spawnSync).
// Instead the tests cover the two layers separately:
//   1. The fail-CLOSED / fail-OPEN policy wrappers — exercised directly by
//      mocking readHookInputSync and asserting the throw / null branch.
//   2. The underlying readHookInputSync over /dev/stdin — covered implicitly
//      under the test runner, which gives us a real "empty stdin" condition.

describe('hook-utils', () => {
  describe('module exports', () => {
    it('exports the four typed entry points', async () => {
      expect(typeof readSecurityHookInput).toBe('function');
      expect(typeof readObservabilityHookInput).toBe('function');
      expect(typeof readSecurityHookInputSync).toBe('function');
      expect(typeof readObservabilityHookInputSync).toBe('function');
    });

    it('exports SecurityHookInputError class', () => {
      const err = new SecurityHookInputError('test');
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('SecurityHookInputError');
      expect(err.message).toBe('test');
    });

    it('exports canonical timeout constants — security tolerates more latency than observability', () => {
      expect(typeof SECURITY_HOOK_INPUT_TIMEOUT_MS).toBe('number');
      expect(typeof OBSERVABILITY_HOOK_INPUT_TIMEOUT_MS).toBe('number');
      expect(SECURITY_HOOK_INPUT_TIMEOUT_MS).toBeGreaterThan(OBSERVABILITY_HOOK_INPUT_TIMEOUT_MS);
    });

    it('keeps legacy readHookInput / readHookInputSync exports', () => {
      expect(typeof readHookInput).toBe('function');
      expect(typeof readHookInputSync).toBe('function');
    });
  });

  describe('fail-CLOSED policy via empty test runner stdin', () => {
    // Inside `bun test`, fd 0 has no JSON payload. readHookInputSync returns null.
    // The security wrapper must throw; the observability wrapper must return null.
    // This is the most important contract — failure modes diverge across policies.

    it('readSecurityHookInputSync throws SecurityHookInputError on empty stdin', () => {
      let caught: unknown = null;
      try {
        readSecurityHookInputSync();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(SecurityHookInputError);
      const message = caught instanceof Error ? caught.message : '';
      expect(message).toContain('Security hook input unavailable');
    });

    it('readObservabilityHookInputSync returns null on empty stdin', () => {
      const result = readObservabilityHookInputSync();
      expect(result).toBeNull();
    });

    it('readSecurityHookInput (async) rejects with SecurityHookInputError when underlying reader yields null', async () => {
      // Use a deliberately tiny timeout so the async path resolves to null
      // immediately (no real stdin payload available under the test runner).
      let caught: unknown = null;
      try {
        await readSecurityHookInput({ timeoutMs: 50 });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(SecurityHookInputError);
    });

    it('readObservabilityHookInput (async) resolves to null when underlying reader yields null', async () => {
      const result = await readObservabilityHookInput({ timeoutMs: 50 });
      expect(result).toBeNull();
    });
  });

});

describe('SecurityHookInputError', () => {
  it('preserves a cause when provided', () => {
    const cause = new Error('underlying');
    const err = new SecurityHookInputError('wrapper', cause);
    expect(err.cause).toBe(cause);
  });

  it('omits cause when not provided', () => {
    const err = new SecurityHookInputError('only');
    expect(err.cause).toBeUndefined();
  });
});

describe('real-stdin integration via Readable.from', () => {
  // Swap process.stdin for a Readable.from stream so we exercise the actual
  // event-listener plumbing in readHookInput. This is the only reliable way
  // to integration-test the async path without subprocesses.

  const setStdin = (replacement: NodeJS.ReadStream): NodeJS.ReadStream => {
    const original = process.stdin;
    Object.defineProperty(process, 'stdin', {
      value: replacement,
      configurable: true,
      writable: true,
    });
    return original;
  };

  it('readObservabilityHookInput resolves with parsed JSON when stdin yields a valid payload', async () => {
    const { Readable } = await import('stream');
    const fake = Readable.from(['{"a":7}']) as unknown as NodeJS.ReadStream;
    const original = setStdin(fake);
    try {
      const result = await readObservabilityHookInput<{ a: number }>({ timeoutMs: 1000 });
      expect(result).toEqual({ a: 7 });
    } finally {
      setStdin(original);
    }
  });

  it('readSecurityHookInput resolves with parsed JSON when stdin yields a valid payload', async () => {
    const { Readable } = await import('stream');
    const fake = Readable.from(['{"a":3}']) as unknown as NodeJS.ReadStream;
    const original = setStdin(fake);
    try {
      const result = await readSecurityHookInput<{ a: number }>({ timeoutMs: 1000 });
      expect(result).toEqual({ a: 3 });
    } finally {
      setStdin(original);
    }
  });

  it('readSecurityHookInput throws when stdin yields invalid JSON', async () => {
    const { Readable } = await import('stream');
    const fake = Readable.from(['not-json{{{']) as unknown as NodeJS.ReadStream;
    const original = setStdin(fake);
    try {
      let caught: unknown = null;
      try {
        await readSecurityHookInput({ timeoutMs: 1000 });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(SecurityHookInputError);
    } finally {
      setStdin(original);
    }
  });

  it('readObservabilityHookInput returns null when stdin yields invalid JSON', async () => {
    const { Readable } = await import('stream');
    const fake = Readable.from(['not-json{{{']) as unknown as NodeJS.ReadStream;
    const original = setStdin(fake);
    try {
      const result = await readObservabilityHookInput({ timeoutMs: 1000 });
      expect(result).toBeNull();
    } finally {
      setStdin(original);
    }
  });
});
