#!/usr/bin/env bun
/**
 * GrillMeLens - Automated GrillMe analytical lens → research directives
 *
 * Applies GrillMe's Socratic analysis lenses to a task description to generate
 * 3-5 directed research questions. These questions enhance the spec pipeline's
 * research phase — no human interaction needed.
 *
 * The lens catalog is defined locally in this file (see the `LENSES` const below) —
 * GrillMe's SKILL.md is a short interview prompt and has no lens pool of its own.
 *
 * Lens selection is performed by the LLM: all candidate lenses are presented
 * and the LLM picks the 3-5 most relevant to the task and generates a concrete
 * directive per selected lens. No regex/keyword heuristics.
 *
 * Usage:
 *   bun GrillMeLens.ts --title "add caching" --description "add caching to RecipeSearch"
 *   bun GrillMeLens.ts --title "fix auth" --format text
 */

import { inference } from "../../../../lib/core/Inference.ts";

// ============================================================================
// Types
// ============================================================================

export type ItemType = "bug" | "feature" | "refactor" | "new";

interface Lens {
  name: string;
  description: string;
  questionTemplate: string;
}

export interface LensDirective {
  lens: string;
  directive: string;
}

// ============================================================================
// Lens Catalog (defined locally in this file — not sourced from GrillMe's SKILL.md)
// All lenses are presented to the LLM for selection — no pre-filtering.
// ============================================================================

const LENSES: Record<string, Lens | undefined> = {
  dependencies: {
    name: "Dependencies",
    description: "What depends on what; single points of failure",
    questionTemplate: "If X doesn't work — what else breaks?",
  },
  cascade: {
    name: "Cascade Effects",
    description: "Consequences of consequences (2nd-order effects)",
    questionTemplate: "This leads to B. And what does B lead to?",
  },
  negative_space: {
    name: "Negative Space",
    description: "What was NOT said, avoided, or answered superficially",
    questionTemplate:
      "You didn't mention X — was that deliberate or unconsidered?",
  },
  premortem: {
    name: "Pre-mortem",
    description: "Most likely cause of failure if this goes wrong",
    questionTemplate: "6 months have passed, this failed. Why?",
  },
  horizon: {
    name: "Horizon Conflict",
    description: "Good now vs bad later tradeoffs",
    questionTemplate: "In 3 months, does this decision still work?",
  },
  kill: {
    name: "Kill Criterion",
    description: "Stop condition — what would make this not worth doing",
    questionTemplate: "At what result would you say 'not worth it'?",
  },
  confidence: {
    name: "Confidence Level",
    description: "What is a verified fact vs assumption vs hope",
    questionTemplate: "Is that a verified fact or a feeling?",
  },
  minimum: {
    name: "Minimum Version",
    description: "Scope creep risk — what is the minimum viable version",
    questionTemplate: "What's the minimum version that solves 80%?",
  },
  historical: {
    name: "Historical Pattern",
    description: "Whether this repeats a past pattern in the codebase",
    questionTemplate: "Have you been in similar situations before?",
  },
};

// All lens keys as an array — passed to the LLM so it can pick what fits
const ALL_LENSES: Lens[] = Object.values(LENSES).filter(
  (l): l is Lens => l !== undefined
);

// ============================================================================
// Directive Generation (one LLM inference call — selection + generation)
// ============================================================================

export async function generateDirectives(
  title: string,
  description: string,
  // type parameter kept for interface compat; LLM infers item nature from content
  _type: ItemType | "" = ""
): Promise<LensDirective[]> {
  const systemPrompt = `You apply analytical lenses to a task description to generate specific research questions for an autonomous code research agent. The agent has access to Bash, Read, Glob, and Grep tools on a local codebase. Generate concrete, investigable directives — not abstract questions.`;

  const userPrompt = `Task: ${title}
Description: ${description}

Available analytical lenses (select 3-5 that are most relevant to this specific task):
${ALL_LENSES.map((l) => `- ${l.name}: ${l.description}`).join("\n")}

Select the 3-5 lenses that apply best to this task based on its content. For each selected lens, generate ONE specific research directive — a concrete question the research agent should investigate in the codebase. Focus on what can be discovered by reading code, checking imports, running grep, or examining file structure.

Return as JSON array: [{"lens": "name", "directive": "specific investigation question"}]
Return between 3 and 5 items.`;

  const result = await inference({
    systemPrompt,
    userPrompt,
    level: "standard",
    expectJson: true,
    // Generous cushion. Directive generation is optional/non-fatal but valued
    // for grill depth, and the underlying claude -p spawn can stall on cold
    // start or a post-2026-06-15 credit-pool pause — prefer waiting over losing
    // the lenses on every research run. ("standard" default is 90s.)
    timeout: 240000,
    retries: 2,
    retryDelayMs: 4000,
  });

  if (!result.success || !result.parsed) {
    console.warn(
      `[GrillMeLens] Inference failed for "${title}": ${result.error ?? "no output"}`
    );
    return [];
  }

  const raw = result.parsed;
  if (!Array.isArray(raw)) return [];

  return raw.filter(
    (
      item: unknown
    ): item is { lens: string; directive: string } =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as Record<string, unknown>).lens === "string" &&
      typeof (item as Record<string, unknown>).directive === "string"
  );
}

// ============================================================================
// CLI Entry Point
// ============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  const titleIdx = args.indexOf("--title");
  const descIdx = args.indexOf("--description");
  const formatIdx = args.indexOf("--format");

  if (titleIdx === -1 || !args[titleIdx + 1]) {
    console.error(
      'Usage: bun GrillMeLens.ts --title "..." [--description "..."] [--format text|json]'
    );
    process.exit(1);
  }

  const title = args[titleIdx + 1];
  const description = descIdx !== -1 ? (args[descIdx + 1] ?? "") : "";
  const format = formatIdx !== -1 ? args[formatIdx + 1] : "json";

  const directives = await generateDirectives(title, description);

  if (format === "text") {
    console.log("## Directed Investigation\n");
    for (const d of directives) {
      console.log(`**${d.lens}:** ${d.directive}`);
    }
  } else {
    console.log(JSON.stringify(directives, null, 2));
  }
}
