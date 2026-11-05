#!/usr/bin/env bun
/**
 * RepairDegradedReasoning — one-off cleanup for tasks whose ai_reasoning was
 * overwritten by the "AI scoring unavailable" placeholder (before the
 * 2026-11-04 fix, degraded AI batches were saved over real reasoning).
 *
 * For each open task still carrying the placeholder, walks its task_events
 * history (newest first) for the last update whose ai_reasoning `to` was real
 * text, and restores that reasoning plus the ai_priority_score set in the same
 * event. Tasks with no real reasoning in their history are reset to null
 * (no reasoning beats a misleading placeholder).
 *
 * Usage:
 *   bun RepairDegradedReasoning.ts            # dry run: print the plan
 *   bun RepairDegradedReasoning.ts --apply    # write it (actor "repair", logged in task_events)
 */
import { getTaskDB } from "./TaskDB.ts";
import { AI_SCORING_UNAVAILABLE } from "./TaskAI.ts";

interface Change {
  from?: unknown;
  to?: unknown;
}

export interface RepairPlan {
  id: string;
  title: string;
  restoreReasoning: string | null;
  restoreScore: number | null;
}

export function planRepairs(db: ReturnType<typeof getTaskDB>): RepairPlan[] {
  const raw = db.getRawDb();
  const tasks = raw
    .prepare(
      `SELECT id, title FROM tasks
       WHERE ai_reasoning = $placeholder AND status NOT IN ('done', 'cancelled')`,
    )
    .all({ $placeholder: AI_SCORING_UNAVAILABLE }) as Array<{ id: string; title: string }>;

  const eventsStmt = raw.prepare(
    `SELECT changes FROM task_events
     WHERE task_id = $id AND changes LIKE '%"ai_reasoning"%'
     ORDER BY id DESC`,
  );

  return tasks.map((t) => {
    const events = eventsStmt.all({ $id: t.id }) as Array<{ changes: string | null }>;
    for (const e of events) {
      let changes: Record<string, Change>;
      try {
        changes = JSON.parse(e.changes ?? "{}") as Record<string, Change>;
      } catch {
        continue;
      }
      const to = changes.ai_reasoning?.to;
      if (typeof to === "string" && to.trim() !== "" && to !== AI_SCORING_UNAVAILABLE) {
        const score = changes.ai_priority_score?.to;
        return {
          id: t.id,
          title: t.title,
          restoreReasoning: to,
          restoreScore: typeof score === "number" ? score : null,
        };
      }
    }
    return { id: t.id, title: t.title, restoreReasoning: null, restoreScore: null };
  });
}

if (import.meta.main) {
  const apply = process.argv.includes("--apply");
  const db = getTaskDB();
  const plans = planRepairs(db);
  for (const p of plans) {
    const what = p.restoreReasoning ? `restore "${p.restoreReasoning}"` : "clear (no real reasoning in history)";
    console.log(
      `${p.id}  ${p.title.slice(0, 60)}\n    → ${what}${p.restoreScore !== null ? ` [score ${p.restoreScore}]` : ""}`,
    );
    if (apply) {
      const updates: { ai_reasoning: string | null; ai_priority_score?: number | null } = {
        ai_reasoning: p.restoreReasoning,
      };
      // Only touch the score when we have the real one; the placeholder run
      // wrote the deterministic score, which is still a sane value to keep.
      if (p.restoreScore !== null) updates.ai_priority_score = p.restoreScore;
      db.updateTask(p.id, updates, "repair");
    }
  }
  const restored = plans.filter((p) => p.restoreReasoning).length;
  console.log(
    `\n${plans.length} task(s) carry the placeholder: ${restored} restorable, ${plans.length - restored} to clear.` +
      (apply ? " Applied." : " Dry run — pass --apply to write."),
  );
  db.close();
}
