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
  /** Executable command extracted from spec content */
  embeddedCommand?: string;
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

// ============================================================================
// Embedded Command Extraction
// ============================================================================

const SAFE_COMMAND_EXECUTABLES = new Set([
  "bun", "node", "npx", "grep", "rg", "test", "diff", "wc", "jq", "ls", "cat", "head", "tail",
]);

const SAFE_GIT_SUBCOMMANDS_SP = new Set([
  "diff", "log", "show", "status", "rev-parse", "merge-base",
]);

/**
 * Extract a single executable command from text. Returns undefined if not safe.
 * Matches known safe executables followed by arguments.
 * Rejects commands containing shell operators (|, &&, ;, `, $()).
 */
export function extractEmbeddedCommand(text: string): string | undefined {
  // Try to extract from backticks first
  const backtickMatch = text.match(/`([^`]+)`/);
  const candidate = (backtickMatch ? backtickMatch[1] : text).trim();
  if (!candidate) return undefined;

  // Reject shell operators in the extracted candidate
  if (/[|;&`]|\$\(/.test(candidate)) return undefined;

  const parts = candidate.split(/\s+/);
  if (parts.length === 0) return undefined;

  const exe = parts[0];

  // git subcommand validation
  if (exe === "git") {
    const sub = parts[1];
    if (!sub || !SAFE_GIT_SUBCOMMANDS_SP.has(sub)) return undefined;
    return candidate;
  }

  if (!SAFE_COMMAND_EXECUTABLES.has(exe)) return undefined;
  return candidate;
}

/**
 * Extract executable commands from a narrative section.
 * Looks for patterns like:
 * - Run `grep -ri "asana" skills/`
 * - Test: `bun test`
 * - Run bun skills/.../file.ts --test
 */
export function extractCommandsFromNarrative(content: string): Array<{ command: string; context: string }> {
  const results: Array<{ command: string; context: string }> = [];
  const lines = content.split("\n");

  for (const line of lines) {
    // Pattern 1: - Run `command`
    const runBacktickMatch = line.match(/[-*]\s+Run\s+`([^`]+)`/i);
    if (runBacktickMatch) {
      const cmd = extractEmbeddedCommand(runBacktickMatch[1]);
      if (cmd) {
        results.push({ command: cmd, context: line.trim() });
        continue;
      }
    }

    // Pattern 2: - Test: `command` or - Test: command
    const testMatch = line.match(/[-*]\s+Test:\s+(.+)$/im);
    if (testMatch) {
      const cmd = extractEmbeddedCommand(testMatch[1].trim());
      if (cmd) {
        results.push({ command: cmd, context: line.trim() });
        continue;
      }
    }

    // Pattern 3: - Run <safe-exe> args (no backticks)
    const runBareMatch = line.match(/[-*]\s+Run\s+((?:grep|rg|bun|test|diff|node|npx|git)\s+[^\n]+)/i);
    if (runBareMatch) {
      const cmd = extractEmbeddedCommand(runBareMatch[1].trim());
      if (cmd) {
        results.push({ command: cmd, context: line.trim() });
        continue;
      }
    }
  }

  return results;
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

  // Pattern 3: Test case tables (## Testing & Validation, ## Test Cases)
  // Extracts rows like | TC-01 | Description | ... |
  const testSectionMatch = content.match(
    /##\s+(?:Testing(?:\s+&\s+Validation)?|Test\s+Cases|Validation).*?\n([\s\S]+?)(?=\n##\s|\n---|$)/i
  );

  if (testSectionMatch) {
    const testSection = testSectionMatch[1];
    const tcRowRegex = /\|\s*(TC-\d+)\s*\|([^|]+)\|/g;
    let tcMatch: RegExpExecArray | null;
    let tcNum = 200; // Start at 200 to avoid conflicts

    while ((tcMatch = tcRowRegex.exec(testSection)) !== null) {
      const tcId = tcMatch[1].trim();
      const tcDesc = tcMatch[2].trim();
      // Skip header-like rows
      if (/^[-\s]+$/.test(tcDesc) || /description/i.test(tcDesc)) continue;

      const fullDesc = `${tcId}: ${tcDesc}`;
      const isDuplicate = isc.some(
        (i) =>
          i.description.includes(tcDesc.slice(0, 40)) ||
          tcDesc.includes(i.description.slice(0, 40))
      );

      if (!isDuplicate) {
        isc.push({
          number: tcNum++,
          description: fullDesc,
          source: "EXPLICIT",
          verifyMethod: "test",
          isChecked: false,
        });
      }
    }
  }

  // Pattern 4: File structure entries (## File Structure)
  // Extracts expected files with extensions (not directories)
  const fileSectionMatch = content.match(
    /##\s+File\s+Structure.*?\n([\s\S]+?)(?=\n##\s|\n---|$)/i
  );

  if (fileSectionMatch) {
    const fileSection = fileSectionMatch[1];
    const lines = fileSection.split("\n");
    let fileNum = 300; // Start at 300 to avoid conflicts

    for (const line of lines) {
      // Match lines containing file paths with extensions
      const fileMatch = line.match(/([\w\-./]+\.\w{1,6})/);
      if (!fileMatch) continue;

      const filePath = fileMatch[1];
      // Skip common non-file patterns (version numbers like 1.0, etc.)
      if (/^\d+\.\d+$/.test(filePath)) continue;

      const isDuplicate = isc.some(
        (i) => i.description.includes(filePath)
      );

      if (!isDuplicate) {
        const category = inferCategory(filePath);
        isc.push({
          number: fileNum++,
          description: filePath,
          source: "EXPLICIT",
          verifyMethod: /\.test\.\w+$|\.spec\.\w+$/.test(filePath) ? "test" : "existence",
          isChecked: false,
        });
      }
    }
  }

  // Pattern 5: Criteria tables (Success Criteria, Acceptance Criteria, Validation Criteria)
  // Matches | Criterion | Measurement | Target | format in dedicated criteria sections
  const criteriaSectionMatch = content.match(
    /###?\s+(?:\d+(?:\.\d+)?\s+)?(?:Success|Acceptance|Validation)\s+Criteria.*?\n([\s\S]+?)(?=\n###?\s|\n---|$)/i
  );

  if (criteriaSectionMatch) {
    const criteriaSection = criteriaSectionMatch[1];
    const criteriaRowRegex = /\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/g;
    let criteriaMatch: RegExpExecArray | null;
    let criteriaNum = 400;

    while ((criteriaMatch = criteriaRowRegex.exec(criteriaSection)) !== null) {
      const col1 = criteriaMatch[1].trim();
      const col2 = criteriaMatch[2].trim();
      const col3 = criteriaMatch[3].trim();

      // Skip header and separator rows
      if (/^[-\s]+$/.test(col1) || /^[-\s]+$/.test(col2) ||
          /^criterion$/i.test(col1) || /^measurement$/i.test(col1) ||
          /^description$/i.test(col1) || /^#$/i.test(col1)) {
        continue;
      }

      const description = col3 && col3 !== "-" ? `${col1} — target: ${col3}` : col1;
      const embeddedCmd = extractEmbeddedCommand(col2);

      // Dedup against existing ISC rows
      const isDuplicate = isc.some(
        (i) =>
          col1.length > 10 && (
            i.description.includes(col1.slice(0, 40)) ||
            col1.includes(i.description.slice(0, 40))
          )
      );

      if (!isDuplicate) {
        isc.push({
          number: criteriaNum++,
          description,
          source: "EXPLICIT",
          verifyMethod: embeddedCmd ? "command" : "manual",
          isChecked: false,
          embeddedCommand: embeddedCmd,
        });
      }
    }
  }

  // Pattern 6: Narrative verification sections
  // Extracts executable commands from Phase N: Verify sections
  {
    const verifyParts: string[] = [];

    // Find content after **Phase N: Verify** bold markers
    const phaseVerifyRegex = /\*\*Phase\s+\d+:\s*Verify(?:ication)?\*\*\s*\n([\s\S]+?)(?=\n\d+\.\s+\*\*Phase|\n###?\s|\n---|$)/gi;
    let pvMatch: RegExpExecArray | null;
    while ((pvMatch = phaseVerifyRegex.exec(content)) !== null) {
      verifyParts.push(pvMatch[1]);
    }

    // Find content after ### Verify/Validation/Testing headings
    // No `m` flag — `$` must mean end-of-string, not end-of-line (lazy match stops too early with `m`)
    const headingVerifyRegex = /(?:^|\n)###?\s+(?:\d+(?:\.\d+)?\s+)?(?:Verify|Verification|Validation|Testing)\b[^\n]*\n([\s\S]+?)(?=\n###?\s|\n---|$)/gi;
    let hvMatch: RegExpExecArray | null;
    while ((hvMatch = headingVerifyRegex.exec(content)) !== null) {
      verifyParts.push(hvMatch[1]);
    }

    let narrativeNum = 500;
    for (const part of verifyParts) {
      const commands = extractCommandsFromNarrative(part);
      for (const { command, context } of commands) {
        const isDuplicate = isc.some(
          (i) => i.embeddedCommand === command ||
            (command.length > 10 && i.description.includes(command.slice(0, 30)))
        );

        if (!isDuplicate) {
          isc.push({
            number: narrativeNum++,
            description: `Verify: ${context.replace(/^[-*]\s+/, "").slice(0, 100)}`,
            source: "EXPLICIT",
            verifyMethod: "command",
            isChecked: false,
            embeddedCommand: command,
          });
        }
      }
    }
  }

  // Sort by number
  isc.sort((a, b) => a.number - b.number);

  return isc;
}

/**
 * Infer ISC row category from description and optional phase context.
 * Returns a category string compatible with ISCRowCategory in WorkOrchestrator.
 */
export function inferCategory(description: string, phaseContext?: string): "implementation" | "testing" | "documentation" | "deployment" | "cleanup" {
  const text = `${description} ${phaseContext || ""}`.toLowerCase();
  if (/deploy|launchd|launchctl|plist|install|load\s+service/.test(text)) return "deployment";
  if (/skill\.md|readme|document|update\s+docs|api\s+docs/.test(text)) return "documentation";
  if (/clean\s*up|remove\s+legacy|deprecat|remove\s+old|config\s+removal/.test(text)) return "cleanup";
  if (/test|spec|assert|validate|verify/.test(text)) return "testing";
  return "implementation";
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

// parseSpec, getPhaseCompletion, getISCCompletion, inferCategory exported inline
// extractEmbeddedCommand, extractCommandsFromNarrative exported inline at declaration
export { extractPhases, extractISC };
