/**
 * EscalationHelper.test.ts — hermetic unit tests for the lifted escalation
 * helpers (no LucidTasks import; a tiny in-memory fake implements the
 * structural EscalationTaskStore, which is itself the proof that the
 * interface stays narrow). The cross-seam integration against the REAL
 * TaskDB lives in skills/Automation/AutonomousWork/Tools/__tests__/
 * EscalationHelper.test.ts.
 */
import { describe, it, expect } from "bun:test";

import {
  NEEDS_JM_PROJECT_NAME,
  computeTriageHash,
  buildEscalationStamp,
  ensureNeedsJmProject,
  createOrReopenEscalationTask,
  type EscalationTaskStore,
} from "./EscalationHelper.ts";

interface FakeTask {
  id: string;
  title: string;
  description?: string;
  status: string;
  priority?: number;
  project_id?: string | null;
  labels?: string[];
  kaya_triage?: string;
}

function makeFakeStore() {
  const projects = new Map<string, { id: string; name: string; sort_order?: number }>();
  const tasks = new Map<string, FakeTask>();
  const updateActors: string[] = [];
  let nextProjectId = 1;

  const store: EscalationTaskStore = {
    getProjectByName(name) {
      for (const p of projects.values()) if (p.name === name) return { id: p.id };
      return null;
    },
    createProject(input) {
      const id = `proj-${nextProjectId++}`;
      projects.set(id, { id, name: input.name, sort_order: input.sort_order });
      return { id };
    },
    getTask(id) {
      return tasks.get(id) ?? null;
    },
    createTask(input) {
      const task: FakeTask = {
        id: input.id ?? `task-${tasks.size + 1}`,
        title: input.title,
        description: input.description,
        status: input.status ?? "inbox",
        priority: input.priority,
        project_id: input.project_id,
        labels: input.labels,
      };
      tasks.set(task.id, task);
      return task;
    },
    updateTask(id, updates, actor) {
      const existing = tasks.get(id);
      if (!existing) return null;
      Object.assign(existing, updates);
      if (actor) updateActors.push(actor);
      return existing;
    },
  };

  return { store, projects, tasks, updateActors };
}

describe("computeTriageHash", () => {
  it("is stable, content-sensitive, and treats undefined project as empty", () => {
    const h = computeTriageHash("Self", "Buy groceries", "weekly run");
    expect(h).toBe(computeTriageHash("Self", "Buy groceries", "weekly run"));
    expect(h).not.toBe(computeTriageHash("Self", "Buy groceries NOW", "weekly run"));
    expect(h).not.toBe(computeTriageHash("Kaya", "Buy groceries", "weekly run"));
    expect(computeTriageHash(undefined, "t", "d")).toBe(computeTriageHash("", "t", "d"));
    // 8-hex-char FNV-1a output shape
    expect(h).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("buildEscalationStamp", () => {
  it("embeds the content hash and the not-executable verdict", () => {
    const stamp = JSON.parse(buildEscalationStamp(NEEDS_JM_PROJECT_NAME, "T", "D"));
    expect(stamp.verdict).toBe("not-executable");
    expect(stamp.confidence).toBe(1);
    expect(stamp.hash).toBe(computeTriageHash(NEEDS_JM_PROJECT_NAME, "T", "D"));
  });
});

describe("ensureNeedsJmProject", () => {
  it("creates the project once with sort_order -1 and is idempotent", () => {
    const { store, projects } = makeFakeStore();
    const first = ensureNeedsJmProject(store);
    const second = ensureNeedsJmProject(store);
    expect(second).toBe(first);
    expect(projects.size).toBe(1);
    expect([...projects.values()][0]).toMatchObject({
      name: NEEDS_JM_PROJECT_NAME,
      sort_order: -1,
    });
  });
});

describe("createOrReopenEscalationTask", () => {
  it("creates manual-<itemId> with status next and a valid stamp via a 'system' update", () => {
    const { store, tasks, updateActors } = makeFakeStore();
    const projectId = ensureNeedsJmProject(store);

    const id = createOrReopenEscalationTask(store, "item-1", "Title", "Desc", projectId);
    expect(id).toBe("manual-item-1");

    const task = tasks.get(id)!;
    expect(task.status).toBe("next");
    expect(task.priority).toBe(2);
    expect(task.project_id).toBe(projectId);
    expect(task.labels).toContain("human-required");
    expect(updateActors).toEqual(["system"]);
    const stamp = JSON.parse(task.kaya_triage!);
    expect(stamp.hash).toBe(computeTriageHash(NEEDS_JM_PROJECT_NAME, "Title", "Desc"));
  });

  it("folds a repeat escalation into the existing open task and re-stamps over the appended content", () => {
    const { store, tasks } = makeFakeStore();
    const projectId = ensureNeedsJmProject(store);

    createOrReopenEscalationTask(store, "item-2", "Title", "Attempt 1", projectId);
    createOrReopenEscalationTask(store, "item-2", "Title", "Attempt 2", projectId);

    const task = tasks.get("manual-item-2")!;
    expect(task.status).toBe("next");
    expect(task.description).toContain("Attempt 1");
    expect(task.description).toContain("Attempt 2");
    const stamp = JSON.parse(task.kaya_triage!);
    expect(stamp.hash).toBe(computeTriageHash(NEEDS_JM_PROJECT_NAME, task.title, task.description!));
  });

  it("reopens a done task to next and honors the priority override", () => {
    const { store, tasks } = makeFakeStore();
    const projectId = ensureNeedsJmProject(store);

    createOrReopenEscalationTask(store, "item-3", "Title", "Cycle 1", projectId);
    tasks.get("manual-item-3")!.status = "done";

    createOrReopenEscalationTask(store, "item-3", "Title", "Cycle 2", projectId, { priority: 1 });
    const task = tasks.get("manual-item-3")!;
    expect(task.status).toBe("next");
    expect(task.priority).toBe(1);
    expect(task.description).toContain("Cycle 1");
    expect(task.description).toContain("Cycle 2");
  });
});
