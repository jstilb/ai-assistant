#!/usr/bin/env bun
/**
 * SpecParser.ts - Parse phases and ISC from spec markdown
 *
 * Extracts structured phase and ISC information from spec files
 * to enable progress tracking and resumption.
 *
 * Usage:
 *   bun run SpecParser.ts parse <spec-path>      # Parse and display phases/ISC
 *   bun run SpecParser.ts phases <spec-path>     # List phases only
 *   bun run SpecParser.ts isc <spec-path>        # List ISC rows only
 */

import { readFileSync, existsSync } from "fs";
import { parseArgs } from "util";

// ============================================================================
// Types
// ============================================================================

/** Parsed ISC criterion from spec */
export interface ISCCriterion {
  /** ISC number from the spec (1, 2, 3...) */
  number: number;
  /** The criterion description */
  description: string;
  /** Source: EXPLICIT, IMPLICIT, INFERRED */
  source?: string;
  /** Verification method */
  verifyMethod?: string;
  /** Whether this criterion is checked ([ ] vs [x]) */
  isChecked: boolean;
}

/** Parsed phase from spec */
export interface SpecPhase {
  /** Phase number (1, 2, 3...) */
  number: number;
  /** Phase name */
  name: string;
  /** Implementation steps within this phase */
  steps: string[];
  /** ISC criteria that belong to this phase (if identifiable) */
  iscNumbers: number[];
}

/** Complete parsed spec */
export interface ParsedSpec {
  /** Spec title */
  title: string;
  /** All phases found */
  phases: SpecPhase[];
  /** All ISC criteria found */
  isc: ISCCriterion[];
  /** Total phases count */
  totalPhases: number;
  /** Total ISC count */
  totalISC: number;
}

// ============================================================================
// Parser Functions
// ============================================================================

/**
 * Parse a spec file and extract phases and ISC
 */
export function parseSpec(specPath: string): ParsedSpec {
  if (!existsSync(specPath)) {
    throw new Error(`Spec file not found: ${specPath}`);
  }

  const content = readFileSync(specPath, "utf-8");
  const lines = content.split("\n");

  const title = extractTitle(content);
  const phases = extractPhases(content);
  const isc = extractISC(content);

  return {
    title,
    phases,
    isc,
    totalPhases: phases.length,
    totalISC: isc.length,
  };
}

/**
 * Extract the spec title from the first heading
 */
function extractTitle(content: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : "Untitled Spec";
}

/**
 * Extract phases from the spec
 *
 * Looks for patterns like:
 * - **Phase 1: Foundation**
 * - ### Phase 1: Foundation
 * - ## 5.2 Implementation Steps → Phase headers within
 */
function extractPhases(content: string): SpecPhase[] {
  const phases: SpecPhase[] = [];

  // Pattern 1: **Phase N: Name** (inline bold)
  const boldPhaseRegex = /\*\*Phase\s+(\d+):\s+([^*]+)\*\*/gi;
  let match: RegExpExecArray | null;

  while ((match = boldPhaseRegex.exec(content)) !== null) {
    const phaseNum = parseInt(match[1], 10);
    const phaseName = match[2].trim().replace(/\s*\([^)]+\)\s*$/, ""); // Remove trailing (Week X)

    // Extract steps after this phase heading
    const phaseStart = match.index + match[0].length;
    const nextPhaseMatch = content.slice(phaseStart).match(/\*\*Phase\s+\d+:/i);
    const phaseEnd = nextPhaseMatch
      ? phaseStart + (nextPhaseMatch.index || 0)
      : content.length;

    const phaseContent = content.slice(phaseStart, phaseEnd);
    const steps = extractSteps(phaseContent);

    // Check if phase already exists (avoid duplicates)
    if (!phases.find((p) => p.number === phaseNum)) {
      phases.push({
        number: phaseNum,
        name: phaseName,
        steps,
        iscNumbers: [], // Will be populated by ISC mapping if available
      });
    }
  }

  // Pattern 2: ### Phase N: Name (heading style)
  const headingPhaseRegex = /^###?\s+Phase\s+(\d+):\s+(.+)$/gim;
  while ((match = headingPhaseRegex.exec(content)) !== null) {
    const phaseNum = parseInt(match[1], 10);
    const phaseName = match[2].trim();

    if (!phases.find((p) => p.number === phaseNum)) {
      phases.push({
        number: phaseNum,
        name: phaseName,
        steps: [],
        iscNumbers: [],
      });
    }
  }

  // Sort by phase number
  phases.sort((a, b) => a.number - b.number);

  // After extracting phases, look for ISC mapping hints
  for (const phase of phases) {
    const phasePattern = new RegExp(
      `\\*\\*Phase\\s+${phase.number}:`,
      'i'
    );
    const phaseMatch = content.match(phasePattern);
    if (phaseMatch?.index !== undefined) {
      const after = content.slice(phaseMatch.index, phaseMatch.index + 500);
      const hintMatch = after.match(/<!--\s*ISC:\s*([\d,\s]+)\s*-->/);
      if (hintMatch) {
        phase.iscNumbers = hintMatch[1]
          .split(',')
          .map(n => parseInt(n.trim(), 10))
          .filter(n => !isNaN(n));
      }
    }
  }

  return phases;
}

/**
 * Extract numbered steps from phase content
 */
function extractSteps(content: string): string[] {
  const steps: string[] = [];

  // Match numbered list items: 1. **Step Name**
  const stepRegex = /^\s*(\d+)\.\s+\*\*([^*]+)\*\*/gm;
  let match: RegExpExecArray | null;

  while ((match = stepRegex.exec(content)) !== null) {
    steps.push(match[2].trim());
  }

  return steps;
}

/**
 * Extract ISC criteria from the spec
 *
 * Looks for:
 * - Table rows: | # | Description | Source | Verify |
 * - Checkbox items: - [ ] or - [x] followed by description
 */
function extractISC(content: string): ISCCriterion[] {
  const isc: ISCCriterion[] = [];

  // Pattern 1: Table format | # | Description | Source | Verify |
  // Look for the ISC section
  const iscSectionMatch = content.match(
    /##\s+\d+\.\s+Ideal State Criteria.*?\n([\s\S]+?)(?=\n##\s+\d+\.|\n---|\n$)/i
  );

  if (iscSectionMatch) {
    const iscSection = iscSectionMatch[1];

    // Parse table rows (skip header)
    const tableRowRegex = /\|\s*(\d+)\s*\|([^|]+)\|([^|]*)\|([^|]*)\|/g;
    let match: RegExpExecArray | null;

    while ((match = tableRowRegex.exec(iscSection)) !== null) {
      const num = parseInt(match[1], 10);
      if (isNaN(num)) continue; // Skip header row

      const description = match[2].trim();
      const source = match[3]?.trim() || "";
      const verifyMethod = match[4]?.trim() || "";

      isc.push({
        number: num,
        description,
        source,
        verifyMethod,
        isChecked: false,
      });
    }
  }

  // Pattern 2: Checkbox format in Success Criteria or other sections
  // - [ ] The thing that needs to be done
  // - [x] Already completed item
  const checkboxRegex = /^[-*]\s+\[([ xX])\]\s+(.+)$/gm;
  let match: RegExpExecArray | null;
  let checkboxNum = 100; // Start high to not conflict with table ISC

  while ((match = checkboxRegex.exec(content)) !== null) {
    const isChecked = match[1].toLowerCase() === "x";
    const description = match[2].trim();

    // Skip if this seems like a duplicate of a table ISC
    const isDuplicate = isc.some(
      (i) =>
        description.includes(i.description.slice(0, 50)) ||
        i.description.includes(description.slice(0, 50))
    );

    if (!isDuplicate) {
      isc.push({
        number: checkboxNum++,
        description,
        isChecked,
      });
    }
  }

  // Sort by number
  isc.sort((a, b) => a.number - b.number);

  return isc;
}

/**
 * Get ISC criteria for a specific phase (if mapping exists)
 */
export function getISCForPhase(spec: ParsedSpec, phaseNumber: number): ISCCriterion[] {
  const phase = spec.phases.find((p) => p.number === phaseNumber);
  if (!phase || phase.iscNumbers.length === 0) {
    return [];
  }

  return spec.isc.filter((isc) => phase.iscNumbers.includes(isc.number));
}

/**
 * Get completion percentage for phases
 */
export function getPhaseCompletion(spec: ParsedSpec, completedPhases: number[]): number {
  if (spec.totalPhases === 0) return 0;
  return Math.round((completedPhases.length / spec.totalPhases) * 100);
}

/**
 * Get completion percentage for ISC
 */
export function getISCCompletion(spec: ParsedSpec, completedISC: Record<string, boolean>): number {
  if (spec.totalISC === 0) return 0;
  const completed = Object.values(completedISC).filter(Boolean).length;
  return Math.round((completed / spec.totalISC) * 100);
}

// ============================================================================
// CLI Interface
// ============================================================================

function formatPhases(phases: SpecPhase[]): string {
  if (phases.length === 0) {
    return "  (No phases found)";
  }

  return phases
    .map((p) => {
      let output = `  Phase ${p.number}: ${p.name}`;
      if (p.steps.length > 0) {
        output += `\n    Steps: ${p.steps.length}`;
        for (const step of p.steps.slice(0, 3)) {
          output += `\n      - ${step}`;
        }
        if (p.steps.length > 3) {
          output += `\n      ... and ${p.steps.length - 3} more`;
        }
      }
      return output;
    })
    .join("\n");
}

function formatISC(isc: ISCCriterion[]): string {
  if (isc.length === 0) {
    return "  (No ISC found)";
  }

  return isc
    .map((i) => {
      const checkbox = i.isChecked ? "[x]" : "[ ]";
      const source = i.source ? ` (${i.source})` : "";
      const desc =
        i.description.length > 60 ? i.description.slice(0, 60) + "..." : i.description;
      return `  ${checkbox} ISC #${i.number}: ${desc}${source}`;
    })
    .join("\n");
}

async function main() {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      help: { type: "boolean", short: "h" },
      output: { type: "string", short: "o", default: "text" },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(`
SpecParser - Parse phases and ISC from spec markdown

Commands:
  parse <spec-path>     Parse and display all extracted data
  phases <spec-path>    List phases only
  isc <spec-path>       List ISC criteria only

Options:
  -o, --output <fmt>    Output format: text (default), json
  -h, --help            Show this help

Examples:
  bun run SpecParser.ts parse plans/Specs/Queue/ml8z2lj4-spec.md
  bun run SpecParser.ts phases plans/Specs/Queue/ml8z2lj4-spec.md --output json
`);
    return;
  }

  const command = positionals[0];
  const specPath = positionals[1];

  if (!specPath) {
    console.error("Error: spec-path required");
    process.exit(1);
  }

  try {
    const spec = parseSpec(specPath);

    switch (command) {
      case "parse": {
        if (values.output === "json") {
          console.log(JSON.stringify(spec, null, 2));
        } else {
          console.log(`
═══════════════════════════════════════════════════════════
SPEC PARSER: ${spec.title}
═══════════════════════════════════════════════════════════

PHASES (${spec.totalPhases}):
${formatPhases(spec.phases)}

ISC CRITERIA (${spec.totalISC}):
${formatISC(spec.isc)}

═══════════════════════════════════════════════════════════`);
        }
        break;
      }

      case "phases": {
        if (values.output === "json") {
          console.log(JSON.stringify(spec.phases, null, 2));
        } else {
          console.log(`Phases (${spec.totalPhases}):\n${formatPhases(spec.phases)}`);
        }
        break;
      }

      case "isc": {
        if (values.output === "json") {
          console.log(JSON.stringify(spec.isc, null, 2));
        } else {
          console.log(`ISC Criteria (${spec.totalISC}):\n${formatISC(spec.isc)}`);
        }
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        console.error("Use --help for usage.");
        process.exit(1);
    }
  } catch (e) {
    console.error(`Error: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  main().catch(console.error);
}

// parseSpec, getPhaseCompletion, getISCCompletion exported inline
export { extractPhases, extractISC };
