#!/usr/bin/env bun
/**
 * ============================================================================
 * EventBus - Typed pub/sub for intra-daemon communication
 * ============================================================================
 *
 * PURPOSE:
 * Simple typed event bus enabling decoupled communication between daemon
 * components (CronManager, MessageQueue, HealthMonitor, WebSocketServer).
 *
 * USAGE:
 *   const bus = createEventBus();
 *
 *   // Subscribe to specific event type
 *   bus.on('job.completed', (event) => {
 *     console.log(`Job ${event.jobId} finished in ${event.duration}ms`);
 *   });
 *
 *   // Subscribe to all events
 *   bus.onAny((event) => {
 *     console.log(`Event: ${event.type}`);
 *   });
 *
 *   // Emit events
 *   bus.emit({ type: 'job.completed', jobId: 'daily-briefing', success: true, duration: 1200 });
 *
 * ============================================================================
 */

// ============================================================================
// Types
// ============================================================================

/**
 * All daemon event types
 */
export type DaemonEvent =
  | { type: 'job.started'; jobId: string; jobType: 'isolated' | 'main'; timestamp: number }
  | { type: 'job.completed'; jobId: string; success: boolean; duration: number; output?: string; timestamp: number }
  | { type: 'job.failed'; jobId: string; error: string; duration: number; timestamp: number }
  | { type: 'queue.processed'; count: number; pending: number; failed: number; timestamp: number }
  | { type: 'queue.enqueued'; messageId: string; channel: string; priority: string; timestamp: number }
  | { type: 'daemon.started'; port: number; pid: number; timestamp: number }
  | { type: 'daemon.stopping'; reason: string; timestamp: number }
  | { type: 'daemon.health'; status: 'healthy' | 'degraded' | 'unhealthy'; details?: string; timestamp: number };

/**
 * Extract event by type
 */
export type EventByType<T extends DaemonEvent['type']> = Extract<DaemonEvent, { type: T }>;

/**
 * Event handler function
 */
export type EventHandler<T extends DaemonEvent = DaemonEvent> = (event: T) => void;

/**
 * EventBus interface
 */
export interface EventBus {
  /** Subscribe to a specific event type */
  on<T extends DaemonEvent['type']>(type: T, handler: EventHandler<EventByType<T>>): () => void;
  /** Subscribe to all events */
  onAny(handler: EventHandler<DaemonEvent>): () => void;
  /** Emit an event to all subscribers */
  emit(event: DaemonEvent): void;
  /** Remove all listeners */
  clear(): void;
  /** Get listener count for a type (or total) */
  listenerCount(type?: DaemonEvent['type']): number;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Create an EventBus instance
 */
export function createEventBus(): EventBus {
  const typedHandlers = new Map<string, Set<EventHandler<any>>>();
  const anyHandlers = new Set<EventHandler<DaemonEvent>>();

  function on<T extends DaemonEvent['type']>(type: T, handler: EventHandler<EventByType<T>>): () => void {
    if (!typedHandlers.has(type)) {
      typedHandlers.set(type, new Set());
    }
    typedHandlers.get(type)!.add(handler);

    // Return unsubscribe function
    return () => {
      typedHandlers.get(type)?.delete(handler);
      if (typedHandlers.get(type)?.size === 0) {
        typedHandlers.delete(type);
      }
    };
  }

  function onAny(handler: EventHandler<DaemonEvent>): () => void {
    anyHandlers.add(handler);
    return () => {
      anyHandlers.delete(handler);
    };
  }

  function emit(event: DaemonEvent): void {
    // Notify typed handlers
    const handlers = typedHandlers.get(event.type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(event);
        } catch (err) {
          console.error(`[EventBus] Handler error for ${event.type}:`, err);
        }
      }
    }

    // Notify any-handlers
    for (const handler of anyHandlers) {
      try {
        handler(event);
      } catch (err) {
        console.error(`[EventBus] Any-handler error for ${event.type}:`, err);
      }
    }
  }

  function clear(): void {
    typedHandlers.clear();
    anyHandlers.clear();
  }

  function listenerCount(type?: DaemonEvent['type']): number {
    if (type) {
      return (typedHandlers.get(type)?.size || 0) + anyHandlers.size;
    }
    let total = anyHandlers.size;
    for (const handlers of typedHandlers.values()) {
      total += handlers.size;
    }
    return total;
  }

  return { on, onAny, emit, clear, listenerCount };
}
