/**
 * TriageResultSchema.ts — Shared Zod schema for KayaUpgrade triage results
 *
 * Used by UpgradeTriage.ts to validate the triage subagent's output. The
 * State/latest-triage-result.json summary (and its TriageSummarySchema) was
 * removed 2026-11-08: its only reader, DailyBriefing, was deleted 2026-11-05.
 */

import { z } from "zod";

export const TriageResultSchema = z.object({
  actionableItems: z.array(
    z.object({
      title: z.string(),
      description: z.string(),
      priority: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      affectedComponents: z.array(z.string()),
      sourceUpdates: z.array(z.string()),
      estimatedEffort: z.enum(["S", "M", "L"]),
      researchGuidance: z.string(),
    }),
  ),
  narrative: z.string(),
  dismissedCount: z.number(),
  dismissalReasoning: z.string(),
});

export type TriageResult = z.infer<typeof TriageResultSchema>;

/**
 * Extract the last valid TriageResult JSON block from subagent output.
 * Uses a bracket-counter approach to handle deeply nested objects correctly.
 * Returns the last candidate that validates against TriageResultSchema.
 */
export function extractTriageResult(output: string): TriageResult | null {
  const candidates: string[] = [];
  let depth = 0;
  let start = -1;

  for (let i = 0; i < output.length; i++) {
    if (output[i] === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (output[i] === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        candidates.push(output.slice(start, i + 1));
      }
    }
  }

  // Validate candidates with Zod — take the last one that parses
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const parsed = TriageResultSchema.parse(JSON.parse(candidates[i] ?? ""));
      return parsed;
    } catch {
      /* try next */
    }
  }

  return null;
}

/**
 * Sanitize external content before writing to _triage-input.md.
 * Neutralizes common prompt injection patterns.
 */
export function sanitizeForSubagent(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const lower = line.toLowerCase();
      if (
        lower.includes("ignore previous") ||
        lower.includes("ignore all") ||
        lower.includes("you are now") ||
        lower.includes("new instructions") ||
        lower.includes("system prompt") ||
        lower.includes("forget your") ||
        /^#+\s*(ignore|override|system|prompt|instructions?)/i.test(line)
      ) {
        return `[SANITIZED: potentially unsafe content removed]`;
      }
      return line;
    })
    .join("\n");
}
