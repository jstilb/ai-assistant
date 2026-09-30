/**
 * EscalationHelper.ts — "Kaya — Needs Jm" escalation task helpers
 *
 * Owns the dedicated board project and the machine-created human-escalation
 * tasks that replaced the retired jm-tasks queue. Lifted from
 * skills/Automation/AutonomousWork (2026-07-05, follow-ups plan F2) because
 * three skills share this seam: AutonomousWork's NotificationDispatcher
 * (work-item escalation summaries + per-row [Human Action] proxies),
 * QueueRouter's SpecPipelineRunner (wedged-item escalations), and
 * QueueRouter's WaitingOnJm (reads the project name for its read-only
 * aggregation).
 *
 * Invariants every caller relies on:
 * - Escalation tasks use deterministic id `manual-${itemId}` — the same key
 *   JmTaskBridge and QueueSyncBridge use to close them on resolution.
 * - kaya_triage is pre-stamped so the hourly KayaTaskClassifier never re-judges
 *   these tasks back into the autonomous pipeline. The stamp hash MUST come
 *   from computeTriageHash below — LucidTasks' KayaTaskClassifier re-exports
 *   and validates against this exact function, so there is one hash source.
 * - queue_item_id is never set: it would both re-hide the task from triage by a
 *   different mechanism AND arm TaskDB's reverse-sync archive hook, which on
 *   "done" would archive the PARENT work item prematurely.
 *
 * This module is dependency-free: callers hand it any store satisfying the
 * structural EscalationTaskStore interface (LucidTasks' TaskDB does), so no
 * lib→skills import exists in either direction at runtime or in types.
 */

/** Dedicated board project for machine-created human escalations. */
export const NEEDS_JM_PROJECT_NAME = "Kaya — Needs Jm";

/**
 * Stable content hash (FNV-1a 32-bit, hex) over project + title + description.
 * Pure function — no I/O. Project name is included so moving a task into the
 * Kaya project re-triggers triage even when the text is unchanged.
 *
 * Single source of truth for the kaya_triage stamp hash. LucidTasks'
 * KayaTaskClassifier imports and re-exports this — any drift between stamper
 * and validator silently breaks the triage skip, so there is exactly one copy.
 */
export function computeTriageHash(
  projectName: string | undefined,
  title: string,
  description: string
): string {
  const input = `${projectName ?? ""}\n${title}\n${description}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * The narrow slice of a task store the escalation helpers need. LucidTasks'
 * TaskDB satisfies this structurally — no import of the concrete class here,
 * which is what lets this module live in lib/core without a skills dependency.
 */
export interface EscalationTaskStore {
  getProjectByName(name: string): { id: string } | null;
  createProject(input: {
    name: string;
    description?: string;
    status?: "active";
    sort_order?: number;
  }): { id: string };
  getTask(id: string): { title: string; description?: string | null; status: string } | null;
  createTask(input: {
    id?: string;
    title: string;
    description?: string;
    status?: "next";
    priority?: number;
    project_id?: string | null;
    labels?: string[];
  }): unknown;
  updateTask(
    id: string,
    updates: {
      status?: "next";
      priority?: number;
      description?: string;
      kaya_triage?: string;
    },
    actor?: string
  ): unknown;
}

/**
 * Return the id of the "Kaya — Needs Jm" project, creating it on first use.
 * sort_order -1 floats the column to the front of the board (projects sort
 * by sort_order ASC, name ASC; user projects default to 0).
 */
export function ensureNeedsJmProject(db: EscalationTaskStore): string {
  const existing = db.getProjectByName(NEEDS_JM_PROJECT_NAME);
  if (existing) return existing.id;
  return db.createProject({
    name: NEEDS_JM_PROJECT_NAME,
    description: "Machine-created escalations from AutonomousWork that require Jm's action",
    status: "active",
    sort_order: -1,
  }).id;
}

/**
 * Build a kaya_triage stamp that hasValidTriageStamp accepts for the given
 * content. The hash MUST be computed with computeTriageHash above (FNV-1a
 * over project name + title + description) — any drift silently breaks
 * the triage skip and these tasks start round-tripping through spec-pipeline.
 */
export function buildEscalationStamp(projectName: string, title: string, description: string): string {
  return JSON.stringify({
    verdict: "not-executable",
    confidence: 1,
    reasoning: "machine-created human escalation — pre-stamped at creation",
    hash: computeTriageHash(projectName, title, description),
    at: new Date().toISOString(),
  });
}

/**
 * Create the escalation task `manual-${itemId}`, or fold a repeat escalation
 * into the existing one. createTask with an explicit id bypasses the
 * dedup-by-title guard and would violate the PK on a duplicate, so this is
 * check-then-create. Repeat escalations append their context (attempt history
 * survives across cycles) and reopen the task if a prior cycle closed it.
 */
export function createOrReopenEscalationTask(
  db: EscalationTaskStore,
  itemId: string,
  title: string,
  description: string,
  projectId: string,
  opts?: { priority?: number }
): string {
  const id = `manual-${itemId}`;
  const existing = db.getTask(id);

  if (!existing) {
    db.createTask({
      id,
      title,
      description,
      status: "next",
      priority: opts?.priority ?? 2,
      project_id: projectId,
      labels: ["human-required", "autonomous-work"],
    });
    // createTask input doesn't accept kaya_triage — stamp via update.
    db.updateTask(id, { kaya_triage: buildEscalationStamp(NEEDS_JM_PROJECT_NAME, title, description) }, "system");
    return id;
  }

  const appended = existing.description
    ? `${existing.description}\n\n---\n\n${description}`
    : description;
  const reopen = existing.status === "done" || existing.status === "cancelled";
  db.updateTask(
    id,
    {
      ...(reopen ? { status: "next" as const } : {}),
      ...(opts?.priority ? { priority: opts.priority } : {}),
      description: appended,
      kaya_triage: buildEscalationStamp(NEEDS_JM_PROJECT_NAME, existing.title, appended),
    },
    "system"
  );
  return id;
}
