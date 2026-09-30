#!/usr/bin/env bun

/**
 * RecallPlan.ts - List and recall Claude Code plan-mode plans
 *
 * Claude Code's plan mode (ExitPlanMode) persists every plan as a markdown
 * file under ~/.claude/plans/*.md — verified on disk (2026-07-04): 58 real
 * plan files spanning Feb-Jul 2026, auto-named with cryptic slugs (e.g.
 * "create-a-plan-to-iridescent-treehouse.md", "rosy-blum.md"). No Kaya hook
 * writes there — this is native Claude Code behavior, so the persistence
 * seam already exists. This tool only adds the missing piece: making those
 * plans identifiable at a glance (title/date/excerpt instead of raw slugs)
 * and letting a session recall one by index or name.
 *
 * Usage:
 *   bun RecallPlan.ts list [--limit N] [--dir <path>] [--json]
 *   bun RecallPlan.ts show <selector> [--dir <path>] [--json] [--lines N]
 *
 * Commands:
 *   list    Show the last N plans (default 10): index, date, title, excerpt
 *   show    Print one plan's path + title + excerpt for context injection
 *
 * @author Kaya System
 * @version 1.0.0
 */

import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, basename } from "path";
import { kayaHomePath } from "../../../../lib/core/KayaHome";

export interface PlanSummary {
  /** 1-based position in the deterministic (mtime desc) ordering */
  index: number;
  /** filename only, e.g. "create-a-plan-to-iridescent-treehouse.md" */
  file: string;
  /** absolute path to the plan file */
  path: string;
  /** human title — first markdown H1, or a title-cased filename fallback */
  title: string;
  /** ISO date (YYYY-MM-DD) derived from the file's mtime */
  date: string;
  mtimeMs: number;
  /** short readable excerpt following the title */
  excerpt: string;
}

export const DEFAULT_PLANS_DIR = kayaHomePath("plans");
const DEFAULT_LIMIT = 10;
const DEFAULT_EXCERPT_LINES = 3;
const EXCERPT_MAX_CHARS = 220;

/**
 * Filters out non-plan files that happen to live in the plans directory:
 * reference templates (e.g. TEMPLATE-plan-prompt.md) and anything that
 * isn't a markdown file (e.g. the sibling Specs/ directory).
 */
function isRealPlanFile(filename: string): boolean {
  if (!filename.toLowerCase().endsWith(".md")) return false;
  if (/^template/i.test(filename)) return false;
  return true;
}

function filenameFallbackTitle(filename: string): string {
  return basename(filename, ".md")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Derive a human title + short excerpt from a plan's markdown content.
 * Title = first line starting with "# ". Excerpt = the next few non-blank,
 * non-heading lines after the title, joined and truncated.
 */
export function extractTitleAndExcerpt(
  content: string,
  fallbackTitle: string,
  excerptLines: number = DEFAULT_EXCERPT_LINES,
): { title: string; excerpt: string } {
  const lines = content.split("\n");
  let titleIdx = -1;
  let title = fallbackTitle;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("# ")) {
      title = line.replace(/^#+\s*/, "").trim();
      titleIdx = i;
      break;
    }
  }

  // Most plans in this repo follow "# Title\n\n## Context\n\nprose" — skip
  // over blank lines and sub-headings (rather than stopping at them) so the
  // excerpt reaches the actual prose instead of coming back empty.
  const bodyLines: string[] = [];
  for (let i = titleIdx + 1; i < lines.length && bodyLines.length < excerptLines; i++) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    if (line.startsWith("#")) continue; // skip sub-headings, keep scanning
    bodyLines.push(line);
  }

  let excerpt = bodyLines.join(" ").trim();
  if (excerpt.length > EXCERPT_MAX_CHARS) {
    excerpt = excerpt.slice(0, EXCERPT_MAX_CHARS).trim() + "…";
  }

  return { title, excerpt };
}

/** List the most recent plans in a directory, newest first. */
export function listPlans(
  plansDir: string = DEFAULT_PLANS_DIR,
  limit: number = DEFAULT_LIMIT,
): PlanSummary[] {
  if (!existsSync(plansDir)) return [];

  const entries = readdirSync(plansDir, { withFileTypes: true })
    .filter((e) => e.isFile() && isRealPlanFile(e.name))
    .map((e) => {
      const path = join(plansDir, e.name);
      const stat = statSync(path);
      return { file: e.name, path, mtimeMs: stat.mtimeMs };
    })
    // Deterministic order: newest mtime first, filename as a stable tiebreak.
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.file.localeCompare(b.file));

  const top = entries.slice(0, Math.max(0, limit));

  return top.map((entry, i) => {
    const content = readFileSync(entry.path, "utf-8");
    const { title, excerpt } = extractTitleAndExcerpt(
      content,
      filenameFallbackTitle(entry.file),
    );
    const date = new Date(entry.mtimeMs).toISOString().slice(0, 10);
    return {
      index: i + 1,
      file: entry.file,
      path: entry.path,
      title,
      date,
      mtimeMs: entry.mtimeMs,
      excerpt,
    };
  });
}

/**
 * Resolve a selector to a single plan: a 1-based index from `list`, an exact
 * filename, or a case-insensitive substring match against filename/title.
 *
 * Matching is deterministic on purpose (no LLM fuzz here) — picking the
 * wrong plan silently injects the wrong context into a session, so an
 * ambiguous selector is surfaced as an error rather than guessed at.
 */
export function resolvePlan(
  plansDir: string = DEFAULT_PLANS_DIR,
  selector: string,
  searchLimit: number = 500,
): PlanSummary {
  const plans = listPlans(plansDir, searchLimit);
  if (plans.length === 0) {
    throw new Error(`No plans found in ${plansDir}`);
  }

  // 1) 1-based numeric index into the same deterministic ordering as `list`
  if (/^\d+$/.test(selector.trim())) {
    const idx = parseInt(selector.trim(), 10);
    const match = plans.find((p) => p.index === idx);
    if (!match) {
      throw new Error(`No plan at index ${idx} (have ${plans.length} plans)`);
    }
    return match;
  }

  // 2) exact filename match (with or without .md)
  const wantFile = selector.endsWith(".md") ? selector : `${selector}.md`;
  const exact = plans.find((p) => p.file === wantFile || p.file === selector);
  if (exact) return exact;

  // 3) case-insensitive substring match against filename or title
  const needle = selector.toLowerCase();
  const matches = plans.filter(
    (p) => p.file.toLowerCase().includes(needle) || p.title.toLowerCase().includes(needle),
  );

  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    throw new Error(`No plan matched "${selector}" in ${plansDir}`);
  }

  const names = matches.slice(0, 8).map((m) => `  #${m.index} ${m.file}`).join("\n");
  throw new Error(
    `Ambiguous selector "${selector}" — matched ${matches.length} plans:\n${names}\nUse the numeric index or a more specific name.`,
  );
}

// ============================================================================
// CLI
// ============================================================================

function printHelp(): void {
  console.log(`RecallPlan - list and recall Claude Code plan-mode plans

Usage:
  bun RecallPlan.ts list [--limit N] [--dir <path>] [--json]
  bun RecallPlan.ts show <selector> [--dir <path>] [--json] [--lines N]

Commands:
  list    Show the last N plans (default 10): index, date, title, excerpt
  show    Print one plan's path + title + excerpt (full content by default;
          pass --lines N to cap the printed body to N lines)

<selector> for 'show': the 1-based index printed by 'list', an exact
filename, or a substring match against the filename/title.`);
}

interface Flags {
  dir?: string;
  limit?: number;
  json: boolean;
  lines?: number;
  positional: string[];
}

function parseFlags(args: string[]): Flags {
  const positional: string[] = [];
  let dir: string | undefined;
  let limit: number | undefined;
  let lines: number | undefined;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dir") {
      dir = args[++i];
    } else if (arg === "--limit") {
      limit = parseInt(args[++i], 10);
    } else if (arg === "--lines") {
      lines = parseInt(args[++i], 10);
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    } else {
      positional.push(arg);
    }
  }

  return { dir, limit, json, lines, positional };
}

function formatList(plans: PlanSummary[]): string {
  if (plans.length === 0) return "No plans found.";
  return plans
    .map(
      (p) =>
        `#${p.index}  ${p.date}  ${p.title}\n      ${p.file}\n      ${p.excerpt || "(no excerpt)"}`,
    )
    .join("\n\n");
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === "-h" || command === "--help") {
    printHelp();
    process.exit(command ? 0 : 1);
  }

  const { dir, limit, json, lines, positional } = parseFlags(rest);
  const plansDir = dir ?? DEFAULT_PLANS_DIR;

  try {
    if (command === "list") {
      const plans = listPlans(plansDir, limit ?? DEFAULT_LIMIT);
      console.log(json ? JSON.stringify(plans, null, 2) : formatList(plans));
    } else if (command === "show") {
      const selector = positional[0];
      if (!selector) {
        console.error("Error: 'show' requires a selector (index, filename, or name substring)");
        process.exit(1);
      }
      const plan = resolvePlan(plansDir, selector);
      const content = readFileSync(plan.path, "utf-8");
      const body =
        lines && lines > 0 ? content.split("\n").slice(0, lines).join("\n") : content;

      if (json) {
        console.log(JSON.stringify({ ...plan, content: body }, null, 2));
      } else {
        console.log(`# ${plan.title}\n`);
        console.log(`Path: ${plan.path}`);
        console.log(`Date: ${plan.date}\n`);
        console.log(body);
      }
    } else {
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
