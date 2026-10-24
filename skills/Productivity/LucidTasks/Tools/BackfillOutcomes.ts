/**
 * BackfillOutcomes.ts — one-time backfill of Task Outcome Cards.
 *
 * Drafts an outcome for recently closed (done) and delivered (waiting) tasks that have none,
 * from the comments, completed-event note and description they already carry.
 *
 *   1. Deterministic extraction (pure, exported): executor comment shapes -> merge state,
 *      commit/branch/path links, verify verdict, and the source text.
 *   2. ONE LLM call per task (Inference.ts, level "standard") drafts headline / deliverables /
 *      check / forJm from that text ONLY. Parsed defensively; on failure a deterministic
 *      headline is used and the task is counted as an LLM fallback.
 *   3. Deliverables are kept only when they appear verbatim in the source text AND exist.
 *
 * Writes touch ONLY the `outcome` column (db.updateTask with no status change). Default is DRY RUN.
 *
 * Usage: bun BackfillOutcomes.ts [--since 2026-09-23] [--apply] [--limit N] [--ids t-a,t-b]
 *                                [--db <path>] [--backup <path>] [--json]
 *
 * Safety: before a live --apply, snapshot the DB with `--backup <path>` (SQLite VACUUM INTO; the file
 * must not exist) or by hand: sqlite3 <db> ".backup <path>". After --apply the tool prints a
 * ready-to-run rollback line: UPDATE tasks SET outcome = NULL WHERE id IN (...).
 *
 * @module BackfillOutcomes
 */

import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { execFileSync } from "child_process";
import { homedir } from "os";
import { join } from "path";
import { TaskDB, type ActivityLogEntry, type Task } from "./TaskDB.ts";
import {
  HEADLINE_TARGET,
  linkFromTarget,
  serializeOutcome,
  type ForJmItem,
  type Outcome,
  type OutcomeLink,
} from "./TaskOutcome.ts";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";

export const DEFAULT_SINCE = "2026-09-23";
const MAX_DELIVERABLES = 5;
const MAX_FOR_JM = 20;
const MAX_SOURCE_CHARS = 14000;

// ============================================================================
// Pure helpers
// ============================================================================

export function clip(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/**
 * A headline of at most `max` chars: whole text if it fits, else its first sentence if that fits,
 * else a cut at a word boundary plus "…". Never cuts mid-word (unless one word fills the limit).
 */
export function fitHeadline(text: string, max: number = HEADLINE_TARGET): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const sentence = flat.match(/^(.+?[.!?])(?:\s|$)/)?.[1];
  if (sentence && sentence.length <= max) return sentence;
  const room = flat.slice(0, max - 1);
  // Prefer the last clause boundary (; , : —) that leaves a meaningful head.
  let clause = -1;
  for (const m of room.matchAll(/[;,:—]/g)) {
    const i = m.index ?? -1;
    if (flat[i + 1] === " " || flat[i + 1] === undefined) clause = i;
  }
  if (clause >= 30) return `${room.slice(0, clause).replace(/[\s,;:.\-–—(]+$/, "")}…`;
  const cut = room.lastIndexOf(" ");
  const base = cut > 0 && flat[max - 1] !== " " ? room.slice(0, cut) : room;
  return `${base.replace(/[\s,;:.\-–—(]+$/, "")}…`;
}

/** First sentence of the first paragraph of `text`, fitted to the headline limit. */
export function firstSentence(text: string, max: number = HEADLINE_TARGET): string {
  const flat = text.trim().split(/\n\s*\n/)[0]?.replace(/\s+/g, " ").trim() ?? "";
  const m = flat.match(/^(.+?[.!?])(?:\s|$)/);
  return fitHeadline(m ? m[1] : flat, max);
}

/** Parse the text of a comment event; null when the event is not a comment or has no text. */
export function commentText(ev: Pick<ActivityLogEntry, "action" | "changes">): string | null {
  if (ev.action !== "comment" || !ev.changes) return null;
  try {
    const parsed: unknown = JSON.parse(ev.changes);
    if (parsed && typeof parsed === "object" && "text" in parsed && typeof parsed.text === "string") {
      return parsed.text;
    }
  } catch {
    // not JSON: not a comment we wrote
  }
  return null;
}

/** The `note` of a completed event's changes JSON, or null. */
export function completedNote(ev: Pick<ActivityLogEntry, "action" | "changes">): string | null {
  if (ev.action !== "completed" || !ev.changes) return null;
  try {
    const parsed: unknown = JSON.parse(ev.changes);
    if (parsed && typeof parsed === "object" && "note" in parsed && typeof parsed.note === "string") {
      const n = parsed.note.trim();
      return n === "" ? null : n;
    }
  } catch {
    // not JSON
  }
  return null;
}

const MERGED_RE = /^✅ Auto-merged branch `([^`]+)` → main @ `([0-9a-f]{7,40})`\.[ \t]*(?:\n|$)/;
const DELIVERABLE_BRANCH_RE = /^Deliverable \(branch `([^`]+)`\):[ \t]*$/m;
const DELIVERABLE_PATHS_RE = /^Deliverable:(.*)$/m;
const WIKILINK_RE = /\[\[([^\]\n]+)\]\]/g;
const OUTCOMEISH_LINE_RE = /^[ \t]*(?:[-*][ \t]+)?(?:RECONCILED|OUTCOME|RESULT|DELIVERED|SHIPPED)\b.*$/gim;

function wikilinks(text: string): string[] {
  return [...text.matchAll(WIKILINK_RE)].map((m) => m[1].trim()).filter((s) => s !== "");
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export interface Extracted {
  /** Body of the latest merged/deliverable comment (the executor's own summary). */
  summary: string;
  /** Deterministic links (commit / branch / wikilink paths). Path existence is NOT yet checked. */
  links: OutcomeLink[];
  merge?: NonNullable<Outcome["merge"]>;
  verify?: NonNullable<Outcome["verify"]>;
  /**
   * Everything the LLM may draw from: description outcome lines, then every non-noise comment and
   * the completion note, oldest first, each prefixed "[timestamp actor]". "" when nothing usable.
   */
  sourceText: string;
  /** Actor of the latest `completed` event, if any. */
  closer: string | null;
  /** A non-executor comment exists AFTER the last executor delivery marker: merge/verify are unreliable. */
  laterHandled: boolean;
  /** Anchored shas that later (non-executor) comments claim landed on main; newest comment's first. UNVERIFIED. */
  claimedShas: string[];
  /** First text of the latest non-noise timeline entry (for a neutral fallback headline). */
  lastText: string;
}

const NOISE_PREFIXES = ["EXECUTOR_PAUSED", "EXECUTOR_RECLAIM", "EXECUTOR_FAIL", "EXECUTOR_VERIFY", "MERGE_DEFERRED:", "MERGE_FAILED:"];
const MAX_ENTRY_CHARS = 2500;

/**
 * shas a comment claims landed on main, anchored on `on main at <sha>`, `main @ <sha>`, `-> <sha>`
 * or `→ <sha>`. Never the first hex-looking token. Pure; the caller must verify ancestry.
 */
export function anchoredShas(text: string): string[] {
  const out: string[] = [];
  const re = /(?:\bmerged to main\s*(?:(?:at|@)\s*)?|\bon main at|\bmain @|->|→)\s*(?:main @\s*)?`?([0-9a-f]{7,40})\b/gi;
  for (const m of text.matchAll(re)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/** Strip the trailing Review / Also wrote boilerplate from a branch-deliverable body. */
function branchDeliverableBody(afterHeader: string): { body: string; alsoWrote: string[] } {
  const lines = afterHeader.split("\n");
  const kept: string[] = [];
  const also: string[] = [];
  for (const line of lines) {
    if (/^Review: `git diff main\.\.\./.test(line)) continue;
    if (/^Also wrote:/.test(line)) {
      also.push(...wikilinks(line));
      continue;
    }
    kept.push(line);
  }
  return { body: kept.join("\n").trim(), alsoWrote: also };
}

/**
 * Deterministic extraction from a task's events (any order) and description. Pure.
 * Executor noise (EXECUTOR_PAUSED / RECLAIM / FAIL) is ignored by construction: only the shapes
 * below are read.
 */
export function extractFromTask(
  task: { description?: string | null },
  events: ReadonlyArray<Pick<ActivityLogEntry, "id" | "action" | "changes" | "actor" | "created_at">>,
): Extracted {
  // created_at can tie within a millisecond: break ties on the row id, then keep input order.
  const chrono = [...events].sort((a, b) =>
    a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : (a.id ?? 0) - (b.id ?? 0),
  );

  let summary = "";
  let links: OutcomeLink[] = [];
  let merge: Extracted["merge"];
  let verify: Extracted["verify"];
  let closer: string | null = null;
  const entries: string[] = [];
  let lastText = "";
  let lastDeliveryAt = -1; // chrono index of the last executor delivery marker
  const laterComments: { at: number; text: string }[] = []; // non-executor comments
  const stamp = (ev: { created_at: string; actor: string }): string => `[${ev.created_at.slice(0, 16)}Z ${ev.actor}]`;

  for (const [at, ev] of chrono.entries()) {
    if (ev.action === "completed") {
      closer = ev.actor;
      const n = completedNote(ev);
      if (n) {
        entries.push(`${stamp(ev)} COMPLETION NOTE: ${clip(n, MAX_ENTRY_CHARS)}`);
        lastText = n;
      }
      // A close by anyone but the executor, after its delivery, makes its merge/verify claims stale
      // (with or without a note). The note's own sha anchors count as claims.
      if (ev.actor !== "executor") laterComments.push({ at, text: n ?? "" });
      continue;
    }
    const text = commentText(ev);
    if (text === null) continue;
    const t = text.trim();
    const noise = NOISE_PREFIXES.some((p) => t.startsWith(p));
    if (!noise && t !== "" && ev.actor !== "backfill") {
      entries.push(`${stamp(ev)} ${clip(t, MAX_ENTRY_CHARS)}`);
      lastText = t;
    }
    if (ev.actor !== "executor") {
      if (!noise) laterComments.push({ at, text: t });
    } else if (
      t.startsWith("EXECUTOR_VERIFY:") || t.startsWith("MERGE_DEFERRED:") || t.startsWith("MERGE_FAILED:") ||
      MERGED_RE.test(t) || DELIVERABLE_BRANCH_RE.test(t) || DELIVERABLE_PATHS_RE.test(t)
    ) {
      lastDeliveryAt = at;
    }

    if (t.startsWith("EXECUTOR_VERIFY:")) {
      const rec = parseJsonObject(t.slice("EXECUTOR_VERIFY:".length).split("\n", 1)[0].trim());
      const v = rec?.verdict;
      if (v === "pass" || v === "fail" || v === "uncertain") {
        const reasoning = typeof rec?.reasoning === "string" ? rec.reasoning : "";
        verify = reasoning.trim() ? { verdict: v, note: clip(reasoning, 600) } : { verdict: v };
      }
      continue;
    }
    if (t.startsWith("MERGE_DEFERRED:")) {
      const rec = parseJsonObject(t.slice("MERGE_DEFERRED:".length).split("\n", 1)[0].trim());
      if (rec && merge?.state !== "merged") {
        const branch = typeof rec.branch === "string" ? rec.branch : merge?.branch;
        merge = branch ? { state: "deferred", branch } : { state: "deferred" };
        if (branch && !links.some((l) => l.kind === "branch")) {
          links = [...links, { kind: "branch", target: branch, label: "Diff" }];
        }
      }
      continue;
    }
    if (t.startsWith("MERGE_FAILED:")) {
      if (merge?.state !== "merged") merge = merge?.branch ? { state: "failed", branch: merge.branch } : { state: "failed" };
      continue;
    }

    const mergedMatch = t.match(MERGED_RE);
    if (mergedMatch) {
      const [whole, branch, sha] = mergedMatch;
      merge = { state: "merged", branch, sha };
      links = [{ kind: "commit", target: sha, label: "Merge" }];
      summary = t.slice(whole.length).trim();
      continue;
    }

    const branchMatch = t.match(DELIVERABLE_BRANCH_RE);
    if (branchMatch && branchMatch.index !== undefined) {
      const branch = branchMatch[1];
      const { body, alsoWrote } = branchDeliverableBody(t.slice(branchMatch.index + branchMatch[0].length));
      merge = { state: "pending", branch };
      links = [{ kind: "branch", target: branch, label: "Diff" }, ...alsoWrote.map((p) => linkFromTarget(p))];
      summary = body;
      if (t.includes("⚠️ verification skipped")) verify = { verdict: "skipped" };
      continue;
    }

    const pathsMatch = t.match(DELIVERABLE_PATHS_RE);
    if (pathsMatch && pathsMatch.index !== undefined) {
      links = wikilinks(pathsMatch[1]).map((p) => linkFromTarget(p));
      merge = { state: "none" };
      summary = t.slice(pathsMatch.index + pathsMatch[0].length).trim();
      if (t.includes("⚠️ verification skipped")) verify = { verdict: "skipped" };
      continue;
    }

    if (t.includes("⚠️ verification skipped")) verify = { verdict: "skipped" };
  }

  const descLines = [...(task.description ?? "").matchAll(OUTCOMEISH_LINE_RE)].map((m) => m[0].trim());

  // Newest-first budget: drop the OLDEST entries when the text is too long.
  const head = descLines.length > 0 ? `DESCRIPTION OUTCOME LINES:\n${descLines.join("\n")}` : "";
  let budget = MAX_SOURCE_CHARS - head.length;
  const kept: string[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    if (budget - entries[i].length < 0 && kept.length > 0) break;
    kept.unshift(entries[i]);
    budget -= entries[i].length + 2;
  }
  const body = kept.length > 0 ? `Source comments, oldest first:\n${kept.join("\n\n")}` : "";
  const sourceText = [head, body].filter((p) => p !== "").join("\n\n");

  const laterHandled = lastDeliveryAt >= 0 && laterComments.some((c) => c.at > lastDeliveryAt);
  const claimedShas: string[] = [];
  for (const c of [...laterComments].reverse()) {
    if (c.at <= lastDeliveryAt) continue;
    for (const s of anchoredShas(c.text)) if (!claimedShas.includes(s)) claimedShas.push(s);
  }

  return {
    summary,
    links,
    ...(merge ? { merge } : {}),
    ...(verify ? { verify } : {}),
    sourceText,
    closer,
    laterHandled,
    claimedShas,
    lastText: lastText.replace(/^(?:✅|❌|❓)\s*/, ""),
  };
}

// ============================================================================
// LLM draft
// ============================================================================

export interface Draft {
  headline: string;
  deliverables: string[];
  check?: string;
  forJm: string[];
}

export const DRAFT_SYSTEM_PROMPT = [
  "You write the headline card for a finished task in Jm's task system.",
  "Draft ONLY from the text given. Do not invent facts, paths, URLs or commands.",
  "Later comments supersede earlier ones. Describe the FINAL state as of the last comment.",
  "Never repeat a claim a later comment corrects. A line starting with FACT is verified and overrides any comment.",
  "Reply with STRICT JSON only, no prose and no code fence, in this shape:",
  `{"headline": string, "deliverables": string[], "check": string, "forJm": string[]}`,
  `- headline: at most ${HEADLINE_TARGET} characters, plain words for Jm, say what changed.`,
  `- deliverables: file paths or URLs that appear VERBATIM in the text (at most ${MAX_DELIVERABLES}). Empty array if none.`,
  "- check: one command or one step Jm can run to see the result, only if the text gives it. Else empty string.",
  `- forJm: only items that the LATEST text explicitly presents as still open and needing Jm's decision or action (at most ${MAX_FOR_JM}). Leave out anything a later comment resolved. Empty array if none.`,
].join("\n");

/** Injectable: returns the model's raw text, or throws. */
export type InferFn = (systemPrompt: string, userPrompt: string) => Promise<string>;

/** Real inference via lib/core/Inference.ts (level "standard"). Throws on failure. */
export const defaultInfer: InferFn = async (systemPrompt, userPrompt) => {
  const { inference } = await import("../../../../lib/core/Inference.ts");
  const res = await inference({ systemPrompt, userPrompt, level: "standard", expectJson: true, timeout: 120_000 });
  if (!res.success) throw new Error(res.error ?? "inference failed");
  return typeof res.parsed === "object" && res.parsed !== null ? JSON.stringify(res.parsed) : res.output;
};

/** Defensive parse of the model output. null when no usable headline can be read. */
export function parseDraft(raw: string): Draft | null {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  let obj = parseJsonObject(text);
  if (!obj) {
    const a = text.indexOf("{");
    const b = text.lastIndexOf("}");
    if (a >= 0 && b > a) obj = parseJsonObject(text.slice(a, b + 1));
  }
  if (!obj) return null;
  const headline = typeof obj.headline === "string" ? fitHeadline(obj.headline, HEADLINE_TARGET) : "";
  if (headline === "") return null;
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter((s) => s !== "") : [];
  const check = typeof obj.check === "string" && obj.check.trim() !== "" ? clip(obj.check, 300) : undefined;
  return {
    headline,
    deliverables: strings(obj.deliverables).slice(0, MAX_DELIVERABLES),
    ...(check ? { check } : {}),
    forJm: strings(obj.forJm).slice(0, MAX_FOR_JM).map((s) => clip(s, 300)),
  };
}

// ============================================================================
// Link validation
// ============================================================================

const SAFE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SAFE_REPO_PATH_RE = /^[A-Za-z0-9._@+ /-]+$/;

function gitHas(kayaHome: string, ref: string, path: string): boolean {
  if (!SAFE_REF_RE.test(ref) || !SAFE_REPO_PATH_RE.test(path) || path.split("/").includes("..")) return false;
  try {
    execFileSync("git", ["-C", kayaHome, "cat-file", "-e", `${ref}:${path}`], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false; // git exits non-zero when the object is absent
  }
}

/**
 * The validated link for a target, or null when it does not exist. URLs and task ids are kept
 * as-is; absolute / ~/ paths need existsSync; repo-relative paths need to exist under the Kaya
 * home or (for the task's branch) in git, in which case the link carries ref = branch.
 */
export function validateLink(
  link: OutcomeLink,
  ctx: { kayaHome: string; branch?: string },
): OutcomeLink | null {
  switch (link.kind) {
    case "url":
    case "task":
    case "branch":
    case "commit":
      return link;
    case "path": {
      const abs = link.target.startsWith("~/") ? join(homedir(), link.target.slice(2)) : link.target;
      return existsSync(abs) ? link : null;
    }
    case "repo": {
      if (SAFE_REPO_PATH_RE.test(link.target) && !link.target.split("/").includes("..") && existsSync(join(ctx.kayaHome, link.target))) {
        return link;
      }
      if (ctx.branch && gitHas(ctx.kayaHome, ctx.branch, link.target)) return { ...link, ref: ctx.branch };
      return null;
    }
  }
}

/**
 * The branch tip sha when `branch` exists and is already an ancestor of main; else null
 * (missing branch, not merged, or git unavailable: never guessed).
 */
export function mergedBranchTip(kayaHome: string, branch: string): string | null {
  if (!SAFE_REF_RE.test(branch)) return null;
  try {
    const tip = execFileSync("git", ["-C", kayaHome, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }).trim();
    if (!/^[0-9a-f]{40}$/.test(tip)) return null;
    execFileSync("git", ["-C", kayaHome, "merge-base", "--is-ancestor", tip, "main"], { stdio: "ignore", timeout: 10_000 });
    return tip;
  } catch {
    return null; // non-zero exit = branch absent or not an ancestor of main
  }
}

/** `sha` expanded to 40 hex chars when it is a commit that is an ancestor of main; else null. */
export function shaOnMain(kayaHome: string, sha: string): string | null {
  if (!/^[0-9a-f]{7,40}$/.test(sha)) return null;
  try {
    const full = execFileSync("git", ["-C", kayaHome, "rev-parse", "--verify", "--quiet", `${sha}^{commit}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }).trim();
    if (!/^[0-9a-f]{40}$/.test(full)) return null;
    execFileSync("git", ["-C", kayaHome, "merge-base", "--is-ancestor", full, "main"], { stdio: "ignore", timeout: 10_000 });
    return full;
  } catch {
    return null; // non-zero exit = unknown commit or not an ancestor of main
  }
}

const CONTRADICTS_MERGED_RE = /\b(?:not (?:yet )?merged|unmerged|until (?:it(?:'s| is)? )?merged|needs? (?:to be )?merg|awaiting (?:a )?merge|on a branch|waiting to be merged)/i;
export function contradictsMerged(headline: string): boolean {
  return CONTRADICTS_MERGED_RE.test(headline);
}

const CHECK_EXTS = "ts|tsx|js|mjs|md|json|sh|py|ya?ml|db|txt|html|css|plist|toml";
/**
 * False when `check` names a file (absolute, ~/, or repo-relative with a known extension) that does
 * not exist now. URLs are ignored. A check with no file reference is kept.
 */
export function checkPathsExist(check: string, kayaHome: string): boolean {
  const text = check.replace(/https?:\/\/\S+/g, " ");
  const re = new RegExp(`(?:^|[\\s\`'"(])((?:~/|/)[^\\s\`'"),;]+|[A-Za-z0-9_@+.\\-]+(?:/[A-Za-z0-9_@+.\\-]+)*\\.(?:${CHECK_EXTS}))(?=$|[\\s\`'"),;:])`, "g");
  for (const m of text.matchAll(re)) {
    const p = m[1].replace(/[.,:;]+$/, "");
    const abs = p.startsWith("~/") ? join(homedir(), p.slice(2)) : p.startsWith("/") ? p : join(kayaHome, p);
    if (!existsSync(abs)) return false;
  }
  return true;
}

function linkKey(l: OutcomeLink): string {
  return `${l.kind}:${l.target}`;
}

// ============================================================================
// Outcome assembly
// ============================================================================

export interface BuildResult {
  outcome: Outcome;
  llm: "ok" | "fallback";
}

/**
 * Build one task's outcome (not yet serialized). One inference call when there is source text.
 * Returns null when there is no usable text.
 */
export async function buildBackfillOutcome(
  task: { id: string; title: string; description?: string | null; status?: string },
  events: ReadonlyArray<Pick<ActivityLogEntry, "id" | "action" | "changes" | "actor" | "created_at">>,
  opts: { infer: InferFn; kayaHome: string; now?: Date },
): Promise<(BuildResult & { extracted: Extracted }) | null> {
  const extracted = extractFromTask(task, events);
  if (extracted.sourceText === "") return null;

  // ---- Git facts first: the prompt carries them so the headline cannot contradict them. ----
  let merge = extracted.merge;
  let verify = extracted.verify;
  let baseLinks = extracted.links;
  let confirmedSha: string | null = null;
  const execBranch = merge?.branch;
  const isOpen = merge?.state === "pending" || merge?.state === "deferred" || merge?.state === "failed";
  if (extracted.laterHandled) {
    // Someone other than the executor spoke after its delivery: its merge/verify claims are stale.
    verify = undefined;
    const candidates = [
      ...extracted.claimedShas,
      ...(merge?.state === "merged" && merge.sha ? [merge.sha] : []),
    ];
    for (const c of candidates) {
      confirmedSha = shaOnMain(opts.kayaHome, c);
      if (confirmedSha) break;
    }
    // A claimed sha may be a cherry-pick: name the branch only when the branch itself is on main.
    let branchOnMain = false;
    if (!confirmedSha && execBranch) {
      confirmedSha = mergedBranchTip(opts.kayaHome, execBranch);
      branchOnMain = confirmedSha !== null;
    } else if (confirmedSha && execBranch) {
      const tip = mergedBranchTip(opts.kayaHome, execBranch);
      branchOnMain = tip !== null;
    }
    merge = confirmedSha
      ? { state: "merged", ...(branchOnMain && execBranch ? { branch: execBranch } : {}), sha: confirmedSha }
      : undefined;
    baseLinks = baseLinks.filter((l) => l.kind !== "branch" && l.kind !== "commit");
  } else if (merge && execBranch && isOpen) {
    confirmedSha = mergedBranchTip(opts.kayaHome, execBranch);
    if (confirmedSha) {
      merge = { state: "merged", branch: execBranch, sha: confirmedSha };
      baseLinks = baseLinks.filter((l) => !(l.kind === "branch" && l.target === execBranch));
    }
  } else if (merge?.state === "merged" && merge.sha) {
    confirmedSha = shaOnMain(opts.kayaHome, merge.sha);
  }
  if (confirmedSha && !baseLinks.some((l) => l.kind === "commit" && l.target === confirmedSha)) {
    baseLinks = [...baseLinks.filter((l) => l.kind !== "commit"), { kind: "commit", target: confirmedSha, label: "Commit" }];
  }
  const mergedConfirmed = confirmedSha !== null;
  // Files on main need no branch ref; an open (unmerged) branch keeps its ref.
  const branch = merge && merge.state !== "merged" ? merge.branch : undefined;
  const fact = mergedConfirmed ? `FACT: merged to main (commit ${confirmedSha})` : "FACT: merge state unknown";

  const prompt = (extra = ""): string =>
    `TASK TITLE: ${task.title}\nTASK STATUS: ${task.status ?? "unknown"}\n${fact}${extra}\n\n${extracted.sourceText.replace("Source comments, oldest first:", "COMMENTS (oldest first; later supersede earlier):")}`;
  const ask = async (extra = ""): Promise<Draft | null> => {
    try {
      return parseDraft(await opts.infer(DRAFT_SYSTEM_PROMPT, prompt(extra)));
    } catch {
      return null; // counted as fallback in the report; the inference error is not the card's content
    }
  };
  let draft = await ask();
  let headlineFromDraft = draft !== null;
  if (draft && mergedConfirmed && contradictsMerged(draft.headline)) {
    const retry = await ask(
      `\nIMPORTANT: the work IS merged to main. The headline must not say it is unmerged, on a branch, or waiting to be merged.`,
    );
    if (retry && !contradictsMerged(retry.headline)) draft = retry;
    else headlineFromDraft = false; // neutral fallback below
  }

  const links: OutcomeLink[] = [];
  const seen = new Set<string>();
  const add = (raw: OutcomeLink | null): void => {
    if (!raw) return;
    const l = raw.kind === "path" && raw.target.startsWith("~/") ? { ...raw, target: join(homedir(), raw.target.slice(2)) } : raw;
    if (seen.has(linkKey(l)) || links.length >= 20) return;
    seen.add(linkKey(l));
    links.push(l);
  };
  for (const l of baseLinks) add(validateLink(l, { kayaHome: opts.kayaHome, branch }));
  if (draft) {
    for (const target of draft.deliverables) {
      if (!extracted.sourceText.includes(target)) continue; // invented: drop
      let link: OutcomeLink;
      try {
        link = linkFromTarget(target);
      } catch {
        continue;
      }
      add(validateLink(link, { kayaHome: opts.kayaHome, branch }));
    }
  }

  // Neutral fallback: the latest comment's first sentence (the executor summary if nobody spoke later).
  const fallbackText = extracted.laterHandled || !extracted.summary ? extracted.lastText : extracted.summary;
  const headline =
    (headlineFromDraft && draft ? draft.headline : "") || firstSentence(fallbackText) || clip(task.title, 200);
  // Done tasks: Jm already closed them, old prose to-dos are stale. Waiting: the model keeps only still-open items.
  const forJm: ForJmItem[] = task.status === "done" ? [] : (draft?.forJm ?? []).map((text) => ({ text }));
  const check = draft?.check && checkPathsExist(draft.check, opts.kayaHome) ? draft.check : undefined;

  const outcome: Outcome = {
    v: 1,
    headline,
    links,
    ...(links.length === 0 ? { noArtifact: "drafted from old comments; no file link found" } : {}),
    ...(verify ? { verify } : {}),
    ...(merge ? { merge } : {}),
    ...(check ? { check } : {}),
    forJm,
    details: clip(extracted.sourceText, 12000),
    by: "backfill",
    at: (opts.now ?? new Date()).toISOString(),
    source: "backfill",
  };
  return { outcome, llm: draft ? "ok" : "fallback", extracted };
}

// ============================================================================
// Runner
// ============================================================================

export interface BackfillOptions {
  since?: string;
  apply?: boolean;
  limit?: number;
  ids?: string[];
  infer: InferFn;
  kayaHome?: string;
  now?: Date;
  /** Injectable for tests; defaults to the schema-validating serializeOutcome. */
  serialize?: (o: Outcome) => string;
}

export interface TaskReport {
  id: string;
  title: string;
  headline: string;
  links: number;
  forJm: number;
  verdict: string | null;
  merge: string | null;
  llm: "ok" | "fallback";
  written: boolean;
  /** The drafted outcome (shown by --json). */
  outcome: Outcome;
}

export interface SkippedReport {
  id: string;
  title: string;
  closer: string | null;
  reason: "no-text" | "invalid";
  detail?: string;
}

export interface BackfillReport {
  apply: boolean;
  counts: { candidates: number; processed: number; drafted: number; llmFallback: number; skippedNoText: number; skippedInvalid: number };
  tasks: TaskReport[];
  skipped: SkippedReport[];
  /** After --apply with at least one write: a ready-to-run SQL line that undoes it; else null. */
  rollbackSql: string | null;
}

/** Tasks with no outcome that are waiting, or done since `since`. Newest first. */
export function listCandidates(db: TaskDB, since: string, ids?: string[]): Task[] {
  const all = db.listTasks({ status: ["waiting", "done"] });
  const idSet = ids && ids.length > 0 ? new Set(ids) : null;
  return all
    .filter((t) => t.outcome === null || t.outcome === "")
    .filter((t) => t.status === "waiting" || (t.completed_at !== null && t.completed_at >= since))
    .filter((t) => (idSet ? idSet.has(t.id) : true))
    .sort((a, b) => ((b.completed_at ?? b.updated_at ?? "") < (a.completed_at ?? a.updated_at ?? "") ? -1 : 1));
}

export async function runBackfill(db: TaskDB, opts: BackfillOptions): Promise<BackfillReport> {
  const kayaHome = opts.kayaHome ?? getKayaHome();
  const candidates = listCandidates(db, opts.since ?? DEFAULT_SINCE, opts.ids);
  const batch = opts.limit !== undefined ? candidates.slice(0, opts.limit) : candidates;
  const report: BackfillReport = {
    apply: opts.apply === true,
    counts: { candidates: candidates.length, processed: batch.length, drafted: 0, llmFallback: 0, skippedNoText: 0, skippedInvalid: 0 },
    tasks: [],
    skipped: [],
    rollbackSql: null,
  };

  for (const task of batch) {
    const events = db.getActivityLog(task.id, 100_000);
    const built = await buildBackfillOutcome(task, events, { infer: opts.infer, kayaHome, now: opts.now });
    if (!built) {
      report.counts.skippedNoText++;
      const closer = extractFromTask(task, events).closer;
      report.skipped.push({ id: task.id, title: task.title, closer, reason: "no-text" });
      continue;
    }
    let serialized: string;
    try {
      serialized = (opts.serialize ?? serializeOutcome)(built.outcome);
    } catch (err) {
      report.counts.skippedInvalid++;
      report.skipped.push({
        id: task.id,
        title: task.title,
        closer: built.extracted.closer,
        reason: "invalid",
        detail: err instanceof Error ? err.message.slice(0, 300) : String(err),
      });
      continue;
    }
    if (opts.apply) db.updateTask(task.id, { outcome: serialized }, "backfill");
    report.counts.drafted++;
    if (built.llm === "fallback") report.counts.llmFallback++;
    report.tasks.push({
      id: task.id,
      title: task.title,
      headline: built.outcome.headline,
      links: built.outcome.links.length,
      forJm: built.outcome.forJm.length,
      verdict: built.outcome.verify?.verdict ?? null,
      merge: built.outcome.merge?.state ?? null,
      llm: built.llm,
      written: opts.apply === true,
      outcome: built.outcome,
    });
  }
  if (opts.apply && report.tasks.length > 0) {
    report.rollbackSql = `UPDATE tasks SET outcome = NULL WHERE id IN (${report.tasks.map((t) => `'${t.id.replace(/'/g, "''")}'`).join(", ")});`;
  }
  return report;
}

export function formatReport(r: BackfillReport): string {
  const c = r.counts;
  const lines = [
    `${r.apply ? "APPLIED" : "DRY RUN (nothing written)"} — candidates ${c.candidates}, processed ${c.processed}, drafted ${c.drafted}, ` +
      `llm-fallback ${c.llmFallback}, skipped-no-text ${c.skippedNoText}, skipped-invalid ${c.skippedInvalid}`,
    "",
  ];
  for (const t of r.tasks) {
    lines.push(
      `${t.written ? "WROTE" : "WOULD WRITE"} ${t.id} "${clip(t.title, 60)}"`,
      `  headline: ${t.headline}`,
      `  links ${t.links} | forJm ${t.forJm} | verify ${t.verdict ?? "-"} | merge ${t.merge ?? "-"}${t.llm === "fallback" ? " | LLM FALLBACK" : ""}`,
    );
  }
  if (r.skipped.length > 0) {
    lines.push("", "SKIPPED:");
    for (const s of r.skipped) {
      lines.push(`  ${s.id} "${clip(s.title, 60)}" closer=${s.closer ?? "unknown"} (${s.reason}${s.detail ? `: ${s.detail}` : ""})`);
    }
  }
  if (r.rollbackSql) lines.push("", `ROLLBACK (sqlite3 <db> "..."): ${r.rollbackSql}`);
  return lines.join("\n");
}

// ============================================================================
// CLI
// ============================================================================

export interface CliArgs {
  since: string;
  apply: boolean;
  limit?: number;
  ids?: string[];
  db?: string;
  /** Snapshot the DB to this new file (VACUUM INTO) before an --apply run. */
  backup?: string;
  json: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { since: DEFAULT_SINCE, apply: false, json: false };
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--dry-run") out.apply = false;
    else if (a === "--json") out.json = true;
    else if (a === "--since") out.since = value(i++, a);
    else if (a === "--db") out.db = value(i++, a);
    else if (a === "--backup") out.backup = value(i++, a);
    else if (a === "--ids") out.ids = value(i++, a).split(",").map((s) => s.trim()).filter((s) => s !== "");
    else if (a === "--limit") {
      const n = Number(value(i++, a));
      if (!Number.isInteger(n) || n < 0) throw new Error("--limit needs a non-negative integer");
      out.limit = n;
    } else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

if (import.meta.main) {
  (async () => {
    const args = parseArgs(process.argv.slice(2));
    const db = args.db ? new TaskDB(args.db) : new TaskDB();
    try {
      if (args.backup) {
        // Same default path as TaskDB.defaultDbPath (not exported).
        const dbPath = args.db ?? join(getKayaHome(), "skills/Productivity/LucidTasks/Data/lucidtasks.db");
        const src = new Database(dbPath, { readonly: true });
        try {
          src.run("VACUUM INTO ?", [args.backup]); // fails loud if the file exists
        } finally {
          src.close();
        }
        console.error(`backup written: ${args.backup}`);
      }
      const report = await runBackfill(db, {
        since: args.since,
        apply: args.apply,
        limit: args.limit,
        ids: args.ids,
        infer: defaultInfer,
      });
      console.log(args.json ? JSON.stringify(report, null, 2) : formatReport(report));
    } finally {
      db.close();
    }
  })().catch((err) => {
    console.error(`BackfillOutcomes failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
