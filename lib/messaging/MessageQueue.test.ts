#!/usr/bin/env bun
/**
 * ============================================================================
 * MessageQueue Tests
 * ============================================================================
 *
 * Following TDD - these tests are written FIRST and will FAIL initially.
 * The implementation will be written to make these tests pass.
 */

import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { existsSync, unlinkSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  MessageQueue,
  createMessageQueue,
  enqueue,
  process as processQueue,
  getQueueStatus,
  type Message,
  type MessageChannel,
  type MessagePriority,
} from './MessageQueue';

const TEST_QUEUE_PATH = join(homedir(), '.claude', 'MEMORY', 'daemon', 'message-queue-test.json');
const DEFAULT_QUEUE_PATH = join(homedir(), '.claude', 'MEMORY', 'daemon', 'message-queue.json');

describe('MessageQueue', () => {
  beforeEach(() => {
    // Clean up test queue file before each test
    if (existsSync(TEST_QUEUE_PATH)) {
      unlinkSync(TEST_QUEUE_PATH);
    }
    // Also clean up default queue for singleton tests
    if (existsSync(DEFAULT_QUEUE_PATH)) {
      unlinkSync(DEFAULT_QUEUE_PATH);
    }
  });

  afterEach(() => {
    // Clean up test queue file after each test
    if (existsSync(TEST_QUEUE_PATH)) {
      unlinkSync(TEST_QUEUE_PATH);
    }
    // Also clean up default queue for singleton tests
    if (existsSync(DEFAULT_QUEUE_PATH)) {
      unlinkSync(DEFAULT_QUEUE_PATH);
    }
  });

  describe('enqueue', () => {
    test('should add message to queue and return message ID', () => {
      const queue = createMessageQueue({ queuePath: TEST_QUEUE_PATH });

      const messageId = queue.enqueue({
        content: 'Test notification',
        channel: 'voice',
        priority: 'normal',
      });

      expect(messageId).toBeTypeOf('string');
      expect(messageId).toMatch(/^msg_/);
    });

    test('should handle all channel types', () => {
      const queue = createMessageQueue({ queuePath: TEST_QUEUE_PATH });

      const channels: MessageChannel[] = ['voice', 'push', 'email', 'discord'];

      channels.forEach(channel => {
        const id = queue.enqueue({
          content: `Test ${channel}`,
          channel,
          priority: 'normal',
        });
        expect(id).toBeTypeOf('string');
      });
    });

    test('should handle all priority levels', () => {
      const queue = createMessageQueue({ queuePath: TEST_QUEUE_PATH });

      const priorities: MessagePriority[] = ['low', 'normal', 'high', 'critical'];

      priorities.forEach(priority => {
        const id = queue.enqueue({
          content: `Test ${priority}`,
          channel: 'voice',
          priority,
        });
        expect(id).toBeTypeOf('string');
      });
    });

    test('should support scheduled messages', () => {
      const queue = createMessageQueue({ queuePath: TEST_QUEUE_PATH });

      const scheduledFor = new Date(Date.now() + 60000); // 1 minute from now

      const id = queue.enqueue({
        content: 'Scheduled message',
        channel: 'voice',
        priority: 'normal',
        scheduledFor,
      });

      expect(id).toBeTypeOf('string');
    });

    test('should persist queue to disk', () => {
      const queue = createMessageQueue({ queuePath: TEST_QUEUE_PATH });

      queue.enqueue({
        content: 'Persisted message',
        channel: 'voice',
        priority: 'normal',
      });

      expect(existsSync(TEST_QUEUE_PATH)).toBe(true);
    });
  });

  describe('process', () => {
    test('should process pending messages', async () => {
      const queue = createMessageQueue({
        queuePath: TEST_QUEUE_PATH,
        onProcess: () => Promise.resolve(true), // Mock successful processing
      });

      queue.enqueue({
        content: 'Message 1',
        channel: 'voice',
        priority: 'normal',
      });

      queue.enqueue({
        content: 'Message 2',
        channel: 'voice',
        priority: 'high',
      });

      await queue.process();

      const status = queue.getQueueStatus();
      expect(status.pending).toBe(0);
      expect(status.processed).toBeGreaterThan(0);
    });

    test('should process messages in priority order', async () => {
      const queue = createMessageQueue({ queuePath: TEST_QUEUE_PATH });

      const processedMessages: string[] = [];

      // Mock the notification service to track order
      const mockQueue = createMessageQueue({
        queuePath: TEST_QUEUE_PATH,
        onProcess: (message) => {
          processedMessages.push(message.content);
          return Promise.resolve(true);
        },
      });

      mockQueue.enqueue({
        content: 'Low priority',
        channel: 'voice',
        priority: 'low',
      });

      mockQueue.enqueue({
        content: 'Critical priority',
        channel: 'voice',
        priority: 'critical',
      });

      mockQueue.enqueue({
        content: 'Normal priority',
        channel: 'voice',
        priority: 'normal',
      });

      await mockQueue.process();

      // Critical should be first
      expect(processedMessages[0]).toBe('Critical priority');
    });

    test('should not process scheduled messages before their time', async () => {
      const queue = createMessageQueue({ queuePath: TEST_QUEUE_PATH });

      const futureTime = new Date(Date.now() + 60000); // 1 minute from now

      queue.enqueue({
        content: 'Future message',
        channel: 'voice',
        priority: 'normal',
        scheduledFor: futureTime,
      });

      await queue.process();

      const status = queue.getQueueStatus();
      expect(status.pending).toBe(1);
      expect(status.processed).toBe(0);
    });

    test('should retry failed messages with exponential backoff', async () => {
      let attemptCount = 0;

      const queue = createMessageQueue({
        queuePath: TEST_QUEUE_PATH,
        maxRetries: 3,
        onProcess: () => {
          attemptCount++;
          // Fail first 2 attempts, succeed on 3rd
          return Promise.resolve(attemptCount >= 3);
        },
      });

      queue.enqueue({
        content: 'Flaky message',
        channel: 'voice',
        priority: 'normal',
      });

      await queue.process();

      expect(attemptCount).toBe(3);
    });

    test('should mark message as failed after max retries', async () => {
      const queue = createMessageQueue({
        queuePath: TEST_QUEUE_PATH,
        maxRetries: 2,
        onProcess: () => Promise.resolve(false), // Always fail
      });

      queue.enqueue({
        content: 'Failing message',
        channel: 'voice',
        priority: 'normal',
      });

      await queue.process();

      const status = queue.getQueueStatus();
      expect(status.failed).toBe(1);
    });
  });

  describe('deduplication', () => {
    test('should prevent duplicate messages within time window', () => {
      const queue = createMessageQueue({
        queuePath: TEST_QUEUE_PATH,
        deduplicationWindowMs: 5000,
      });

      const id1 = queue.enqueue({
        content: 'Same message',
        channel: 'voice',
        priority: 'normal',
      });

      const id2 = queue.enqueue({
        content: 'Same message',
        channel: 'voice',
        priority: 'normal',
      });

      expect(id1).toBe(id2);

      const status = queue.getQueueStatus();
      expect(status.pending).toBe(1);
    });

    test('should allow duplicate messages after time window', async () => {
      const queue = createMessageQueue({
        queuePath: TEST_QUEUE_PATH,
        deduplicationWindowMs: 100, // 100ms window
      });

      const id1 = queue.enqueue({
        content: 'Same message',
        channel: 'voice',
        priority: 'normal',
      });

      // Wait for deduplication window to expire
      await new Promise(resolve => setTimeout(resolve, 150));

      const id2 = queue.enqueue({
        content: 'Same message',
        channel: 'voice',
        priority: 'normal',
      });

      expect(id1).not.toBe(id2);
    });
  });

  describe('rate limiting', () => {
    test('should enforce rate limits per channel', async () => {
      const queue = createMessageQueue({
        queuePath: TEST_QUEUE_PATH,
        rateLimits: {
          voice: { maxPerMinute: 2 },
        },
        onProcess: () => Promise.resolve(true), // Mock successful processing
      });

      // Enqueue 3 messages
      queue.enqueue({ content: 'Msg 1', channel: 'voice', priority: 'normal' });
      queue.enqueue({ content: 'Msg 2', channel: 'voice', priority: 'normal' });
      queue.enqueue({ content: 'Msg 3', channel: 'voice', priority: 'normal' });

      await queue.process();

      const status = queue.getQueueStatus();
      // Only 2 should be processed, 1 should remain pending
      expect(status.pending).toBe(1);
      expect(status.processed).toBeLessThanOrEqual(2);
    });
  });

  describe('user preferences', () => {
    test('should respect quiet hours', async () => {
      // Mock current time to be in quiet hours
      const now = new Date();
      const quietStart = now.getHours();
      const quietEnd = (now.getHours() + 1) % 24;

      const queue = createMessageQueue({
        queuePath: TEST_QUEUE_PATH,
        userPreferences: {
          quietHours: {
            enabled: true,
            start: quietStart,
            end: quietEnd,
          },
        },
      });

      queue.enqueue({
        content: 'Message during quiet hours',
        channel: 'voice',
        priority: 'normal',
      });

      await queue.process();

      const status = queue.getQueueStatus();
      // Message should remain pending during quiet hours
      expect(status.pending).toBe(1);
    });

    test('should allow critical messages during quiet hours', async () => {
      const now = new Date();
      const quietStart = now.getHours();
      const quietEnd = (now.getHours() + 1) % 24;

      const queue = createMessageQueue({
        queuePath: TEST_QUEUE_PATH,
        userPreferences: {
          quietHours: {
            enabled: true,
            start: quietStart,
            end: quietEnd,
          },
        },
      });

      queue.enqueue({
        content: 'Critical message',
        channel: 'voice',
        priority: 'critical',
      });

      await queue.process();

      const status = queue.getQueueStatus();
      // Critical messages should process even during quiet hours
      expect(status.processed).toBe(1);
    });

    test('should respect disabled channels', () => {
      const queue = createMessageQueue({
        queuePath: TEST_QUEUE_PATH,
        userPreferences: {
          disabledChannels: ['email'],
        },
      });

      expect(() => {
        queue.enqueue({
          content: 'Email message',
          channel: 'email',
          priority: 'normal',
        });
      }).toThrow();
    });
  });

  describe('getQueueStatus', () => {
    test('should return accurate queue statistics', () => {
      const queue = createMessageQueue({ queuePath: TEST_QUEUE_PATH });

      queue.enqueue({ content: 'Msg 1', channel: 'voice', priority: 'normal' });
      queue.enqueue({ content: 'Msg 2', channel: 'voice', priority: 'high' });

      const status = queue.getQueueStatus();

      expect(status.pending).toBe(2);
      expect(status.failed).toBe(0);
      expect(status.processed).toBe(0);
    });
  });

  describe('persistence', () => {
    test('should load existing queue from disk', () => {
      const queue1 = createMessageQueue({ queuePath: TEST_QUEUE_PATH });

      queue1.enqueue({ content: 'Persisted', channel: 'voice', priority: 'normal' });

      // Create new instance - should load from disk
      const queue2 = createMessageQueue({ queuePath: TEST_QUEUE_PATH });

      const status = queue2.getQueueStatus();
      expect(status.pending).toBe(1);
    });

    test('should handle corrupted queue file gracefully', () => {
      // Write invalid JSON to queue file
      const fs = require('fs');
      const path = require('path');
      const dir = path.dirname(TEST_QUEUE_PATH);
      if (!existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(TEST_QUEUE_PATH, 'invalid json');

      // Should not throw, should start fresh
      expect(() => {
        createMessageQueue({ queuePath: TEST_QUEUE_PATH });
      }).not.toThrow();
    });
  });

  describe('singleton exports', () => {
    test('should provide all singleton functions', async () => {
      // Test enqueue
      const id = enqueue({
        content: 'Singleton test',
        channel: 'voice',
        priority: 'normal',
      });
      expect(id).toBeTypeOf('string');

      // Test getQueueStatus
      let status = getQueueStatus();
      expect(status).toHaveProperty('pending');
      expect(status).toHaveProperty('failed');
      expect(status).toHaveProperty('processed');
      expect(status.pending).toBeGreaterThan(0);

      // Note: We don't test processQueue() with real messages because
      // it would attempt to use the actual NotificationService.
      // The function exists and is callable, but we can't test it
      // without mocking the NotificationService, which isn't possible
      // with the singleton pattern. Individual process tests above
      // cover the functionality with mocked handlers.
    });
  });
});
