#!/usr/bin/env bun
/**
 * BoardServer.ts — always-on, live, interactive task board served on 127.0.0.1:7777.
 *
 * Serves the LIVE SQLite DB: the page fetches `/api/tasks` on load + every 30s, and edits
 * (mark-done / status / priority / project / title / quick-add) PATCH/POST straight
 * back to the DB. The render layer (BOARD_CSS + card markup) and CRUD layer (TaskDB)
 * are reused wholesale — the only new code here is the HTTP server + live client.
 *
 * Views: a projects overview (masonry of project cards), a global status kanban,
 * a per-project drill-in (click a project name → that project's tasks as status
 * swimlanes, hash-routed via #p=<id>), and a Today lane (GET /api/next — the same
 * deterministic 7-factor scorer as `tasks next`). The header chips are clickable
 * filters (status / overdue / due-today); layout+filter prefs persist in
 * localStorage. `t` opens keyboard-first inbox triage (N/W/S/D/X, 1/2/3, skip).
 * Remote access (Pixel via Tailscale/LAN) is opt-in: see loadBoardToken() —
 * BOARD_BIND + a token; non-loopback without a token refuses to start.
 *
 * Loopback-only by design (no auth, no CORS) — relies on host firewall + 127.0.0.1 bind.
 * Modeled on AppUsageTracker/Tools/Dashboard.ts.
 *
 * Connection: a single long-lived TaskDB singleton is held for process lifetime.
 * We NEVER call db.close() — that would null the singleton and drop busy_timeout,
 * reintroducing the silent rapid-edit WAL-lock failures this server fixes.
 *
 * Run:
 *   bun run Tools/BoardServer.ts             # blocks; serve until killed
 *   PORT=7777 bun run Tools/BoardServer.ts   # custom port
 *
 * In production, com.kaya.lucidtasks-board (KeepAlive) keeps it alive across reboot.
 *
 * ⚠️  AFTER EDITING THIS FILE: bun caches compiled TS in the running process, so the
 *     live server keeps serving stale code. Restart it with:
 *         launchctl kickstart -k gui/$UID/com.kaya.lucidtasks-board
 *     (or kill the `bun … BoardServer.ts` PID if running it by hand).
 *
 * @module BoardServer
 */

import {
  getTaskDB,
  resetTaskDB,
  installRealQueueArchiveHook,
  TaskStatus,
  inheritedContextLines,
  type TaskDB,
  type Task,
  type TaskFilter,
} from "./TaskDB.ts";
import { withRetry } from "./TaskDB.ts";
import { safeParseJSON } from "./TaskFormatter.ts";
import {
  BOARD_CSS,
  ACTIVE_STATUSES,
  STATUS_RANK,
  STATUS_META,
} from "./TaskBoard.ts";
import { reorganizeTaskFromComment, type ReorganizeContext } from "./TaskAI.ts";
import { scoreTask, type ScoringContext } from "./TaskScorer.ts";
import { buildPriorityList } from "./PriorityList.ts";
import { loadTelosData } from "./TelosGoalLoader.ts";
import { timingSafeEqual } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join as joinPath, resolve as resolvePath } from "node:path";

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT ?? 7777);
const MAX_TITLE_LEN = 1000;
const MAX_COMMENT_LEN = 5000;

// ============================================================================
// API serialization
// ============================================================================

/** A Task with context_tags/labels normalized from JSON-strings to arrays. */
type BoardTask = Omit<Task, "context_tags" | "labels"> & {
  context_tags: string[];
  labels: string[];
};

/** Normalize the two JSON-string columns into real arrays for the client. */
function serializeTask(t: Task): BoardTask {
  return {
    ...t,
    context_tags: safeParseJSON(t.context_tags),
    labels: safeParseJSON(t.labels),
  };
}

// ============================================================================
// Route handlers
// ============================================================================

/** GET /api/tasks?status=&project_id=&limit= */
function handleListTasks(db: TaskDB, url: URL): Response {
  const filter: TaskFilter = { limit: 100_000 };

  const statusParam = url.searchParams.get("status");
  if (statusParam) {
    const requested = statusParam
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const valid = requested.filter((s) => TaskStatus.safeParse(s).success) as TaskStatus[];
    filter.status = valid.length > 0 ? valid : [...ACTIVE_STATUSES];
  } else {
    filter.status = [...ACTIVE_STATUSES];
  }

  const projectId = url.searchParams.get("project_id");
  if (projectId) filter.project_id = projectId;

  const limitParam = url.searchParams.get("limit");
  if (limitParam) {
    const n = Number(limitParam);
    if (Number.isFinite(n) && n > 0) filter.limit = n;
  }

  const tasks = db.listTasks(filter).map(serializeTask);
  return Response.json({ tasks });
}

/** GET /api/projects */
function handleListProjects(db: TaskDB): Response {
  return Response.json({ projects: db.listProjects() });
}

/** GET /api/stats */
function handleStats(db: TaskDB): Response {
  return Response.json(db.getStats());
}

/**
 * GET /api/open?path=<abs or ~/ path>&line=<n> — opens a file on this Mac via the
 * macOS `open` command, so a task's CONTEXT: path is one click from the drawer.
 * `line` is accepted but currently ignored (no editor line-jump wired yet).
 *
 * Trust boundary: this server binds 127.0.0.1 only (loadBoardBind), so only a
 * process on the same machine can reach it by default. As defense in depth the
 * resolved path is still required to live inside the user's home directory.
 */
async function handleOpenPath(url: URL): Promise<Response> {
  const raw = url.searchParams.get("path");
  if (!raw || raw.trim() === "") {
    return Response.json({ error: "path is required" }, { status: 400 });
  }

  const home = resolvePath(homedir());
  const expanded = raw === "~" || raw.startsWith("~/") ? joinPath(home, raw.slice(1)) : raw;
  const resolved = resolvePath(expanded);
  if (resolved !== home && !resolved.startsWith(home + "/")) {
    return Response.json({ error: "path must be inside the home directory" }, { status: 400 });
  }
  if (!existsSync(resolved)) {
    return Response.json({ error: "path not found" }, { status: 404 });
  }

  try {
    Bun.spawn(["open", resolved]);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
  return Response.json({ ok: true });
}

/**
 * GET /api/next?top=N — the board's Today lane: the same deterministic 7-factor
 * scorer as `kaya-cli tasks next` (candidates = next/in_progress/inbox, TELOS
 * goal alignment when available). Two deliberate deviations from the CLI:
 * no LLM re-rank (the board refetches every 30s and must stay instant + free),
 * and Icebox-project tasks are excluded (the board hides that project).
 */
function handleNext(db: TaskDB, url: URL): Response {
  const topParam = Number(url.searchParams.get("top") ?? 10);
  const top = Number.isInteger(topParam) && topParam > 0 && topParam <= 50 ? topParam : 10;

  const iceboxId = db.listProjects().find((p) => p.name.toLowerCase() === "icebox")?.id ?? null;
  const candidates = db
    .listTasks({ status: ["next", "in_progress", "inbox"], limit: 50 })
    .filter((t) => !iceboxId || t.project_id !== iceboxId);

  let activeGoalIds: string[] = [];
  try {
    activeGoalIds = loadTelosData()
      .goals.filter((g) => g.status === "In Progress")
      .map((g) => g.id);
  } catch {
    // TELOS unavailable — score without goal alignment (same fallback as cmdNext).
  }

  const ctx: ScoringContext = { activeGoalIds, now: new Date() };
  const scored = candidates.map((t) => scoreTask(t, ctx));
  // Same tiebreak chain as cmdNext: score desc, priority asc, due asc (nulls last), created desc.
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.task.priority !== b.task.priority) return a.task.priority - b.task.priority;
    if (a.task.due_date && b.task.due_date) return a.task.due_date.localeCompare(b.task.due_date);
    if (a.task.due_date && !b.task.due_date) return -1;
    if (!a.task.due_date && b.task.due_date) return 1;
    return (b.task.created_at || "").localeCompare(a.task.created_at || "");
  });

  return Response.json({
    next: scored.slice(0, top).map((s) => ({
      task: serializeTask(s.task),
      score: s.score,
      reasons: s.reasons,
    })),
  });
}

/**
 * GET /api/priority — Jm's prioritized list across ALL projects (the board's
 * "Priority" mode + `tasks priority`). Everything that is Jm's to do — not the
 * executor's autonomous lane, not Icebox — ranked by the stored AI priority
 * score (nightly rescore) with the live 7-factor score as fallback; `waiting`
 * trails. See PriorityList.ts. No LLM call: instant + free on every poll.
 * `ai_scored_at` = when the AI ranking was last refreshed (null = never).
 */
function handlePriority(db: TaskDB): Response {
  const { items, totals } = buildPriorityList(db);
  return Response.json({
    items: items.map((it) => ({ ...it, task: serializeTask(it.task) })),
    totals,
    ai_scored_at: db.getLastActivityAt(["ai_scored", "auto_prioritized"]),
    generated_at: new Date().toISOString(),
  });
}

/** Result of validating a partial-task update body: either parsed updates or an error. */
type ValidationResult =
  | { ok: true; updates: Partial<Omit<Task, "id" | "created_at">> }
  | { ok: false; error: string; status: number };

/**
 * Validate a partial-Task update body into a safe `updates` object. Shared by
 * handlePatchTask AND the reorganize-apply path so the two can never diverge —
 * any field the board (or Kaya) can change is validated in exactly one place.
 * Returns {ok:false,...} on the first invalid field; does NOT touch the DB
 * beyond the project_id existence check.
 */
function validateTaskUpdates(db: TaskDB, body: Record<string, unknown>): ValidationResult {
  const updates: Partial<Omit<Task, "id" | "created_at">> = {};

  if (body.title !== undefined) {
    if (typeof body.title !== "string" || body.title.trim() === "") {
      return { ok: false, error: "title must be a non-empty string", status: 400 };
    }
    if (body.title.trim().length > MAX_TITLE_LEN) {
      return { ok: false, error: `title exceeds ${MAX_TITLE_LEN} chars`, status: 400 };
    }
    updates.title = body.title.trim();
  }

  if (body.status !== undefined) {
    const parsed = TaskStatus.safeParse(body.status);
    if (!parsed.success) {
      return { ok: false, error: "invalid status", status: 400 };
    }
    updates.status = parsed.data;
  }

  if (body.priority !== undefined) {
    const p = Number(body.priority);
    if (!Number.isInteger(p) || p < 1 || p > 3) {
      return { ok: false, error: "priority must be 1, 2, or 3", status: 400 };
    }
    updates.priority = p;
  }

  // Priority-list drag-and-drop: pin to a 1-based slot, or null to unpin (back to score order).
  if (body.manual_rank !== undefined) {
    if (body.manual_rank === null) {
      updates.manual_rank = null;
      updates.manual_ranked_at = null;
    } else {
      const r = Number(body.manual_rank);
      if (!Number.isInteger(r) || r < 1) {
        return { ok: false, error: "manual_rank must be a positive integer or null", status: 400 };
      }
      updates.manual_rank = r;
      updates.manual_ranked_at = new Date().toISOString();
    }
  }

  if (body.project_id !== undefined) {
    if (body.project_id === null) {
      updates.project_id = null;
    } else {
      const pid = String(body.project_id);
      // Validate up front so a bad id returns 400, not a raw 500 from the FK constraint.
      if (!db.getProject(pid)) {
        return { ok: false, error: "invalid project_id", status: 400 };
      }
      updates.project_id = pid;
    }
  }

  if (body.due_date !== undefined) {
    updates.due_date = body.due_date === null ? null : String(body.due_date);
  }

  if (body.scheduled_date !== undefined) {
    updates.scheduled_date = body.scheduled_date === null ? null : String(body.scheduled_date);
  }

  if (body.description !== undefined) {
    if (typeof body.description !== "string") {
      return { ok: false, error: "description must be a string", status: 400 };
    }
    updates.description = body.description;
  }

  if (body.energy_level !== undefined) {
    if (body.energy_level === null) {
      updates.energy_level = null;
    } else if (
      body.energy_level === "low" ||
      body.energy_level === "medium" ||
      body.energy_level === "high"
    ) {
      updates.energy_level = body.energy_level;
    } else {
      return { ok: false, error: "energy_level must be low, medium, high, or null", status: 400 };
    }
  }

  if (body.estimated_minutes !== undefined) {
    if (body.estimated_minutes === null) {
      updates.estimated_minutes = null;
    } else {
      const m = Number(body.estimated_minutes);
      if (!Number.isInteger(m) || m <= 0) {
        return { ok: false, error: "estimated_minutes must be a positive integer or null", status: 400 };
      }
      updates.estimated_minutes = m;
    }
  }

  if (body.goal_id !== undefined) {
    updates.goal_id = body.goal_id === null ? null : String(body.goal_id);
  }

  if (Array.isArray(body.context_tags)) {
    updates.context_tags = JSON.stringify(body.context_tags);
  }
  if (Array.isArray(body.labels)) {
    updates.labels = JSON.stringify(body.labels);
  }

  return { ok: true, updates };
}

/**
 * PATCH /api/tasks/:id — body is a partial Task (title/status/priority/project_id/
 * due_date/scheduled_date/description/energy_level/estimated_minutes/goal_id, plus
 * context_tags/labels arrays). Validates each field via validateTaskUpdates(); 404 if
 * the task is missing, 400 if any provided field is invalid. The write is wrapped in
 * withRetry() and logged with actor="board" for activity provenance.
 */
async function handlePatchTask(db: TaskDB, id: string, req: Request): Promise<Response> {
  const existing = db.getTask(id);
  if (!existing) return Response.json({ error: "task not found" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const validation = validateTaskUpdates(db, body);
  if (!validation.ok) {
    return Response.json({ error: validation.error }, { status: validation.status });
  }
  const updates = validation.updates;

  if (Object.keys(updates).length === 0) {
    return Response.json({ error: "no valid fields to update" }, { status: 400 });
  }

  const updated = withRetry(() => db.updateTask(id, updates, "board"));
  if (!updated) return Response.json({ error: "task not found" }, { status: 404 });
  return Response.json({ task: serializeTask(updated) });
}

/**
 * POST /api/priority/pins — body {ids: string[]}: the full hand-ordered top of the
 * Priority list after a drag. Each id gets manual_rank = its 1-based index (and a
 * fresh manual_ranked_at); tasks not listed are left alone. The client sends the
 * dragged row plus everything above it, so the pinned block stays a contiguous
 * prefix (see PriorityList.placePinned). 400 on a malformed body or unknown id;
 * nothing is written unless every id resolves.
 */
async function handleSetPins(db: TaskDB, req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const ids = body.ids;
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((x): x is string => typeof x === "string")) {
    return Response.json({ error: "ids must be a non-empty array of task ids" }, { status: 400 });
  }
  if (new Set(ids).size !== ids.length) {
    return Response.json({ error: "ids must be unique" }, { status: 400 });
  }
  const missing = ids.filter((id) => !db.getTask(id));
  if (missing.length > 0) {
    return Response.json({ error: `unknown task id: ${missing[0]}` }, { status: 400 });
  }
  const stamp = new Date().toISOString();
  const tasks = ids.map((id, i) =>
    withRetry(() => db.updateTask(id, { manual_rank: i + 1, manual_ranked_at: stamp }, "board")),
  );
  return Response.json({ tasks: tasks.filter((t): t is Task => t !== null).map(serializeTask) });
}

/** GET /api/tasks/:id → { task, activity }. 404 if missing. Powers the detail drawer. */
function handleGetTask(db: TaskDB, id: string): Response {
  const task = db.getTask(id);
  if (!task) return Response.json({ error: "task not found" }, { status: 404 });
  return Response.json({ task: serializeTask(task), activity: db.getActivityLog(id, 100) });
}

/** DELETE /api/tasks/:id — hard delete (drawer-only "Delete permanently"). 200/404. */
function handleDeleteTask(db: TaskDB, id: string): Response {
  const ok = withRetry(() => db.deleteTask(id));
  if (!ok) return Response.json({ error: "task not found" }, { status: 404 });
  return Response.json({ ok: true });
}

/**
 * POST /api/tasks/:id/comments — body {text}. Stores the user comment, then fires a
 * fire-and-forget background reorganize (deps.reorganize) whose reply + field changes
 * surface in the comment thread via the drawer's poll. Returns 201 immediately with
 * the stored user comment — does NOT block on the LLM.
 */
async function handlePostComment(
  db: TaskDB,
  id: string,
  req: Request,
  deps: BoardDeps,
): Promise<Response> {
  const existing = db.getTask(id);
  if (!existing) return Response.json({ error: "task not found" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof body.text !== "string" || body.text.trim() === "") {
    return Response.json({ error: "text is required" }, { status: 400 });
  }
  const text = body.text.trim();
  if (text.length > MAX_COMMENT_LEN) {
    return Response.json({ error: `comment exceeds ${MAX_COMMENT_LEN} chars` }, { status: 400 });
  }

  withRetry(() => db.addComment(id, text, "user"));

  // Fire-and-forget: the reorganize runs in the background; its reply/changes land
  // in the comment thread and the drawer's short poll surfaces them. Never awaited.
  void deps.reorganize(db, id, text).catch((err) => {
    console.error("[BoardServer] reorganize failed:", err);
  });

  return Response.json(
    { ok: true, comment: { task_id: id, action: "comment", actor: "user", text } },
    { status: 201 },
  );
}

// ============================================================================
// Reorganize (background, triggered by a posted comment)
// ============================================================================

/** Injectable dependencies so tests can stub the LLM-backed reorganize. */
export interface BoardDeps {
  reorganize: (db: TaskDB, taskId: string, commentText: string) => Promise<void>;
}

/**
 * Real reorganize: ask Sonnet (via reorganizeTaskFromComment) what to change,
 * validate its proposed updates through the SAME gate as the API, apply them,
 * create any requested subtasks as normal cards, and post Kaya's reply. On ANY
 * failure it posts a visible "⚠️ Couldn't reorganize: …" comment (fail loudly).
 */
async function defaultReorganize(db: TaskDB, taskId: string, commentText: string): Promise<void> {
  try {
    const task = db.getTask(taskId);
    if (!task) return; // task vanished between comment and reorg — nothing to do

    const ctx: ReorganizeContext = {
      today: new Date().toISOString().split("T")[0],
      projects: db.listProjects().map((p) => ({ id: p.id, name: p.name })),
      statuses: [...ACTIVE_STATUSES, "done", "cancelled"],
    };

    const result = await reorganizeTaskFromComment(task, commentText, ctx);
    if (!result) {
      db.addComment(taskId, "⚠️ Couldn't reorganize: the AI request failed or returned an unusable response.", "kaya");
      return;
    }

    const validation = validateTaskUpdates(db, result.updates as Record<string, unknown>);
    if (!validation.ok) {
      db.addComment(taskId, `⚠️ Couldn't reorganize: ${validation.error}`, "kaya");
      return;
    }

    if (Object.keys(validation.updates).length > 0) {
      withRetry(() => db.updateTask(taskId, validation.updates, "kaya"));
    }

    if (result.subtasks && result.subtasks.length > 0) {
      const parent = db.getTask(taskId);
      const projectId = parent?.project_id ?? null;
      // Text standard (SKILL.md "Task context standard"): every task carries its
      // own context — a split subtask inherits the parent's CONTEXT: line(s) so
      // it still opens to the same source docs (falls back to a pointer at the
      // parent task when the parent has none).
      const description = inheritedContextLines(taskId, parent?.description);
      for (const rawTitle of result.subtasks) {
        const title = rawTitle.trim();
        if (!title) continue;
        withRetry(() =>
          db.createTask({ title, description, parent_task_id: taskId, project_id: projectId, status: "next" }),
        );
      }
    }

    db.addComment(taskId, result.reply, "kaya");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      db.addComment(taskId, `⚠️ Couldn't reorganize: ${msg}`, "kaya");
    } catch {
      // DB itself is unwritable — nothing more we can surface.
    }
  }
}

const DEFAULT_DEPS: BoardDeps = { reorganize: defaultReorganize };

/**
 * POST /api/tasks — quick-add. Body {title, status?, project_id?, priority?,
 * due_date?, description?}. 400 if title is missing/blank. 201 with the created
 * task (dedup in createTask may return an existing active task with the same
 * title — acceptable).
 */
async function handleCreateTask(db: TaskDB, req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  if (typeof body.title !== "string" || body.title.trim() === "") {
    return Response.json({ error: "title is required" }, { status: 400 });
  }
  if (body.title.trim().length > MAX_TITLE_LEN) {
    return Response.json({ error: `title exceeds ${MAX_TITLE_LEN} chars` }, { status: 400 });
  }

  const input: Parameters<TaskDB["createTask"]>[0] = { title: body.title.trim() };

  if (body.status !== undefined) {
    const parsed = TaskStatus.safeParse(body.status);
    if (!parsed.success) return Response.json({ error: "invalid status" }, { status: 400 });
    input.status = parsed.data;
  }

  if (body.priority !== undefined) {
    const p = Number(body.priority);
    if (!Number.isInteger(p) || p < 1 || p > 3) {
      return Response.json({ error: "priority must be 1, 2, or 3" }, { status: 400 });
    }
    input.priority = p;
  }

  if (body.project_id !== undefined && body.project_id !== null) {
    const pid = String(body.project_id);
    if (!db.getProject(pid)) {
      return Response.json({ error: "invalid project_id" }, { status: 400 });
    }
    input.project_id = pid;
  }
  if (body.due_date !== undefined && body.due_date !== null) {
    input.due_date = String(body.due_date);
  }

  if (body.description !== undefined) {
    if (typeof body.description !== "string") {
      return Response.json({ error: "description must be a string" }, { status: 400 });
    }
    input.description = body.description;
  }

  const created = withRetry(() => db.createTask(input));
  return Response.json({ task: serializeTask(created) }, { status: 201 });
}

// ============================================================================
// Remote-access auth (opt-in — the default loopback bind stays auth-free)
// ============================================================================

/**
 * The board is loopback-only + auth-free by default. To reach it from the Pixel
 * (Tailscale or LAN), set `lucidtasks_board_bind` (e.g. "0.0.0.0") in
 * ~/.claude/secrets.json — NOT the launchd plist, which rebuild-plists.sh
 * regenerates — then kickstart the service. A non-loopback bind REQUIRES a
 * token (`lucidtasks_board_token` in secrets.json, or env BOARD_TOKEN) and the
 * server refuses to start without one. First visit:
 * http://<host>:7777/?token=<token> (sets a cookie); everything after rides
 * the cookie. /health stays open so the liveness watchdog keeps working.
 */
export function loadBoardToken(): string | null {
  if (process.env.BOARD_TOKEN) return process.env.BOARD_TOKEN;
  return readSecretString("lucidtasks_board_token");
}

/**
 * Bind address: env BOARD_BIND > `lucidtasks_board_bind` in secrets.json >
 * loopback. secrets.json is the durable opt-in switch — the launchd plist is
 * regenerated by bin/rebuild-plists.sh, so an env var hand-edited there would
 * be silently clobbered on the next rebuild.
 */
export function loadBoardBind(): string {
  if (process.env.BOARD_BIND) return process.env.BOARD_BIND;
  return readSecretString("lucidtasks_board_bind") ?? HOST;
}

function readSecretString(key: string): string | null {
  try {
    const j = JSON.parse(readFileSync(joinPath(homedir(), ".claude/secrets.json"), "utf8"));
    const v = (j as Record<string, unknown>)[key];
    return typeof v === "string" && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

function timingSafeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export interface BoardAuthResult {
  ok: boolean;
  /** Set-Cookie header value to attach when a valid ?token= just authenticated. */
  setCookie?: string;
}

/** Gate one request against the board token. `token === null` means auth is off. */
export function checkBoardAuth(req: Request, token: string | null): BoardAuthResult {
  if (token === null) return { ok: true };
  const url = new URL(req.url);
  if (url.pathname === "/health") return { ok: true };
  const q = url.searchParams.get("token");
  if (q !== null) {
    if (timingSafeEq(q, token)) {
      return {
        ok: true,
        setCookie:
          "kaya_board=" + encodeURIComponent(token) +
          "; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000",
      };
    }
    return { ok: false };
  }
  const m = (req.headers.get("cookie") || "").match(/(?:^|;\s*)kaya_board=([^;]+)/);
  if (m && timingSafeEq(decodeURIComponent(m[1]), token)) return { ok: true };
  return { ok: false };
}

// ============================================================================
// Request router
// ============================================================================

/** True if `err` is a SQLite I/O error — notably SQLITE_IOERR_VNODE, thrown on every
 *  query once the DB file's inode has been replaced under the long-lived connection. */
export function isSqliteIOError(err: unknown): boolean {
  if (err && typeof err === "object") {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && code.startsWith("SQLITE_IOERR")) return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /disk i\/o error/i.test(msg);
}

/**
 * Handle one HTTP request. Tests pass a `dbOverride` (an in-memory TaskDB) so the
 * handler never touches the real singleton or DB file, and a `deps` stub so the
 * comment route never spawns an LLM.
 *
 * Production self-heal: the singleton holds ONE connection for the process lifetime.
 * If the DB file's inode is swapped (e.g. a git checkout/commit rewrites a tracked
 * .db — see the file header + the .gitignore note), every query throws
 * SQLITE_IOERR_VNODE and the connection is permanently dead. launchd KeepAlive won't
 * help because the process keeps running (just 500ing). So on a SQLite I/O error we
 * reopen the connection once and retry, instead of staying down until a manual
 * `launchctl kickstart`. Only the real singleton self-heals — a test dbOverride is
 * owned by the caller and passed straight through.
 */
export async function handleRequest(
  req: Request,
  dbOverride?: TaskDB,
  deps: BoardDeps = DEFAULT_DEPS,
): Promise<Response> {
  if (dbOverride !== undefined) {
    return routeRequest(req, dbOverride, deps);
  }
  // Clone first so a retry still has an unconsumed body (POST/PATCH read req.json()).
  const retryReq = req.clone();
  try {
    return await routeRequest(req, getTaskDB(), deps);
  } catch (err) {
    if (!isSqliteIOError(err)) throw err;
    console.error(
      "[BoardServer] SQLite I/O error — DB file likely replaced; reopening connection and retrying once:",
      err instanceof Error ? err.message : String(err),
    );
    resetTaskDB();
    return await routeRequest(retryReq, getTaskDB(), deps);
  }
}

/** Route one request against a specific db connection (no self-heal — see handleRequest). */
async function routeRequest(req: Request, db: TaskDB, deps: BoardDeps): Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;

  if (pathname === "/health") {
    return new Response("ok\n", { headers: { "content-type": "text/plain" } });
  }
  if (pathname === "/") {
    return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (pathname === "/api/tasks" && req.method === "GET") {
    return handleListTasks(db, url);
  }
  if (pathname === "/api/tasks" && req.method === "POST") {
    return handleCreateTask(db, req);
  }
  if (pathname === "/api/projects" && req.method === "GET") {
    return handleListProjects(db);
  }
  if (pathname === "/api/stats" && req.method === "GET") {
    return handleStats(db);
  }
  if (pathname === "/api/priority" && req.method === "GET") {
    return handlePriority(db);
  }
  if (pathname === "/api/priority/pins" && req.method === "POST") {
    return handleSetPins(db, req);
  }
  if (pathname === "/api/next" && req.method === "GET") {
    return handleNext(db, url);
  }
  if (pathname === "/api/open" && req.method === "GET") {
    return handleOpenPath(url);
  }

  // POST /api/tasks/:id/comments — match before the generic :id route so the
  // task-id regex below doesn't swallow the trailing "/comments".
  const commentMatch = pathname.match(/^\/api\/tasks\/(.+)\/comments$/);
  if (commentMatch && req.method === "POST") {
    return handlePostComment(db, decodeURIComponent(commentMatch[1]), req, deps);
  }

  // Task ids contain no slashes, so [^/]+ is safe and won't catch sub-paths.
  const taskIdMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskIdMatch) {
    const id = decodeURIComponent(taskIdMatch[1]);
    if (req.method === "GET") return handleGetTask(db, id);
    if (req.method === "PATCH") return handlePatchTask(db, id, req);
    if (req.method === "DELETE") return handleDeleteTask(db, id);
  }

  return new Response("not found", { status: 404 });
}

// ============================================================================
// Client HTML (inline; renders dynamically from fetched JSON)
// ============================================================================

const CLIENT_CONSTANTS = `
  const STATUS_META = ${JSON.stringify(STATUS_META)};
  const STATUS_RANK = ${JSON.stringify(STATUS_RANK)};
  const ACTIVE_STATUSES = ${JSON.stringify([...ACTIVE_STATUSES])};
`;

const EXTRA_CSS = `
  .controls .toggle { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); }
  #status { color: var(--muted); font-size: 11px; margin-left: 8px; font-weight: 400; }
  /* interactive affordances */
  li.task { align-items: flex-start; flex-wrap: wrap; }   /* top-align controls; let badges wrap below a cramped title */
  /* Title keeps a usable min-width so trailing badges wrap to a second line
     instead of squeezing it to one-character-per-line in narrow kanban columns. */
  li.task .title { min-width: 130px; overflow-wrap: anywhere; word-break: normal; }
  li.task .check {
    flex: none; width: 16px; height: 16px; border: 1.5px solid var(--line); border-radius: 50%;
    background: #fff; cursor: pointer; padding: 0; font-size: 10px; line-height: 14px; color: transparent;
    margin-top: 2px;
  }
  li.task .check:hover { border-color: var(--green); color: var(--green); }
  li.task .dot { cursor: pointer; margin-top: 3px; }
  li.task .dot:hover { color: var(--ink); }
  li.task .badges { margin-top: 3px; }
  li.task .prio { margin-top: 3px; }
  li.task .prio {
    flex: none; cursor: pointer; font-size: 10px; padding: 1px 6px; border-radius: 5px;
    font-variant-numeric: tabular-nums; user-select: none;
  }
  li.task .prio.p1 { background: #fde8e8; color: var(--p1); }
  li.task .prio.p2 { background: #fef0d9; color: #b76e00; }
  li.task .prio.p3 { background: #eef0f2; color: var(--muted); }
  li.task .trash {
    flex: none; cursor: pointer; border: none; background: none; color: var(--muted);
    font-size: 12px; padding: 0 2px; opacity: 0; transition: opacity .12s; margin-top: 1px;
  }
  li.task:hover .trash { opacity: .5; }
  li.task .trash:hover { opacity: 1; color: var(--p1); }
  li.task.removing { opacity: 0; transform: translateX(8px); transition: opacity .22s, transform .22s; }
  li.task.dragging { opacity: .4; }
  li.task .title { cursor: pointer; }                 /* single-click opens the detail drawer */
  li.task[draggable="true"] { cursor: grab; }
  .card.drop-target { outline: 2px dashed var(--accent); outline-offset: -2px; background: #eef4ff; }
  /* quick-add */
  .addbtn {
    padding: 6px 12px; font-size: 12px; border: 1px solid var(--accent); background: var(--accent);
    color: #fff; border-radius: 7px; cursor: pointer;
  }
  .addbtn:hover { background: #2f74e0; }
  .addbar { margin-top: 12px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .addbar[hidden] { display: none; }   /* [hidden] UA rule loses to display:flex without this */
  .addbar input, .addbar select, .addbar button { height: 34px; }
  .addbar input, .addbar select {
    padding: 0 11px; border: 1px solid var(--line); border-radius: 8px; font-size: 13px; background: #fff;
  }
  .addbar #add-title { flex: 1; min-width: 220px; max-width: 420px; }
  .addbar button {
    padding: 0 14px; font-size: 13px; border-radius: 8px; cursor: pointer; border: 1px solid var(--accent);
    background: var(--accent); color: #fff;
  }
  .addbar button.ghost { background: #fff; color: var(--muted); border-color: var(--line); }
  .card-head .cardadd {
    border: none; background: none; color: var(--muted); cursor: pointer; font-size: 16px;
    line-height: 1; padding: 0 4px; opacity: .5;
  }
  .card-head .cardadd:hover { opacity: 1; color: var(--accent); }
  .card-head .right { display: flex; align-items: center; gap: 6px; }
  /* status breakdown chips */
  .chip.s-waiting { color: #b76e00; border-color: #f0d8a8; background: #fef6e7; }
  .chip.s-inbox { color: var(--muted); }
  .chip.s-someday { color: var(--muted); }
  .chip.overdue { color: var(--p1); border-color: #f5c2c2; background: #fde8e8; }
  .chip.done { color: var(--green); border-color: #b7e0c0; background: #eefcf1; }
  /* per-task tag + due affordances */
  li.task .tag { font-size: 10px; padding: 1px 6px; border-radius: 5px; background: #eef2ff; color: #4456c7; white-space: nowrap; }
  li.task .due { cursor: pointer; }
  li.task .adddue {
    flex: none; cursor: pointer; border: none; background: none; color: var(--muted);
    font-size: 10px; padding: 0 2px; opacity: 0; transition: opacity .12s;
  }
  li.task:hover .adddue { opacity: .5; }
  li.task .adddue:hover { opacity: 1; color: var(--accent); }
  li.task .dueedit { font-size: 11px; }
  /* toasts */
  #toasts { position: fixed; right: 16px; bottom: 16px; z-index: 50; display: flex; flex-direction: column; gap: 8px; }
  .toast {
    background: var(--ink); color: #fff; font-size: 13px; padding: 9px 14px; border-radius: 8px;
    box-shadow: 0 4px 14px rgba(0,0,0,.18); opacity: 0; transform: translateY(6px);
    transition: opacity .18s, transform .18s; max-width: 320px;
  }
  .toast.show { opacity: 1; transform: translateY(0); }
  .toast.err { background: var(--p1); }
  .toast.ok { background: var(--green); }
  .toast.action { display: flex; align-items: center; gap: 12px; }
  .toast .toast-action {
    background: rgba(255,255,255,.2); border: none; color: #fff; font-size: 12px; font-weight: 600;
    padding: 3px 10px; border-radius: 6px; cursor: pointer; flex: none;
  }
  .toast .toast-action:hover { background: rgba(255,255,255,.34); }
  /* detail drawer */
  #drawer-backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,.28); z-index: 60;
    opacity: 0; transition: opacity .18s;
  }
  #drawer-backdrop.show { opacity: 1; }
  #drawer-backdrop[hidden] { display: none; }
  #drawer {
    position: fixed; top: 0; right: 0; height: 100%; width: 440px; max-width: 92vw;
    background: #fff; z-index: 61; box-shadow: -8px 0 28px rgba(0,0,0,.16);
    transform: translateX(100%); transition: transform .2s ease; display: flex; flex-direction: column;
  }
  #drawer.show { transform: translateX(0); }
  #drawer[hidden] { display: none; }
  .drawer-head {
    display: flex; align-items: center; gap: 8px; padding: 13px 16px; border-bottom: 1px solid var(--line);
  }
  .drawer-head #dw-title {
    flex: 1; font-size: 16px; font-weight: 600; border: 1px solid transparent; border-radius: 6px;
    padding: 5px 7px; background: #fff; color: var(--ink); font-family: inherit;
  }
  .drawer-head #dw-title:hover { border-color: var(--line); }
  .drawer-head #dw-title:focus { outline: none; border-color: var(--accent); }
  .drawer-head #dw-close {
    flex: none; border: none; background: none; font-size: 18px; cursor: pointer;
    color: var(--muted); line-height: 1; padding: 4px 6px;
  }
  .drawer-head #dw-close:hover { color: var(--ink); }
  .drawer-body { flex: 1; overflow-y: auto; padding: 14px 16px 36px; }
  .dw-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 11px 12px; }
  .dw-field { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .dw-field.full { grid-column: 1 / -1; }
  .dw-field label {
    font-size: 10px; color: var(--muted); font-weight: 700;
    text-transform: uppercase; letter-spacing: .04em;
  }
  .dw-field input, .dw-field select, .dw-field textarea {
    border: 1px solid var(--line); border-radius: 7px; padding: 6px 8px; font-size: 13px;
    font-family: inherit; background: #fff; color: var(--ink); width: 100%;
  }
  .dw-field input:focus, .dw-field select:focus, .dw-field textarea:focus {
    outline: none; border-color: var(--accent);
  }
  .dw-field textarea { resize: vertical; min-height: 60px; }
  .dw-meta { margin-top: 14px; font-size: 11px; color: var(--muted); line-height: 1.7; }
  .dw-section { margin-top: 22px; }
  .dw-section h4 {
    margin: 0 0 9px; font-size: 11px; text-transform: uppercase;
    letter-spacing: .04em; color: var(--muted);
  }
  #dw-thread { display: flex; flex-direction: column; gap: 8px; max-height: 320px; overflow-y: auto; }
  .dw-bubble {
    max-width: 88%; padding: 7px 11px; border-radius: 12px; font-size: 13px;
    white-space: pre-wrap; overflow-wrap: anywhere;
  }
  .dw-bubble.user { align-self: flex-end; background: var(--accent); color: #fff; border-bottom-right-radius: 4px; }
  .dw-bubble.kaya { align-self: flex-start; background: #eef0f2; color: var(--ink); border-bottom-left-radius: 4px; }
  .dw-sys { align-self: center; font-size: 11px; color: var(--muted); font-style: italic; text-align: center; }
  .dw-empty { color: var(--muted); font-size: 12px; }
  .dw-composer { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; }
  .dw-composer textarea {
    border: 1px solid var(--line); border-radius: 8px; padding: 8px; font-size: 13px;
    font-family: inherit; resize: vertical; min-height: 54px;
  }
  .dw-composer textarea:focus { outline: none; border-color: var(--accent); }
  .dw-composer button {
    align-self: flex-end; padding: 7px 14px; font-size: 13px; border-radius: 8px; cursor: pointer;
    border: 1px solid var(--accent); background: var(--accent); color: #fff;
  }
  .dw-composer button:disabled { opacity: .5; cursor: default; }
  .dw-danger { margin-top: 26px; padding-top: 14px; border-top: 1px solid var(--line); }
  .dw-danger button {
    padding: 7px 12px; font-size: 12px; border-radius: 8px; cursor: pointer;
    border: 1px solid #f5c2c2; background: #fff; color: var(--p1);
  }
  .dw-danger button:hover { background: #fde8e8; }
  /* done / cancelled cards (Done filter scope) */
  li.task.finished .title { color: var(--muted); }
  li.task[data-status="done"] .title { text-decoration: line-through; text-decoration-color: #c9ced4; }
  li.task[data-status="cancelled"] .title { font-style: italic; }
  li.task .check.reopen { color: var(--muted); font-size: 11px; }
  li.task .check.reopen:hover { border-color: var(--accent); color: var(--accent); }
  li.task .donedate {
    font-size: 10px; padding: 1px 6px; border-radius: 5px; white-space: nowrap;
    background: #eefcf1; color: var(--green); font-variant-numeric: tabular-nums;
  }
  li.task .donedate.x { background: #f3f4f6; color: var(--muted); }
  li.task .due.today { background: #fef6e7; color: #b76e00; font-weight: 600; }
  /* breadcrumb (project drill-in view) */
  #crumb { display: flex; align-items: center; gap: 8px; margin: 0 0 4px; }
  #crumb[hidden] { display: none; }
  #crumb button {
    border: none; background: none; color: var(--accent); font-size: 12px; cursor: pointer;
    padding: 0; font-family: inherit;
  }
  #crumb button:hover { text-decoration: underline; }
  /* clickable project names (overview → drill-in) */
  .pname.link { cursor: pointer; }
  .pname.link:hover { color: var(--accent); text-decoration: underline; }
  /* top chips double as filters */
  .chips .chip { font-family: inherit; }
  .chips button.chip { cursor: pointer; }
  .chips button.chip:not(.active):hover { border-color: var(--ink); color: var(--ink); }
  .chips .chip.active { background: var(--ink); color: #fff; border-color: var(--ink); }
  .chip.clear { color: var(--p1); border-color: #f5c2c2; }
  /* empty swimlane columns stay visible as drop targets */
  .card.col-empty ul.tasks { min-height: 64px; }
  .card.col-empty ul.tasks::after {
    content: 'No tasks'; display: block; padding: 10px 14px; color: var(--muted); font-size: 11px;
  }
  /* paragraph-length titles: clamp to 2 lines on cards (full text in tooltip + drawer) */
  li.task .title {
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  /* Today lane (ranked by the 7-factor scorer) */
  #board.today-lane { grid-template-columns: minmax(320px, 760px); justify-content: center; }
  #board.today-lane ul.tasks { max-height: none; }
  li.task .score {
    flex: none; font-size: 10px; font-weight: 700; padding: 1px 7px; border-radius: 999px;
    background: #ede9fe; color: #6d28d9; font-variant-numeric: tabular-nums; margin-top: 3px;
    cursor: help;
  }
  li.task .why { flex-basis: 100%; font-size: 11px; color: var(--muted); margin: 1px 0 2px 24px; }
  /* Priority list — Jm's ranked list across all projects (GET /api/priority) */
  #board.plist { grid-template-columns: minmax(320px, 980px); justify-content: center; }
  #board.plist ul.tasks { max-height: none; }
  #board.plist li.task { align-items: center; padding: 8px 14px; border-bottom: 1px solid #f0f1f3; flex-wrap: wrap; }
  #board.plist li.task .title { -webkit-line-clamp: 1; }
  li.task .rank {
    flex: none; width: 28px; font-size: 12px; font-weight: 700; color: var(--muted);
    font-variant-numeric: tabular-nums; text-align: right;
  }
  /* hand-placed by drag-and-drop: accent rank + pin; click to release back to score order */
  li.task .rank.pinned { color: var(--accent); cursor: pointer; }
  li.task .rank.pinned::after { content: '📌'; font-size: 9px; margin-left: 2px; }
  /* in-list reorder target (Priority list) */
  #board.plist li.task.drop-before { box-shadow: inset 0 3px 0 0 var(--accent); }
  #board.plist li.task.drop-after { box-shadow: inset 0 -3px 0 0 var(--accent); }
  li.task .proj {
    font-size: 10px; padding: 1px 6px; border-radius: 5px; background: #eef4ff; color: #2b5fb8;
    white-space: nowrap; max-width: 150px; overflow: hidden; text-overflow: ellipsis;
  }
  li.task .energy.medium { background: #fff4e0; color: #b7791f; }
  li.task .energy.unset, li.task .est.unset { background: #fff; border: 1px dashed var(--line); color: var(--muted); }
  li.task .est {
    font-size: 10px; padding: 1px 6px; border-radius: 5px; background: #eef0f2; color: var(--muted);
    white-space: nowrap; font-variant-numeric: tabular-nums;
  }
  #board.plist li.task .energy, #board.plist li.task .est { cursor: pointer; }
  #board.plist li.task .energy:hover, #board.plist li.task .est:hover { outline: 1px solid var(--accent); }
  li.task input.estedit { width: 66px; font-size: 11px; padding: 1px 4px; border: 1px solid var(--accent); border-radius: 5px; font-family: inherit; }
  li.task .score.ai { background: #dcfce7; color: #166534; }
  #board.plist li.task .why { margin-left: 44px; }
  .ptotals {
    font-size: 11px; color: var(--muted); padding: 8px 14px; border-bottom: 1px solid var(--line);
    background: #fbfcfd; display: flex; gap: 14px; flex-wrap: wrap;
  }
  .ptotals b { color: var(--ink); font-weight: 650; }
  /* triage mode */
  #triage-backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,.34); z-index: 70;
  }
  #triage-backdrop[hidden] { display: none; }
  #triage {
    position: fixed; z-index: 71; top: 10vh; left: 50%; transform: translateX(-50%);
    width: 600px; max-width: 94vw; background: #fff; border-radius: 14px;
    box-shadow: 0 12px 40px rgba(0,0,0,.22); padding: 20px 22px 18px;
  }
  #triage[hidden] { display: none; }
  #triage .tg-progress { font-size: 11px; color: var(--muted); display: flex; justify-content: space-between; }
  #triage .tg-title { font-size: 17px; font-weight: 650; margin: 10px 0 4px; line-height: 1.35; overflow-wrap: anywhere; }
  #triage .tg-meta { font-size: 12px; color: var(--muted); margin-bottom: 8px; }
  #triage .tg-desc {
    font-size: 12px; color: var(--ink); background: #f8f9fb; border-radius: 8px; padding: 8px 10px;
    margin-bottom: 12px; max-height: 120px; overflow-y: auto; white-space: pre-wrap;
  }
  #triage .tg-desc:empty { display: none; }
  #triage .tg-selects { display: flex; gap: 8px; margin-bottom: 12px; }
  #triage .tg-selects select {
    flex: 1; border: 1px solid var(--line); border-radius: 7px; padding: 6px 8px; font-size: 13px;
    font-family: inherit; background: #fff;
  }
  #triage .tg-actions { display: flex; gap: 6px; flex-wrap: wrap; }
  #triage .tg-actions button {
    padding: 8px 12px; font-size: 12px; border: 1px solid var(--line); background: #fff;
    border-radius: 8px; cursor: pointer; color: var(--ink); font-family: inherit;
  }
  #triage .tg-actions button:hover { border-color: var(--accent); color: var(--accent); }
  #triage .tg-actions button.danger:hover { border-color: var(--p1); color: var(--p1); }
  #triage .tg-actions button kbd {
    font-family: inherit; font-size: 10px; color: var(--muted); background: #eef0f2;
    border-radius: 4px; padding: 0 4px; margin-right: 5px;
  }
  #triage .tg-done { text-align: center; padding: 26px 0 14px; font-size: 15px; }
  #triage .tg-foot { margin-top: 12px; font-size: 10px; color: var(--muted); }
  /* context-link chips (parsed from a description's CONTEXT: line) — drawer + triage card */
  .ctx-chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .ctx-chips:empty { display: none; }
  .dw-field .ctx-chips { margin-top: 2px; }
  .dw-field:has(> .ctx-chips:empty) { display: none; }
  #triage .ctx-chips { margin: -4px 0 12px; }
  .ctx-chip {
    display: inline-flex; align-items: center; gap: 4px; font-family: inherit; font-size: 11px;
    line-height: 1.4; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line);
    background: #fff; color: var(--muted); cursor: pointer; white-space: nowrap; max-width: 220px;
    overflow: hidden; text-overflow: ellipsis;
  }
  .ctx-chip:hover { border-color: var(--accent); color: var(--accent); }
  .ctx-chip.url { border-color: #b7e0c0; background: #eefcf1; color: var(--green); }
  .ctx-chip.task { border-color: #bcd4fb; background: #eef4ff; color: var(--accent); }
  .ctx-chip.path { border-color: var(--line); background: #eef0f2; color: var(--ink); }
  .ctx-chip.more { cursor: default; opacity: .65; }
  .ctx-chip.more:hover { border-color: var(--line); color: var(--muted); }
`;

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>My Tasks (live)</title>
<style>
${BOARD_CSS}
${EXTRA_CSS}
</style>
</head>
<body>
<header class="top">
  <div id="crumb" hidden><button id="crumb-back" title="Back to all projects (Esc)">← All projects</button></div>
  <h1><span id="h1-title">My Tasks</span> <span class="n" id="count">…</span><span id="status"></span></h1>
  <div class="sub" id="sub">loading…</div>
  <div class="chips" id="chips"></div>
  <div class="controls">
    <input id="search" type="search" placeholder="Filter tasks…" autocomplete="off">
    <div class="filters">
      <button data-f="priority" title="My prioritized list across all projects">Priority</button>
      <button data-f="today">Today</button>
      <button data-f="all" class="on">All</button>
      <button data-f="focus">Active</button>
      <button data-f="inbox">Inbox</button>
      <button data-f="someday">Someday</button>
      <button data-f="done">Done</button>
    </div>
    <div class="filters layout">
      <button data-l="projects" class="on">Projects</button>
      <button data-l="status">Status</button>
    </div>
    <label class="toggle"><input type="checkbox" id="showIcebox"> Show someday in All</label>
    <button id="triage-btn" class="addbtn" title="Triage inbox one task at a time (t)">⚡ Triage</button>
    <button id="add-toggle" class="addbtn">+ Add task</button>
  </div>
  <div class="addbar" id="addbar" hidden>
    <input id="add-title" placeholder="New task title…" autocomplete="off">
    <select id="add-project"><option value="">No Project</option></select>
    <select id="add-status">
      <option value="inbox">Inbox</option><option value="next">Next</option>
      <option value="in_progress">In progress</option><option value="waiting">Waiting</option>
      <option value="someday">Someday</option>
    </select>
    <select id="add-priority">
      <option value="2">P2</option><option value="1">P1</option><option value="3">P3</option>
    </select>
    <input id="add-due" type="date" title="Due date (optional)">
    <button id="add-submit">Add</button>
    <button id="add-cancel" class="ghost">Cancel</button>
  </div>
</header>
<div id="toasts"></div>
<div id="drawer-backdrop" hidden></div>
<aside id="drawer" hidden aria-label="Task details"></aside>
<div id="triage-backdrop" hidden></div>
<div id="triage" hidden aria-label="Inbox triage"></div>
<main id="board">
  <div class="empty" id="empty" hidden>No tasks match.</div>
</main>
<footer>LucidTasks · live board · auto-refreshes every 30s · / search · n add · t triage inbox · click a project name to open its board · Esc back · click a chip to filter · Priority = my ranked list (AI score, nightly; drag a row to pin it and everything above it in my order, click a 📌 rank to release; a status change releases too) · Today = 7-factor ranking</footer>
<script>
${CLIENT_CONSTANTS}

// done/cancelled aren't in the shared active-status maps — extend for the Done filter.
STATUS_META.done = STATUS_META.done || { label: 'Done', icon: '✓' };
STATUS_META.cancelled = STATUS_META.cancelled || { label: 'Cancelled', icon: '✕' };
if (STATUS_RANK.done === undefined) STATUS_RANK.done = 7;
if (STATUS_RANK.cancelled === undefined) STATUS_RANK.cancelled = 8;

// ---- state ---------------------------------------------------------------
let tasks = [];          // BoardTask[]
let projects = [];       // Project[]
const projectName = new Map();
let mode = 'all';
let loadedScope = '';              // '' = active statuses, 'done,cancelled' = Done filter scope
let showIcebox = false;
let layout = 'projects';           // 'projects' (default) | 'status' (kanban)
let projectView = null;            // project id or NO_PROJECT — swimlane drill-in (null = overview)
let chipFilter = null;             // 'status:<s>' | 'overdue' | 'dueToday' — top-chip filter (null = off)
let todayInfo = new Map();         // task id → {score, reasons, rank} from /api/next (Today mode)
let priorityInfo = new Map();      // task id → {rank, score, source, det_score, det_reasons, ai_reasoning} from /api/priority
let priorityMeta = null;           // {ai_scored_at} from /api/priority
let editingEstId = null;           // task id whose estimate input is open (Priority mode)
let triage = null;                 // {queue: [ids], i, acted} while inbox triage is open (null = closed)
let stats = null;                  // /api/stats payload for header chips
let editingDueId = null;           // task id whose due-date input is open
const pendingEdits = new Set();    // task ids with an edit in progress (poll won't clobber)
let lastSignature = '';            // model signature at last render() — polls skip if unchanged
let dragging = false;              // a card drag is in flight (poll won't clobber)
let draggedId = null;              // task id being dragged
// detail drawer
let drawerTaskId = null;           // open task id (null = closed)
let drawerTask = null;             // last-known full task for the open drawer
let drawerActivity = [];           // activity log entries for the open drawer
let replyPollTimer = null;         // short poll waiting on a kaya reorganize reply

const STATUS_OPTIONS = [...ACTIVE_STATUSES, 'done', 'cancelled'];

const board = document.getElementById('board');
const countEl = document.getElementById('count');
const subEl = document.getElementById('sub');
const statusEl = document.getElementById('status');
const chipsEl = document.getElementById('chips');
const toastsEl = document.getElementById('toasts');
const searchEl = document.getElementById('search');
const addbar = document.getElementById('addbar');
const addTitle = document.getElementById('add-title');
const addProject = document.getElementById('add-project');
const addStatus = document.getElementById('add-status');
const addPriority = document.getElementById('add-priority');
const addDue = document.getElementById('add-due');
const drawerEl = document.getElementById('drawer');
const backdropEl = document.getElementById('drawer-backdrop');
const crumbEl = document.getElementById('crumb');
const h1TitleEl = document.getElementById('h1-title');
const layoutFiltersEl = document.querySelector('.filters.layout');
const triageEl = document.getElementById('triage');
const triageBackdropEl = document.getElementById('triage-backdrop');

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function todayISO() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

const NO_PROJECT = '__none__';
const ICEBOX_KEY = () => {
  const p = projects.find(p => p.name.toLowerCase() === 'icebox');
  return p ? p.id : null;
};

function setStatus(msg) { statusEl.textContent = msg ? '· ' + msg : ''; }

function toast(msg, kind) {
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = msg;
  toastsEl.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 220);
  }, 2600);
}

// Toast with an action button (e.g. Undo). Stays ~6s so the action is reachable.
function toastAction(msg, actionLabel, onAction, kind) {
  const el = document.createElement('div');
  el.className = 'toast action' + (kind ? ' ' + kind : '');
  const span = document.createElement('span');
  span.textContent = msg;
  const btn = document.createElement('button');
  btn.className = 'toast-action';
  btn.textContent = actionLabel;
  let acted = false;
  const dismiss = () => { el.classList.remove('show'); setTimeout(() => el.remove(), 220); };
  btn.addEventListener('click', () => {
    if (acted) return;
    acted = true;
    dismiss();
    onAction();
  });
  el.appendChild(span);
  el.appendChild(btn);
  toastsEl.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(dismiss, 6000);
}

// ---- view-state persistence ----------------------------------------------
const PREFS_KEY = 'lt-board-prefs';
function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify({ layout, mode, showIcebox, chipFilter })); } catch (_) {}
}
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    if (p.layout === 'projects' || p.layout === 'status') layout = p.layout;
    if (p.mode === 'icebox') mode = 'someday';
    else if (['priority', 'today', 'all', 'focus', 'inbox', 'someday', 'done'].includes(p.mode)) mode = p.mode;
    if (typeof p.showIcebox === 'boolean') showIcebox = p.showIcebox;
    if (typeof p.chipFilter === 'string') chipFilter = p.chipFilter;
  } catch (_) {}
}
// Reflect restored state back into the header controls.
function syncControls() {
  document.querySelectorAll('.filters:not(.layout) button').forEach(x => x.classList.toggle('on', x.dataset.f === mode));
  document.querySelectorAll('.filters.layout button').forEach(x => x.classList.toggle('on', x.dataset.l === layout));
  document.getElementById('showIcebox').checked = showIcebox;
}

// ---- rendering -----------------------------------------------------------
function matchesMode(t) {
  if (mode === 'today') return todayInfo.has(t.id);
  if (mode === 'priority') return priorityInfo.has(t.id);
  if (mode === 'done') return t.status === 'done' || t.status === 'cancelled';
  if (mode === 'someday') return t.status === 'someday';
  if (mode === 'focus') return t.status === 'in_progress' || t.status === 'next' || t.status === 'waiting';
  if (mode === 'inbox') return t.status === 'inbox';
  // 'all': hide someday tasks unless opted in via showIcebox — or explicitly filtered to them
  return showIcebox || chipFilter === 'status:someday' || t.status !== 'someday';
}

function matchesChip(t) {
  if (!chipFilter) return true;
  const finished = t.status === 'done' || t.status === 'cancelled';
  if (chipFilter === 'overdue') return !finished && !!t.due_date && t.due_date < todayISO();
  if (chipFilter === 'dueToday') return !finished && t.due_date === todayISO();
  if (chipFilter.indexOf('status:') === 0) return t.status === chipFilter.slice(7);
  return true;
}

function projectOptions(selectedId) {
  let opts = '<option value="">No Project</option>';
  for (const p of projects) {
    opts += '<option value="' + esc(p.id) + '"' + (p.id === selectedId ? ' selected' : '') + '>' + esc(p.name) + '</option>';
  }
  return opts;
}

function renderTask(t) {
  const pr = t.priority || 3;
  const sm = STATUS_META[t.status] || { label: t.status, icon: '•' };
  const today = todayISO();
  const finished = t.status === 'done' || t.status === 'cancelled';
  const overdue = !finished && t.due_date && t.due_date < today;
  const dueToday = !finished && t.due_date === today;
  let dueControl;
  if (finished) {
    // Completed/cancelled date instead of a due-date affordance.
    const when = (t.completed_at || t.updated_at || '').slice(0, 10);
    dueControl = t.status === 'done'
      ? '<span class="donedate" title="Completed">✓ ' + esc(when) + '</span>'
      : '<span class="donedate x" title="Cancelled">✕ ' + esc(when) + '</span>';
  } else if (t.id === editingDueId) {
    dueControl = '<input class="dueedit" type="date" data-act="duesave" value="' + esc(t.due_date || '') + '">';
  } else if (t.due_date) {
    dueControl = '<span class="due' + (overdue ? ' overdue' : (dueToday ? ' today' : '')) + '" data-act="due" title="Click to change due date">' + esc(t.due_date) + '</span>';
  } else {
    dueControl = '<button class="adddue" data-act="due" title="Set due date">+due</button>';
  }
  const tagBadges = (t.context_tags || []).slice(0, 3).map(tag => '<span class="tag">' + esc(tag) + '</span>').join('');
  // Priority mode: the list exists to assess WHEN to schedule, so energy + estimate
  // are always visible and editable inline (click energy to cycle, click est to type).
  const pi = mode === 'priority' ? priorityInfo.get(t.id) : null;
  const rankSpan = pi
    ? (pi.manual_rank != null
      ? '<span class="rank pinned" data-act="unpin" title="Rank ' + pi.rank + ' — placed by you (drag to move · click to release to score order)">' + pi.rank + '</span>'
      : '<span class="rank" title="Rank ' + pi.rank + ' — drag to reorder">' + pi.rank + '</span>')
    : '';
  const projBadge = pi ? '<span class="proj" title="Project">' + esc(projectName.get(t.project_id) || 'No project') + '</span>' : '';
  const energyBadge = pi
    ? '<span class="energy ' + esc(t.energy_level || 'unset') + '" data-act="energy" title="Energy — click to cycle low → medium → high">' + esc(t.energy_level || 'energy?') + '</span>'
    : ((t.energy_level && t.energy_level !== 'medium')
      ? '<span class="energy ' + esc(t.energy_level) + '">' + esc(t.energy_level) + '</span>' : '');
  let estBadge = '';
  if (pi) {
    if (t.id === editingEstId) {
      estBadge = '<input class="estedit" type="number" min="1" step="5" placeholder="min" value="' + esc(t.estimated_minutes != null ? t.estimated_minutes : '') + '">';
    } else if (t.estimated_minutes) {
      estBadge = '<span class="est" data-act="estimate" title="Estimate — click to edit (minutes)">' + esc(fmtMin(t.estimated_minutes)) + '</span>';
    } else {
      estBadge = '<span class="est unset" data-act="estimate" title="Set time estimate (minutes)">+est</span>';
    }
  }
  const goalBadge = t.goal_id ? '<span class="goal">' + esc(t.goal_id) + '</span>' : '';
  // Today mode: show the scorer's verdict — score badge + why-line (project · reasons).
  // Priority mode: the ranking score (AI, nightly) + its reasoning; 7-factor when no AI score.
  const ti = mode === 'today' ? todayInfo.get(t.id) : null;
  let scoreBadge = '', whyLine = '';
  if (ti) {
    scoreBadge = '<span class="score" title="' + esc(ti.reasons.join(' · ') || 'no scoring factors hit') + '">' + ti.score + '</span>';
    whyLine = '<div class="why">' + esc((projectName.get(t.project_id) || 'No project') +
        (ti.reasons.length ? ' · ' + ti.reasons.join(' · ') : '')) + '</div>';
  } else if (pi) {
    const det = '7-factor: ' + pi.det_score + (pi.det_reasons.length ? ' (' + pi.det_reasons.join(' · ') + ')' : '');
    scoreBadge = '<span class="score' + (pi.source === 'ai' ? ' ai' : '') + '" title="' +
      esc(pi.source === 'ai' ? 'AI priority score (nightly rescore) · ' + det : det) + '">' + pi.score + '</span>';
    whyLine = '<div class="why">' + esc(pi.source === 'ai'
      ? (pi.ai_reasoning || 'AI-ranked')
      : (pi.det_reasons.length ? pi.det_reasons.join(' · ') : 'no scoring factors hit — not yet AI-ranked')) + '</div>';
  }
  const checkBtn = finished
    ? '<button class="check reopen" data-act="reopen" title="Reopen (→ Next)">↺</button>'
    : '<button class="check" data-act="done" title="Mark done">✓</button>';
  return '<li class="task p' + pr + (finished ? ' finished' : '') + '" draggable="true" data-id="' + esc(t.id) +
    '" data-status="' + esc(t.status) + '" data-priority="' + pr + '">' +
    rankSpan +
    checkBtn +
    '<span class="dot" data-act="status" title="' + esc(sm.label) + ' — click to cycle">' + esc(sm.icon) + '</span>' +
    '<span class="title" title="' + esc(t.title) + '">' + esc(t.title) + '</span>' +
    '<span class="badges">' + dueControl + projBadge + tagBadges + energyBadge + estBadge + goalBadge + '</span>' +
    scoreBadge +
    '<span class="prio p' + pr + '" data-act="priority" title="Priority ' + pr + ' — click to cycle">P' + pr + '</span>' +
    (finished ? '' : '<button class="trash" data-act="trash" title="Cancel task (soft-delete)">🗑</button>') +
    whyLine +
    '</li>';
}

/** True when columns are statuses (kanban): the status layout, or any project drill-in. */
function statusGrouping() {
  return projectView !== null || layout === 'status';
}

/** Today in the overview = one ranked lane (drill-in keeps its status columns). */
function todayLane() {
  return mode === 'today' && projectView === null;
}

/** Priority in the overview = one ranked LIST of Jm's tasks across all projects. */
function priorityLane() {
  return mode === 'priority' && projectView === null;
}

function fmtMin(m) {
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60), r = m % 60;
  return r ? h + 'h ' + r + 'm' : h + 'h';
}

// Totals bar for the Priority list — computed from the tasks actually shown so
// search / chip filters narrow the numbers too (the API's totals cover the whole lane).
function priorityTotalsHtml(arr) {
  const be = { high: [0, 0], medium: [0, 0], low: [0, 0], unset: [0, 0] };
  let minutes = 0, unest = 0, waiting = 0;
  for (const t of arr) {
    const b = be[t.energy_level || 'unset'];
    b[0]++;
    if (t.estimated_minutes) { minutes += t.estimated_minutes; b[1] += t.estimated_minutes; } else unest++;
    if (t.status === 'waiting') waiting++;
  }
  const seg = (k, label) => be[k][0]
    ? '<span>' + label + ' <b>' + be[k][0] + '</b>' + (be[k][1] ? ' · ' + fmtMin(be[k][1]) : '') + '</span>' : '';
  return '<div class="ptotals">' +
    '<span><b>' + arr.length + '</b> tasks</span>' +
    '<span>≈ <b>' + fmtMin(minutes) + '</b> estimated' + (unest ? ' <span title="No estimate yet — click +est on the row">(' + unest + ' unestimated)</span>' : '') + '</span>' +
    seg('high', '🔥 high') + seg('medium', '〰 medium') + seg('low', '🌙 low') + seg('unset', '? energy') +
    (waiting ? '<span>⏳ <b>' + waiting + '</b> waiting (listed last)</span>' : '') +
    '</div>';
}

function groupKeyOf(t) {
  if (todayLane()) return '__today__';
  if (priorityLane()) return '__priority__';
  return statusGrouping() ? t.status : (t.project_id || NO_PROJECT);
}

function render() {
  const q = searchEl.value.trim().toLowerCase();
  const iceboxId = ICEBOX_KEY();

  const groups = new Map();
  let shown = 0;
  for (const t of tasks) {
    if (projectView !== null && (t.project_id || NO_PROJECT) !== projectView) continue;
    if (!matchesMode(t)) continue;
    if (!matchesChip(t)) continue;
    if (q) {
      const hay = (t.title + ' ' + (t.goal_id || '') + ' ' + (projectName.get(t.project_id) || '') +
        ' ' + (t.context_tags || []).join(' ')).toLowerCase();
      if (!hay.includes(q)) continue;
    }
    // Hide Icebox-project tasks unless asked to show them — except when drilled into Icebox itself.
    if (!showIcebox && iceboxId && projectView !== iceboxId && (t.project_id || NO_PROJECT) === iceboxId) continue;
    const key = groupKeyOf(t);
    (groups.get(key) || groups.set(key, []).get(key)).push(t);
    shown++;
  }

  // Sort within each group: status rank, priority, due date, then id as a final
  // tie-break so identical data always renders in the same order (no jitter).
  // Done view instead sorts by most recently completed.
  for (const arr of groups.values()) {
    arr.sort((a, b) => {
      if (mode === 'today') {
        const ra = todayInfo.has(a.id) ? todayInfo.get(a.id).rank : 99;
        const rb = todayInfo.has(b.id) ? todayInfo.get(b.id).rank : 99;
        if (ra !== rb) return ra - rb;
        return a.id.localeCompare(b.id);
      }
      if (mode === 'priority') {
        const ra = priorityInfo.has(a.id) ? priorityInfo.get(a.id).rank : 9999;
        const rb = priorityInfo.has(b.id) ? priorityInfo.get(b.id).rank : 9999;
        if (ra !== rb) return ra - rb;
        return a.id.localeCompare(b.id);
      }
      if (mode === 'done') {
        const cc = (b.completed_at || b.updated_at || '').localeCompare(a.completed_at || a.updated_at || '');
        if (cc !== 0) return cc;
        return a.id.localeCompare(b.id);
      }
      const sr = (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9);
      if (sr !== 0) return sr;
      const pr = (a.priority || 3) - (b.priority || 3);
      if (pr !== 0) return pr;
      const dd = (a.due_date || '9999').localeCompare(b.due_date || '9999');
      if (dd !== 0) return dd;
      return a.id.localeCompare(b.id);
    });
  }

  const kanban = statusGrouping();
  const labelFor = (key) => {
    if (key === '__today__') return 'Today — ranked by the 7-factor scorer';
    if (key === '__priority__') return 'My prioritized list — all projects';
    if (kanban) return statusLabel(key);
    return key === NO_PROJECT ? 'No Project' : (projectName.get(key) || key);
  };

  // Order cards by a FIXED key, not live task-count — counting made cards jump
  // columns whenever any count changed. Kanban → the FULL fixed status list
  // (empty columns render too, as drop targets); projects layout → project
  // sort_order, then name, then id; "No Project" pinned last.
  const sortOrderOf = (key) => {
    const p = projects.find(x => x.id === key);
    return p ? (p.sort_order || 0) : 0;
  };
  let keys;
  if (todayLane()) {
    keys = ['__today__'];
  } else if (priorityLane()) {
    keys = ['__priority__'];
  } else if (kanban) {
    keys = mode === 'done'
      ? ['done', 'cancelled']
      : [...ACTIVE_STATUSES].sort((a, b) => (STATUS_RANK[a] ?? 9) - (STATUS_RANK[b] ?? 9));
  } else {
    keys = [...groups.keys()].sort((a, b) => {
      if (a === NO_PROJECT) return 1;
      if (b === NO_PROJECT) return -1;
      const so = sortOrderOf(a) - sortOrderOf(b);
      if (so !== 0) return so;
      const nameCmp = labelFor(a).localeCompare(labelFor(b));
      if (nameCmp !== 0) return nameCmp;
      return a.localeCompare(b);
    });
  }

  // Kanban = a true board: one row of N columns (not the projects masonry grid,
  // which auto-fills to viewport width and orphans the 5th status onto row 2).
  // The Today lane centers a single wide column via the .today-lane class.
  board.classList.toggle('today-lane', todayLane());
  board.classList.toggle('plist', priorityLane());
  board.style.gridTemplateColumns = (!todayLane() && !priorityLane() && kanban && keys.length > 0)
    ? 'repeat(' + keys.length + ', minmax(230px, 1fr))'
    : '';

  const html = keys.map(key => {
    const arr = groups.get(key) || [];
    const linkable = !kanban && !todayLane() && !priorityLane();
    const nameCls = 'pname' + (linkable ? ' link' : '');
    const nameTitle = linkable ? ' title="Open project board"' : '';
    return '<section class="card' + (arr.length === 0 ? ' col-empty' : '') + '" data-groupkey="' + esc(key) + '">' +
      '<header class="card-head"><span class="' + nameCls + '"' + nameTitle + '>' + esc(labelFor(key)) + '</span>' +
      '<span class="right"><span class="pcount">' + arr.length + '</span>' +
      '<button class="cardadd" title="Add task here">+</button></span></header>' +
      (key === '__priority__' ? priorityTotalsHtml(arr) : '') +
      '<ul class="tasks">' + arr.map(renderTask).join('') + '</ul></section>';
  }).join('');

  board.innerHTML = html + '<div class="empty" id="empty"' + (shown > 0 ? ' hidden' : '') + '>No tasks match.</div>';

  // Header reflects the drill-in state: project name + breadcrumb when inside a project.
  const inProject = projectView !== null;
  crumbEl.hidden = !inProject;
  layoutFiltersEl.style.display = inProject ? 'none' : '';   // grouping is fixed inside a project
  h1TitleEl.textContent = inProject
    ? (projectView === NO_PROJECT ? 'No Project' : (projectName.get(projectView) || projectView))
    : 'My Tasks';

  // Active count from stats so it stays correct while the Done scope is loaded.
  // Inside a project drill-in the count is scoped to that project, matching the h1.
  const active = inProject
    ? tasks.filter(t => (t.project_id || NO_PROJECT) === projectView &&
        t.status !== 'done' && t.status !== 'cancelled').length
    : (stats && stats.byStatus)
      ? ACTIVE_STATUSES.reduce((n, s) => n + (stats.byStatus[s] || 0), 0)
      : tasks.filter(t => t.status !== 'done' && t.status !== 'cancelled').length;
  countEl.textContent = active + ' active';
  subEl.textContent = inProject
    ? shown + ' shown · grouped by status'
    : priorityLane()
      ? shown + ' of my tasks · ranked by AI priority score' +
        (priorityMeta && priorityMeta.ai_scored_at ? ' (refreshed ' + fmtTs(priorityMeta.ai_scored_at) + ')' : ' (never refreshed — 7-factor only)') +
        ' · Kaya’s autonomous lane + Icebox hidden'
      : keys.length + (kanban ? ' statuses · ' : ' projects · ') + shown + ' shown';
  renderChips();
  lastSignature = modelSignature();   // record what's now on screen so idle polls can skip
}

// A cheap signature of everything render() reads from the data + view state.
// refresh() compares it to skip a no-op DOM rebuild on the 30s poll.
function modelSignature() {
  let s = layout + '|' + mode + '|' + (showIcebox ? 1 : 0) + '|' + searchEl.value + '|' + (editingDueId || '') +
    '|' + (projectView || '') + '|' + (chipFilter || '') + '||';
  for (const [id, ti] of todayInfo) s += id + '=' + ti.score + ',';
  s += '||' + (editingEstId || '') + '|';
  for (const [id, pi] of priorityInfo) s += id + '=' + pi.rank + '/' + pi.score + '/' + (pi.manual_rank == null ? '' : 'm') + ',';
  s += '||';
  for (const t of tasks) {
    s += t.id + '~' + t.status + '~' + (t.priority || 0) + '~' + (t.project_id || '') + '~' +
      (t.due_date || '') + '~' + t.title + '~' + (t.goal_id || '') + '~' +
      ((t.context_tags || []).join(',')) + '~' + (t.energy_level || '') + '~' + (t.estimated_minutes || '') + '~' + (t.completed_at || '') + ';';
  }
  s += '||';
  for (const p of projects) s += p.id + '#' + p.name + '#' + (p.sort_order || 0) + ';';
  return s;
}

// ---- data ----------------------------------------------------------------
function scopeOf(m) { return m === 'done' ? 'done,cancelled' : ''; }

async function load() {
  const scope = scopeOf(mode);
  const [tRes, pRes, sRes, nRes, prRes] = await Promise.all([
    fetch('/api/tasks' + (scope ? '?status=' + scope : '')), fetch('/api/projects'), fetch('/api/stats'),
    fetch('/api/next?top=10'), fetch('/api/priority'),
  ]);
  if (!tRes.ok || !pRes.ok) throw new Error('HTTP ' + tRes.status + '/' + pRes.status);
  tasks = (await tRes.json()).tasks;
  loadedScope = scope;
  projects = (await pRes.json()).projects;
  stats = sRes.ok ? await sRes.json() : null;
  todayInfo = new Map();
  if (nRes.ok) {
    const { next } = await nRes.json();
    next.forEach((n, i) => todayInfo.set(n.task.id, { score: n.score, reasons: n.reasons, rank: i }));
  }
  priorityInfo = new Map();
  priorityMeta = null;
  if (prRes.ok) {
    const pr = await prRes.json();
    priorityMeta = { ai_scored_at: pr.ai_scored_at };
    for (const it of pr.items) {
      priorityInfo.set(it.task.id, {
        rank: it.rank, score: it.score, source: it.source,
        det_score: it.det_score, det_reasons: it.det_reasons, ai_reasoning: it.ai_reasoning,
        manual_rank: it.manual_rank == null ? null : it.manual_rank,
      });
    }
  }
  projectName.clear();
  for (const p of projects) projectName.set(p.id, p.name);
  populateAddProjects();
}

// Chips are clickable filters. Counts are computed client-side from the loaded
// tasks under the same scoping the board applies (project drill-in, hidden
// Icebox project), so the chip numbers always match what filtering can show.
function renderChips() {
  const parts = [];
  const chipBtn = (key, cls, inner) =>
    '<button class="chip ' + cls + (chipFilter === key ? ' active' : '') + '" data-chip="' + key +
    '" title="Click to filter">' + inner + '</button>';

  const byStatus = {};
  let overdue = 0, dueToday = 0;
  const today = todayISO();
  const iceboxId = ICEBOX_KEY();
  for (const t of tasks) {
    if (projectView !== null && (t.project_id || NO_PROJECT) !== projectView) continue;
    if (projectView === null && !showIcebox && iceboxId && (t.project_id || NO_PROJECT) === iceboxId) continue;
    if (t.status === 'done' || t.status === 'cancelled') continue;
    byStatus[t.status] = (byStatus[t.status] || 0) + 1;
    if (t.due_date && t.due_date < today) overdue++;
    else if (t.due_date === today) dueToday++;
  }

  for (const s of ACTIVE_STATUSES) {
    const n = byStatus[s] || 0;
    const key = 'status:' + s;
    if (!n && chipFilter !== key) continue;   // keep the active chip visible even at 0
    const sm = STATUS_META[s] || { label: s, icon: '•' };
    parts.push(chipBtn(key, 's-' + s, sm.icon + ' ' + n + ' ' + esc(sm.label.toLowerCase())));
  }
  if (overdue || chipFilter === 'overdue') parts.push(chipBtn('overdue', 'overdue', '⚠ ' + overdue + ' overdue'));
  if (dueToday || chipFilter === 'dueToday') parts.push(chipBtn('dueToday', '', '📅 ' + dueToday + ' due today'));
  if (projectView === null && stats && stats.completedThisWeek) {
    parts.push('<button class="chip done" data-chip="donemode" title="Show completed tasks">✓ ' +
      stats.completedThisWeek + ' done this week</button>');
  }
  if (chipFilter) parts.push('<button class="chip clear" data-chip="__clear__">✕ clear filter</button>');
  chipsEl.innerHTML = parts.join('');
}

chipsEl.addEventListener('click', (e) => {
  const b = e.target.closest('[data-chip]');
  if (!b) return;
  const key = b.dataset.chip;
  if (key === 'donemode') {
    // Same path as the Done filter button — it owns the done/cancelled scope load.
    const doneBtn = document.querySelector('.filters:not(.layout) button[data-f="done"]');
    if (doneBtn) doneBtn.click();
    return;
  }
  chipFilter = (key === '__clear__' || chipFilter === key) ? null : key;
  // A chip filter only makes sense against the full active scope — leave Done/Inbox/etc.
  if (chipFilter && mode !== 'all') {
    const allBtn = document.querySelector('.filters:not(.layout) button[data-f="all"]');
    if (allBtn) { allBtn.click(); return; }   // its handler saves prefs + re-renders
  }
  savePrefs();
  render();
});

function populateAddProjects() {
  const cur = addProject.value;
  addProject.innerHTML = '<option value="">No Project</option>' +
    projects.map(p => '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>').join('');
  addProject.value = cur;
}

async function refresh() {
  try {
    await load();
    // Don't clobber an in-progress interaction: skip the visual re-render while an
    // inline edit / drawer is open (pendingEdits) or a drag is in flight. Data is
    // still refreshed; the next commit re-renders it. And even when free, only
    // re-render if the model actually changed — an idle poll shouldn't reflow the
    // board (which used to make open dropdowns vanish and cards twitch).
    const guarded = pendingEdits.size > 0 || dragging;
    if (!guarded && modelSignature() !== lastSignature) render();
    setStatus('updated ' + new Date().toLocaleTimeString());
  } catch (e) {
    setStatus('refresh failed: ' + e.message);
  }
}

// ---- events --------------------------------------------------------------
searchEl.addEventListener('input', render);
for (const b of document.querySelectorAll('.filters:not(.layout) button')) {
  b.addEventListener('click', async () => {
    document.querySelectorAll('.filters:not(.layout) button').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    mode = b.dataset.f;
    // One filter dimension at a time: a chip filter only survives on the All
    // scope (incl. the chip handler's programmatic switch to All).
    if (mode !== 'all') chipFilter = null;
    savePrefs();
    // Done filter needs a different fetch scope (done/cancelled aren't loaded by default).
    if (scopeOf(mode) !== loadedScope) {
      setStatus('loading…');
      try {
        await load();
        setStatus('updated ' + new Date().toLocaleTimeString());
      } catch (e) {
        setStatus('load failed: ' + e.message);
      }
    }
    render();
  });
}
for (const b of document.querySelectorAll('.filters.layout button')) {
  b.addEventListener('click', () => {
    document.querySelectorAll('.filters.layout button').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    layout = b.dataset.l;
    savePrefs();
    render();
  });
}
document.getElementById('showIcebox').addEventListener('change', (e) => {
  showIcebox = e.target.checked;
  savePrefs();
  render();
});

// ---- edits ---------------------------------------------------------------
async function patchTask(id, updates) {
  const idx = tasks.findIndex(x => x.id === id);
  if (idx < 0) return;
  const before = { ...tasks[idx] };
  Object.assign(tasks[idx], updates);   // optimistic
  render();
  try {
    const res = await fetch('/api/tasks/' + encodeURIComponent(id), {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(updates),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const { task } = await res.json();
    const j = tasks.findIndex(x => x.id === id);
    if (j >= 0) tasks[j] = task;        // reconcile with server truth
    render();
    setStatus('saved ' + new Date().toLocaleTimeString());
  } catch (e) {
    const j = tasks.findIndex(x => x.id === id);
    if (j >= 0) tasks[j] = before;       // revert on failure
    render();
    toast('Save failed — reverted: ' + e.message, 'err');
  }
}

async function markDone(id, li) {
  if (li) li.classList.add('removing');
  await new Promise(r => setTimeout(r, 220));
  const idx = tasks.findIndex(x => x.id === id);
  const before = idx >= 0 ? tasks[idx] : null;
  const priorStatus = before ? before.status : 'next';
  if (idx >= 0) tasks.splice(idx, 1);    // done leaves the active board
  render();
  try {
    const res = await fetch('/api/tasks/' + encodeURIComponent(id), {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'done' }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    toastAction('Marked done', 'Undo', () => undoStatusChange(id, priorStatus), 'ok');
  } catch (e) {
    if (before) { tasks.push(before); render(); }
    toast('Mark-done failed — restored: ' + e.message, 'err');
  }
}

// Soft-delete: status→cancelled (leaves the active board, stays in the DB) with
// an Undo toast that re-PATCHes the captured prior status.
async function softDelete(id, li) {
  const idx = tasks.findIndex(x => x.id === id);
  if (idx < 0) return;
  const before = { ...tasks[idx] };
  const priorStatus = before.status;
  if (li) li.classList.add('removing');
  await new Promise(r => setTimeout(r, 220));
  const j = tasks.findIndex(x => x.id === id);
  if (j >= 0) tasks.splice(j, 1);
  render();
  try {
    const res = await fetch('/api/tasks/' + encodeURIComponent(id), {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'cancelled' }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    toastAction('Cancelled “' + before.title + '”', 'Undo', () => undoStatusChange(id, priorStatus));
  } catch (e) {
    if (!tasks.find(x => x.id === id)) tasks.push(before);
    render();
    toast('Delete failed — restored: ' + e.message, 'err');
  }
}

async function undoStatusChange(id, priorStatus) {
  try {
    const res = await fetch('/api/tasks/' + encodeURIComponent(id), {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: priorStatus }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const { task } = await res.json();
    if (!tasks.find(x => x.id === id)) tasks.push(task);
    render();
    toast('Restored', 'ok');
  } catch (e) {
    toast('Undo failed: ' + e.message, 'err');
  }
}

function cycleStatus(cur) {
  const i = ACTIVE_STATUSES.indexOf(cur);
  return ACTIVE_STATUSES[(i + 1) % ACTIVE_STATUSES.length];
}

board.addEventListener('click', (e) => {
  // Click a project name in the overview → drill into that project's swimlane board.
  const pn = e.target.closest('.pname.link');
  if (pn) {
    const card = pn.closest('.card');
    if (card) openProject(card.dataset.groupkey);
    return;
  }
  const addBtn = e.target.closest('.cardadd');
  if (addBtn) {
    const key = addBtn.closest('.card').dataset.groupkey;
    if (key === '__today__') openAdd({ status: 'next' });
    else if (projectView !== null) openAdd({ status: key, project_id: projectView === NO_PROJECT ? '' : projectView });
    else if (layout === 'status') openAdd({ status: key });
    else openAdd({ project_id: key === NO_PROJECT ? '' : key });
    return;
  }
  // Single-click a task title → open the detail drawer (the new rename path lives there).
  const titleEl = e.target.closest('.title');
  if (titleEl) {
    const li = titleEl.closest('li.task');
    if (li) openDrawer(li.dataset.id);
    return;
  }
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const li = el.closest('li.task');
  if (!li) return;
  const id = li.dataset.id;
  const t = tasks.find(x => x.id === id);
  if (!t) return;
  switch (el.dataset.act) {
    case 'done': markDone(id, li); break;
    case 'unpin': setManualRank(id, null); break;
    case 'reopen': patchTask(id, { status: 'next' }); toast('Reopened → Next', 'ok'); break;
    case 'trash': softDelete(id, li); break;
    case 'status': patchTask(id, { status: cycleStatus(t.status) }); break;
    case 'priority': patchTask(id, { priority: ((t.priority || 3) % 3) + 1 }); break;
    case 'energy': {
      const cycle = { low: 'medium', medium: 'high', high: 'low' };
      patchTask(id, { energy_level: cycle[t.energy_level] || 'low' });
      break;
    }
    case 'estimate': {
      if (editingEstId && editingEstId !== id) pendingEdits.delete(editingEstId);
      editingEstId = id;
      pendingEdits.add(id);
      render();
      const inp = board.querySelector('li.task[data-id="' + CSS.escape(id) + '"] .estedit');
      if (inp) { inp.focus(); inp.select(); }
      break;
    }
    case 'due': {
      // Release any previous due-edit — otherwise its id stays in pendingEdits
      // forever and the 30s poll never re-renders again.
      if (editingDueId && editingDueId !== id) pendingEdits.delete(editingDueId);
      editingDueId = id;
      pendingEdits.add(id);
      render();
      const inp = board.querySelector('li.task[data-id="' + CSS.escape(id) + '"] .dueedit');
      if (inp) { inp.focus(); if (inp.showPicker) { try { inp.showPicker(); } catch (_) {} } }
      break;
    }
  }
});

board.addEventListener('change', (e) => {
  const due = e.target.closest('.dueedit');
  if (due) {
    const id = due.closest('li.task').dataset.id;
    editingDueId = null;
    pendingEdits.delete(id);
    patchTask(id, { due_date: due.value || null });
  }
  const est = e.target.closest('.estedit');
  if (est) {
    const id = est.closest('li.task').dataset.id;
    const n = parseInt(est.value, 10);
    editingEstId = null;
    pendingEdits.delete(id);
    if (est.value === '') patchTask(id, { estimated_minutes: null });
    else if (Number.isInteger(n) && n > 0) patchTask(id, { estimated_minutes: n });
    else { toast('Estimate must be a positive number of minutes', 'err'); render(); }
  }
});

// Enter commits the estimate (via change); Escape cancels without saving.
board.addEventListener('keydown', (e) => {
  const est = e.target.closest && e.target.closest('.estedit');
  if (!est) return;
  if (e.key === 'Enter') { e.preventDefault(); est.blur(); }
  else if (e.key === 'Escape') {
    e.preventDefault();
    if (editingEstId) { pendingEdits.delete(editingEstId); editingEstId = null; render(); }
  }
});

board.addEventListener('blur', (e) => {
  if (!e.target.closest) return;
  if (e.target.closest('.dueedit')) {
    if (editingDueId) {        // blurred without picking → cancel
      pendingEdits.delete(editingDueId);
      editingDueId = null;
      render();
    }
  }
  if (e.target.closest('.estedit')) {
    // change (if any) has already fired and cleared editingEstId; a plain blur cancels.
    if (editingEstId) {
      pendingEdits.delete(editingEstId);
      editingEstId = null;
      render();
    }
  }
}, true);

// ---- drag-and-drop: move cards between project cards / status columns -----
board.addEventListener('dragstart', (e) => {
  const li = e.target.closest('li.task');
  if (!li) return;
  draggedId = li.dataset.id;
  dragging = true;
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', draggedId); } catch (_) {}
  }
  li.classList.add('dragging');
  startDragAutoScroll();
});

board.addEventListener('dragend', (e) => {
  const li = e.target.closest('li.task');
  if (li) li.classList.remove('dragging');
  dragging = false;
  draggedId = null;
  stopDragAutoScroll();
  board.querySelectorAll('.card.drop-target').forEach(c => c.classList.remove('drop-target'));
  clearReorderMarks();
});

// ---- auto-scroll while dragging -------------------------------------------------
// Native HTML5 drag barely edge-scrolls and often swallows the wheel, so a long list
// can't be dragged past the viewport. While a drag is live, hovering near the top or
// bottom edge scrolls the window — faster the closer to (or past) the edge. The last
// pointer Y is kept when the pointer leaves the page, so dragging out above the
// window keeps scrolling up until it comes back or the drag ends.
const DRAG_SCROLL_ZONE = 90;    // px from the viewport edge where scrolling starts
const DRAG_SCROLL_MAX = 28;     // px per frame at (or beyond) the edge
let dragPointerY = null;
let dragScrollRaf = 0;

function dragScrollStep() {
  if (!dragging) { dragScrollRaf = 0; return; }
  if (dragPointerY != null) {
    const h = window.innerHeight;
    const zone = Math.min(DRAG_SCROLL_ZONE, h / 4);
    let v = 0;
    if (dragPointerY < zone) v = -Math.min(1, (zone - dragPointerY) / zone);
    else if (dragPointerY > h - zone) v = Math.min(1, (dragPointerY - (h - zone)) / zone);
    if (v) window.scrollBy(0, Math.round(v * v * Math.sign(v) * DRAG_SCROLL_MAX) || Math.sign(v));
  }
  dragScrollRaf = requestAnimationFrame(dragScrollStep);
}
function startDragAutoScroll() {
  dragPointerY = null;
  if (!dragScrollRaf) dragScrollRaf = requestAnimationFrame(dragScrollStep);
}
function stopDragAutoScroll() {
  dragPointerY = null;
  if (dragScrollRaf) cancelAnimationFrame(dragScrollRaf);
  dragScrollRaf = 0;
}
document.addEventListener('dragover', (e) => { if (dragging) dragPointerY = e.clientY; });
document.addEventListener('drop', stopDragAutoScroll);

// ---- Priority list: drag a row to a new slot (persists as manual_rank) --------
function clearReorderMarks() {
  board.querySelectorAll('li.task.drop-before, li.task.drop-after').forEach(li => li.classList.remove('drop-before', 'drop-after'));
}

/** Drop position relative to the row under the pointer: 'before' (top half) / 'after'. */
function reorderSide(li, e) {
  const r = li.getBoundingClientRect();
  return (e.clientY - r.top) < r.height / 2 ? 'before' : 'after';
}

/**
 * Release a pinned task back to score order (click its 📌 rank). Ranks come from the
 * server's placement, so after the PATCH lands we reload the list instead of trusting
 * a local guess.
 */
async function setManualRank(id, rank) {
  const t = tasks.find(x => x.id === id);
  if (!t) return;
  const before = t.manual_rank;
  t.manual_rank = rank;
  const pi = priorityInfo.get(id);
  if (pi) pi.manual_rank = rank;
  render();
  try {
    const res = await fetch('/api/tasks/' + encodeURIComponent(id), {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ manual_rank: rank }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    await load();   // server placement is the truth (pins interact with each other)
    render();
    setStatus('saved ' + new Date().toLocaleTimeString());
    toast(rank == null ? 'Released to score order' : 'Moved to #' + rank, 'ok');
  } catch (e) {
    t.manual_rank = before;
    try { await load(); } catch (_) {}
    render();
    toast('Reorder failed — reverted: ' + e.message, 'err');
  }
}

/**
 * Drop the dragged row at 1-based \`slot\`. The pinned block is the hand-ordered TOP
 * of the list, so a drop pins the dragged row AND every row above it (those are the
 * rows Jm just looked past and accepted). Rows already pinned below the slot stay
 * pinned and shift down. Sends the whole prefix in one POST so the ordinals are
 * rewritten together; the server placement is reloaded afterwards.
 */
async function dropAtSlot(id, slot) {
  const current = [...priorityInfo.entries()]
    .sort((a, b) => a[1].rank - b[1].rank)
    .map(([tid, pi]) => ({ id: tid, pinned: pi.manual_rank != null }))
    .filter(r => r.id !== id);
  current.splice(slot - 1, 0, { id, pinned: true });
  const ids = current.filter((r, i) => i < slot || r.pinned).map(r => r.id);
  // Optimistic: show the new order now; server placement replaces it after the POST.
  current.forEach((r, i) => {
    const pi = priorityInfo.get(r.id);
    if (!pi) return;
    pi.rank = i + 1;
    if (i < slot || r.pinned) pi.manual_rank = i + 1;
    const t = tasks.find(x => x.id === r.id);
    if (t && (i < slot || r.pinned)) t.manual_rank = i + 1;
  });
  render();
  try {
    const res = await fetch('/api/priority/pins', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    await load();
    render();
    setStatus('saved ' + new Date().toLocaleTimeString());
    toast('Moved to #' + slot + ' · top ' + ids.length + ' pinned in your order', 'ok');
  } catch (e) {
    try { await load(); } catch (_) {}
    render();
    toast('Reorder failed — reverted: ' + e.message, 'err');
  }
}

board.addEventListener('dragover', (e) => {
  if (!draggedId) return;
  if (priorityLane()) {
    const li = e.target.closest('li.task');
    if (!li || li.dataset.id === draggedId) { clearReorderMarks(); return; }
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const side = reorderSide(li, e);
    if (!li.classList.contains('drop-' + side)) {
      clearReorderMarks();
      li.classList.add('drop-' + side);
    }
    return;
  }
  const card = e.target.closest('.card');
  if (!card) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  if (!card.classList.contains('drop-target')) {
    board.querySelectorAll('.card.drop-target').forEach(c => c.classList.remove('drop-target'));
    card.classList.add('drop-target');
  }
});

board.addEventListener('dragleave', (e) => {
  if (priorityLane()) {
    const li = e.target.closest('li.task');
    if (li && !li.contains(e.relatedTarget)) li.classList.remove('drop-before', 'drop-after');
    return;
  }
  const card = e.target.closest('.card');
  if (card && !card.contains(e.relatedTarget)) card.classList.remove('drop-target');
});

board.addEventListener('drop', (e) => {
  if (!draggedId) return;
  if (priorityLane()) {
    const li = e.target.closest('li.task');
    clearReorderMarks();
    if (!li || li.dataset.id === draggedId) return;
    e.preventDefault();
    const id = draggedId;
    const side = reorderSide(li, e);
    const from = priorityInfo.get(id), to = priorityInfo.get(li.dataset.id);
    if (!from || !to) return;
    // Slot in the list WITHOUT the dragged row, then 1-based.
    let slot = to.rank - (from.rank < to.rank ? 1 : 0);
    if (side === 'after') slot++;
    if (slot === from.rank && from.manual_rank != null) return;   // dropped where it already is
    dropAtSlot(id, slot);
    return;
  }
  const card = e.target.closest('.card');
  if (!card) return;
  e.preventDefault();
  card.classList.remove('drop-target');
  const id = draggedId;
  const key = card.dataset.groupkey;
  if (key === '__today__') return;   // the ranked lane is not a drop target
  const t = tasks.find(x => x.id === id);
  if (!t) return;
  if (statusGrouping()) {
    if (t.status !== key) patchTask(id, { status: key });   // natural kanban move
  } else {
    const newProj = key === NO_PROJECT ? null : key;
    if ((t.project_id || null) !== newProj) patchTask(id, { project_id: newProj });
  }
});

// ---- quick-add -----------------------------------------------------------
function openAdd(prefill) {
  addbar.hidden = false;
  prefill = prefill || {};
  if (prefill.project_id !== undefined) addProject.value = prefill.project_id;
  else if (projectView !== null) addProject.value = projectView === NO_PROJECT ? '' : projectView;
  if (prefill.status !== undefined) {
    addStatus.value = prefill.status;
    // Prefill from a Done/Cancelled column has no matching option — fall back.
    if (addStatus.value !== prefill.status) addStatus.value = 'inbox';
  }
  addTitle.focus();
}
function closeAdd() { addbar.hidden = true; addTitle.value = ''; addDue.value = ''; }

async function submitAdd() {
  const title = addTitle.value.trim();
  if (!title) { addTitle.focus(); return; }
  const body = { title, status: addStatus.value || 'inbox', priority: Number(addPriority.value) || 2 };
  if (addProject.value) body.project_id = addProject.value;
  if (addDue.value) body.due_date = addDue.value;
  try {
    const res = await fetch('/api/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    if (res.status !== 201) throw new Error('HTTP ' + res.status);
    const { task } = await res.json();
    addTitle.value = '';
    addDue.value = '';
    toast('Added “' + task.title + '”', 'ok');
    await refresh();   // pull the fresh list incl. the new task
    addTitle.focus();  // ready for the next add
  } catch (e) {
    toast('Add failed: ' + e.message, 'err');
  }
}

document.getElementById('add-toggle').addEventListener('click', () => {
  if (addbar.hidden) openAdd(); else closeAdd();
});
document.getElementById('add-submit').addEventListener('click', submitAdd);
document.getElementById('add-cancel').addEventListener('click', closeAdd);
addTitle.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); submitAdd(); }
  else if (e.key === 'Escape') { e.preventDefault(); closeAdd(); }
});

// ---- detail drawer -------------------------------------------------------
function statusLabel(s) {
  if (STATUS_META[s]) return STATUS_META[s].label;
  if (s === 'done') return 'Done';
  if (s === 'cancelled') return 'Cancelled';
  return s;
}
function statusOptionsHtml(sel) {
  return STATUS_OPTIONS.map(s =>
    '<option value="' + esc(s) + '"' + (s === sel ? ' selected' : '') + '>' + esc(statusLabel(s)) + '</option>'
  ).join('');
}
function fmtTs(ts) {
  if (!ts) return '—';
  try { const d = new Date(ts); return isNaN(d.getTime()) ? ts : d.toLocaleString(); } catch (_) { return ts; }
}
function splitCsv(s) {
  return String(s).split(',').map(x => x.trim()).filter(Boolean);
}

// ---- context links (parsed out of a description's CONTEXT: line) ---------
// Pure helper: given a description string, returns an ordered, de-duplicated
// list of {kind:'url'|'path'|'task', text, target} — every openable reference
// found anywhere in the text (not just on a CONTEXT: line), so a plain-pasted
// path/URL/task-id still becomes a chip. Kaya's task-context standard puts
// these on a CONTEXT: line, but this stays permissive about where they sit.
function extractContextLinks(description) {
  const text = String(description == null ? '' : description);
  const claimed = [];   // [start, end) ranges already turned into a link
  const isClaimed = (s, e) => claimed.some(r => s < r[1] && e > r[0]);
  const claim = (s, e) => claimed.push([s, e]);
  const seen = new Set();
  const out = [];
  const add = (kind, raw, target) => {
    const key = kind + ':' + target;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind: kind, text: raw, target: target });
  };

  // NOTE: this whole client script is itself the body of the HTML template
  // literal string (see the giant HTML constant it lives in), so every
  // backslash below is doubled — the outer literal's own string-escape pass
  // collapses a double backslash to a single one before this ever reaches the
  // browser as real JS. A single backslash here would silently vanish (see
  // the "bad escape blanks the whole board" test).
  let m;
  const urlRe = /https?:\\/\\/[^\\s)>\\]"']+/g;
  while ((m = urlRe.exec(text))) {
    const raw = m[0].replace(/[.,;:!?)\\]]+$/, '');
    claim(m.index, m.index + raw.length);
    add('url', raw, raw);
  }

  const taskRe = /\\bt-[a-z0-9]{8}-[a-z0-9]{5}\\b|\\bmanual-[a-z0-9][a-z0-9-]*\\b/gi;
  while ((m = taskRe.exec(text))) {
    if (isClaimed(m.index, m.index + m[0].length)) continue;
    claim(m.index, m.index + m[0].length);
    add('task', m[0], m[0]);
  }

  const knownDirs = new Set(['skills', 'Tools', 'Data', 'Desktop', 'Documents', 'USER', 'docs', 'lib', 'src', 'memory']);

  // Home-dir paths (~/... and /Users/...) may contain spaces, unicode, and a
  // trailing parenthetical (Jm's Obsidian vault: "WIG 2026 Q4 Brainstorm —
  // Kaya Notes 2026-09-11.md (sections 3-4)", "Buy Sheet (2026-09-19).md"), so
  // they get their own greedy matcher that runs to the next hard delimiter
  // (" | ", a newline, or end of string) instead of stopping at the first space.
  const widePathRe = /~\\/[^\\n]+|\\/Users\\/[^\\n]+/g;
  while ((m = widePathRe.exec(text))) {
    if (isClaimed(m.index, m.index + m[0].length)) continue;
    let raw = m[0].split(' | ')[0];
    // A trailing " (...)" is a note about the file, not part of it, ONLY when
    // stripping it still leaves a real filename (has an extension) — so
    // "...2026-09-11.md (sections 3-4)" drops the note, but a mid-filename
    // parenthetical like "...Buy Sheet (2026-09-19).md" (extension comes
    // AFTER the paren, so there's no trailing "(...)" at all) is untouched.
    const parenMatch = raw.match(/^(.*)\\s\\([^()]*\\)$/);
    if (parenMatch && /\\.[A-Za-z0-9]{1,8}$/.test(parenMatch[1])) {
      raw = parenMatch[1];
    }
    raw = raw.replace(/[,:.;\\s]+$/, '');
    if (!raw) continue;
    const segs = raw.split('/').filter(Boolean);
    const lastSeg = segs[segs.length - 1] || '';
    const hasExt = /\\.[A-Za-z0-9]{1,8}$/.test(lastSeg);
    if (!hasExt && !raw.endsWith('/')) continue;
    claim(m.index, m.index + raw.length);
    add('path', raw, raw);
  }

  // Generic /abs/path with >=2 segments, no spaces (source paths, etc.); kept
  // only when the last segment looks like a file (has an extension) or the
  // path runs through a recognizable dir, so we don't turn every bare "/" in
  // prose into a chip.
  const pathRe = /~\\/[^\\s,|)]+|\\/[A-Za-z0-9_.-]+(?:\\/[A-Za-z0-9_.-]+)+/g;
  while ((m = pathRe.exec(text))) {
    if (isClaimed(m.index, m.index + m[0].length)) continue;
    let raw = m[0].replace(/[)\\,|:]+$/, '');
    let target = raw;
    const lineMatch = raw.match(/^(.*):(\\d+)$/);
    if (lineMatch) target = lineMatch[1];
    const segs = target.split('/').filter(Boolean);
    const lastSeg = segs[segs.length - 1] || '';
    const hasExt = /\\.[A-Za-z0-9]{1,8}$/.test(lastSeg);
    const hasKnownDir = segs.some(seg => knownDirs.has(seg));
    if (!hasExt && !hasKnownDir) continue;
    claim(m.index, m.index + raw.length);
    add('path', raw, target);
  }

  return out;
}

function ctxChipLabel(link) {
  if (link.kind === 'task') return link.target;
  if (link.kind === 'url') {
    let label = link.target;
    try { const u = new URL(link.target); label = u.host + (u.pathname !== '/' ? u.pathname : ''); } catch (_) {}
    return label.length > 40 ? label.slice(0, 37) + '…' : label;
  }
  const segs = link.target.split('/').filter(Boolean);
  const tail = segs.slice(-2).join('/');
  const prefix = link.target.startsWith('~') ? '~/' : '…/';
  return prefix + tail;
}

function ctxChipHtml(link) {
  const icon = link.kind === 'url' ? '🔗' : (link.kind === 'task' ? '☑' : '📄');
  return '<button type="button" class="ctx-chip ' + link.kind + '" data-ctx-kind="' + link.kind +
    '" data-ctx-target="' + esc(link.target) + '" title="' + esc(link.text) + '">' +
    icon + ' ' + esc(ctxChipLabel(link)) + '</button>';
}

function contextChipsHtml(description, max) {
  const links = extractContextLinks(description);
  if (links.length === 0) return '';
  const limit = max || links.length;
  const shown = links.slice(0, limit).map(ctxChipHtml).join('');
  const extra = links.length - limit;
  return shown + (extra > 0 ? '<span class="ctx-chip more">+' + extra + '</span>' : '');
}

// Drawer "Context" strip: a stable-id wrapper so a description save can refresh
// just this field. Hidden via CSS (.dw-field:has(> .ctx-chips:empty)) when the
// description carries no openable reference — the common human-quick-capture case.
function contextFieldHtml(description) {
  return '<div class="dw-field full" id="dw-context-field"><label>Context</label>' +
    '<div class="ctx-chips">' + contextChipsHtml(description) + '</div></div>';
}

function onCtxChipClick(e) {
  const btn = e.target.closest('.ctx-chip');
  if (!btn || !btn.dataset.ctxKind) return;
  const kind = btn.dataset.ctxKind;
  const target = btn.dataset.ctxTarget;
  if (kind === 'url') { window.open(target, '_blank', 'noopener'); return; }
  if (kind === 'task') { openDrawer(target); return; }
  fetch('/api/open?path=' + encodeURIComponent(target))
    .then(async res => {
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || ('HTTP ' + res.status));
      toast('Opened ' + target, 'ok');
    })
    .catch(e => toast('Could not open: ' + e.message, 'err'));
}

function wireCtxChips(container) {
  container.querySelectorAll('.ctx-chip[data-ctx-kind]').forEach(b => b.addEventListener('click', onCtxChipClick));
}

async function openDrawer(id) {
  if (replyPollTimer) { clearInterval(replyPollTimer); replyPollTimer = null; }
  drawerTaskId = id;
  pendingEdits.add(id);                 // poll won't clobber the board while open
  drawerEl.hidden = false;
  backdropEl.hidden = false;
  drawerEl.innerHTML =
    '<div class="drawer-head"><span style="flex:1;padding:6px;color:var(--muted)">Loading…</span>' +
    '<button id="dw-close" title="Close (Esc)">✕</button></div>';
  document.getElementById('dw-close').addEventListener('click', closeDrawer);
  requestAnimationFrame(() => { drawerEl.classList.add('show'); backdropEl.classList.add('show'); });
  try {
    const res = await fetch('/api/tasks/' + encodeURIComponent(id));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (drawerTaskId !== id) return;    // closed / switched while loading
    drawerTask = data.task;
    drawerActivity = data.activity || [];
    buildDrawer();
  } catch (e) {
    toast('Could not load task: ' + e.message, 'err');
    closeDrawer();
  }
}

function closeDrawer() {
  if (replyPollTimer) { clearInterval(replyPollTimer); replyPollTimer = null; }
  const id = drawerTaskId;
  drawerTaskId = null; drawerTask = null; drawerActivity = [];
  if (id) pendingEdits.delete(id);
  drawerEl.classList.remove('show');
  backdropEl.classList.remove('show');
  setTimeout(() => { drawerEl.hidden = true; backdropEl.hidden = true; }, 200);
}

function drawerMetaHtml(t) {
  return 'Created: ' + esc(fmtTs(t.created_at)) + '<br>' +
    'Updated: ' + esc(fmtTs(t.updated_at)) +
    (t.started_at ? '<br>Started: ' + esc(fmtTs(t.started_at)) : '') +
    (t.completed_at ? '<br>Completed: ' + esc(fmtTs(t.completed_at)) : '') +
    '<br>Goal: ' + esc(t.goal_id || '—') + ' · ID: ' + esc(t.id);
}

function buildDrawer() {
  const t = drawerTask;
  if (!t) return;
  const energy = t.energy_level || '';
  const estmin = (t.estimated_minutes != null) ? t.estimated_minutes : '';
  const tags = (t.context_tags || []).join(', ');
  const labels = (t.labels || []).join(', ');
  drawerEl.innerHTML =
    '<div class="drawer-head">' +
      '<input id="dw-title" value="' + esc(t.title) + '" maxlength="1000">' +
      '<button id="dw-close" title="Close (Esc)">✕</button>' +
    '</div>' +
    '<div class="drawer-body">' +
      '<div class="dw-grid">' +
        '<div class="dw-field full"><label>Description</label><textarea id="dw-description" placeholder="Add a description…">' + esc(t.description || '') + '</textarea></div>' +
        contextFieldHtml(t.description) +
        '<div class="dw-field"><label>Status</label><select id="dw-status">' + statusOptionsHtml(t.status) + '</select></div>' +
        '<div class="dw-field"><label>Priority</label><select id="dw-priority">' +
          [1,2,3].map(p => '<option value="' + p + '"' + (p === (t.priority || 2) ? ' selected' : '') + '>P' + p + '</option>').join('') +
        '</select></div>' +
        '<div class="dw-field full"><label>Project</label><select id="dw-project">' + projectOptions(t.project_id) + '</select></div>' +
        '<div class="dw-field"><label>Energy</label><select id="dw-energy">' +
          ['', 'low', 'medium', 'high'].map(en => '<option value="' + en + '"' + (en === energy ? ' selected' : '') + '>' + (en || '—') + '</option>').join('') +
        '</select></div>' +
        '<div class="dw-field"><label>Est. minutes</label><input id="dw-estmin" type="number" min="1" step="1" value="' + esc(estmin) + '"></div>' +
        '<div class="dw-field"><label>Due date</label><input id="dw-due" type="date" value="' + esc(t.due_date || '') + '"></div>' +
        '<div class="dw-field"><label>Scheduled</label><input id="dw-sched" type="date" value="' + esc(t.scheduled_date || '') + '"></div>' +
        '<div class="dw-field full"><label>Context tags (comma-separated)</label><input id="dw-tags" value="' + esc(tags) + '"></div>' +
        '<div class="dw-field full"><label>Labels (comma-separated)</label><input id="dw-labels" value="' + esc(labels) + '"></div>' +
      '</div>' +
      '<div class="dw-meta" id="dw-meta">' + drawerMetaHtml(t) + '</div>' +
      '<div class="dw-section">' +
        '<h4>Comments</h4>' +
        '<div id="dw-thread"></div>' +
        '<div class="dw-composer">' +
          '<textarea id="dw-comment" placeholder="Tell Kaya what to do — e.g. “move to Next and bump to P1”…"></textarea>' +
          '<button id="dw-comment-send">Comment &amp; reorganize</button>' +
        '</div>' +
      '</div>' +
      '<div class="dw-danger"><button id="dw-delete">Delete permanently</button></div>' +
    '</div>';
  wireDrawer();
  renderThread();
}

function wireDrawer() {
  document.getElementById('dw-close').addEventListener('click', closeDrawer);
  wireCtxChips(drawerEl);
  const onField = (elId, field, transform) => {
    const el = document.getElementById(elId);
    if (!el) return;
    el.addEventListener('change', () => drawerSaveField(field, transform(el), el));
  };
  onField('dw-title', 'title', el => el.value.trim());
  onField('dw-description', 'description', el => el.value);
  onField('dw-status', 'status', el => el.value);
  onField('dw-priority', 'priority', el => Number(el.value));
  onField('dw-project', 'project_id', el => el.value || null);
  onField('dw-energy', 'energy_level', el => el.value || null);
  onField('dw-estmin', 'estimated_minutes', el => el.value === '' ? null : Number(el.value));
  onField('dw-due', 'due_date', el => el.value || null);
  onField('dw-sched', 'scheduled_date', el => el.value || null);
  onField('dw-tags', 'context_tags', el => splitCsv(el.value));
  onField('dw-labels', 'labels', el => splitCsv(el.value));
  document.getElementById('dw-comment-send').addEventListener('click', submitComment);
  document.getElementById('dw-comment').addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submitComment(); }
  });
  document.getElementById('dw-delete').addEventListener('click', deletePermanently);
}

async function drawerSaveField(field, value, el) {
  const id = drawerTaskId;
  if (!id) return;
  if (field === 'title' && !value) { revertField(field, el); return; }   // no blank titles
  const body = {}; body[field] = value;
  try {
    const res = await fetch('/api/tasks/' + encodeURIComponent(id), {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errj = await res.json().catch(() => ({}));
      throw new Error(errj.error || ('HTTP ' + res.status));
    }
    const { task } = await res.json();
    drawerTask = task;
    syncBoardModel(task);
    const meta = document.getElementById('dw-meta');
    if (meta) meta.innerHTML = drawerMetaHtml(task);
    if (field === 'description') {
      const cf = document.getElementById('dw-context-field');
      if (cf) { cf.outerHTML = contextFieldHtml(task.description); wireCtxChips(drawerEl); }
    }
    setStatus('saved ' + new Date().toLocaleTimeString());
  } catch (e) {
    revertField(field, el);
    toast('Save failed: ' + e.message, 'err');
  }
}

function revertField(field, el) {
  const t = drawerTask;
  if (!t) return;
  if (field === 'context_tags') el.value = (t.context_tags || []).join(', ');
  else if (field === 'labels') el.value = (t.labels || []).join(', ');
  else if (field === 'estimated_minutes') el.value = (t.estimated_minutes != null) ? t.estimated_minutes : '';
  else if (field === 'priority') el.value = String(t.priority || 2);
  else if (field === 'project_id') el.value = t.project_id || '';
  else el.value = (t[field] != null) ? t[field] : '';
}

// Keep the board's local model + DOM in sync after a drawer edit / reorg. A task
// that left the loaded scope (active vs done/cancelled) leaves the board.
function syncBoardModel(task) {
  const idx = tasks.findIndex(x => x.id === task.id);
  const finished = (task.status === 'done' || task.status === 'cancelled');
  const inScope = loadedScope ? finished : !finished;
  if (!inScope) {
    if (idx >= 0) tasks.splice(idx, 1);
  } else if (idx >= 0) {
    tasks[idx] = task;
  } else {
    tasks.push(task);
  }
  render();
}

function syncDrawerFields(t) {
  const set = (elId, val) => {
    const el = document.getElementById(elId);
    if (!el || el === document.activeElement) return;   // don't clobber a focused field
    el.value = val;
  };
  set('dw-title', t.title);
  set('dw-description', t.description || '');
  set('dw-status', t.status);
  set('dw-priority', String(t.priority || 2));
  set('dw-project', t.project_id || '');
  set('dw-energy', t.energy_level || '');
  set('dw-estmin', (t.estimated_minutes != null) ? t.estimated_minutes : '');
  set('dw-due', t.due_date || '');
  set('dw-sched', t.scheduled_date || '');
  set('dw-tags', (t.context_tags || []).join(', '));
  set('dw-labels', (t.labels || []).join(', '));
}

function countKaya(activity) {
  return (activity || []).filter(a => a.action === 'comment' && a.actor === 'kaya').length;
}

function fmtVal(v) {
  if (v === null || v === undefined || v === '') return '∅';
  return String(v);
}

function activityLine(a) {
  const when = fmtTs(a.created_at);
  if (a.action === 'created') return 'Created · ' + when;
  if (a.action === 'deleted') return 'Deleted · ' + when;
  if (a.action === 'recurrence_created') return 'Recurrence created · ' + when;
  let summary = a.action;
  try {
    const ch = JSON.parse(a.changes || '{}');
    const parts = Object.keys(ch).filter(k => k !== 'updated_at').map(k => {
      const v = ch[k];
      if (v && typeof v === 'object' && ('from' in v) && ('to' in v)) return k + ': ' + fmtVal(v.from) + ' → ' + fmtVal(v.to);
      return k;
    });
    if (parts.length) summary = parts.join(', ');
  } catch (_) {}
  const actor = (a.actor && a.actor !== 'user') ? ' (' + a.actor + ')' : '';
  return summary + actor + ' · ' + when;
}

function renderThread() {
  const el = document.getElementById('dw-thread');
  if (!el) return;
  const entries = (drawerActivity || []).slice().reverse();   // oldest first, reads top→bottom
  if (entries.length === 0) { el.innerHTML = '<div class="dw-empty">No activity yet.</div>'; return; }
  el.innerHTML = entries.map(a => {
    if (a.action === 'comment') {
      let text = '';
      try { text = (JSON.parse(a.changes || '{}').text) || ''; } catch (_) { text = a.changes || ''; }
      const who = a.actor === 'kaya' ? 'kaya' : 'user';
      return '<div class="dw-bubble ' + who + '">' + esc(text) + '</div>';
    }
    return '<div class="dw-sys">' + esc(activityLine(a)) + '</div>';
  }).join('');
  el.scrollTop = el.scrollHeight;
}

async function submitComment() {
  const id = drawerTaskId;
  if (!id) return;
  const ta = document.getElementById('dw-comment');
  const sendBtn = document.getElementById('dw-comment-send');
  const text = ta.value.trim();
  if (!text) { ta.focus(); return; }
  sendBtn.disabled = true;
  // optimistic user bubble (server returns the canonical row on the next poll)
  drawerActivity = drawerActivity.concat([{ action: 'comment', actor: 'user', changes: JSON.stringify({ text }), created_at: new Date().toISOString() }]);
  renderThread();
  ta.value = '';
  const baselineKaya = countKaya(drawerActivity);
  try {
    const res = await fetch('/api/tasks/' + encodeURIComponent(id) + '/comments', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }),
    });
    if (res.status !== 201) {
      const errj = await res.json().catch(() => ({}));
      throw new Error(errj.error || ('HTTP ' + res.status));
    }
    setStatus('Kaya is reorganizing…');
    pollForReply(id, baselineKaya);
  } catch (e) {
    toast('Comment failed: ' + e.message, 'err');
  } finally {
    sendBtn.disabled = false;
  }
}

// Short poll (~4s, ≤2min) until a new kaya comment lands, then sync fields + board.
function pollForReply(id, baselineKaya) {
  if (replyPollTimer) { clearInterval(replyPollTimer); replyPollTimer = null; }
  let elapsed = 0;
  const stepMs = 4000, maxMs = 120000;
  replyPollTimer = setInterval(async () => {
    elapsed += stepMs;
    if (drawerTaskId !== id) { clearInterval(replyPollTimer); replyPollTimer = null; return; }
    try {
      const res = await fetch('/api/tasks/' + encodeURIComponent(id));
      if (res.ok) {
        const data = await res.json();
        if (drawerTaskId !== id) return;
        drawerActivity = data.activity || [];
        renderThread();
        if (countKaya(drawerActivity) > baselineKaya) {
          drawerTask = data.task;
          syncDrawerFields(data.task);
          const meta = document.getElementById('dw-meta');
          if (meta) meta.innerHTML = drawerMetaHtml(data.task);
          syncBoardModel(data.task);
          setStatus('Kaya updated this task');
          clearInterval(replyPollTimer); replyPollTimer = null;
        }
      }
    } catch (_) {}
    if (elapsed >= maxMs && replyPollTimer) {
      clearInterval(replyPollTimer); replyPollTimer = null;
      setStatus('reorg timed out');
    }
  }, stepMs);
}

async function deletePermanently() {
  const id = drawerTaskId;
  if (!id) return;
  if (!confirm('Permanently delete this task? This cannot be undone.')) return;
  try {
    const res = await fetch('/api/tasks/' + encodeURIComponent(id), { method: 'DELETE' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const idx = tasks.findIndex(x => x.id === id);
    if (idx >= 0) tasks.splice(idx, 1);
    closeDrawer();
    render();
    toast('Deleted permanently', 'ok');
  } catch (e) {
    toast('Delete failed: ' + e.message, 'err');
  }
}

// ---- inbox triage (keyboard-first, one task at a time) --------------------
// Oldest-first burn-down of the inbox. Scoped to the open project inside a
// drill-in; excludes the hidden Icebox project in the overview.
function triageQueue() {
  const iceboxId = ICEBOX_KEY();
  return tasks
    .filter(t => t.status === 'inbox')
    .filter(t => projectView === null
      ? !(iceboxId && (t.project_id || NO_PROJECT) === iceboxId)
      : (t.project_id || NO_PROJECT) === projectView)
    .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''))
    .map(t => t.id);
}

function openTriage() {
  const queue = triageQueue();
  if (queue.length === 0) { toast('Inbox is empty — nothing to triage', 'ok'); return; }
  triage = { queue, i: 0, acted: 0 };
  triageEl.hidden = false;
  triageBackdropEl.hidden = false;
  renderTriage();
}

function closeTriage() {
  triage = null;
  triageEl.hidden = true;
  triageBackdropEl.hidden = true;
}

/** Current queue entry that is still an inbox task (edits elsewhere auto-skip). */
function triageCurrent() {
  if (!triage) return null;
  while (triage.i < triage.queue.length) {
    const t = tasks.find(x => x.id === triage.queue[triage.i]);
    if (t && t.status === 'inbox') return t;
    triage.i++;
  }
  return null;
}

function ageDays(iso) {
  if (!iso) return '?';
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000));
}

function renderTriage() {
  if (!triage) return;
  const t = triageCurrent();
  if (!t) {
    triageEl.innerHTML =
      '<div class="tg-progress"><span>Inbox triage</span><span>' + triage.acted + ' triaged</span></div>' +
      '<div class="tg-done">🎉 Inbox zero in this scope.</div>' +
      '<div class="tg-actions"><button data-tact="quit"><kbd>Esc</kbd>Close</button></div>';
    wireTriage();
    return;
  }
  const remaining = triage.queue.length - triage.i;
  triageEl.innerHTML =
    '<div class="tg-progress"><span>Inbox triage — ' + remaining + ' remaining</span><span>' + triage.acted + ' triaged</span></div>' +
    '<div class="tg-title">' + esc(t.title) + '</div>' +
    '<div class="tg-meta">' + esc(projectName.get(t.project_id) || 'No project') + ' · P' + (t.priority || 2) +
      ' · added ' + ageDays(t.created_at) + 'd ago' + (t.due_date ? ' · due ' + esc(t.due_date) : '') +
      (t.manual_rank != null ? ' · 📌 pinned in Priority (any status change releases it)' : '') + '</div>' +
    '<div class="tg-desc">' + esc((t.description || '').slice(0, 400)) + '</div>' +
    '<div class="ctx-chips">' + contextChipsHtml(t.description, 4) + '</div>' +
    '<div class="tg-selects">' +
      '<select id="tg-project" title="Move to project">' + projectOptions(t.project_id) + '</select>' +
      '<select id="tg-priority" title="Priority">' +
        [1,2,3].map(p => '<option value="' + p + '"' + (p === (t.priority || 2) ? ' selected' : '') + '>P' + p + '</option>').join('') +
      '</select>' +
    '</div>' +
    '<div class="tg-actions">' +
      '<button data-tact="next"><kbd>N</kbd>Next</button>' +
      '<button data-tact="waiting"><kbd>W</kbd>Waiting</button>' +
      '<button data-tact="someday"><kbd>S</kbd>Someday</button>' +
      '<button data-tact="done"><kbd>D</kbd>Done</button>' +
      '<button data-tact="cancel" class="danger"><kbd>X</kbd>Cancel</button>' +
      '<button data-tact="skip"><kbd>→</kbd>Skip</button>' +
      '<button data-tact="edit"><kbd>E</kbd>Open</button>' +
    '</div>' +
    '<div class="tg-foot">N/W/S/D/X set status · 1/2/3 priority · → skip · E full editor · Esc close</div>';
  wireTriage();
}

function wireTriage() {
  triageEl.querySelectorAll('[data-tact]').forEach(b => b.addEventListener('click', () => triageAct(b.dataset.tact)));
  wireCtxChips(triageEl);
  const proj = document.getElementById('tg-project');
  if (proj) proj.addEventListener('change', () => triagePatch({ project_id: proj.value || null }, false));
  const prio = document.getElementById('tg-priority');
  if (prio) prio.addEventListener('change', () => triagePatch({ priority: Number(prio.value) }, false));
}

async function triagePatch(updates, advance) {
  const t = triageCurrent();
  if (!t) return;
  try {
    const res = await fetch('/api/tasks/' + encodeURIComponent(t.id), {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(updates),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const { task } = await res.json();
    const j = tasks.findIndex(x => x.id === t.id);
    if (j >= 0) tasks[j] = task;
    if (advance) {
      triage.acted++;
      triage.i++;
      if (updates.status) {
        toastAction('→ ' + statusLabel(updates.status) + ': ' + t.title.slice(0, 40), 'Undo',
          () => undoStatusChange(t.id, 'inbox'), 'ok');
      }
    }
    render();
    renderTriage();
  } catch (e) {
    toast('Triage save failed: ' + e.message, 'err');
  }
}

function triageAct(act) {
  if (!triage) return;
  if (act === 'quit') { closeTriage(); return; }
  if (act === 'skip') { triage.i++; renderTriage(); return; }
  if (act === 'edit') { const t = triageCurrent(); closeTriage(); if (t) openDrawer(t.id); return; }
  const map = { next: 'next', waiting: 'waiting', someday: 'someday', done: 'done', cancel: 'cancelled' };
  if (map[act]) triagePatch({ status: map[act] }, true);
}

document.getElementById('triage-btn').addEventListener('click', openTriage);
triageBackdropEl.addEventListener('click', closeTriage);

// ---- project drill-in routing (hash-based: deep-linkable, back/forward work) ----
function openProject(key) { location.hash = 'p=' + encodeURIComponent(key); }
function exitProject() { location.hash = ''; }
function projectFromHash() {
  const m = location.hash.match(/^#p=(.+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}
window.addEventListener('hashchange', () => {
  const pv = projectFromHash();
  if (pv !== projectView) { projectView = pv; render(); }
});
document.getElementById('crumb-back').addEventListener('click', exitProject);

backdropEl.addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => {
  // Triage owns the keyboard while open (except when typing in its selects).
  if (triage) {
    if (e.key === 'Escape') { e.preventDefault(); closeTriage(); return; }
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    const keyActs = { n: 'next', w: 'waiting', s: 'someday', d: 'done', x: 'cancel', e: 'edit' };
    if (keyActs[k]) { e.preventDefault(); triageAct(keyActs[k]); return; }
    if (e.key === 'ArrowRight' || k === 'k') { e.preventDefault(); triageAct('skip'); return; }
    if (k === '1' || k === '2' || k === '3') { e.preventDefault(); triagePatch({ priority: Number(k) }, false); return; }
    return;
  }
  if (e.key === 'Escape') {
    if (drawerTaskId) { closeDrawer(); return; }
    if (document.activeElement === searchEl && searchEl.value) { searchEl.value = ''; render(); return; }
    if (projectView !== null) { exitProject(); return; }
    return;
  }
  if (drawerTaskId) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = (document.activeElement && document.activeElement.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (e.key === '/') { e.preventDefault(); searchEl.focus(); }
  else if (e.key === 'n') { e.preventDefault(); openAdd(); }
  else if (e.key === 't') { e.preventDefault(); openTriage(); }
});

loadPrefs();
syncControls();
projectView = projectFromHash();   // honor a deep link before first paint
refresh();
setInterval(refresh, 30000);
</script>
</body>
</html>`;

// ============================================================================
// Server entrypoint
// ============================================================================

if (import.meta.main) {
  // Acquire the long-lived singleton ONCE and hold it for process lifetime.
  const db = getTaskDB();
  db.getRawDb().exec("PRAGMA busy_timeout=5000"); // belt-and-suspenders; constructor sets it too

  // Wire the real QueueManager archive hook (fire-and-forget install; failure is non-fatal).
  installRealQueueArchiveHook().catch((err) => {
    console.warn("[BoardServer] queue reverse-sync hook install failed:", err);
  });

  // Remote access is opt-in and never unauthenticated: a non-loopback bind
  // without a token is a hard startup failure, not a warning. An explicit
  // BOARD_TOKEN env enforces auth even on loopback (testable + belt-and-
  // suspenders); the secrets.json token only activates for remote binds, so
  // local browsing stays cookie-free once the secret exists.
  const bind = loadBoardBind();
  const authToken = bind === HOST ? (process.env.BOARD_TOKEN || null) : loadBoardToken();
  if (bind !== HOST && authToken === null) {
    console.error(
      "[BoardServer] BOARD_BIND=" + bind + " requires a token (env BOARD_TOKEN or " +
      "lucidtasks_board_token in ~/.claude/secrets.json). Refusing to expose the board unauthenticated.",
    );
    process.exit(1);
  }

  const server = Bun.serve({
    hostname: bind,
    port: PORT,
    fetch: async (req) => {
      const auth = checkBoardAuth(req, authToken);
      if (!auth.ok) return new Response("unauthorized", { status: 401 });
      try {
        const res = await handleRequest(req);
        if (auth.setCookie) res.headers.set("set-cookie", auth.setCookie);
        return res;
      } catch (err) {
        console.error("[BoardServer] handler error:", err);
        return new Response(
          `internal error: ${err instanceof Error ? err.message : String(err)}`,
          { status: 500 },
        );
      }
    },
  });

  console.log(
    `LucidTasks live board → http://${bind}:${server.port}` +
    (authToken ? " (token auth ON)" : ""),
  );
}

export { HTML };
