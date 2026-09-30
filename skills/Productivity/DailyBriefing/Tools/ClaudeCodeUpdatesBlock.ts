#!/usr/bin/env bun
/**
 * ClaudeCodeUpdatesBlock.ts — Claude Code / dev-tooling updates for the briefing
 *
 * Goal (task t-mm0u19t3-gp335): maximize information value, minimize overload.
 * The public internet ships a torrent of Claude Code changelog entries every
 * day — mostly routine bug fixes. This block:
 *
 *   1. Fetches the authoritative Claude Code CHANGELOG (well-structured markdown).
 *   2. Diffs it against a persistent DEVELOPMENTS LOG so only genuinely NEW
 *      releases are ever processed (no re-surfacing yesterday's news).
 *   3. Uses one LLM pass to FILTER + TIER each change — monumental / notable /
 *      minor — so only what's actually worth Jm's attention surfaces. Minor
 *      churn (routine fixes) is logged but never shown.
 *   4. Renders bullet-point key info + links for further reading.
 *   5. Appends every processed release to the developments log — the running
 *      record of "what shipped, and how big a deal it was" that lets the block
 *      (and Jm) know what's monumental over time.
 *
 * Architecture: this is the one block that keeps its own state (the log) and
 * does its own filtering LLM pass, because "is this NEW and is it MONUMENTAL"
 * is a judgment across time that the stateless editorial layer can't make. It
 * hands the editorial engine a compact, pre-filtered list; the editorial engine
 * places it in the World section with the bullets/links preserved.
 *
 * All I/O is injectable (fetchText / infer / now / logDir) so tests are fully
 * hermetic — no live network, no live LLM. See the __tests__ counterpart.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { BlockResult } from "./types.ts";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";
import { inference } from "../../../../lib/core/Inference.ts";
import { createAppendLog } from "../../../../lib/core/AppendLog.ts";

export type { BlockResult };

const BLOCK_NAME = "claudeCodeUpdates";

// Authoritative, well-structured markdown changelog. Kept as an array so the
// source set can grow (e.g. Anthropic API release notes) without a code change.
export const DEFAULT_CHANGELOG_URL =
  "https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md";
const CHANGELOG_HTML_URL = "https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md";

// On a cold start the changelog holds hundreds of releases. Surface only the
// newest few so the FIRST briefing isn't a wall of backfill; the rest are
// recorded as "seen" (backfill) without an LLM pass so tomorrow only genuinely
// new releases get processed.
const SEED_SURFACE_VERSIONS = 3;
// Bound LLM cost/latency: never assess more than this many new releases in one
// run. Any excess (rare — implies the briefing hasn't run in weeks) is logged
// as backfill without surfacing.
const MAX_ASSESS_VERSIONS = 8;

export type UpdateTier = "monumental" | "notable" | "minor";

export interface ClaudeCodeUpdateItem {
  headline: string; // one bullet-ready line of key info
  tier: UpdateTier;
  category: string; // e.g. "agents", "mcp", "performance", "security", "workflow"
  version: string; // the release this change shipped in
}

export interface ClaudeCodeUpdatesData {
  /** Versions newly processed this run (may include backfilled ones). */
  newVersions: string[];
  /** Filtered, tiered items worth Jm's attention (monumental + notable). */
  surfaced: ClaudeCodeUpdateItem[];
  latestVersion: string | null;
  changelogUrl: string;
  /** Total releases in the running developments log after this run. */
  logCount: number;
  /** Monumental releases recorded to date (running significance tally). */
  monumentalToDate: number;
}

// A parsed changelog release: a version header and its bullet lines.
interface ChangelogEntry {
  version: string;
  bullets: string[];
}

// One line in the developments log (JSONL).
interface LogRecord {
  version: string;
  seenAt: string;
  highestTier: UpdateTier | "backfill";
  surfaced: boolean;
  items: Array<{ headline: string; tier: UpdateTier; category: string }>;
}

export interface ClaudeCodeUpdatesConfig {
  changelogUrl?: string;
  /** Absolute path to the developments-log JSONL. Defaults under KAYA_HOME. */
  logPath?: string;
  /** Max surfaced bullets in the rendered markdown. */
  maxSurfaced?: number;
}

export interface ClaudeCodeUpdatesDeps {
  /** Fetch a URL's text body. Returns null on any failure (best-effort). */
  fetchText?: (url: string, timeoutMs: number) => Promise<string | null>;
  /**
   * Assess a batch of new releases. Returns the filtered/tiered items.
   * Injected in tests; defaults to a real LLM call.
   */
  infer?: (entries: ChangelogEntry[]) => Promise<ClaudeCodeUpdateItem[]>;
  now?: () => Date;
}

// ============================================================================
// Changelog parsing
// ============================================================================

/**
 * Parse the Claude Code CHANGELOG markdown into releases, newest-first.
 * Format: `## <version>` header followed by `- <change>` bullet lines.
 * Robust to blank lines and continuation; ignores the top-level `# Changelog`.
 */
export function parseChangelog(markdown: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  let current: ChangelogEntry | null = null;

  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trimEnd();
    const header = line.match(/^##\s+(.+?)\s*$/);
    if (header) {
      if (current) entries.push(current);
      current = { version: header[1]!.trim(), bullets: [] };
      continue;
    }
    if (!current) continue;
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      current.bullets.push(bullet[1]!.trim());
    }
  }
  if (current) entries.push(current);

  // Keep only releases that actually carry changes.
  return entries.filter((e) => e.bullets.length > 0);
}

// ============================================================================
// Developments log (persistent state)
// ============================================================================

function defaultLogPath(): string {
  return join(getKayaHome(), "MEMORY", "BRIEFINGS", "claude-code-dev-log.jsonl");
}

function loadLog(logPath: string): LogRecord[] {
  if (!existsSync(logPath)) return [];
  const records: LogRecord[] = [];
  for (const line of readFileSync(logPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as LogRecord);
    } catch {
      /* skip malformed */
    }
  }
  return records;
}

function appendLog(logPath: string, records: LogRecord[]): void {
  if (records.length === 0) return;
  // This IS the durable "developments log" the section is built on — dedup
  // reads the whole active file, so we don't want rotation splitting seen
  // versions off into archives. Configure it to effectively never rotate
  // (~1-2 lines/day → decades to reach the cap) while still routing through
  // the sanctioned append-log seam (rotation/retention over raw appendFileSync).
  const log = createAppendLog(logPath, {
    maxSizeMB: 100,
    retentionDays: 36500,
    maxRotatedFiles: 50,
  });
  for (const record of records) log.append(record);
}

// ============================================================================
// Default LLM assessment
// ============================================================================

const ASSESS_SYSTEM_PROMPT = `You triage Claude Code (Anthropic's agentic coding CLI) release notes for Jm — a power user who runs an autonomous multi-agent system on Claude Code: background/remote agents, git-worktree isolation, MCP servers, hooks, cron-spawned headless sessions, subagents, and the Agent SDK.

Your job: turn a batch of raw changelog bullets into ONLY the changes worth his attention, each tiered by significance. Ruthlessly filter — the entire point is to cut internet noise, not reproduce it.

Tiers:
- "monumental": a new capability, workflow, model, or paradigm shift he should actively learn or adopt (e.g. new agent/SDK features, new permission or worktree models, big MCP/hook capabilities, major performance or reliability wins that change how he'd work).
- "notable": a genuinely useful improvement or fix in an area he uses (agents, worktrees, MCP, hooks, headless/cron, subagents, performance) that's worth knowing about.
- "minor": routine bug fixes, cosmetic tweaks, narrow-platform (Windows-only) fixes, or anything not relevant to how he works. DO NOT return minor items.

Rules:
- Return ONE item per meaningful change. Merge closely related bullets into a single clear headline.
- Each headline is a concrete, self-contained statement of WHAT CHANGED and why it matters — a reader must understand it without clicking. No teasers.
- Prefer fewer, higher-value items. A batch with only routine fixes should return an EMPTY array — that is a correct and expected outcome.
- Only state what the bullets say. Never invent features or details.
- Assign each item the "version" it appeared under (provided per bullet block).

Respond with ONLY a JSON object, no prose, no code fences:
{"items":[{"headline":"...","tier":"monumental|notable","category":"agents|mcp|hooks|worktrees|performance|security|sdk|workflow|models|other","version":"x.y.z"}]}`;

async function defaultInfer(entries: ChangelogEntry[]): Promise<ClaudeCodeUpdateItem[]> {
  if (entries.length === 0) return [];

  const batch = entries
    .map((e) => `### Version ${e.version}\n${e.bullets.map((b) => `- ${b}`).join("\n")}`)
    .join("\n\n");

  // 120s: steady-state daily runs assess only 0-2 small releases (a few
  // seconds), but a cold start / multi-day backlog can batch dozens of bullets
  // (~8k chars), which pushes Sonnet past the old 60s ceiling. This runs inside
  // the parallel gather phase, so the headroom doesn't serialize the briefing.
  const result = await inference({
    systemPrompt: ASSESS_SYSTEM_PROMPT,
    userPrompt: `Triage these ${entries.length} new Claude Code release(s):\n\n${batch}`,
    level: "standard",
    timeout: 120000,
  });

  if (!result.success || !result.output.trim()) return [];

  const parsed = parseAssessment(result.output);
  const validVersions = new Set(entries.map((e) => e.version));
  // Guard against the LLM inventing a version the batch didn't contain.
  return parsed.filter((i) => validVersions.has(i.version));
}

/** Parse the assessment JSON defensively (fences, stray prose, control chars). */
export function parseAssessment(raw: string): ClaudeCodeUpdateItem[] {
  const candidates: string[] = [raw.trim()];
  const fence = raw.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fence) candidates.push(fence[1]!.trim());
  const brace = raw.match(/\{[\s\S]*\}/);
  if (brace) candidates.push(brace[0]);

  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(candidate) as { items?: unknown };
      if (!Array.isArray(obj.items)) continue;
      const items: ClaudeCodeUpdateItem[] = [];
      for (const raw of obj.items) {
        if (typeof raw !== "object" || raw === null) continue;
        const o = raw as Record<string, unknown>;
        const tier = o.tier === "monumental" || o.tier === "notable" ? o.tier : null;
        if (
          typeof o.headline !== "string" ||
          !o.headline.trim() ||
          !tier ||
          typeof o.version !== "string"
        ) {
          continue;
        }
        items.push({
          headline: o.headline.trim(),
          tier,
          category: typeof o.category === "string" && o.category.trim() ? o.category.trim() : "other",
          version: o.version,
        });
      }
      return items;
    } catch {
      /* try next candidate */
    }
  }
  return [];
}

// ============================================================================
// Default network fetch
// ============================================================================

async function defaultFetchText(url: string, timeoutMs: number): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) return null;
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

// ============================================================================
// Rendering
// ============================================================================

function tierRank(tier: UpdateTier): number {
  return tier === "monumental" ? 2 : tier === "notable" ? 1 : 0;
}

// ============================================================================
// Main
// ============================================================================

export async function execute(
  config: ClaudeCodeUpdatesConfig = {},
  deps: ClaudeCodeUpdatesDeps = {}
): Promise<BlockResult> {
  const changelogUrl = config.changelogUrl ?? DEFAULT_CHANGELOG_URL;
  const logPath = config.logPath ?? defaultLogPath();
  const maxSurfaced = config.maxSurfaced ?? 6;
  const fetchText = deps.fetchText ?? defaultFetchText;
  const infer = deps.infer ?? defaultInfer;
  const now = deps.now ?? (() => new Date());

  // Return type widened to BlockResult.data's Record<string, unknown> — a
  // named interface has no implicit index signature, so it isn't directly
  // assignable; the shape is still an explicit ClaudeCodeUpdatesData literal.
  const emptyData = (extra: Partial<ClaudeCodeUpdatesData> = {}): Record<string, unknown> => ({
    newVersions: [],
    surfaced: [],
    latestVersion: null,
    changelogUrl,
    logCount: 0,
    monumentalToDate: 0,
    ...extra,
  });

  try {
    const md = await fetchText(changelogUrl, 8000);
    if (!md) {
      return {
        blockName: BLOCK_NAME,
        success: false,
        data: emptyData(),
        markdown: "",
        summary: "Claude Code changelog unavailable",
        error: "changelog fetch failed",
      };
    }

    const entries = parseChangelog(md);
    const latestVersion = entries[0]?.version ?? null;

    const existing = loadLog(logPath);
    const seen = new Set(existing.map((r) => r.version));
    const priorMonumental = existing.filter((r) => r.highestTier === "monumental").length;

    const isFirstRun = existing.length === 0;
    const newEntries = entries.filter((e) => !seen.has(e.version));

    // Nothing new — success with an empty section (block simply shows nothing).
    if (newEntries.length === 0) {
      return {
        blockName: BLOCK_NAME,
        success: true,
        data: emptyData({
          latestVersion,
          logCount: existing.length,
          monumentalToDate: priorMonumental,
        }),
        markdown: "",
        summary: latestVersion
          ? `No new Claude Code releases (latest ${latestVersion})`
          : "No new Claude Code releases",
      };
    }

    // Decide which new releases get an LLM pass vs. get backfilled silently.
    // On first run: only assess the newest few, backfill the rest.
    // On steady state: assess up to MAX_ASSESS_VERSIONS newest, backfill any excess.
    const assessLimit = isFirstRun ? SEED_SURFACE_VERSIONS : MAX_ASSESS_VERSIONS;
    const toAssess = newEntries.slice(0, assessLimit);
    const toBackfill = newEntries.slice(assessLimit);

    const assessed = await infer(toAssess);

    const seenAt = now().toLocaleDateString("en-CA");
    const records: LogRecord[] = [];

    // Assessed releases → one log record each, carrying their surfaced items.
    for (const entry of toAssess) {
      const items = assessed.filter((i) => i.version === entry.version);
      const highestTier: UpdateTier | "backfill" =
        items.some((i) => i.tier === "monumental")
          ? "monumental"
          : items.some((i) => i.tier === "notable")
            ? "notable"
            : "minor";
      records.push({
        version: entry.version,
        seenAt,
        highestTier,
        surfaced: items.length > 0,
        items: items.map((i) => ({ headline: i.headline, tier: i.tier, category: i.category })),
      });
    }
    // Backfilled releases → recorded seen, never surfaced, no LLM cost.
    for (const entry of toBackfill) {
      records.push({
        version: entry.version,
        seenAt,
        highestTier: "backfill",
        surfaced: false,
        items: [],
      });
    }

    appendLog(logPath, records);

    // Surface only monumental + notable, most-significant-first, capped.
    const surfaced = [...assessed]
      .filter((i) => i.tier === "monumental" || i.tier === "notable")
      .sort((a, b) => tierRank(b.tier) - tierRank(a.tier))
      .slice(0, maxSurfaced);

    const logCount = existing.length + records.length;
    const monumentalToDate =
      priorMonumental + records.filter((r) => r.highestTier === "monumental").length;

    // No markdown rendering — the live path (DataGatherer) reads only .data.
    const markdown = "";

    const monumentalCount = surfaced.filter((i) => i.tier === "monumental").length;
    const summary =
      surfaced.length > 0
        ? `${surfaced.length} Claude Code update${surfaced.length === 1 ? "" : "s"} worth knowing` +
          (monumentalCount > 0 ? ` (${monumentalCount} major)` : "") +
          ` from ${toAssess.length} new release${toAssess.length === 1 ? "" : "s"}`
        : `${newEntries.length} new Claude Code release${newEntries.length === 1 ? "" : "s"} — nothing notable`;

    return {
      blockName: BLOCK_NAME,
      success: true,
      data: {
        newVersions: newEntries.map((e) => e.version),
        surfaced,
        latestVersion,
        changelogUrl,
        logCount,
        monumentalToDate,
      } satisfies ClaudeCodeUpdatesData,
      markdown,
      summary,
    };
  } catch (err) {
    return {
      blockName: BLOCK_NAME,
      success: false,
      data: emptyData(),
      markdown: "",
      summary: "Claude Code updates unavailable",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ============================================================================
// CLI
// ============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);
  // --dry-run: parse + assess but write to a scratch log so a manual run
  // doesn't poison tomorrow's real diff.
  const dryRun = args.includes("--dry-run");
  const cfg: ClaudeCodeUpdatesConfig = dryRun
    ? { logPath: join(getKayaHome(), "MEMORY", "BRIEFINGS", ".claude-code-dev-log.dryrun.jsonl") }
    : {};

  execute(cfg)
    .then((result) => {
      console.log("=== ClaudeCodeUpdatesBlock ===\n");
      console.log("Success:", result.success);
      console.log("Summary:", result.summary);
      if (result.error) console.log("Error:", result.error);
      console.log("\n--- Markdown ---\n");
      console.log(result.markdown || "(empty — nothing new/notable)");
      console.log("\n--- Data ---");
      console.log(JSON.stringify(result.data, null, 2));
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
