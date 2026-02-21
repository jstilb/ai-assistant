/**
 * Shared types for DailyBriefing blocks.
 *
 * BlockResult is the canonical interface returned by every block's execute()
 * function. Previously duplicated across 8 files.
 */

export interface BlockResult {
  blockName: string;
  success: boolean;
  data: Record<string, unknown>;
  markdown: string;
  summary: string;
  error?: string;
}
