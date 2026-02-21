#!/usr/bin/env bun
/**
 * SpotCheck Grader
 *
 * Samples a percentage of model outputs for human calibration.
 * Used to verify that model-based graders are aligned with human judgment.
 */

import { BaseGrader, registerGrader, type GraderContext } from '../Base.ts';
import type { GraderConfig, GraderResult } from '../../Types/index.ts';
import { queueForReview, getCalibrationStats } from './HumanReview.ts';

// ============================================================================
// Types
// ============================================================================

export interface SpotCheckParams {
  /** Percentage of evals to sample (0-1, default 0.1 = 10%) */
  sampleRate?: number;
  /** Minimum number of spot checks before skipping */
  minSamples?: number;
  /** Model grader score to compare against */
  modelScore?: number;
  /** Model grader type for tracking */
  modelGraderType?: string;
  /** Rubric for human to evaluate against */
  rubric?: string;
  /** Priority for spot check queue items */
  priority?: 'low' | 'normal' | 'high';
}

// Track spot check state
const spotCheckState: Map<string, { checked: number; skipped: number }> = new Map();

// ============================================================================
// Grader Implementation
// ============================================================================

export class SpotCheckGrader extends BaseGrader {
  type = 'spot_check' as const;
  category = 'human' as const;

  async grade(context: GraderContext): Promise<GraderResult> {
    const start = performance.now();
    const params = (this.config.params || {}) as SpotCheckParams;

    const sampleRate = params.sampleRate ?? 0.1;
    const minSamples = params.minSamples ?? 5;
    const graderKey = params.modelGraderType || 'default';

    // Get state for this grader type
    if (!spotCheckState.has(graderKey)) {
      spotCheckState.set(graderKey, { checked: 0, skipped: 0 });
    }
    const state = spotCheckState.get(graderKey)!;

    // Determine if we should sample this eval
    const shouldSample = this.shouldSample(sampleRate, minSamples, state);

    if (!shouldSample) {
      state.skipped++;

      // Return model score as-is
      const score = params.modelScore ?? 0.5;
      return this.createResult(score, score >= 0.5, performance.now() - start, {
        reasoning: 'Skipped spot check (not sampled)',
        details: {
          sampleRate,
          totalChecked: state.checked,
          totalSkipped: state.skipped,
          usingModelScore: params.modelScore !== undefined,
        },
      });
    }

    // Queue for spot check
    state.checked++;

    const reviewId = await queueForReview(
      {
        evalId: `spotcheck_${context.task_id}_${context.trial_id}`,
        taskId: context.task_id,
        trialId: context.trial_id,
        transcript: JSON.stringify(context.transcript, null, 2),
        output: context.output,
        rubric: params.rubric || 'Spot check: Verify model grader alignment',
        modelScore: params.modelScore,
        modelGraderType: params.modelGraderType,
      },
      params.priority || 'normal'
    );

    // Return model score but flag as pending calibration
    const score = params.modelScore ?? 0.5;
    return this.createResult(score, score >= 0.5, performance.now() - start, {
      reasoning: 'Queued for spot check calibration',
      details: {
        reviewId,
        status: 'pending_calibration',
        sampleRate,
        totalChecked: state.checked,
        modelScore: params.modelScore,
      },
    });
  }

  /**
   * Determine if we should sample this eval for spot checking
   */
  private shouldSample(sampleRate: number, minSamples: number, state: { checked: number; skipped: number }): boolean {
    const total = state.checked + state.skipped;

    // Always sample first minSamples
    if (total < minSamples) {
      return true;
    }

    // Check if we're below target sample rate
    const currentRate = state.checked / (total + 1);
    if (currentRate < sampleRate) {
      // Increase sampling probability to catch up
      return Math.random() < sampleRate * 2;
    }

    // Standard random sampling
    return Math.random() < sampleRate;
  }
}

registerGrader('spot_check', SpotCheckGrader);

// ============================================================================
// Calibration Analysis
// ============================================================================

/**
 * Analyze spot check results to identify calibration issues
 */
export async function analyzeSpotChecks(): Promise<{
  overallCalibration: 'good' | 'needs_attention' | 'poor';
  recommendations: string[];
  stats: Awaited<ReturnType<typeof getCalibrationStats>>;
}> {
  const stats = await getCalibrationStats();

  const recommendations: string[] = [];
  let calibration: 'good' | 'needs_attention' | 'poor' = 'good';

  // Check overall agreement
  if (stats.agreementRate < 0.7) {
    calibration = 'poor';
    recommendations.push(`Low agreement rate (${(stats.agreementRate * 100).toFixed(1)}%). Review grader rubrics.`);
  } else if (stats.agreementRate < 0.85) {
    calibration = 'needs_attention';
    recommendations.push(`Agreement rate (${(stats.agreementRate * 100).toFixed(1)}%) could be improved.`);
  }

  // Check average score difference
  if (stats.avgScoreDiff > 0.3) {
    calibration = 'poor';
    recommendations.push(`High average score difference (${stats.avgScoreDiff.toFixed(2)}). Graders may be miscalibrated.`);
  } else if (stats.avgScoreDiff > 0.15) {
    if (calibration === 'good') calibration = 'needs_attention';
    recommendations.push(`Moderate score difference (${stats.avgScoreDiff.toFixed(2)}). Consider rubric refinement.`);
  }

  // Check individual grader types
  for (const [graderType, typeStats] of Object.entries(stats.byGraderType)) {
    if (typeStats.avgDiff > 0.25) {
      recommendations.push(`${graderType} grader shows high divergence (${typeStats.avgDiff.toFixed(2)}). Review its rubric.`);
    }
  }

  // Check sample size
  if (stats.totalReviews < 10) {
    recommendations.push('Insufficient spot checks for reliable calibration. Increase sampling.');
  }

  return {
    overallCalibration: calibration,
    recommendations,
    stats,
  };
}
