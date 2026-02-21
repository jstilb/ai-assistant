/**
 * Test fixtures for KnowledgeSynthesizer.detectPatterns()
 *
 * Items are shaped as { text: string; score?: number; timestamp: string }
 * matching the detectPatterns input type.
 */

import type { Pattern } from "../../KnowledgeSynthesizer";

/** Items that should match frustration patterns repeatedly */
export const REPEATING_FRUSTRATION_ITEMS = [
  { text: "Task took too long, had to wait minutes", score: 2, timestamp: "2026-02-01T10:00:00Z" },
  { text: "Slow response, delay in processing", score: 3, timestamp: "2026-02-02T11:00:00Z" },
  { text: "Again another slow performance issue with long wait time", score: 1, timestamp: "2026-02-03T09:00:00Z" },
  { text: "Wrong approach taken, misunderstood the task", score: 2, timestamp: "2026-02-01T14:00:00Z" },
  { text: "Incorrect implementation, not what I asked", score: 3, timestamp: "2026-02-02T15:00:00Z" },
  { text: "Still seeing the same problem again with timing", score: 2, timestamp: "2026-02-04T10:00:00Z" },
];

/** Frustration pattern definitions matching KnowledgeSynthesizer */
export const FRUSTRATION_PATTERNS: Record<string, RegExp> = {
  "Time/Performance Issues": /time|slow|delay|hang|wait|long|minutes|hours/i,
  "Incomplete Work": /incomplete|missing|partial|didn't finish|not done/i,
  "Wrong Approach": /wrong|incorrect|not what|misunderstand|mistake/i,
  "Over-engineering": /over-?engineer|too complex|unnecessary|bloat/i,
  "Tool/System Failures": /^(?!.*(?:fix|resolv|handl|repair|patch|correct|clean)).*(?:fail|error|broken|crash|bug|issue)/i,
  "Communication Problems": /unclear|confus|didn't ask|should have asked/i,
  "Repetitive Issues": /again|repeat|still|same problem/i,
};

/** Success pattern definitions matching KnowledgeSynthesizer */
export const SUCCESS_PATTERNS: Record<string, RegExp> = {
  "Quick Resolution": /quick|fast|efficient|smooth/i,
  "Good Understanding": /understood|clear|exactly|perfect/i,
  "Proactive Help": /proactive|anticipat|helpful|above and beyond/i,
  "Clean Implementation": /clean|simple|elegant|well done/i,
  "Good Communication": /explain|understood|asked|clarif/i,
};

/** Items where each matches a unique pattern only once */
export const UNIQUE_PATTERN_ITEMS = [
  { text: "Quick fix applied", score: 8, timestamp: "2026-02-01T10:00:00Z" },
  { text: "Clean code delivered", score: 9, timestamp: "2026-02-02T11:00:00Z" },
  { text: "Proactive suggestion", score: 7, timestamp: "2026-02-03T12:00:00Z" },
];

/** Empty items array */
export const EMPTY_ITEMS: Array<{ text: string; score?: number; timestamp: string }> = [];

/** Large input for performance testing */
export const LARGE_INPUT = Array.from({ length: 500 }, (_, i) => ({
  text: i % 3 === 0
    ? `Slow performance issue ${i} with long delay`
    : i % 3 === 1
    ? `Quick resolution for task ${i}`
    : `Random text with no pattern match ${i}`,
  score: Math.floor(Math.random() * 10) + 1,
  timestamp: new Date(Date.now() - i * 3600000).toISOString(),
}));

/** Items with no pattern matches */
export const NO_MATCH_ITEMS = [
  { text: "The weather is nice today", timestamp: "2026-02-01T10:00:00Z" },
  { text: "Just a regular conversation", timestamp: "2026-02-01T11:00:00Z" },
  { text: "Nothing noteworthy here", timestamp: "2026-02-01T12:00:00Z" },
];

/** Items with scores for average calculation */
export const SCORED_ITEMS = [
  { text: "Task was slow and took too long", score: 2, timestamp: "2026-02-01T10:00:00Z" },
  { text: "Delay in response time", score: 4, timestamp: "2026-02-02T10:00:00Z" },
  { text: "Long wait for results", score: 6, timestamp: "2026-02-03T10:00:00Z" },
];
