/**
 * EventBus.test.ts - Smoke tests for EventBus
 */
import { describe, it, expect } from 'bun:test';
import { createEventBus } from './EventBus';
import type { DaemonEvent } from './EventBus';

describe('EventBus', () => {
  it('createEventBus is importable and callable', () => {
    expect(typeof createEventBus).toBe('function');
  });

  it('creates a bus with on, onAny, emit, clear, listenerCount', () => {
    const bus = createEventBus();
    expect(typeof bus.on).toBe('function');
    expect(typeof bus.onAny).toBe('function');
    expect(typeof bus.emit).toBe('function');
    expect(typeof bus.clear).toBe('function');
    expect(typeof bus.listenerCount).toBe('function');
  });

  it('emits job.completed events to typed subscriber', () => {
    const bus = createEventBus();
    const received: DaemonEvent[] = [];

    bus.on('job.completed', (event) => {
      received.push(event);
    });

    bus.emit({
      type: 'job.completed',
      jobId: 'test-job',
      success: true,
      duration: 100,
      timestamp: Date.now(),
    });

    expect(received.length).toBe(1);
    expect(received[0].type).toBe('job.completed');
    if (received[0].type === 'job.completed') {
      expect(received[0].jobId).toBe('test-job');
      expect(received[0].success).toBe(true);
    }
  });

  it('onAny receives all events', () => {
    const bus = createEventBus();
    const received: DaemonEvent[] = [];

    bus.onAny((event) => received.push(event));

    bus.emit({ type: 'daemon.started', port: 3000, pid: 1234, timestamp: Date.now() });
    bus.emit({ type: 'daemon.health', status: 'healthy', timestamp: Date.now() });

    expect(received.length).toBe(2);
  });

  it('unsubscribe function removes handler', () => {
    const bus = createEventBus();
    const received: DaemonEvent[] = [];

    const unsub = bus.on('job.failed', (event) => received.push(event));

    bus.emit({ type: 'job.failed', jobId: 'x', error: 'oops', duration: 50, timestamp: Date.now() });
    expect(received.length).toBe(1);

    unsub();

    bus.emit({ type: 'job.failed', jobId: 'x', error: 'oops', duration: 50, timestamp: Date.now() });
    expect(received.length).toBe(1); // Should not increase after unsubscribe
  });

  it('listenerCount returns correct counts', () => {
    const bus = createEventBus();
    expect(bus.listenerCount()).toBe(0);

    const unsub = bus.on('queue.processed', () => {});
    expect(bus.listenerCount('queue.processed')).toBe(1);

    unsub();
    expect(bus.listenerCount('queue.processed')).toBe(0);
  });

  it('clear() removes all listeners', () => {
    const bus = createEventBus();
    bus.on('daemon.stopping', () => {});
    bus.onAny(() => {});
    expect(bus.listenerCount()).toBeGreaterThan(0);

    bus.clear();
    expect(bus.listenerCount()).toBe(0);
  });

  it('does not throw when emitting to type with no subscribers', () => {
    const bus = createEventBus();
    expect(() => {
      bus.emit({ type: 'daemon.health', status: 'unhealthy', timestamp: Date.now() });
    }).not.toThrow();
  });
});
