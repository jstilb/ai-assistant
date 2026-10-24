/**
 * TaskOutcome.ts — the "Task Outcome Card" contract.
 *
 * What came of a task: headline, where the work is (links), whether it was
 * checked and merged, and what is left for Jm. Stored as a JSON string in the
 * `tasks.outcome` column. Pure module, except `createForJmTasks` (creates child tasks).
 */

import { z } from "zod";
import { recordFailure } from "../../../../lib/core/FailureLog.ts";
import { generateTaskId, inheritedContextLines, type Task, type TaskDB } from "./TaskDB.ts";

const MAX_FOR_JM_ITEMS = 20;

export const OutcomeLinkKind = z.enum(["path", "repo", "url", "task", "branch", "commit"]);
// path   = absolute or ~/ file path (opens via the board's existing /api/open)
// repo   = repo-relative path inside ~/.claude; `ref` = branch/sha holding it while not on main
// url    = http(s) URL
// task   = LucidTasks task id (opens that task's drawer)
// branch = git branch with the work (board shows `git diff main...<branch>`)
// commit = git sha on main (board shows `git show <sha>`)
export const OutcomeLinkSchema = z.object({
  kind: OutcomeLinkKind,
  target: z.string().trim().min(1),
  label: z.string().trim().min(1).max(40).optional(), // short role label, e.g. "Report", "Tool"
  ref: z.string().trim().min(1).optional(), // kind "repo" only
});
export const ForJmItemSchema = z.object({
  text: z.string().trim().min(1).max(300),
  taskId: z.string().optional(), // set once the child task exists
});
export const OutcomeSchema = z.object({
  v: z.literal(1),
  headline: z.string().trim().min(1).max(200), // ask writers for <= 140 chars (HEADLINE_TARGET)
  links: z.array(OutcomeLinkSchema).max(20).default([]),
  noArtifact: z.string().trim().min(1).max(300).optional(), // why there is nothing to link
  verify: z
    .object({
      verdict: z.enum(["pass", "fail", "uncertain", "skipped"]),
      note: z.string().max(600).optional(),
    })
    .optional(),
  merge: z
    .object({
      state: z.enum(["merged", "pending", "deferred", "failed", "none"]),
      branch: z.string().optional(),
      sha: z.string().optional(),
    })
    .optional(),
  check: z.string().trim().min(1).max(300).optional(), // one command or one step for Jm
  forJm: z.array(ForJmItemSchema).max(20).default([]),
  details: z.string().max(12000).optional(), // full report, folded by default
  by: z.string().min(1), // actor that recorded it
  at: z.string().min(1), // ISO timestamp
  source: z.enum(["executor", "cli", "board", "system", "backfill"]),
});
export type Outcome = z.infer<typeof OutcomeSchema>;
export type OutcomeLink = z.infer<typeof OutcomeLinkSchema>;
export type ForJmItem = z.infer<typeof ForJmItemSchema>;
export const HEADLINE_TARGET = 140;
export const HUMAN_CLOSE_ACTORS: ReadonlySet<string> = new Set(["board", "telegram"]);

/** Never throws. null input -> {outcome:null}; bad JSON / schema -> {outcome:null, error}. */
export function readOutcome(raw: string | null | undefined): { outcome: Outcome | null; error?: string } {
  if (raw === null || raw === undefined || raw === "") return { outcome: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { outcome: null, error: `outcome is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  const result = OutcomeSchema.safeParse(parsed);
  if (!result.success) return { outcome: null, error: `outcome has the wrong shape: ${result.error.message}` };
  return { outcome: result.data };
}

/** Validates with OutcomeSchema; THROWS on invalid. Returns the JSON string for the tasks.outcome column. */
export function serializeOutcome(o: Outcome): string {
  return JSON.stringify(OutcomeSchema.parse(o));
}

/** null when acceptable for an agent close; else a one-line reason. */
export function agentOutcomeProblem(o: Outcome | null): string | null {
  if (!o) return "no outcome recorded";
  if (o.headline.trim() === "") return "outcome headline is empty";
  if (o.links.length === 0 && !(o.noArtifact && o.noArtifact.trim() !== "")) {
    return "outcome has no links and no noArtifact reason";
  }
  return null;
}

export class OutcomeRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutcomeRequiredError";
  }
}

/** Guess a link kind from its target: url, task id, commit sha (7-40 hex), absolute/~ path, else repo-relative. */
export function inferLinkKind(target: string): z.infer<typeof OutcomeLinkKind> {
  const t = target.trim();
  if (/^https?:\/\//i.test(t)) return "url";
  if (/^t-[a-z0-9]+-[a-z0-9]+$/i.test(t)) return "task";
  if (/^[0-9a-f]{7,40}$/i.test(t)) return "commit";
  if (t.startsWith("/") || t.startsWith("~/")) return "path";
  return "repo";
}

/** Build a link from a bare target. Throws on an empty target; label is kept only when non-empty. */
export function linkFromTarget(target: string, label?: string): z.infer<typeof OutcomeLinkSchema> {
  let t = target.trim();
  if (t === "") throw new Error("linkFromTarget: empty target");
  // An explicit prefix forces the kind: commit:<sha> branch:<name> task:<id> repo:<path> url:<url>.
  let kind: z.infer<typeof OutcomeLinkKind> | undefined;
  const prefixed = /^(commit|branch|task|repo|url):(.*)$/s.exec(t);
  if (prefixed) {
    kind = OutcomeLinkKind.parse(prefixed[1]);
    t = prefixed[2].trim();
    if (t === "") throw new Error(`linkFromTarget: empty target after "${prefixed[1]}:" prefix`);
  }
  const k = kind ?? inferLinkKind(t);
  const l = label?.trim();
  return l ? { kind: k, target: t, label: l } : { kind: k, target: t };
}

/**
 * Create each "for Jm" item as its own task: a child of `parent`, status `inbox`, disposition
 * `needs-jm`, same project. Returns the items with `taskId` set. Idempotent: when an open or
 * done child of this parent already has the same title (case-insensitive, trimmed) its id is
 * reused, so a re-engagement that re-delivers never duplicates. Blank items are dropped.
 */
export function createForJmTasks(db: TaskDB, parent: Task, items: string[]): ForJmItem[] {
  const existing = db
    .getSubtasks(parent.id)
    .filter((t) => t.status !== "cancelled")
    .map((t) => ({ key: t.title.trim().toLowerCase(), id: t.id }));
  const out: ForJmItem[] = [];
  const nonBlank = items.filter((raw) => raw.trim() !== "").length;
  if (nonBlank > MAX_FOR_JM_ITEMS) {
    recordFailure({
      source: "executor:outcome",
      error: `createForJmTasks over cap: dropped ${nonBlank - MAX_FOR_JM_ITEMS} items`,
      context: { parentId: parent.id, dropped: nonBlank - MAX_FOR_JM_ITEMS },
    });
  }
  for (const raw of items) {
    if (out.length >= MAX_FOR_JM_ITEMS) break; // OutcomeSchema.forJm limit
    const text = raw.trim().slice(0, 300).trim();
    if (text === "") continue;
    const title = text.slice(0, 200).trim();
    const key = title.toLowerCase();
    let match = existing.find((e) => e.key === key);
    if (!match) {
      // Explicit id: createTask's own title+project dedup would otherwise hand back an UNRELATED
      // task. Only ever reuse a child of THIS parent (the `existing` list above).
      const created = db.createTask({
        id: generateTaskId(),
        title,
        description:
          `WHAT: ${text}\nFROM: outcome of ${parent.id} "${parent.title}"\n` +
          inheritedContextLines(parent.id, parent.description),
        status: "inbox",
        parent_task_id: parent.id,
        project_id: parent.project_id,
        disposition: "needs-jm",
      });
      if (created.parent_task_id !== parent.id) {
        throw new Error(`createForJmTasks: created task ${created.id} is not a child of ${parent.id}`);
      }
      match = { key, id: created.id };
      existing.push(match);
    }
    out.push({ text, taskId: match.id });
  }
  return out;
}

function clip(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/**
 * A valid outcome for a bookkeeping close that has no artifact (queue sync, escalation closed, ...).
 * source "system", at = now. Headline and noArtifact are clipped to the schema limits; never throws
 * on long input.
 */
export function systemOutcome(opts: { by: string; headline: string; noArtifact: string; links?: OutcomeLink[] }): Outcome {
  return {
    v: 1,
    headline: clip(opts.headline, 200) || "Closed by system",
    links: (opts.links ?? []).slice(0, 20),
    noArtifact: clip(opts.noArtifact, 300) || "bookkeeping close",
    forJm: [],
    by: opts.by,
    at: new Date().toISOString(),
    source: "system",
  };
}
