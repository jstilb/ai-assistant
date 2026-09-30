#!/usr/bin/env bun
/**
 * SpecValidator.ts — UX/UI structural gate + behavioral ISC derivation.
 *
 * Doctrine (markdown-regex remediation, 2026-08-01): the spec markdown is
 * LLM-authored prose, so READING it is delegated to a schema-constrained
 * model call (extractUXStructure). What stays deterministic is the arithmetic
 * on the extracted structure:
 *   computeUXCompleteness — declaredStates − wireframeStates set math
 *   renderBehavioralISC   — ISC table-row formatting from GWT criteria
 *
 * HISTORY: the previous implementation chained parseScreenInventory (strict
 * Zod table parse) → coverageGaps (H2 heading splitter requiring the exact
 * "## Screen: <Name> (`<id>`)" shape) → GWT bullet regexes. It was a HARD
 * gate: a heading-format mismatch in markdown the spec-writing LLM actually
 * wrote bounced the whole spec to awaiting-context ("telling the LLM it's
 * missing something it actually wrote"), and criteria phrased with bold
 * markers or across lines silently never became ISC rows.
 *
 * Failure policy: extractUXStructure returns {ok:false} on inference failure
 * — callers surface that loudly (the pipeline gate bounces with an explicit
 * "extraction unavailable" reason rather than a phantom coverage gap).
 */

import { inference } from "../../../../lib/core/Inference.ts";

// ============================================================================
// Types
// ============================================================================

/** Result shape shared by completeness validators (pipeline gate contract). */
export interface CompletenessResult {
  pass: boolean;
  failures: string[];
}

/** One screen as extracted from the spec's UX/UI section. */
export interface UXScreenStructure {
  /** Screen id exactly as written in the Screen Inventory (e.g. "item-list"). */
  id: string;
  /** Human-readable screen name. */
  name: string;
  /** Route/path if the spec states one, else null. */
  route: string | null;
  /** States declared for this screen in the Screen Inventory. */
  declaredStates: string[];
  /** States whose wireframe/layout content actually appears in the screen's section. */
  wireframeStates: string[];
  /** This screen's Given/When/Then acceptance criteria, one string each. */
  gwtCriteria: string[];
}

export interface UXStructure {
  screens: UXScreenStructure[];
}

export type UXStructureResult =
  | { ok: true; structure: UXStructure }
  | { ok: false; error: string };

// ============================================================================
// Model extraction (the only reader of the LLM-authored markdown)
// ============================================================================

const UX_STRUCTURE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    screens: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          route: { type: ["string", "null"] },
          declaredStates: { type: "array", items: { type: "string" } },
          wireframeStates: { type: "array", items: { type: "string" } },
          gwtCriteria: { type: "array", items: { type: "string" } },
        },
        required: ["id", "name", "route", "declaredStates", "wireframeStates", "gwtCriteria"],
        additionalProperties: false,
      },
    },
  },
  required: ["screens"],
  additionalProperties: false,
};

const UX_STRUCTURE_SYSTEM_PROMPT = `You analyze the "UX/UI Specification" section of an implementation spec (markdown authored by another model). Extract its screen structure EXACTLY as written — never invent screens, states, or criteria that are not in the document.

Definitions:
- Screen Inventory: the part listing all screens, usually a markdown table with columns like Screen ID / Name / Route / States. declaredStates = the states listed there for each screen (split comma-separated lists into individual states).
- wireframeStates: within each screen's own section (canonically headed "## Screen: <Name> (\`<id>\`)"), the states whose wireframe/layout content is actually presented. The canonical marker is a "### State: <state>" subsection, but tolerate formatting variation (bold labels, different heading depth, minor casing) — what matters is whether that state's wireframe content is really there.
- gwtCriteria: that screen's Given/When/Then acceptance criteria, one string per criterion ("Given ..., when ..., then ..."), as written — tolerate bold markers, multi-line phrasing, and list formatting.
- route: the screen's route/path if stated, else null.

Output one entry per screen that appears in the Screen Inventory. If the Screen Inventory is missing or empty, output an empty screens array. Keep ids exactly as written (trim whitespace only).`;

/**
 * Extract the UX/UI screen structure from a spec via a schema-constrained
 * model call. One call serves both the coverage gate and ISC derivation —
 * callers should extract once and feed both pure functions below.
 */
export async function extractUXStructure(specMarkdown: string): Promise<UXStructureResult> {
  const result = await inference({
    systemPrompt: UX_STRUCTURE_SYSTEM_PROMPT,
    userPrompt: specMarkdown.slice(0, 120_000),
    level: "standard",
    schema: UX_STRUCTURE_SCHEMA,
    timeout: 180_000,
    retries: 1,
  });

  if (!result.success || result.parsed === undefined || result.parsed === null) {
    return { ok: false, error: result.error ?? "no structured output" };
  }

  return { ok: true, structure: result.parsed as UXStructure };
}

// ============================================================================
// Deterministic arithmetic on the extracted structure
// ============================================================================

function normState(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * computeUXCompleteness — screen × state coverage as pure set math.
 *
 * A declared state with no wireframe content in its screen's section is a
 * gap. An empty screens array fails: the caller only invokes this when the
 * spec has a UX/UI section, so "no screens" means the Screen Inventory
 * itself is missing or empty.
 */
export function computeUXCompleteness(structure: UXStructure): CompletenessResult {
  const failures: string[] = [];

  if (structure.screens.length === 0) {
    failures.push("Screen Inventory missing or empty in the UX/UI Specification section");
  }

  for (const screen of structure.screens) {
    const wireframes = new Set(screen.wireframeStates.map(normState));
    for (const state of screen.declaredStates) {
      if (!wireframes.has(normState(state))) {
        failures.push(
          `Screen "${screen.id}" is missing a wireframe for declared state "${state}" (add a "### State: ${state}" subsection)`
        );
      }
    }
  }

  return { pass: failures.length === 0, failures };
}

/**
 * renderBehavioralISC — format each screen's GWT criteria as ISC table rows.
 *
 * Row format (pipe-delimited, matching SpecTemplate §9):
 *   | UX-<screenId>-<NN> | [<screenId>] <criterion> | <route or /screenId> | browser/Playwright | M |
 */
export function renderBehavioralISC(structure: UXStructure): string[] {
  const rows: string[] = [];
  let rowIndex = 1;

  for (const screen of structure.screens) {
    for (const criterion of screen.gwtCriteria) {
      // Pipes inside a criterion would break the table row — neutralize them.
      const text = criterion.trim().replace(/\s*\|\s*/g, " / ");
      if (text.length === 0) continue;

      const id = `UX-${screen.id}-${String(rowIndex).padStart(2, "0")}`;
      const files = screen.route && screen.route.trim().length > 0 ? screen.route.trim() : `/${screen.id}`;
      rows.push(`| ${id} | [${screen.id}] ${text} | ${files} | browser/Playwright | M |`);
      rowIndex++;
    }
  }

  return rows;
}
