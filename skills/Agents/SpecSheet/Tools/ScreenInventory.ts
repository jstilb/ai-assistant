/**
 * ScreenInventory.ts — Shared parser for the Screen Inventory yaml block
 *
 * This is the shared seam used by the UXSpec skill, UISpec skill, SpecValidator,
 * and the spec pipeline. All downstream slices depend on these types and helpers.
 *
 * Screen Inventory blocks appear in UX Specs as a fenced yaml block tagged
 * with "screen-inventory":
 *
 *   ```yaml screen-inventory
 *   screens:
 *     - id: home
 *       ...
 *   ```
 *
 * Usage:
 *   import { parseScreenInventory, listScreens, statesFor, coverageGaps } from "./ScreenInventory.ts";
 */

import { z } from "zod";
import { parseDocument } from "yaml";

// ============================================================================
// Contract Types
// ============================================================================

// Recommended baseline states — not an exclusive whitelist.
// Screens MAY declare additional feature-specific states (e.g. "renaming", "editing", "selecting").
// Every declared state — baseline or custom — must have its own `### State: <state>` wireframe.
export const VALID_STATES = ["default", "empty", "loading", "error", "success", "edge"] as const;

export type ScreenState = string;

export interface ScreenEntry {
  id: string;
  name: string;
  purpose: string;
  route?: string;
  entry: string[];
  exits: string[];
  states: ScreenState[];
}

export interface ScreenInventory {
  screens: ScreenEntry[];
}

export interface ParseResult {
  ok: boolean;
  inventory?: ScreenInventory;
  errors: string[];
}

/** Returned by coverageGaps — full implementation is Slice 5 */
export interface CoverageGap {
  screenId: string;
  state: ScreenState;
  description: string;
}

// ============================================================================
// Zod Schemas
// ============================================================================

// Accepts any non-empty string — baseline states are recommended, not an exclusive whitelist.
// The "default" requirement is enforced as a post-parse business rule below.
const ScreenStateSchema = z.string().min(1, "State name must be non-empty");

const ScreenEntrySchema = z.object({
  id: z.string().min(1, "Screen id must be non-empty"),
  name: z.string().min(1, "Screen name must be non-empty"),
  purpose: z.string().min(1, "Screen purpose must be non-empty"),
  route: z.string().optional(),
  entry: z.array(z.string()).min(1, "Screen must have at least one entry point"),
  exits: z.array(z.string()).min(1, "Screen must have at least one exit"),
  states: z.array(ScreenStateSchema).min(1, "Screen must declare at least one state"),
});

const ScreenInventorySchema = z.object({
  screens: z.array(ScreenEntrySchema).min(1, "Screen inventory must contain at least one screen"),
});

// ============================================================================
// Parser
// ============================================================================

/**
 * Extract the raw YAML content from the first ```yaml screen-inventory block
 * found in the markdown string. Returns null if no such block is found.
 */
function extractInventoryBlock(markdown: string): string | null {
  // Match fenced code block: ```yaml screen-inventory ... ``` (may have trailing spaces)
  const match = markdown.match(/```yaml\s+screen-inventory\s*\n([\s\S]*?)```/);
  if (!match) return null;
  return match[1];
}

/**
 * Parse the screen inventory from a markdown spec document.
 *
 * Finds the first ```yaml screen-inventory fenced block, parses the YAML,
 * validates structure with Zod, and returns a ParseResult.
 *
 * Hard constraints:
 * - Every screen's states array must include "default"
 * - Screen ids must be unique
 */
export function parseScreenInventory(markdown: string): ParseResult {
  // 1. Find the inventory block
  const raw = extractInventoryBlock(markdown);
  if (!raw) {
    return {
      ok: false,
      errors: [
        'No ```yaml screen-inventory block found in the spec. Add a fenced YAML block tagged as "screen-inventory".',
      ],
    };
  }

  // 2. Parse YAML — use yaml library for spec-compliant parsing
  let parsed: unknown;
  try {
    const doc = parseDocument(raw);
    if (doc.errors && doc.errors.length > 0) {
      return {
        ok: false,
        errors: doc.errors.map((e) => `YAML parse error: ${e.message}`),
      };
    }
    parsed = doc.toJSON();
  } catch (err) {
    return {
      ok: false,
      errors: [`YAML parse error: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  // 3. Validate schema with Zod
  const zodResult = ScreenInventorySchema.safeParse(parsed);
  if (!zodResult.success) {
    const errors = zodResult.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? `[${issue.path.join(".")}] ` : "";
      return `${path}${issue.message}`;
    });
    return { ok: false, errors };
  }

  const inventory = zodResult.data as ScreenInventory;

  // 4. Business-rule validations (not expressible in Zod schema alone)
  const ruleErrors: string[] = [];

  // Rule: every screen must have "default" in its states
  for (const screen of inventory.screens) {
    if (!screen.states.includes("default")) {
      ruleErrors.push(
        `Screen "${screen.id}" is missing required state "default". Every screen must include the default state.`
      );
    }
  }

  // Rule: screen ids must be unique
  const seen = new Set<string>();
  for (const screen of inventory.screens) {
    if (seen.has(screen.id)) {
      ruleErrors.push(
        `Duplicate screen id "${screen.id}". Screen ids must be unique across the inventory.`
      );
    }
    seen.add(screen.id);
  }

  if (ruleErrors.length > 0) {
    return { ok: false, errors: ruleErrors };
  }

  return { ok: true, inventory, errors: [] };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Return all screens from an already-parsed inventory, in declaration order.
 */
export function listScreens(inventory: ScreenInventory): ScreenEntry[] {
  return inventory.screens;
}

/**
 * Return the states declared for a specific screen id.
 * Returns an empty array if the screen id is not found.
 */
export function statesFor(inventory: ScreenInventory, screenId: string): ScreenState[] {
  const screen = inventory.screens.find((s) => s.id === screenId);
  return screen ? screen.states : [];
}

/**
 * coverageGaps — Slice 5 implementation.
 *
 * For each screen × state declared in the inventory, checks whether the spec
 * markdown contains a `### State: <state>` wireframe subsection **scoped to
 * that screen's co-located section**.
 *
 * Screen-section delimiter (co-location unit):
 *   `## Screen: <Name> (`<screen-id>`)` (H2 level, backtick-quoted id).
 * This is the canonical heading from UXUISpecFormat.md where each screen's
 * UX intent AND UI realization both live.
 * The `### State: <state>` marker inside that section is the coverage signal.
 *
 * Algorithm:
 *   1. Split the markdown on H2 headings that match the Screen section pattern.
 *   2. For each (screenId, state), look up the matching section slice and check
 *      for the exact `### State: <state>` marker.
 *   3. If the marker is absent, emit a CoverageGap.
 *
 * @param inventory    The parsed Screen Inventory
 * @param specMarkdown The full spec markdown to scan for coverage
 * @returns Array of CoverageGap descriptors — empty means full coverage
 */
export function coverageGaps(
  inventory: ScreenInventory,
  specMarkdown: string
): CoverageGap[] {
  const gaps: CoverageGap[] = [];

  // Split the markdown into sections delimited by H2 headings.
  // Each element is the text from one H2 heading to the next.
  // Pattern: "## Screen: <Name> (`<id>`)" — backtick-quoted id is required.
  const lines = specMarkdown.split("\n");

  // Build a map from screenId → the text slice of its Screen section.
  // A section begins at "## Screen: <Name> (`<id>`)" and ends before the next H2.
  const sectionMap = new Map<string, string>();

  let currentScreenId: string | null = null;
  let currentSectionLines: string[] = [];

  for (const line of lines) {
    // Detect a co-located Screen section heading: ## Screen: <Name> (`<screen-id>`)
    const sectionMatch = line.match(/^##\s+Screen:\s+.+\(`([^`]+)`\)/);
    if (sectionMatch) {
      // Save any previous section
      if (currentScreenId !== null) {
        sectionMap.set(currentScreenId, currentSectionLines.join("\n"));
      }
      currentScreenId = sectionMatch[1];
      currentSectionLines = [line];
      continue;
    }

    // Detect any other H2 heading (ends the current Screen section)
    if (line.startsWith("## ") && currentScreenId !== null) {
      sectionMap.set(currentScreenId, currentSectionLines.join("\n"));
      currentScreenId = null;
      currentSectionLines = [];
      continue;
    }

    if (currentScreenId !== null) {
      currentSectionLines.push(line);
    }
  }

  // Flush the last section if still open
  if (currentScreenId !== null) {
    sectionMap.set(currentScreenId, currentSectionLines.join("\n"));
  }

  // For each screen × state, check whether the state marker exists in that screen's section
  for (const screen of inventory.screens) {
    const section = sectionMap.get(screen.id);

    for (const state of screen.states) {
      // The exact machine-detectable marker from UXUISpecFormat.md:
      // "### State: <state>" (three # chars, capital S, colon, space, lowercase state name)
      const marker = `### State: ${state}`;

      if (!section || !section.includes(marker)) {
        gaps.push({
          screenId: screen.id,
          state,
          description: `Screen "${screen.id}" is missing a wireframe section for state "${state}". Add a "${marker}" subsection inside the "## Screen: ${screen.name} (\`${screen.id}\`)" section.`,
        });
      }
    }
  }

  return gaps;
}
