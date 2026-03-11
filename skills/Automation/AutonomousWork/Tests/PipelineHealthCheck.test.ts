import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { healthCheck, type HealthCheckResult } from "./PipelineHealthCheck";

// --- Helpers ---

function makeTempQueue(items: Array<{ id: string; status: string; createdAt?: string }>) {
  const dir = join(tmpdir(), `phc-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, "work-queue.json");
  writeFileSync(filePath, JSON.stringify({ items }), "utf-8");
  return { filePath, dir };
}

// --- Tests ---

describe("PipelineHealthCheck", () => {
  describe("ISC-1 & ISC-2: healthCheck() return shape", () => {
    it("returns correct shape with totalItems, byStatus, and oldestPending fields", () => {
      const { filePath, dir } = makeTempQueue([
        { id: "a", status: "pending", createdAt: "2024-01-01T00:00:00Z" },
        { id: "b", status: "completed" },
      ]);

      const result: HealthCheckResult = healthCheck(filePath);

      expect(typeof result.totalItems).toBe("number");
      expect(typeof result.byStatus).toBe("object");
      expect(result.oldestPending === null || typeof result.oldestPending === "string").toBe(true);

      rmSync(dir, { recursive: true });
    });

    it("returns totalItems equal to the number of items in the queue", () => {
      const { filePath, dir } = makeTempQueue([
        { id: "x1", status: "pending" },
        { id: "x2", status: "pending" },
        { id: "x3", status: "completed" },
      ]);

      const result = healthCheck(filePath);

      expect(result.totalItems).toBe(3);

      rmSync(dir, { recursive: true });
    });

    it("aggregates byStatus counts correctly across multiple statuses", () => {
      const { filePath, dir } = makeTempQueue([
        { id: "a", status: "pending" },
        { id: "b", status: "pending" },
        { id: "c", status: "completed" },
        { id: "d", status: "in_progress" },
      ]);

      const result = healthCheck(filePath);

      expect(result.byStatus["pending"]).toBe(2);
      expect(result.byStatus["completed"]).toBe(1);
      expect(result.byStatus["in_progress"]).toBe(1);

      rmSync(dir, { recursive: true });
    });
  });

  describe("ISC-2: oldestPending logic", () => {
    it("returns the id of the oldest pending item based on createdAt", () => {
      const { filePath, dir } = makeTempQueue([
        { id: "newer", status: "pending", createdAt: "2024-06-01T00:00:00Z" },
        { id: "oldest", status: "pending", createdAt: "2024-01-01T00:00:00Z" },
        { id: "middle", status: "pending", createdAt: "2024-03-01T00:00:00Z" },
      ]);

      const result = healthCheck(filePath);

      expect(result.oldestPending).toBe("oldest");

      rmSync(dir, { recursive: true });
    });

    it("returns null for oldestPending when there are no pending items", () => {
      const { filePath, dir } = makeTempQueue([
        { id: "a", status: "completed" },
        { id: "b", status: "completed" },
      ]);

      const result = healthCheck(filePath);

      expect(result.oldestPending).toBeNull();

      rmSync(dir, { recursive: true });
    });

    it("returns null for oldestPending when the queue is empty", () => {
      const { filePath, dir } = makeTempQueue([]);

      const result = healthCheck(filePath);

      expect(result.totalItems).toBe(0);
      expect(result.oldestPending).toBeNull();
      expect(Object.keys(result.byStatus).length).toBe(0);

      rmSync(dir, { recursive: true });
    });
  });

  describe("ISC-4: integration with real work-queue.json", () => {
    it("healthCheck() runs against the real work-queue.json without throwing", () => {
      // Uses the default path resolution (project root MEMORY/WORK/work-queue.json)
      let result: HealthCheckResult | undefined;
      expect(() => {
        result = healthCheck();
      }).not.toThrow();

      // The real queue exists and returns a valid shape
      expect(result).toBeDefined();
      expect(typeof result!.totalItems).toBe("number");
      expect(result!.totalItems).toBeGreaterThanOrEqual(0);
    });
  });
});
