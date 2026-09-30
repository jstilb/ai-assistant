/**
 * TriageResultSchema.ts — Shared Zod schema for KayaUpgrade triage results
 *
 * Shared by:
 *   - UpgradeTriage.ts (writer)
 *   - DailyBriefing/Tools/EcosystemUpdatesBlock.ts (reader)
 *
 * Increment TRIAGE_RESULT_VERSION only on breaking schema changes.
 */

import { z } from 'zod';

export const TriageResultSchema = z.object({
  actionableItems: z.array(z.object({
    title: z.string(),
    description: z.string(),
    priority: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    affectedComponents: z.array(z.string()),
    sourceUpdates: z.array(z.string()),
    estimatedEffort: z.enum(['S', 'M', 'L']),
    researchGuidance: z.string(),
  })),
  narrative: z.string(),
  dismissedCount: z.number(),
  dismissalReasoning: z.string(),
});

export type TriageResult = z.infer<typeof TriageResultSchema>;

export const TRIAGE_RESULT_VERSION = 1;

export const VersionedTriageResultSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string(),
  result: TriageResultSchema,
});

export type VersionedTriageResult = z.infer<typeof VersionedTriageResultSchema>;

// Summary schema — written to latest-triage-result.json for DailyBriefing consumption.
// version is optional with default 1 for backward compatibility with pre-versioned files.
export const TriageSummarySchema = z.object({
  version: z.literal(1).optional().default(1),
  timestamp: z.string(),
  level: z.string(),
  actionableCount: z.number(),
  dismissedCount: z.number(),
  items: z.array(z.object({
    title: z.string(),
    priority: z.number(),
    effort: z.string(),
    description: z.string().optional(),
    sourceUrls: z.array(z.string()).optional(),
  })),
});

export type TriageSummary = z.infer<typeof TriageSummarySchema>;

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
    if (output[i] === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (output[i] === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        candidates.push(output.slice(start, i + 1));
      }
    }
  }

  // Validate candidates with Zod — take the last one that parses
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const parsed = TriageResultSchema.parse(JSON.parse(candidates[i]));
      return parsed;
    } catch { /* try next */ }
  }

  return null;
}

/**
 * Sanitize external content before writing to _triage-input.md.
 * Neutralizes common prompt injection patterns.
 */
export function sanitizeForSubagent(text: string): string {
  return text
    .split('\n')
    .map(line => {
      const lower = line.toLowerCase();
      if (
        lower.includes('ignore previous') ||
        lower.includes('ignore all') ||
        lower.includes('you are now') ||
        lower.includes('new instructions') ||
        lower.includes('system prompt') ||
        lower.includes('forget your') ||
        /^#+\s*(ignore|override|system|prompt|instructions?)/i.test(line)
      ) {
        return `[SANITIZED: potentially unsafe content removed]`;
      }
      return line;
    })
    .join('\n');
}
