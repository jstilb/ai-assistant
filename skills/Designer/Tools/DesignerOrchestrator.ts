#!/usr/bin/env bun
/**
 * DesignerOrchestrator.ts - Main pipeline orchestrator for Designer skill
 *
 * Executes the full design analysis pipeline:
 *   1. Sequential: Load Config -> Validate Image -> Run Vision Analysis (RoomAnalyzer)
 *   2. Parallel: FurnitureSearch + MoodBoardGenerator (both depend on RoomAnalysis)
 *   3. Aggregate: Combine results -> Format -> Return
 *
 * Error handling: if any parallel task fails, still returns results from
 * successful ones. Timing is logged for each phase.
 *
 * Usage:
 *   import { createDesignerOrchestrator } from './DesignerOrchestrator';
 *   const orchestrator = createDesignerOrchestrator(deps);
 *   const result = await orchestrator.run({ imagePath: '/path/to/room.jpg', budget: 2000 });
 *
 * @module DesignerOrchestrator
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PipelineTimings {
  configLoad_ms: number;
  visionAnalysis_ms: number;
  parallelPhase_ms: number;
  aggregation_ms: number;
  total_ms: number;
}

export interface OrchestratorInput {
  imagePath: string;
  budget?: number;
  style?: string;
  focus?: string;
  currency?: string;
}

export interface OrchestratorResult {
  success: boolean;
  roomAnalysis: unknown | null;
  furnitureResults: unknown[];
  moodBoard: unknown | null;
  budgetResult: unknown | null;
  formattedOutput: string;
  errors: string[];
  timings: PipelineTimings;
}

export interface OrchestratorDeps {
  analyzeRoom: (imagePath: string, focus?: string) => Promise<unknown | null>;
  searchFurniture: (opts: unknown) => Promise<unknown[]>;
  generateMoodBoard: (analysis: unknown) => unknown;
  calculateBudget: (products: unknown[], budget: number | null, currency?: string) => unknown;
  formatOutput: (data: unknown) => string;
  loadConfig: () => unknown;
}

export interface DesignerOrchestrator {
  run(input: OrchestratorInput): Promise<OrchestratorResult>;
}

// ---------------------------------------------------------------------------
// Timer utility
// ---------------------------------------------------------------------------

function timer(): { elapsed: () => number } {
  const start = performance.now();
  return {
    elapsed: () => Math.round(performance.now() - start),
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDesignerOrchestrator(deps: OrchestratorDeps): DesignerOrchestrator {
  return {
    async run(input: OrchestratorInput): Promise<OrchestratorResult> {
      const totalTimer = timer();
      const errors: string[] = [];

      let roomAnalysis: unknown | null = null;
      let furnitureResults: unknown[] = [];
      let moodBoard: unknown | null = null;
      let budgetResult: unknown | null = null;
      let formattedOutput = "";

      // -----------------------------------------------------------------------
      // Phase 1: Sequential - Load Config
      // -----------------------------------------------------------------------
      const configTimer = timer();
      let config: unknown;
      try {
        config = deps.loadConfig();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Config load failed: ${msg}`);
        config = null;
      }
      const configLoad_ms = configTimer.elapsed();

      // -----------------------------------------------------------------------
      // Phase 2: Sequential - Vision Analysis (depends on config)
      // -----------------------------------------------------------------------
      const visionTimer = timer();
      try {
        roomAnalysis = await deps.analyzeRoom(input.imagePath, input.focus);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Vision analysis failed: ${msg}`);
        roomAnalysis = null;
      }
      const visionAnalysis_ms = visionTimer.elapsed();

      // If vision analysis failed or returned null, we cannot proceed with parallel phase
      if (roomAnalysis === null) {
        return {
          success: false,
          roomAnalysis: null,
          furnitureResults: [],
          moodBoard: null,
          budgetResult: null,
          formattedOutput: "",
          errors: errors.length > 0 ? errors : ["Room analysis returned no results"],
          timings: {
            configLoad_ms,
            visionAnalysis_ms,
            parallelPhase_ms: 0,
            aggregation_ms: 0,
            total_ms: totalTimer.elapsed(),
          },
        };
      }

      // -----------------------------------------------------------------------
      // Phase 3: Parallel - Furniture Search + MoodBoard (both need RoomAnalysis)
      // -----------------------------------------------------------------------
      const parallelTimer = timer();

      const furniturePromise = (async () => {
        try {
          const analysisObj = roomAnalysis as Record<string, unknown>;
          const styleInfo = analysisObj?.style as Record<string, unknown> | undefined;
          const results = await deps.searchFurniture({
            query: "furniture",
            style: styleInfo?.primary || input.style,
            budget: input.budget,
          });
          return results;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`Furniture search failed: ${msg}`);
          return [];
        }
      })();

      const moodBoardPromise = (async () => {
        try {
          const board = deps.generateMoodBoard(roomAnalysis);
          return board;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`Mood board generation failed: ${msg}`);
          return null;
        }
      })();

      const [furnitureSettled, moodBoardSettled] = await Promise.all([
        furniturePromise,
        moodBoardPromise,
      ]);

      furnitureResults = furnitureSettled;
      moodBoard = moodBoardSettled;

      const parallelPhase_ms = parallelTimer.elapsed();

      // -----------------------------------------------------------------------
      // Phase 4: Aggregate - Budget + Format
      // -----------------------------------------------------------------------
      const aggregationTimer = timer();

      try {
        budgetResult = deps.calculateBudget(
          furnitureResults,
          input.budget || null,
          input.currency
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Budget calculation failed: ${msg}`);
      }

      try {
        formattedOutput = deps.formatOutput({
          roomAnalysis,
          furnitureResults,
          moodBoard,
          budgetResult,
          config,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Output formatting failed: ${msg}`);
      }

      const aggregation_ms = aggregationTimer.elapsed();

      return {
        success: true,
        roomAnalysis,
        furnitureResults,
        moodBoard,
        budgetResult,
        formattedOutput,
        errors,
        timings: {
          configLoad_ms,
          visionAnalysis_ms,
          parallelPhase_ms,
          aggregation_ms,
          total_ms: totalTimer.elapsed(),
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

if (import.meta.main) {
  console.log("DesignerOrchestrator - Main pipeline orchestrator");
  console.log("");
  console.log("Pipeline stages:");
  console.log("  1. [Sequential] Load Config");
  console.log("  2. [Sequential] Vision Analysis (RoomAnalyzer)");
  console.log("  3. [Parallel]   Furniture Search + Mood Board");
  console.log("  4. [Aggregate]  Budget Calculation + Output Formatting");
  console.log("");
  console.log("Usage (programmatic):");
  console.log("  import { createDesignerOrchestrator } from './DesignerOrchestrator';");
  console.log("  const orchestrator = createDesignerOrchestrator(deps);");
  console.log("  const result = await orchestrator.run({ imagePath: '/path/to/room.jpg' });");
}
