#!/usr/bin/env bun
/**
 * TeamsBridge Unit Tests
 *
 * Tests the Agent Teams abstraction layer.
 * Run: bun test TeamsBridge.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { TeamsBridge } from "./TeamsBridge.ts";
import { existsSync, rmSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const KAYA_DIR = process.env.KAYA_DIR || join(homedir(), ".claude");
const TEAMS_DIR = join(KAYA_DIR, "MEMORY", "teams");

// ============================================================================
// isAvailable Tests
// ============================================================================

describe("TeamsBridge.isAvailable", () => {
  const originalEnv = process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = originalEnv;
    } else {
      delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
    }
  });

  test("returns true when env is '1'", () => {
    process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1";
    expect(TeamsBridge.isAvailable()).toBe(true);
  });

  test("returns true when env is 'true'", () => {
    process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "true";
    expect(TeamsBridge.isAvailable()).toBe(true);
  });

  test("returns false when env is not set", () => {
    delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
    expect(TeamsBridge.isAvailable()).toBe(false);
  });

  test("returns false when env is '0'", () => {
    process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "0";
    expect(TeamsBridge.isAvailable()).toBe(false);
  });

  test("returns false when env is 'false'", () => {
    process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "false";
    expect(TeamsBridge.isAvailable()).toBe(false);
  });
});

// ============================================================================
// create Tests
// ============================================================================

describe("TeamsBridge.create", () => {
  const originalEnv = process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = originalEnv;
    } else {
      delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
    }
  });

  test("returns null when Agent Teams unavailable", async () => {
    delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
    const team = await TeamsBridge.create({ teamName: "test-team" });
    expect(team).toBeNull();
  });

  test("creates team when available", async () => {
    process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1";
    const team = await TeamsBridge.create({ teamName: "test-team" });

    expect(team).not.toBeNull();
    expect(team!.teamName).toBe("test-team");
    expect(team!.teamId).toMatch(/^team_\d+_/);
    expect(existsSync(team!.teamDir)).toBe(true);

    // Verify directory structure
    expect(existsSync(join(team!.teamDir, "manifest.json"))).toBe(true);
    expect(existsSync(join(team!.teamDir, "inboxes"))).toBe(true);
    expect(existsSync(join(team!.teamDir, "tasks"))).toBe(true);
    expect(existsSync(join(team!.teamDir, "results"))).toBe(true);
    expect(existsSync(join(team!.teamDir, "tasks", "queue.json"))).toBe(true);

    // Verify manifest
    const manifest = JSON.parse(readFileSync(join(team!.teamDir, "manifest.json"), "utf-8"));
    expect(manifest.teamName).toBe("test-team");
    expect(manifest.displayMode).toBe("in_process");
    expect(manifest.delegateMode).toBe(true);
    expect(manifest.autoCleanup).toBe(true);

    // Cleanup
    rmSync(team!.teamDir, { recursive: true, force: true });
  });

  test("applies custom config", async () => {
    process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1";
    const team = await TeamsBridge.create({
      teamName: "custom-team",
      displayMode: "background",
      delegateMode: false,
      autoCleanup: false,
      defaultModel: "haiku",
      defaultTimeoutMs: 60000,
    });

    expect(team).not.toBeNull();

    const manifest = JSON.parse(readFileSync(join(team!.teamDir, "manifest.json"), "utf-8"));
    expect(manifest.displayMode).toBe("background");
    expect(manifest.delegateMode).toBe(false);
    expect(manifest.autoCleanup).toBe(false);
    expect(manifest.defaultModel).toBe("haiku");
    expect(manifest.defaultTimeoutMs).toBe(60000);

    // Cleanup
    rmSync(team!.teamDir, { recursive: true, force: true });
  });
});

// ============================================================================
// Shared Tasks Tests
// ============================================================================

describe("Team shared tasks", () => {
  const originalEnv = process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
  let team: Awaited<ReturnType<typeof TeamsBridge.create>>;

  beforeEach(async () => {
    process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1";
    team = await TeamsBridge.create({ teamName: "task-test-team" });
  });

  afterEach(async () => {
    if (team) {
      rmSync(team.teamDir, { recursive: true, force: true });
    }
    if (originalEnv !== undefined) {
      process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = originalEnv;
    } else {
      delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
    }
  });

  test("creates shared task", async () => {
    const task = await team!.createSharedTask("Test task", "Do something");
    expect(task.id).toMatch(/^task_/);
    expect(task.title).toBe("Test task");
    expect(task.description).toBe("Do something");
    expect(task.status).toBe("pending");
    expect(task.createdBy).toBe("lead");
  });

  test("lists shared tasks", async () => {
    await team!.createSharedTask("Task 1", "First");
    await team!.createSharedTask("Task 2", "Second");

    const tasks = team!.getSharedTasks();
    expect(tasks.length).toBe(2);
    expect(tasks[0].title).toBe("Task 1");
    expect(tasks[1].title).toBe("Task 2");
  });

  test("updates shared task", async () => {
    const task = await team!.createSharedTask("Update me", "Test");

    await team!.updateSharedTask(task.id, {
      status: "in_progress",
      assignedTo: "worker-1",
    });

    const tasks = team!.getSharedTasks();
    const updated = tasks.find((t) => t.id === task.id);
    expect(updated!.status).toBe("in_progress");
    expect(updated!.assignedTo).toBe("worker-1");
  });

  test("completes shared task with result", async () => {
    const task = await team!.createSharedTask("Complete me", "Test");

    await team!.updateSharedTask(task.id, {
      status: "completed",
      result: "All done!",
    });

    const tasks = team!.getSharedTasks();
    const completed = tasks.find((t) => t.id === task.id);
    expect(completed!.status).toBe("completed");
    expect(completed!.result).toBe("All done!");
  });
});

// ============================================================================
// Messaging Tests
// ============================================================================

describe("Team messaging", () => {
  const originalEnv = process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
  let team: Awaited<ReturnType<typeof TeamsBridge.create>>;

  beforeEach(async () => {
    process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1";
    team = await TeamsBridge.create({ teamName: "msg-test-team" });
    // Create member inboxes manually (normally done by spawn)
    const manifest = JSON.parse(readFileSync(join(team!.teamDir, "manifest.json"), "utf-8"));
    manifest.members = ["worker-1", "worker-2"];
    const { writeFileSync: ws } = await import("fs");
    ws(join(team!.teamDir, "manifest.json"), JSON.stringify(manifest, null, 2));
    mkdirSync(join(team!.teamDir, "inboxes", "worker-1"), { recursive: true });
    mkdirSync(join(team!.teamDir, "inboxes", "worker-2"), { recursive: true });
    ws(join(team!.teamDir, "inboxes", "worker-1", "messages.json"), "[]");
    ws(join(team!.teamDir, "inboxes", "worker-2", "messages.json"), "[]");
  });

  afterEach(async () => {
    if (team) {
      rmSync(team.teamDir, { recursive: true, force: true });
    }
    if (originalEnv !== undefined) {
      process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = originalEnv;
    } else {
      delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
    }
  });

  test("sends message to specific member", async () => {
    await team!.send("worker-1", "Hello worker 1!");

    const messages = TeamsBridge.getInboxMessages(team!.teamId, "worker-1");
    expect(messages.length).toBe(1);
    expect(messages[0].from).toBe("lead");
    expect(messages[0].to).toBe("worker-1");
    expect(messages[0].content).toBe("Hello worker 1!");

    // Verify worker-2 didn't get the message
    const w2Messages = TeamsBridge.getInboxMessages(team!.teamId, "worker-2");
    expect(w2Messages.length).toBe(0);
  });

  test("broadcasts to all members", async () => {
    await team!.broadcast("Attention everyone!");

    const w1 = TeamsBridge.getInboxMessages(team!.teamId, "worker-1");
    const w2 = TeamsBridge.getInboxMessages(team!.teamId, "worker-2");

    expect(w1.length).toBe(1);
    expect(w2.length).toBe(1);
    expect(w1[0].content).toBe("Attention everyone!");
    expect(w1[0].to).toBe("all");
    expect(w2[0].content).toBe("Attention everyone!");
  });

  test("throws on send to unknown member", async () => {
    await expect(team!.send("nonexistent", "Hello")).rejects.toThrow("not found");
  });
});

// ============================================================================
// listTeams / getTeam Tests
// ============================================================================

describe("TeamsBridge inspection", () => {
  const originalEnv = process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
  let team: Awaited<ReturnType<typeof TeamsBridge.create>>;

  beforeEach(async () => {
    process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1";
    team = await TeamsBridge.create({ teamName: "inspect-test" });
  });

  afterEach(async () => {
    if (team) {
      rmSync(team.teamDir, { recursive: true, force: true });
    }
    if (originalEnv !== undefined) {
      process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = originalEnv;
    } else {
      delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
    }
  });

  test("lists teams", () => {
    const teams = TeamsBridge.listTeams();
    const found = teams.find((t) => t.teamId === team!.teamId);
    expect(found).not.toBeUndefined();
    expect(found!.teamName).toBe("inspect-test");
  });

  test("gets team by ID", () => {
    const result = TeamsBridge.getTeam(team!.teamId);
    expect(result).not.toBeNull();
    expect(result!.manifest.teamName).toBe("inspect-test");
  });

  test("returns null for unknown team", () => {
    const result = TeamsBridge.getTeam("nonexistent");
    expect(result).toBeNull();
  });

  test("getInboxMessages returns empty for unknown", () => {
    const messages = TeamsBridge.getInboxMessages("fake", "fake");
    expect(messages).toEqual([]);
  });
});

// ============================================================================
// Cleanup Tests
// ============================================================================

describe("Team cleanup", () => {
  const originalEnv = process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = originalEnv;
    } else {
      delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
    }
  });

  test("cleanup writes summary", async () => {
    process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1";
    const team = await TeamsBridge.create({ teamName: "cleanup-test" });
    expect(team).not.toBeNull();

    await team!.cleanup();

    const summaryPath = join(team!.teamDir, "summary.json");
    expect(existsSync(summaryPath)).toBe(true);

    const summary = JSON.parse(readFileSync(summaryPath, "utf-8"));
    expect(summary.teamId).toBe(team!.teamId);
    expect(summary.teamName).toBe("cleanup-test");
    expect(summary.completedAt).toBeDefined();

    // Cleanup
    rmSync(team!.teamDir, { recursive: true, force: true });
  });
});
