#!/usr/bin/env bun
/**
 * HumanReview Grader
 *
 * Queues eval outputs for human judgment and tracks calibration
 * against model-based graders.
 */

import { BaseGrader, registerGrader, type GraderContext } from '../Base.ts';
import type { GraderConfig, GraderResult, HumanReview as HumanReviewType } from '../../Types/index.ts';
import { FileApprovalQueue, type ApprovalItemBase } from '../../../CORE/Tools/ApprovalQueue.ts';
import { join } from 'path';

const KAYA_HOME = process.env.KAYA_HOME || join(process.env.HOME || '', '.claude');
const HUMAN_REVIEW_QUEUE_PATH = join(KAYA_HOME, 'MEMORY/QUEUES/evals-human-review.json');

// ============================================================================
// Types
// ============================================================================

export interface HumanReviewParams {
  /** Rubric or criteria for human to evaluate against */
  rubric?: string;
  /** Minimum required score (0-1) */
  minScore?: number;
  /** Whether this blocks completion or can be async */
  blocking?: boolean;
  /** Model grader results to compare against (for calibration) */
  modelGraderResults?: { type: string; score: number }[];
  /** Timeout in ms before falling back to model score */
  timeoutMs?: number;
}

export interface HumanReviewItem {
  evalId: string;
  taskId: string;
  trialId: string;
  transcript: string;
  output: string;
  rubric?: string;
  modelScore?: number;
  modelGraderType?: string;
}

// ============================================================================
// Queue Management
// ============================================================================

let reviewQueue: FileApprovalQueue<HumanReviewItem> | null = null;

function getQueue(): FileApprovalQueue<HumanReviewItem> {
  if (!reviewQueue) {
    reviewQueue = new FileApprovalQueue<HumanReviewItem>(HUMAN_REVIEW_QUEUE_PATH, {
      defaultExpiry: 7, // 7 days to review
      onApprove: async (item) => {
        // Could notify or trigger calibration analysis
        console.log(`Human review approved for ${item.evalId}`);
      },
    });
  }
  return reviewQueue;
}

/**
 * Queue an eval for human review
 */
export async function queueForReview(
  item: HumanReviewItem,
  priority: 'low' | 'normal' | 'high' | 'critical' = 'normal'
): Promise<string> {
  const queue = getQueue();
  return queue.add(item, { priority });
}

/**
 * Get pending reviews
 */
export async function getPendingReviews(): Promise<(HumanReviewItem & ApprovalItemBase)[]> {
  const queue = getQueue();
  return queue.list({ status: 'pending' });
}

/**
 * Complete a review with human judgment
 */
export async function completeReview(
  id: string,
  score: number,
  notes?: string,
  reviewer?: string
): Promise<HumanReviewItem & ApprovalItemBase> {
  const queue = getQueue();

  // Approve with the score in notes
  const reviewResult = await queue.approve(
    id,
    `Score: ${score}${notes ? `\nNotes: ${notes}` : ''}`,
    reviewer
  );

  return reviewResult;
}

/**
 * Get calibration stats (agreement between human and model graders)
 */
export async function getCalibrationStats(): Promise<{
  totalReviews: number;
  agreementRate: number;
  avgScoreDiff: number;
  byGraderType: Record<string, { count: number; avgDiff: number }>;
}> {
  const queue = getQueue();
  const approved = await queue.list({ status: 'approved' });

  const stats = {
    totalReviews: 0,
    agreementRate: 0,
    avgScoreDiff: 0,
    byGraderType: {} as Record<string, { count: number; avgDiff: number }>,
  };

  let agreements = 0;
  let totalDiff = 0;

  for (const review of approved) {
    if (review.modelScore !== undefined && review.reviewNotes) {
      stats.totalReviews++;

      // Parse human score from notes
      const scoreMatch = review.reviewNotes.match(/Score:\s*([\d.]+)/);
      if (scoreMatch) {
        const humanScore = parseFloat(scoreMatch[1]);
        const diff = Math.abs(humanScore - review.modelScore);

        totalDiff += diff;

        // Agreement = both pass or both fail (threshold 0.5)
        const humanPass = humanScore >= 0.5;
        const modelPass = review.modelScore >= 0.5;
        if (humanPass === modelPass) {
          agreements++;
        }

        // Track by grader type
        if (review.modelGraderType) {
          if (!stats.byGraderType[review.modelGraderType]) {
            stats.byGraderType[review.modelGraderType] = { count: 0, avgDiff: 0 };
          }
          stats.byGraderType[review.modelGraderType].count++;
          stats.byGraderType[review.modelGraderType].avgDiff =
            (stats.byGraderType[review.modelGraderType].avgDiff *
              (stats.byGraderType[review.modelGraderType].count - 1) +
              diff) /
            stats.byGraderType[review.modelGraderType].count;
        }
      }
    }
  }

  if (stats.totalReviews > 0) {
    stats.agreementRate = agreements / stats.totalReviews;
    stats.avgScoreDiff = totalDiff / stats.totalReviews;
  }

  return stats;
}

// ============================================================================
// Grader Implementation
// ============================================================================

export class HumanReviewGrader extends BaseGrader {
  type = 'human_review' as const;
  category = 'human' as const;

  async grade(context: GraderContext): Promise<GraderResult> {
    const start = performance.now();
    const params = (this.config.params || {}) as HumanReviewParams;

    // Queue for human review
    const reviewId = await queueForReview({
      evalId: `${context.task_id}_${context.trial_id}`,
      taskId: context.task_id,
      trialId: context.trial_id,
      transcript: JSON.stringify(context.transcript, null, 2),
      output: context.output,
      rubric: params.rubric,
      modelScore: params.modelGraderResults?.[0]?.score,
      modelGraderType: params.modelGraderResults?.[0]?.type,
    });

    // If blocking, wait for review (with timeout)
    if (params.blocking) {
      const queue = getQueue();
      const timeout = params.timeoutMs || 86400000; // 24 hours default
      const startWait = Date.now();

      while (Date.now() - startWait < timeout) {
        const item = await queue.get(reviewId);
        if (item && item.status !== 'pending') {
          // Parse score from review notes
          const scoreMatch = item.reviewNotes?.match(/Score:\s*([\d.]+)/);
          const score = scoreMatch ? parseFloat(scoreMatch[1]) : 0;
          const passed = score >= (params.minScore ?? 0.5);

          return this.createResult(score, passed, performance.now() - start, {
            reasoning: item.reviewNotes || 'Human review completed',
            details: {
              reviewId,
              reviewer: item.reviewedBy,
              reviewedAt: item.reviewedAt,
            },
          });
        }
        // Wait 10 seconds before checking again
        await new Promise(resolve => setTimeout(resolve, 10000));
      }

      // Timeout - fall back to model score if available
      if (params.modelGraderResults?.length) {
        const fallbackScore = params.modelGraderResults[0].score;
        return this.createResult(fallbackScore, fallbackScore >= 0.5, performance.now() - start, {
          reasoning: 'Human review timed out, using model grader score',
          details: { reviewId, fallbackFrom: params.modelGraderResults[0].type },
        });
      }

      // No fallback available
      return this.createResult(0, false, performance.now() - start, {
        reasoning: 'Human review timed out with no fallback',
        details: { reviewId },
      });
    }

    // Non-blocking: return pending status
    return this.createResult(0.5, true, performance.now() - start, {
      reasoning: 'Queued for human review (non-blocking)',
      details: {
        reviewId,
        status: 'pending_human',
        queuePath: HUMAN_REVIEW_QUEUE_PATH,
      },
    });
  }
}

registerGrader('human_review', HumanReviewGrader);
