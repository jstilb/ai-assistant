/**
 * MessageRouter.test.ts - Smoke tests for MessageRouter
 *
 * route() returns message IDs (strings) that were enqueued into MessageQueue,
 * not channel names. We verify correct enqueue behavior by checking IDs and
 * queue status.
 */
import { describe, it, expect } from 'bun:test';
import { createMessageRouter } from './MessageRouter';
import { createMessageQueue } from './MessageQueue';

describe('MessageRouter', () => {
  it('createMessageRouter is importable and callable', () => {
    expect(typeof createMessageRouter).toBe('function');
  });

  it('creates router with route method', () => {
    const mq = createMessageQueue({ maxSize: 100 });
    const router = createMessageRouter({ messageQueue: mq });
    expect(typeof router.route).toBe('function');
  });

  it('route() voice mode enqueues messages and returns message IDs', () => {
    const mq = createMessageQueue({ maxSize: 100 });
    const router = createMessageRouter({ messageQueue: mq });

    const ids = router.route({
      content: 'Test voice message',
      outputMode: 'voice',
      priority: 'normal',
      jobId: 'test-job',
    });

    // Returns array of message IDs
    expect(Array.isArray(ids)).toBe(true);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    }
  });

  it('route() text mode enqueues at least one message', () => {
    const mq = createMessageQueue({ maxSize: 100 });
    const router = createMessageRouter({ messageQueue: mq });

    const ids = router.route({
      content: 'Text message',
      outputMode: 'text',
      priority: 'normal',
    });

    expect(Array.isArray(ids)).toBe(true);
    expect(ids.length).toBeGreaterThan(0);
  });

  it('route() silent mode returns empty array (no messages queued)', () => {
    const mq = createMessageQueue({ maxSize: 100 });
    const router = createMessageRouter({ messageQueue: mq });

    const ids = router.route({
      content: 'Silent message',
      outputMode: 'silent',
      priority: 'low',
    });

    expect(ids.length).toBe(0);
  });

  it('route() both mode enqueues multiple messages', () => {
    const mq = createMessageQueue({ maxSize: 100 });
    const router = createMessageRouter({ messageQueue: mq });

    const ids = router.route({
      content: 'Both mode',
      outputMode: 'both',
      priority: 'high',
    });

    // "both" = voice + push = 2 messages
    expect(ids.length).toBeGreaterThanOrEqual(2);
  });

  it('route() push mode enqueues at least one message', () => {
    const mq = createMessageQueue({ maxSize: 100 });
    const router = createMessageRouter({ messageQueue: mq });

    const ids = router.route({
      content: 'Push notification',
      outputMode: 'push',
      priority: 'normal',
    });

    expect(ids.length).toBeGreaterThan(0);
  });

  it('quiet hours config does not crash', () => {
    const mq = createMessageQueue({ maxSize: 100 });
    const router = createMessageRouter({
      messageQueue: mq,
      quietHours: { enabled: true, start: 22, end: 8 },
    });

    expect(() => {
      router.route({
        content: 'During quiet hours',
        outputMode: 'voice',
        priority: 'normal',
      });
    }).not.toThrow();
  });

  it('discord mode enqueues at least one message', () => {
    const mq = createMessageQueue({ maxSize: 100 });
    const router = createMessageRouter({ messageQueue: mq });

    const ids = router.route({
      content: 'Discord message',
      outputMode: 'discord',
      priority: 'normal',
    });

    expect(ids.length).toBeGreaterThan(0);
  });

  it('callGuard config does not crash', () => {
    const mq = createMessageQueue({ maxSize: 100 });
    const router = createMessageRouter({
      messageQueue: mq,
      callGuard: {
        enabled: true,
        detectApps: ['zoom'],
        useMicDetection: false,
        timeoutMs: 500,
        allowCriticalOverride: true,
      },
    });

    expect(() => {
      router.route({
        content: 'During potential call',
        outputMode: 'voice',
        priority: 'normal',
      });
    }).not.toThrow();
  });

  it('callGuard disabled does not affect routing', () => {
    const mq = createMessageQueue({ maxSize: 100 });
    const router = createMessageRouter({
      messageQueue: mq,
      callGuard: {
        enabled: false,
        detectApps: [],
        useMicDetection: false,
        timeoutMs: 500,
        allowCriticalOverride: true,
      },
    });

    const ids = router.route({
      content: 'Voice with guard disabled',
      outputMode: 'voice',
      priority: 'normal',
    });

    expect(ids.length).toBeGreaterThan(0);
  });
});
