/**
 * TaskBoard.ts - shared constants + styles for the LucidTasks task board.
 *
 * Holds the status ordering/labels and CSS consumed by the live board server
 * (`BoardServer.ts`, served on 127.0.0.1:7777 via `kaya-cli tasks board`).
 *
 * @module TaskBoard
 */

// ============================================================================
// Constants
// ============================================================================

/** Statuses that count as "on the to-do list" (excludes done / cancelled). */
export const ACTIVE_STATUSES = ["in_progress", "next", "inbox", "waiting", "someday"] as const;

/** Sort weight per status — lower sorts first within a project card. */
export const STATUS_RANK: Record<string, number> = {
  in_progress: 0,
  next: 1,
  waiting: 2,
  inbox: 3,
  someday: 4,
};

export const STATUS_META: Record<string, { label: string; icon: string }> = {
  in_progress: { label: "In progress", icon: "▶" },
  next: { label: "Next", icon: "→" },
  waiting: { label: "Waiting", icon: "⏳" },
  inbox: { label: "Inbox", icon: "○" },
  someday: { label: "Someday", icon: "☆" },
};

// ============================================================================
// Shared CSS
// ============================================================================

/**
 * The board's visual style, consumed by the live `BoardServer.ts`. Contents
 * of a `<style>` block (no tags).
 */
export const BOARD_CSS = `
  :root {
    --bg: #f6f7f9; --card: #ffffff; --ink: #1a1d21; --muted: #6b7280;
    --line: #e5e7eb; --p1: #e5484d; --p2: #f5a623; --p3: #9aa0a6;
    --accent: #3b82f6; --green: #2f9e44;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  }
  header.top {
    position: sticky; top: 0; z-index: 5; background: var(--bg);
    padding: 18px 24px 12px; border-bottom: 1px solid var(--line);
  }
  h1 { margin: 0; font-size: 20px; font-weight: 650; letter-spacing: -0.01em; }
  h1 .n { color: var(--accent); }
  .sub { color: var(--muted); font-size: 12px; margin-top: 2px; }
  .chips { margin-top: 10px; display: flex; gap: 8px; flex-wrap: wrap; }
  .chip {
    font-size: 12px; padding: 3px 9px; border-radius: 999px;
    background: #fff; border: 1px solid var(--line); color: var(--muted);
  }
  .chip.s-in_progress { color: var(--accent); border-color: #bcd4fb; background: #eef4ff; }
  .chip.s-next { color: var(--green); border-color: #b7e0c0; background: #eefcf1; }
  .controls { margin-top: 12px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  #search {
    flex: 1; min-width: 200px; max-width: 360px; padding: 7px 11px;
    border: 1px solid var(--line); border-radius: 8px; font-size: 13px; background: #fff;
  }
  .filters { display: flex; gap: 4px; }
  .filters button {
    padding: 6px 12px; font-size: 12px; border: 1px solid var(--line);
    background: #fff; border-radius: 7px; cursor: pointer; color: var(--muted);
  }
  .filters button.on { background: var(--ink); color: #fff; border-color: var(--ink); }
  main {
    padding: 18px 24px 48px;
    display: grid; gap: 14px;
    grid-template-columns: repeat(auto-fill, minmax(290px, 1fr));
    align-items: start;
  }
  .card {
    background: var(--card); border: 1px solid var(--line); border-radius: 12px;
    overflow: hidden; display: flex; flex-direction: column;
  }
  .card-head {
    display: flex; justify-content: space-between; align-items: center;
    padding: 11px 14px; border-bottom: 1px solid var(--line); background: #fbfcfd;
  }
  .pname { font-weight: 650; font-size: 13px; }
  .pcount {
    font-size: 11px; color: var(--muted); background: #eef0f2;
    padding: 1px 8px; border-radius: 999px; font-variant-numeric: tabular-nums;
  }
  ul.tasks { list-style: none; margin: 0; padding: 4px 0; max-height: 440px; overflow-y: auto; }
  li.task {
    display: flex; align-items: baseline; gap: 8px; padding: 6px 14px;
    border-left: 3px solid transparent;
  }
  li.task:hover { background: #f8f9fb; }
  li.task.p1 { border-left-color: var(--p1); }
  li.task.p2 { border-left-color: var(--p2); }
  li.task.p3 { border-left-color: transparent; }
  li.task[data-status="in_progress"] { background: #eef4ff; }
  li.task[data-status="in_progress"]:hover { background: #e4eeff; }
  .dot { font-size: 11px; color: var(--muted); width: 14px; text-align: center; flex: none; }
  li.task[data-status="in_progress"] .dot { color: var(--accent); }
  li.task[data-status="next"] .dot { color: var(--green); }
  .title { flex: 1; word-break: break-word; }
  .badges { display: flex; gap: 4px; flex: none; align-items: baseline; }
  .goal, .due, .energy {
    font-size: 10px; padding: 1px 6px; border-radius: 5px; white-space: nowrap;
  }
  .goal { background: #ede9fe; color: #6d28d9; }
  .due { background: #eef0f2; color: var(--muted); font-variant-numeric: tabular-nums; }
  .due.overdue { background: #fde8e8; color: var(--p1); font-weight: 600; }
  .energy.high { background: #fde8e8; color: var(--p1); }
  .energy.low { background: #eef0f2; color: var(--muted); }
  .empty { color: var(--muted); padding: 40px; text-align: center; grid-column: 1/-1; }
  footer { padding: 0 24px 32px; color: var(--muted); font-size: 11px; }`;
