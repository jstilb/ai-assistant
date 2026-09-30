/**
 * TelosGoals.ts — typed source of truth for Jm's TELOS goals.
 *
 * Option (b) of the markdown-regex remediation (Jm's call, 2026-08-02):
 * `USER/TELOS/goals.yaml` is the STRUCTURED SOURCE Jm edits; `GOALS.md` is a
 * GENERATED artifact rendered from it (skills/Life/Telos/Tools/GenerateGoalsMd.ts).
 * This deletes the five independent regex parsers that each re-derived the
 * same hand-written GOALS.md grammar (DailyBriefing/GoalsBlock,
 * LucidTasks/TelosGoalLoader, AgentMetacognition/GoalConnector,
 * LifeOS/StatusRefresh, KnowledgeGraph/GapDetector) — a format change that
 * satisfied one silently broke the other four.
 *
 * Contract:
 *  - Goal prose (metrics, leads, design notes, scheduler comments) lives in
 *    each goal's `body` VERBATIM — never re-summarized, never parsed. Only
 *    id/title/type/status/supports are structured fields.
 *  - renderGoalsMd() must reproduce the historical GOALS.md format exactly:
 *    other consumers still regex the rendered markdown (DigestBuilder's
 *    "## Q\d+ WIGs — Active" em-dash heading, KayaScheduler's weeklyHours
 *    lines) — section headings and bodies are therefore literal strings.
 *  - All validation fails LOUD (throw), never degrades to empty data.
 *
 * @module TelosGoals
 */

import { readFileSync } from "fs";
import { join } from "path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { getKayaHome } from "./KayaHome.ts";

// ============================================================================
// Schema
// ============================================================================

const MissionRefSchema = z.object({
  id: z.string().regex(/^M\d+$/, "mission id must match M<number>"),
  name: z.string().min(1).optional(),
});

const GoalDefSchema = z.object({
  title: z.string().min(1),
  /** Optional "**Type:** ..." line (e.g. "Quarterly WIG"). */
  type: z.string().min(1).optional(),
  /** Full status line, markdown allowed. Rendered as "**Status:** ...". */
  status: z.string().min(1),
  /** Missions this goal supports. Rendered "M1 (Community), M4 (Friend)". */
  supports: z.array(MissionRefSchema).min(1),
  /** Everything else in the goal's section, VERBATIM markdown. */
  body: z.string().optional(),
});

const GoalSectionSchema = z.object({
  /** Literal heading line, e.g. "## Q3 WIGs — Active (2026-07-06 → 2026-09-27)". */
  heading: z.string().regex(/^## /, "section heading must start with '## '"),
  /** WIG section (quarterly/monthly big-rocks). */
  wig: z.boolean().optional(),
  /** The currently-active quarter's section. At most one across the file. */
  active: z.boolean().optional(),
  /** Literal markdown between the heading and the first goal. */
  preamble: z.string().optional(),
  /** Ordered goal ids in this section. */
  goals: z.array(z.string().regex(/^G\d+$/)).min(1),
});

const LiteralSectionSchema = z.object({
  /** A full literal markdown section (heading included) with no goal entries. */
  markdown: z.string().min(1),
});

const SectionSchema = z.union([GoalSectionSchema, LiteralSectionSchema]);

const GoalsFileSchema = z.object({
  /** Literal document head (the "# Goals" H1 + intro paragraphs). */
  preamble: z.string().min(1),
  sections: z.array(SectionSchema).min(1),
  /** Literal document tail (the italic review/footer lines). */
  footer: z.string().min(1),
  /** Goal definitions keyed by id (G<number>). */
  goals: z.record(z.string().regex(/^G\d+$/), GoalDefSchema),
});

export type TelosMissionRef = z.infer<typeof MissionRefSchema>;
export type TelosGoalDef = z.infer<typeof GoalDefSchema>;
export type TelosGoalSection = z.infer<typeof GoalSectionSchema>;
export type TelosLiteralSection = z.infer<typeof LiteralSectionSchema>;
export type TelosSection = z.infer<typeof SectionSchema>;
export type GoalsFileModel = z.infer<typeof GoalsFileSchema>;

export function isGoalSection(s: TelosSection): s is TelosGoalSection {
  return "heading" in s;
}

// ============================================================================
// Parse + validate
// ============================================================================

/**
 * Parse goals.yaml text into a validated model. Throws on schema violations,
 * dangling/duplicate goal references, flag/heading drift, or structured
 * fields duplicated inside a body.
 */
export function parseGoalsModel(yamlText: string): GoalsFileModel {
  // uniqueKeys is the yaml package default — duplicate goal ids throw here.
  const raw: unknown = parseYaml(yamlText);
  const model = GoalsFileSchema.parse(raw);

  const referenced = new Map<string, string>(); // goal id → section heading
  let activeCount = 0;

  for (const section of model.sections) {
    if (!isGoalSection(section)) continue;

    if (section.active) {
      activeCount++;
      if (!section.heading.includes("Active")) {
        throw new Error(
          `TelosGoals: section "${section.heading}" is flagged active but its heading does not say "Active" — heading-regex consumers (DigestBuilder) and the flag would disagree`,
        );
      }
    } else if (/\bActive\b/.test(section.heading)) {
      throw new Error(
        `TelosGoals: section "${section.heading}" says "Active" in its heading but is not flagged active:true — set the flag or fix the heading`,
      );
    }

    if (section.wig && !section.heading.includes("WIG")) {
      throw new Error(
        `TelosGoals: section "${section.heading}" is flagged wig but its heading does not say "WIG"`,
      );
    }
    if (!section.wig && section.heading.includes("WIG")) {
      throw new Error(
        `TelosGoals: section "${section.heading}" says "WIG" in its heading but is not flagged wig:true`,
      );
    }

    for (const id of section.goals) {
      const prior = referenced.get(id);
      if (prior !== undefined) {
        throw new Error(
          `TelosGoals: goal ${id} is referenced by two sections ("${prior}" and "${section.heading}")`,
        );
      }
      referenced.set(id, section.heading);
      if (!(id in model.goals)) {
        throw new Error(
          `TelosGoals: section "${section.heading}" references ${id}, which has no definition under goals:`,
        );
      }
    }
  }

  if (activeCount > 1) {
    throw new Error(`TelosGoals: ${activeCount} sections are flagged active — at most one quarter may be active`);
  }

  for (const id of Object.keys(model.goals)) {
    if (!referenced.has(id)) {
      throw new Error(`TelosGoals: goal ${id} is defined but not placed in any section`);
    }
    const body = model.goals[id]!.body;
    if (body !== undefined) {
      const duplicated = body.match(/^\*\*(Type|Status|Supports):\*\*/m);
      if (duplicated) {
        throw new Error(
          `TelosGoals: goal ${id}'s body contains a "${duplicated[0]}" line — that field is structured; set it on the goal, not in body (silent-drift guard)`,
        );
      }
    }
  }

  return model;
}

// ============================================================================
// Render (goals.yaml model → GOALS.md text)
// ============================================================================

/** Render mission refs as the historical Supports label: "M1 (Community), M4 (Friend)". */
export function renderSupportsLabel(supports: TelosMissionRef[]): string {
  return supports.map((m) => (m.name ? `${m.id} (${m.name})` : m.id)).join(", ");
}

function renderGoal(id: string, goal: TelosGoalDef): string {
  const lines = [`### ${id}: ${goal.title}`];
  if (goal.type !== undefined) lines.push(`**Type:** ${goal.type}`);
  lines.push(`**Status:** ${goal.status}`);
  lines.push(`**Supports:** ${renderSupportsLabel(goal.supports)}`);
  if (goal.body !== undefined && goal.body.trim().length > 0) {
    lines.push(goal.body.replace(/\s+$/, ""));
  }
  return lines.join("\n");
}

function renderSection(section: TelosSection, goals: GoalsFileModel["goals"]): string {
  if (!isGoalSection(section)) return section.markdown.replace(/\s+$/, "");
  const parts = [section.heading];
  if (section.preamble !== undefined && section.preamble.trim().length > 0) {
    parts.push(section.preamble.replace(/\s+$/, ""));
  }
  for (const id of section.goals) {
    parts.push(renderGoal(id, goals[id]!));
  }
  return parts.join("\n\n");
}

/**
 * Render the full GOALS.md document (no banner — the generator CLI adds it).
 * Sections are joined with the historical `---` separators.
 */
export function renderGoalsMd(model: GoalsFileModel): string {
  const parts = [
    model.preamble.replace(/\s+$/, ""),
    ...model.sections.map((s) => renderSection(s, model.goals)),
    model.footer.replace(/\s+$/, ""),
  ];
  return parts.join("\n\n---\n\n") + "\n";
}

// ============================================================================
// Loader (what the former five parsers' consumers use)
// ============================================================================

/** One goal with its section context attached. */
export interface TelosGoalEntry {
  id: string;
  title: string;
  type?: string;
  /** Full status line as authored (markdown allowed). */
  status: string;
  supports: TelosMissionRef[];
  /** Verbatim goal prose (metrics, leads, notes) — display/LLM context only. */
  body?: string;
  sectionHeading: string;
  /** Goal lives in a WIG section (any quarter, active or closed). */
  sectionWig: boolean;
  /** Goal lives in the active quarter's section. */
  sectionActive: boolean;
}

export interface TelosGoalsData {
  model: GoalsFileModel;
  /** All goals in document order. */
  goals: TelosGoalEntry[];
  goalById: Map<string, TelosGoalEntry>;
  /** Goals in the active WIG section (the current quarter's WIGs), in order. */
  activeWigs: TelosGoalEntry[];
}

export function telosGoalsYamlPath(): string {
  return join(getKayaHome(), "USER", "TELOS", "goals.yaml");
}

export function telosGoalsMdPath(): string {
  return join(getKayaHome(), "USER", "TELOS", "GOALS.md");
}

/** Flatten a validated model into consumer-facing entries. */
export function flattenGoals(model: GoalsFileModel): TelosGoalsData {
  const goals: TelosGoalEntry[] = [];
  for (const section of model.sections) {
    if (!isGoalSection(section)) continue;
    for (const id of section.goals) {
      const def = model.goals[id]!;
      goals.push({
        id,
        title: def.title,
        ...(def.type !== undefined ? { type: def.type } : {}),
        status: def.status,
        supports: def.supports,
        ...(def.body !== undefined ? { body: def.body } : {}),
        sectionHeading: section.heading,
        sectionWig: section.wig === true,
        sectionActive: section.active === true,
      });
    }
  }
  return {
    model,
    goals,
    goalById: new Map(goals.map((g) => [g.id, g])),
    activeWigs: goals.filter((g) => g.sectionActive && g.sectionWig),
  };
}

/**
 * Load and validate USER/TELOS/goals.yaml. Throws (fail loud) when the file
 * is missing or invalid — consumers must surface that, not render empty.
 */
export function loadTelosGoals(): TelosGoalsData {
  const path = telosGoalsYamlPath();
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (e) {
    throw new Error(
      `TelosGoals: cannot read ${path} (${e instanceof Error ? e.message : String(e)}). ` +
        `goals.yaml is the source of truth for GOALS.md — if it is missing, the TELOS migration is broken; do NOT fall back to parsing GOALS.md.`,
    );
  }
  return flattenGoals(parseGoalsModel(text));
}
