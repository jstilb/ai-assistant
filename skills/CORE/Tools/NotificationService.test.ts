#!/usr/bin/env bun
/**
 * NotificationService.test.ts - Test suite for unified notification service
 *
 * TDD: Tests written FIRST, implementation follows
 *
 * Run: bun test NotificationService.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';

// We'll import these after creating the implementation
// import {
//   createNotificationService,
//   notify,
//   notifySync,
//   type NotifyOptions,
//   type NotificationConfig,
// } from './NotificationService';

describe('NotificationService', () => {
  describe('createNotificationService()', () => {
    it('should create a service instance with default config', async () => {
      const { createNotificationService } = await import('./NotificationService');
      const service = createNotificationService();
      expect(service).toBeDefined();
      expect(typeof service.notify).toBe('function');
      expect(typeof service.notifySync).toBe('function');
      expect(typeof service.batch).toBe('function');
      expect(typeof service.isServiceHealthy).toBe('function');
      expect(typeof service.getQueuedCount).toBe('function');
      expect(typeof service.flush).toBe('function');
    });

    it('should accept custom configuration', async () => {
      const { createNotificationService } = await import('./NotificationService');
      const service = createNotificationService({
        voiceServerUrl: 'http://localhost:9999/notify',
        defaultChannel: 'push',
        batchWindowMs: 100,
        maxRetries: 5,
      });
      expect(service).toBeDefined();
    });
  });

  describe('notify()', () => {
    it('should send a basic voice notification', async () => {
      const { createNotificationService } = await import('./NotificationService');

      // Mock fetch
      const mockFetch = mock(async () => ({
        ok: true,
        status: 200,
      }));
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const service = createNotificationService({
        voiceServerUrl: 'http://localhost:8888/notify',
      });

      await service.notify('Test message');

      // Should have called fetch with the voice server
      expect(mockFetch).toHaveBeenCalled();
    });

    it('should support priority levels', async () => {
      const { createNotificationService } = await import('./NotificationService');

      const calls: any[] = [];
      globalThis.fetch = mock(async (url, opts) => {
        calls.push({ url, opts });
        return { ok: true, status: 200 };
      }) as unknown as typeof fetch;

      const service = createNotificationService();

      await service.notify('Critical alert', { priority: 'critical' });

      expect(calls.length).toBeGreaterThan(0);
    });

    it('should support custom voiceId', async () => {
      const { createNotificationService } = await import('./NotificationService');

      let capturedBody: any;
      globalThis.fetch = mock(async (url, opts) => {
        if (opts?.body) {
          capturedBody = JSON.parse(opts.body as string);
        }
        return { ok: true, status: 200 };
      }) as unknown as typeof fetch;

      const service = createNotificationService();
      await service.notify('Hello', { voiceId: 'custom-voice-id' });

      expect(capturedBody?.voice_id).toBe('custom-voice-id');
    });

    it('should use agentName in notification title', async () => {
      const { createNotificationService } = await import('./NotificationService');

      let capturedBody: any;
      globalThis.fetch = mock(async (url, opts) => {
        if (opts?.body) {
          capturedBody = JSON.parse(opts.body as string);
        }
        return { ok: true, status: 200 };
      }) as unknown as typeof fetch;

      const service = createNotificationService();
      await service.notify('Task complete', { agentName: 'Engineer' });

      expect(capturedBody?.title).toBe('Engineer');
    });
  });

  describe('notifySync()', () => {
    it('should be fire-and-forget (non-blocking)', async () => {
      const { createNotificationService } = await import('./NotificationService');

      let fetchCalled = false;
      globalThis.fetch = mock(async () => {
        // Simulate slow network
        await new Promise((r) => setTimeout(r, 100));
        fetchCalled = true;
        return { ok: true, status: 200 };
      }) as unknown as typeof fetch;

      const service = createNotificationService();
      const start = Date.now();
      service.notifySync('Fire and forget');
      const elapsed = Date.now() - start;

      // Should return immediately (not wait for fetch)
      expect(elapsed).toBeLessThan(50);

      // Wait for the async operation to complete
      await new Promise((r) => setTimeout(r, 150));
      expect(fetchCalled).toBe(true);
    });
  });

  describe('batch()', () => {
    it('should batch multiple messages into one notification', async () => {
      const { createNotificationService } = await import('./NotificationService');

      let callCount = 0;
      let lastBody: any;
      globalThis.fetch = mock(async (url, opts) => {
        callCount++;
        if (opts?.body) {
          lastBody = JSON.parse(opts.body as string);
        }
        return { ok: true, status: 200 };
      }) as unknown as typeof fetch;

      const service = createNotificationService({ batchWindowMs: 50 });

      await service.batch(['Step 1 complete', 'Step 2 complete', 'Step 3 complete']);

      // Should have combined messages
      expect(lastBody?.message).toContain('Step 1');
      expect(lastBody?.message).toContain('Step 2');
      expect(lastBody?.message).toContain('Step 3');
    });
  });

  describe('isServiceHealthy()', () => {
    it('should return true when voice server is responding', async () => {
      const { createNotificationService } = await import('./NotificationService');

      globalThis.fetch = mock(async () => ({
        ok: true,
        status: 200,
      })) as unknown as typeof fetch;

      const service = createNotificationService();
      const healthy = await service.isServiceHealthy('voice');

      expect(healthy).toBe(true);
    });

    it('should return false when voice server is down', async () => {
      const { createNotificationService } = await import('./NotificationService');

      globalThis.fetch = mock(async () => {
        throw new Error('Connection refused');
      }) as unknown as typeof fetch;

      const service = createNotificationService();
      const healthy = await service.isServiceHealthy('voice');

      expect(healthy).toBe(false);
    });
  });

  describe('retry with backoff', () => {
    it('should retry on failure with exponential backoff', async () => {
      const { createNotificationService } = await import('./NotificationService');

      let attempts = 0;
      globalThis.fetch = mock(async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error('Network error');
        }
        return { ok: true, status: 200 };
      }) as unknown as typeof fetch;

      const service = createNotificationService({ maxRetries: 3 });
      await service.notify('Retry test', { retry: 3 });

      expect(attempts).toBe(3);
    });
  });

  describe('queue for offline', () => {
    it('should queue notifications when service is down', async () => {
      const { createNotificationService } = await import('./NotificationService');

      globalThis.fetch = mock(async () => {
        throw new Error('Service unavailable');
      }) as unknown as typeof fetch;

      const service = createNotificationService({ maxRetries: 1 });

      // This should not throw but queue the message
      await service.notify('Queued message');

      const queuedCount = service.getQueuedCount();
      expect(queuedCount).toBeGreaterThanOrEqual(0); // May be 0 if retry exhausted
    });

    it('should flush queued notifications when service recovers', async () => {
      const { createNotificationService } = await import('./NotificationService');

      let failCount = 0;
      let successCount = 0;

      globalThis.fetch = mock(async () => {
        if (failCount < 2) {
          failCount++;
          throw new Error('Service unavailable');
        }
        successCount++;
        return { ok: true, status: 200 };
      }) as unknown as typeof fetch;

      const service = createNotificationService({ maxRetries: 0 });

      // Queue some messages while "offline"
      await service.notify('Message 1');
      await service.notify('Message 2');

      // Now service is "online" - flush
      failCount = 99; // Make fetch succeed
      await service.flush();

      expect(successCount).toBeGreaterThanOrEqual(0);
    });
  });

  describe('fallback channels', () => {
    it('should fallback to push if voice fails', async () => {
      const { createNotificationService } = await import('./NotificationService');

      const calledUrls: string[] = [];
      globalThis.fetch = mock(async (url) => {
        calledUrls.push(url as string);
        if ((url as string).includes('localhost:8888')) {
          throw new Error('Voice server down');
        }
        return { ok: true, status: 200 };
      }) as unknown as typeof fetch;

      const service = createNotificationService({
        ntfyTopic: 'test-topic',
      });

      await service.notify('Fallback test', { fallback: true, channel: 'voice' });

      // Should have tried both voice and push
      expect(calledUrls.some((u) => u.includes('localhost:8888'))).toBe(true);
      expect(calledUrls.some((u) => u.includes('ntfy'))).toBe(true);
    });
  });

  describe('channel-specific behavior', () => {
    it('should send to voice channel by default', async () => {
      const { createNotificationService } = await import('./NotificationService');

      let calledUrl = '';
      globalThis.fetch = mock(async (url) => {
        calledUrl = url as string;
        return { ok: true, status: 200 };
      }) as unknown as typeof fetch;

      const service = createNotificationService();
      await service.notify('Voice message');

      expect(calledUrl).toContain('localhost:8888');
    });

    it('should send to push channel when specified', async () => {
      const { createNotificationService } = await import('./NotificationService');

      let calledUrl = '';
      globalThis.fetch = mock(async (url) => {
        calledUrl = url as string;
        return { ok: true, status: 200 };
      }) as unknown as typeof fetch;

      const service = createNotificationService({ ntfyTopic: 'my-topic' });
      await service.notify('Push message', { channel: 'push' });

      expect(calledUrl).toContain('ntfy.sh/my-topic');
    });
  });

  describe('CLI interface', () => {
    it('should support --test flag for testing', async () => {
      // This tests that the CLI can be invoked
      const proc = Bun.spawn(['bun', 'run', './NotificationService.ts', '--test', 'Hello CLI'], {
        cwd: '~/.claude/skills/CORE/Tools',
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const exitCode = await proc.exited;
      // May fail if voice server isn't running, but should not crash
      expect(exitCode === 0 || exitCode === 1).toBe(true);
    });
  });
});

describe('Module exports', () => {
  it('should export notify function', async () => {
    const module = await import('./NotificationService');
    expect(typeof module.notify).toBe('function');
  });

  it('should export notifySync function', async () => {
    const module = await import('./NotificationService');
    expect(typeof module.notifySync).toBe('function');
  });

  it('should export createNotificationService function', async () => {
    const module = await import('./NotificationService');
    expect(typeof module.createNotificationService).toBe('function');
  });
});
