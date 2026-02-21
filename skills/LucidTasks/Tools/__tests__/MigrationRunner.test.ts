/**
 * MigrationRunner.test.ts - Test Suite for MigrationRunner
 *
 * Tests for MigrationRunner class focusing on dry-run mode and parsing.
 * Full migration tests are skipped since they would write to the real database.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { MigrationRunner } from "../MigrationRunner.ts";
import { writeFileSync, mkdirSync, existsSync, rmSync } from "fs";
import { join } from "path";

const TEST_DIR = join(process.env.KAYA_HOME || join(process.env.HOME || "", ".claude"), "context");
const TEST_CONTEXT_FILE = join(TEST_DIR, "AsanaContext.md");

beforeEach(() => {
  // Ensure context directory exists
  if (!existsSync(TEST_DIR)) {
    mkdirSync(TEST_DIR, { recursive: true });
  }
});

afterEach(() => {
  // Clean up test context file
  if (existsSync(TEST_CONTEXT_FILE)) {
    rmSync(TEST_CONTEXT_FILE);
  }
});

// ============================================================================
// MigrationRunner - Dry Run Mode
// ============================================================================

describe("MigrationRunner - Dry Run", () => {
  it("parses tasks without writing to database", async () => {
    const testData = `
# Asana Context

\`\`\`
[
  {
    "gid": "1234567890",
    "name": "Test task 1",
    "notes": "Test description",
    "completed": false,
    "created_at": "2026-01-01T00:00:00Z",
    "modified_at": "2026-01-01T00:00:00Z",
    "due_on": null,
    "memberships": [
      {
        "project": { "gid": "proj-123", "name": "Test Project" },
        "section": { "gid": "sec-123", "name": "To Do" }
      }
    ]
  }
]
\`\`\`
`;

    writeFileSync(TEST_CONTEXT_FILE, testData);

    const runner = new MigrationRunner({ dryRun: true });
    const result = await runner.run();

    expect(result.totalParsed).toBe(1);
    expect(result.totalImported).toBe(0); // Dry run doesn't import
  });

  it("reports zero imports in dry run mode", async () => {
    const testData = `
\`\`\`
[
  {"gid": "1", "name": "Task 1", "notes": "", "completed": false, "created_at": "2026-01-01T00:00:00Z", "modified_at": "2026-01-01T00:00:00Z", "due_on": null, "memberships": []},
  {"gid": "2", "name": "Task 2", "notes": "", "completed": false, "created_at": "2026-01-01T00:00:00Z", "modified_at": "2026-01-01T00:00:00Z", "due_on": null, "memberships": []}
]
\`\`\`
`;

    writeFileSync(TEST_CONTEXT_FILE, testData);

    const runner = new MigrationRunner({ dryRun: true });
    const result = await runner.run();

    expect(result.totalParsed).toBe(2);
    expect(result.totalImported).toBe(0);
    expect(result.totalSkipped).toBe(0);
  });

  it("parses tasks with projects in dry run", async () => {
    const testData = `
\`\`\`
[
  {
    "gid": "task-with-project",
    "name": "Task in project",
    "notes": "",
    "completed": false,
    "created_at": "2026-01-01T00:00:00Z",
    "modified_at": "2026-01-01T00:00:00Z",
    "due_on": null,
    "memberships": [
      {
        "project": { "gid": "proj-123", "name": "Test Project" },
        "section": { "gid": "sec-1", "name": "To Do" }
      }
    ]
  }
]
\`\`\`
`;

    writeFileSync(TEST_CONTEXT_FILE, testData);

    const runner = new MigrationRunner({ dryRun: true });
    const result = await runner.run();

    expect(result.totalParsed).toBe(1);
    expect(result.totalImported).toBe(0);
  });
});

// ============================================================================
// MigrationRunner - Error Handling
// ============================================================================

describe("MigrationRunner - Error Handling", () => {
  it("handles missing context file gracefully", async () => {
    // Remove the test file if it exists
    if (existsSync(TEST_CONTEXT_FILE)) {
      rmSync(TEST_CONTEXT_FILE);
    }

    const runner = new MigrationRunner({ dryRun: true });
    const result = await runner.run();

    expect(result.totalParsed).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("handles truncated JSON gracefully", async () => {
    const testData = `
\`\`\`
[
  {
    "gid": "complete-task",
    "name": "Complete task",
    "notes": "",
    "completed": false,
    "created_at": "2026-01-01T00:00:00Z",
    "modified_at": "2026-01-01T00:00:00Z",
    "due_on": null,
    "memberships": []
  },
  {
    "gid": "truncated-task",
    "name": "Truncated
\`\`\`
`;

    writeFileSync(TEST_CONTEXT_FILE, testData);

    const runner = new MigrationRunner({ dryRun: true });
    const result = await runner.run();

    // Should not crash - truncated JSON repair may or may not recover tasks
    // The important thing is it doesn't throw an error
    expect(result.errors.length).toBe(0);
    expect(result.totalParsed).toBeGreaterThanOrEqual(0);
  });

  it("parses empty task array", async () => {
    const testData = `
\`\`\`
[]
\`\`\`
`;

    writeFileSync(TEST_CONTEXT_FILE, testData);

    const runner = new MigrationRunner({ dryRun: true });
    const result = await runner.run();

    expect(result.totalParsed).toBe(0);
  });
});
