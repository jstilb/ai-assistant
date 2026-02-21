#!/usr/bin/env bun
/**
 * AudioBufferQueue.ts - Sequential audio chunk buffer for streaming TTS playback
 *
 * Queues incoming audio chunks for ordered, sequential playback.
 * Supports max buffer size to prevent unbounded memory growth,
 * drain for clean shutdown, and clear for interruption handling.
 *
 * Usage (library):
 *   import { AudioBufferQueue } from "./AudioBufferQueue.ts";
 *
 *   const queue = new AudioBufferQueue({ maxSize: 50 });
 *   queue.enqueue({ data: audioBuffer, index: 0, timestamp: Date.now() });
 *   const chunk = queue.dequeue();
 *   queue.clear(); // On interruption
 *   await queue.drain(); // On clean shutdown
 *
 * @module AudioBufferQueue
 * @version 1.0.0
 */

// ============================================
// TYPES
// ============================================

/**
 * Represents a single audio chunk received from the streaming TTS API.
 * Uses Buffer for audio data to maintain compatibility with Node/Bun APIs.
 */
export interface AudioChunk {
  /** Raw audio data */
  data: Buffer;
  /** Chunk sequence index (0-based) */
  index: number;
  /** Timestamp when chunk was received (ms since epoch) */
  timestamp: number;
  /** Size in bytes */
  byteLength: number;
}

/**
 * Configuration options for AudioBufferQueue
 */
export interface AudioBufferQueueOptions {
  /** Maximum number of chunks in the buffer (default: 100) */
  maxSize?: number;
  /** Callback when buffer is full and a chunk is dropped */
  onOverflow?: (dropped: AudioChunk) => void;
}

// ============================================
// AUDIO BUFFER QUEUE
// ============================================

/**
 * FIFO queue for audio chunks with bounded size and interruption support.
 *
 * Designed for streaming TTS: chunks arrive asynchronously from a WebSocket
 * and are consumed sequentially for playback. The queue enforces a maximum
 * size to prevent unbounded memory growth during slow playback or paused
 * consumers.
 */
export class AudioBufferQueue {
  private queue: AudioChunk[] = [];
  private maxSize: number;
  private onOverflow?: (dropped: AudioChunk) => void;
  private totalBytesEnqueued: number = 0;
  private totalBytesDequeued: number = 0;
  private draining: boolean = false;
  private drainResolve: (() => void) | null = null;

  constructor(options: AudioBufferQueueOptions = {}) {
    this.maxSize = options.maxSize ?? 100;
    this.onOverflow = options.onOverflow;
  }

  /**
   * Add an audio chunk to the end of the queue.
   * If the queue is at max capacity, the oldest chunk is dropped.
   *
   * @param chunk - The audio chunk to enqueue
   * @returns true if enqueued without dropping, false if overflow occurred
   */
  enqueue(chunk: AudioChunk): boolean {
    if (this.draining) {
      return false;
    }

    let overflow = false;

    if (this.queue.length >= this.maxSize) {
      const dropped = this.queue.shift();
      if (dropped && this.onOverflow) {
        this.onOverflow(dropped);
      }
      if (dropped) {
        this.totalBytesDequeued += dropped.byteLength;
      }
      overflow = true;
    }

    this.queue.push(chunk);
    this.totalBytesEnqueued += chunk.byteLength;

    return !overflow;
  }

  /**
   * Remove and return the next audio chunk from the front of the queue.
   * Returns undefined if the queue is empty.
   *
   * @returns The next audio chunk, or undefined if empty
   */
  dequeue(): AudioChunk | undefined {
    const chunk = this.queue.shift();
    if (chunk) {
      this.totalBytesDequeued += chunk.byteLength;

      // If draining and now empty, resolve the drain promise
      if (this.draining && this.queue.length === 0 && this.drainResolve) {
        this.drainResolve();
        this.drainResolve = null;
      }
    }
    return chunk;
  }

  /**
   * Look at the next chunk without removing it.
   *
   * @returns The next audio chunk, or undefined if empty
   */
  peek(): AudioChunk | undefined {
    return this.queue[0];
  }

  /**
   * Clear all chunks from the queue (used during interruption).
   * Immediately empties the buffer and resets byte counters.
   *
   * @returns The number of chunks that were cleared
   */
  clear(): number {
    const count = this.queue.length;
    this.queue = [];
    this.totalBytesEnqueued = 0;
    this.totalBytesDequeued = 0;
    this.draining = false;
    if (this.drainResolve) {
      this.drainResolve();
      this.drainResolve = null;
    }
    return count;
  }

  /**
   * Drain the queue: stop accepting new chunks and wait for all
   * existing chunks to be consumed. Used for clean shutdown.
   *
   * @returns Promise that resolves when the queue is empty
   */
  async drain(): Promise<void> {
    this.draining = true;

    if (this.queue.length === 0) {
      return;
    }

    return new Promise<void>((resolve) => {
      this.drainResolve = resolve;
    });
  }

  /**
   * Check if the queue is empty.
   */
  isEmpty(): boolean {
    return this.queue.length === 0;
  }

  /**
   * Get the current number of chunks in the queue.
   */
  get size(): number {
    return this.queue.length;
  }

  /**
   * Get the total bytes currently buffered (not yet dequeued).
   */
  get bufferedBytes(): number {
    return this.queue.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  }

  /**
   * Get the total bytes that have flowed through the queue.
   */
  get totalBytes(): number {
    return this.totalBytesEnqueued;
  }

  /**
   * Get the maximum buffer size.
   */
  get capacity(): number {
    return this.maxSize;
  }

  /**
   * Check if the queue is currently draining (not accepting new chunks).
   */
  get isDraining(): boolean {
    return this.draining;
  }
}

/**
 * Create an AudioChunk from raw buffer data.
 * Utility function for consistent chunk creation.
 *
 * @param data - Raw audio data
 * @param index - Chunk sequence number
 * @returns Fully formed AudioChunk
 */
export function createAudioChunk(data: Buffer, index: number): AudioChunk {
  return {
    data,
    index,
    timestamp: Date.now(),
    byteLength: data.length,
  };
}
