#!/usr/bin/env bun
/**
 * ApprovalQueue.test.ts - Tests for generic approval queue
 *
 * Following TDD: Tests written FIRST, then implementation.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";

// Tests for the module we're about to build
const TEST_DIR = join(process.cwd(), ".test-approval-queue");

describe("ApprovalQueue", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  describe("MemoryApprovalQueue", () => {
    test("should add item and return ID", async () => {
      const { MemoryApprovalQueue } = await import("./ApprovalQueue.ts");
      const queue = new MemoryApprovalQueue<{ title: string }>();

      const id = await queue.add({ title: "Test item" });

      expect(id).toBeDefined();
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);
    });

    test("should retrieve item by ID", async () => {
      const { MemoryApprovalQueue } = await import("./ApprovalQueue.ts");
      const queue = new MemoryApprovalQueue<{ title: string }>();

      const id = await queue.add({ title: "Test item" });
      const item = await queue.get(id);

      expect(item).toBeDefined();
      expect(item?.title).toBe("Test item");
      expect(item?.status).toBe("pending");
      expect(item?.priority).toBe("normal");
    });

    test("should return null for non-existent ID", async () => {
      const { MemoryApprovalQueue } = await import("./ApprovalQueue.ts");
      const queue = new MemoryApprovalQueue<{ title: string }>();

      const item = await queue.get("non-existent-id");

      expect(item).toBeNull();
    });

    test("should list all pending items", async () => {
      const { MemoryApprovalQueue } = await import("./ApprovalQueue.ts");
      const queue = new MemoryApprovalQueue<{ title: string }>();

      await queue.add({ title: "Item 1" });
      await queue.add({ title: "Item 2" });
      await queue.add({ title: "Item 3" });

      const items = await queue.list({ status: "pending" });

      expect(items.length).toBe(3);
    });

    test("should filter items by status", async () => {
      const { MemoryApprovalQueue } = await import("./ApprovalQueue.ts");
      const queue = new MemoryApprovalQueue<{ title: string }>();

      const id1 = await queue.add({ title: "Item 1" });
      const id2 = await queue.add({ title: "Item 2" });
      await queue.add({ title: "Item 3" });

      await queue.approve(id1);
      await queue.reject(id2);

      const pending = await queue.list({ status: "pending" });
      const approved = await queue.list({ status: "approved" });
      const rejected = await queue.list({ status: "rejected" });

      expect(pending.length).toBe(1);
      expect(approved.length).toBe(1);
      expect(rejected.length).toBe(1);
    });

    test("should filter items by priority", async () => {
      const { MemoryApprovalQueue } = await import("./ApprovalQueue.ts");
      const queue = new MemoryApprovalQueue<{ title: string }>();

      await queue.add({ title: "Normal" });
      await queue.add({ title: "High" }, { priority: "high" });
      await queue.add({ title: "Critical" }, { priority: "critical" });

      const highPriority = await queue.list({ priority: "high" });
      const criticalPriority = await queue.list({ priority: "critical" });

      expect(highPriority.length).toBe(1);
      expect(criticalPriority.length).toBe(1);
    });

    test("should approve item with notes and reviewer", async () => {
      const { MemoryApprovalQueue } = await import("./ApprovalQueue.ts");
      const queue = new MemoryApprovalQueue<{ title: string }>();

      const id = await queue.add({ title: "Test item" });
      const approved = await queue.approve(id, "Looks good!", "daniel");

      expect(approved.status).toBe("approved");
      expect(approved.reviewNotes).toBe("Looks good!");
      expect(approved.reviewedBy).toBe("daniel");
      expect(approved.reviewedAt).toBeDefined();
    });

    test("should reject item with reason", async () => {
      const { MemoryApprovalQueue } = await import("./ApprovalQueue.ts");
      const queue = new MemoryApprovalQueue<{ title: string }>();

      const id = await queue.add({ title: "Test item" });
      const rejected = await queue.reject(id, "Not ready", "daniel");

      expect(rejected.status).toBe("rejected");
      expect(rejected.reviewNotes).toBe("Not ready");
      expect(rejected.reviewedBy).toBe("daniel");
    });

    test("should throw when approving non-existent item", async () => {
      const { MemoryApprovalQueue } = await import("./ApprovalQueue.ts");
      const queue = new MemoryApprovalQueue<{ title: string }>();

      expect(queue.approve("non-existent")).rejects.toThrow();
    });

    test("should throw when approving already approved item", async () => {
      const { MemoryApprovalQueue } = await import("./ApprovalQueue.ts");
      const queue = new MemoryApprovalQueue<{ title: string }>();

      const id = await queue.add({ title: "Test item" });
      await queue.approve(id);

      expect(queue.approve(id)).rejects.toThrow();
    });

    test("should batch approve multiple items", async () => {
      const { MemoryApprovalQueue } = await import("./ApprovalQueue.ts");
      const queue = new MemoryApprovalQueue<{ title: string }>();

      const id1 = await queue.add({ title: "Item 1" });
      const id2 = await queue.add({ title: "Item 2" });
      const id3 = await queue.add({ title: "Item 3" });

      const approved = await queue.batchApprove([id1, id2, id3], "Batch approved");

      expect(approved.length).toBe(3);
      expect(approved.every((i) => i.status === "approved")).toBe(true);
    });

    test("should batch reject multiple items", async () => {
      const { MemoryApprovalQueue } = await import("./ApprovalQueue.ts");
      const queue = new MemoryApprovalQueue<{ title: string }>();

      const id1 = await queue.add({ title: "Item 1" });
      const id2 = await queue.add({ title: "Item 2" });

      const rejected = await queue.batchReject([id1, id2], "Batch rejected");

      expect(rejected.length).toBe(2);
      expect(rejected.every((i) => i.status === "rejected")).toBe(true);
    });

    test("should get accurate statistics", async () => {
      const { MemoryApprovalQueue } = await import("./ApprovalQueue.ts");
      const queue = new MemoryApprovalQueue<{ title: string }>();

      const id1 = await queue.add({ title: "Item 1" });
      const id2 = await queue.add({ title: "Item 2" }, { priority: "high" });
      const id3 = await queue.add({ title: "Item 3" }, { priority: "critical" });
      await queue.add({ title: "Item 4" });

      await queue.approve(id1);
      await queue.reject(id2);

      const stats = await queue.getStats();

      expect(stats.pending).toBe(2);
      expect(stats.approved).toBe(1);
      expect(stats.rejected).toBe(1);
      expect(stats.byPriority.normal).toBe(2);
      expect(stats.byPriority.high).toBe(1);
      expect(stats.byPriority.critical).toBe(1);
    });

    test("should order items by priority", async () => {
      const { MemoryApprovalQueue } = await import("./ApprovalQueue.ts");
      const queue = new MemoryApprovalQueue<{ title: string }>();

      await queue.add({ title: "Normal" }, { priority: "normal" });
      await queue.add({ title: "Critical" }, { priority: "critical" });
      await queue.add({ title: "Low" }, { priority: "low" });
      await queue.add({ title: "High" }, { priority: "high" });

      const items = await queue.list({ status: "pending" });

      // Should be ordered: critical, high, normal, low
      expect(items[0].priority).toBe("critical");
      expect(items[1].priority).toBe("high");
      expect(items[2].priority).toBe("normal");
      expect(items[3].priority).toBe("low");
    });
  });

  describe("FileApprovalQueue", () => {
    test("should persist items to file", async () => {
      const { FileApprovalQueue } = await import("./ApprovalQueue.ts");
      const storagePath = join(TEST_DIR, "queue-state.json");
      const queue = new FileApprovalQueue<{ title: string }>(storagePath);

      await queue.add({ title: "Persisted item" });

      // Create new instance pointing to same file
      const queue2 = new FileApprovalQueue<{ title: string }>(storagePath);
      const items = await queue2.list();

      expect(items.length).toBe(1);
      expect(items[0].title).toBe("Persisted item");
    });

    test("should handle concurrent adds", async () => {
      const { FileApprovalQueue } = await import("./ApprovalQueue.ts");
      const storagePath = join(TEST_DIR, "concurrent-queue.json");
      const queue = new FileApprovalQueue<{ title: string }>(storagePath);

      // Add multiple items concurrently
      const promises = Array.from({ length: 10 }, (_, i) =>
        queue.add({ title: `Item ${i}` })
      );

      const ids = await Promise.all(promises);

      expect(ids.length).toBe(10);
      expect(new Set(ids).size).toBe(10); // All unique IDs

      const items = await queue.list();
      expect(items.length).toBe(10);
    });
  });

  describe("Notification Hooks", () => {
    test("should call onAdd hook when item added", async () => {
      const { MemoryApprovalQueue } = await import("./ApprovalQueue.ts");
      let called = false;
      let addedItem: any = null;

      const queue = new MemoryApprovalQueue<{ title: string }>({
        onAdd: (item) => {
          called = true;
          addedItem = item;
        },
      });

      await queue.add({ title: "Test" });

      expect(called).toBe(true);
      expect(addedItem?.title).toBe("Test");
    });

    test("should call onApprove hook when item approved", async () => {
      const { MemoryApprovalQueue } = await import("./ApprovalQueue.ts");
      let called = false;

      const queue = new MemoryApprovalQueue<{ title: string }>({
        onApprove: () => {
          called = true;
        },
      });

      const id = await queue.add({ title: "Test" });
      await queue.approve(id);

      expect(called).toBe(true);
    });

    test("should call onReject hook when item rejected", async () => {
      const { MemoryApprovalQueue } = await import("./ApprovalQueue.ts");
      let called = false;

      const queue = new MemoryApprovalQueue<{ title: string }>({
        onReject: () => {
          called = true;
        },
      });

      const id = await queue.add({ title: "Test" });
      await queue.reject(id);

      expect(called).toBe(true);
    });
  });

  describe("Expiry", () => {
    test("should set expiry based on defaultExpiry option", async () => {
      const { MemoryApprovalQueue } = await import("./ApprovalQueue.ts");
      const queue = new MemoryApprovalQueue<{ title: string }>({
        defaultExpiry: 7,
      });

      const id = await queue.add({ title: "Test" });
      const item = await queue.get(id);

      expect(item?.expiresAt).toBeDefined();
      const expiryDate = new Date(item!.expiresAt!);
      const now = new Date();
      const daysDiff = Math.round(
        (expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
      );
      expect(daysDiff).toBeGreaterThanOrEqual(6); // Allow some variance
      expect(daysDiff).toBeLessThanOrEqual(8);
    });

    test("should override expiry per-item", async () => {
      const { MemoryApprovalQueue } = await import("./ApprovalQueue.ts");
      const queue = new MemoryApprovalQueue<{ title: string }>({
        defaultExpiry: 7,
      });

      const id = await queue.add({ title: "Test" }, { expiryDays: 30 });
      const item = await queue.get(id);

      const expiryDate = new Date(item!.expiresAt!);
      const now = new Date();
      const daysDiff = Math.round(
        (expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
      );
      expect(daysDiff).toBeGreaterThanOrEqual(29);
      expect(daysDiff).toBeLessThanOrEqual(31);
    });

    test("should cleanup expired items", async () => {
      const { MemoryApprovalQueue } = await import("./ApprovalQueue.ts");
      const queue = new MemoryApprovalQueue<{ title: string }>({
        defaultExpiry: 0, // Expire immediately for testing
      });

      await queue.add({ title: "Expires immediately" });
      await queue.add({ title: "Also expires" });

      // Wait a tiny bit for expiry
      await new Promise((resolve) => setTimeout(resolve, 10));

      const result = await queue.cleanup();

      expect(result.expired).toBe(2);
    });
  });

  describe("Schema Validation", () => {
    test("should validate items against schema if provided", async () => {
      const { z } = await import("zod");
      const { MemoryApprovalQueue } = await import("./ApprovalQueue.ts");

      const schema = z.object({
        title: z.string().min(1),
        priority: z.enum(["low", "medium", "high"]),
      });

      const queue = new MemoryApprovalQueue<z.infer<typeof schema>>({
        schema,
      });

      // Valid item should work
      await expect(
        queue.add({ title: "Valid", priority: "high" })
      ).resolves.toBeDefined();

      // Invalid item should throw
      await expect(
        queue.add({ title: "", priority: "invalid" as any })
      ).rejects.toThrow();
    });
  });

  describe("Factory Function", () => {
    test("should create memory queue", async () => {
      const { createApprovalQueue } = await import("./ApprovalQueue.ts");

      const queue = createApprovalQueue<{ title: string }>("memory");

      const id = await queue.add({ title: "Test" });
      expect(id).toBeDefined();
    });

    test("should create file queue with path", async () => {
      const { createApprovalQueue } = await import("./ApprovalQueue.ts");
      const storagePath = join(TEST_DIR, "factory-queue.json");

      const queue = createApprovalQueue<{ title: string }>("file", storagePath);

      const id = await queue.add({ title: "Test" });
      expect(id).toBeDefined();
      expect(existsSync(storagePath)).toBe(true);
    });
  });
});
