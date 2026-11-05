#!/usr/bin/env bun
/**
 * RelationInferrer - Infer implicit edges in the DevGraph
 *
 * Detects relationships that aren't explicitly recorded:
 * - Temporal co-occurrence (nodes within same time window)
 * - File overlap (sessions/commits touching same files)
 * - Error-to-fix (error followed by commit touching same file)
 * - Learning attribution (learnings created during session)
 *
 * All inferred edges have weight < 1.0 to indicate confidence.
 *
 * @module Graph/RelationInferrer
 * @version 1.0.0
 */

import type { GraphEdge, IngestionResult } from "../types.ts";
import { createEdge } from "../types.ts";
import type { GraphEngine } from "../GraphEngine.ts";
import { type GraphPersistence, getGraphPersistence } from "../GraphPersistence.ts";
import { inference as defaultInference } from "../../../../../lib/core/Inference.ts";
import type { InferenceOptions, InferenceResult } from "../../../../../lib/core/Inference.ts";
import { z } from "zod";

export type InferenceFn = (opts: InferenceOptions) => Promise<InferenceResult>;

const LLMEdgeWeightSchema = z.object({
  adjustments: z
    .array(
      z.object({
        edgeIndex: z.number(),
        adjustedWeight: z.number().min(0).max(1),
        rationale: z.string(),
      }),
    )
    .optional(),
});

// ============================================
// CONFIGURATION
// ============================================

const TEMPORAL_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MIN_WEIGHT = 0.3;
const FILE_OVERLAP_WEIGHT = 0.6;
const TEMPORAL_WEIGHT = 0.5;
const ERROR_FIX_WEIGHT = 0.8;
const LEARNING_WEIGHT = 0.7;
/** Learnings within this window after a session start are candidates for attribution. */
const LEARNING_WINDOW_MS = 2 * 60 * 60 * 1000;
/**
 * Max learned_from edges per session (T7-02 part 2: was all-pairs, ~126k edges).
 * Nearest in time after the session start wins. Override with the learningAttributionTopK option.
 */
export const DEFAULT_LEARNING_ATTRIBUTION_TOP_K = 5;
const TAG_OVERLAP_MIN_WEIGHT = 0.4;
const TAG_OVERLAP_MAX_WEIGHT = 0.8;
const GOAL_ALIGNMENT_WEIGHT = 0.6;
// LLM weight validation is best-effort polish, not load-bearing: edges persist
// with heuristic weights either way. Without a budget, a large new-edge backlog
// (compounded across failed runs, which persist nothing) makes the run outlast
// any job timeout and the backlog grows forever — seen 07-06→07-11.
const VALIDATION_BUDGET_MS = 10 * 60 * 1000;

// ============================================
// RELATION INFERRER
// ============================================

export class RelationInferrer {
  private persistence: GraphPersistence;
  private inferenceFn: InferenceFn;
  private validationBudgetMs: number;
  private learningAttributionTopK: number;

  constructor(
    persistence?: GraphPersistence,
    options?: { inferenceFn?: InferenceFn; validationBudgetMs?: number; learningAttributionTopK?: number },
  ) {
    this.persistence = persistence || getGraphPersistence();
    this.inferenceFn = options?.inferenceFn ?? defaultInference;
    this.validationBudgetMs = options?.validationBudgetMs ?? VALIDATION_BUDGET_MS;
    this.learningAttributionTopK = options?.learningAttributionTopK ?? DEFAULT_LEARNING_ATTRIBUTION_TOP_K;
  }

  private async validateEdgeWeights(edges: GraphEdge[], engine: GraphEngine): Promise<GraphEdge[]> {
    if (edges.length <= 5) return edges;
    const BATCH_SIZE = 20;
    const result = [...edges];
    const deadline = Date.now() + this.validationBudgetMs;
    for (let batchStart = 0; batchStart < edges.length; batchStart += BATCH_SIZE) {
      if (Date.now() >= deadline) {
        console.error(
          `[RelationInferrer] validation budget (${this.validationBudgetMs}ms) exhausted after ${Math.ceil(batchStart / BATCH_SIZE)}/${Math.ceil(edges.length / BATCH_SIZE)} batches — ${edges.length - batchStart} edge(s) keep heuristic weights`,
        );
        break;
      }
      const batch = edges.slice(batchStart, batchStart + BATCH_SIZE);
      const desc = batch
        .map((e, i) => {
          const src = engine.getNode(e.source);
          const tgt = engine.getNode(e.target);
          return `[${i}] type=${e.type} weight=${e.weight} source="${src?.title ?? e.source}(${src?.type ?? "?"})" target="${tgt?.title ?? e.target}(${tgt?.type ?? "?"})"`;
        })
        .join("\n");
      try {
        const llm = await this.inferenceFn({
          level: "standard",
          timeout: 30000,
          expectJson: true,
          systemPrompt:
            "You are a knowledge graph analyst. Review inferred relationship edges and adjust weights based on semantic significance. Only adjust clearly wrong weights. Return JSON only.",
          userPrompt: `Review edges. Return adjustments only for edges needing change.\n\n${desc}\n\nReturn: {"adjustments": [{"edgeIndex": 0, "adjustedWeight": 0.7, "rationale": "..."}]}`,
        });
        if (llm.success && llm.parsed !== undefined) {
          const parsed = LLMEdgeWeightSchema.safeParse(llm.parsed);
          if (parsed.success && parsed.data.adjustments) {
            for (const adj of parsed.data.adjustments) {
              const idx = batchStart + adj.edgeIndex;
              if (idx >= 0 && idx < result.length) {
                const orig = result[idx]!;
                result[idx] = {
                  ...orig,
                  weight:
                    Math.round(Math.max(MIN_WEIGHT, Math.min(1.0, (orig.weight + adj.adjustedWeight) / 2)) * 100) / 100,
                };
              }
            }
          }
        } else {
          console.error("[RelationInferrer] LLM weight validation failed:", llm.error ?? "no output");
        }
      } catch (err) {
        console.error("[RelationInferrer] LLM error:", err instanceof Error ? err.message : String(err));
      }
    }
    return result;
  }

  /**
   * Infer implicit edges and persist them.
   */
  async infer(): Promise<IngestionResult> {
    const startTime = Date.now();
    const result: IngestionResult = {
      source: "inference",
      nodesAdded: 0,
      edgesAdded: 0,
      nodesSkipped: 0,
      edgesSkipped: 0,
      errors: [],
      duration: 0,
    };

    try {
      // Load the full graph
      const engine = this.persistence.loadIntoEngine();
      let inferredCount = 0;
      const newEdges: GraphEdge[] = [];
      // Some strategies return arrays and some are generators; both are iterated once.
      const strategies: Array<(engine: GraphEngine) => Iterable<GraphEdge>> = [
        this.inferTemporalCoOccurrence,
        this.inferFileOverlap,
        this.inferErrorToFix,
        this.inferLearningAttribution,
        this.inferTagOverlap,
        this.inferGoalAlignment,
      ];
      for (const strategy of strategies) {
        for (const edge of strategy.call(this, engine)) {
          inferredCount++;
          if (!engine.getEdge(edge.id)) newEdges.push(edge);
        }
      }

      // LLM weight validation — only for edges not already persisted. The
      // strategies above regenerate every candidate edge on every run, so
      // validating all of them re-reviews the ~98% that appendEdges dedups
      // anyway: dozens of serial 30s LLM batches per daily ingest.
      const validatedEdges = await this.validateEdgeWeights(newEdges, engine);

      // Persist new edges
      const edgesAppended = this.persistence.appendEdges(validatedEdges);

      result.edgesAdded = edgesAppended;
      result.edgesSkipped = inferredCount - edgesAppended;
    } catch (err) {
      result.errors.push(`Inference failed: ${err}`);
    }

    result.duration = Date.now() - startTime;
    return result;
  }

  // ============================================
  // TEMPORAL CO-OCCURRENCE
  // ============================================

  /**
   * Nodes created within the same 1-hour window get a relates_to edge.
   * Only connects different node types to avoid noise.
   */
  private inferTemporalCoOccurrence(engine: GraphEngine): GraphEdge[] {
    const edges: GraphEdge[] = [];
    const nodes = engine.getNodes();
    const seen = new Set<string>();

    // Sort by creation time
    const sorted = nodes
      .filter((n) => n.created_at)
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));

    for (let i = 0; i < sorted.length; i++) {
      const nodeA = sorted[i];
      if (!nodeA) continue;
      const timeA = Date.parse(nodeA.created_at);

      for (let j = i + 1; j < sorted.length; j++) {
        const nodeB = sorted[j];
        if (!nodeB) continue;
        const timeB = Date.parse(nodeB.created_at);

        // Stop if outside temporal window
        if (timeB - timeA > TEMPORAL_WINDOW_MS) break;

        // Only link different types
        if (nodeA.type === nodeB.type) continue;

        // Avoid duplicates
        const key = [nodeA.id, nodeB.id].sort().join("|");
        if (seen.has(key)) continue;
        seen.add(key);

        // Calculate weight based on temporal proximity
        const timeDiff = timeB - timeA;
        const proximity = 1 - timeDiff / TEMPORAL_WINDOW_MS;
        const weight = MIN_WEIGHT + (TEMPORAL_WEIGHT - MIN_WEIGHT) * proximity;

        edges.push(
          createEdge("relates_to", nodeA.id, nodeB.id, Math.round(weight * 100) / 100, {
            source: "inference:temporal",
            timeDiffMs: timeDiff,
          }),
        );
      }

      // Cap inferred edges per run to prevent explosion
      const MAX_TEMPORAL_EDGES_PER_RUN = 500;
      if (edges.length > MAX_TEMPORAL_EDGES_PER_RUN) break;
    }

    return edges;
  }

  // ============================================
  // FILE OVERLAP
  // ============================================

  /**
   * Sessions/commits that touch the same files get a relates_to edge.
   */
  private *inferFileOverlap(engine: GraphEngine): Generator<GraphEdge> {
    const previousFiles = new Set<string>();
    const modifierFiles = new Map<string, Map<string, number>>();

    // Build file -> modifier map
    const fileModifiers = new Map<string, string[]>();

    for (const edge of engine.getEdges("modifies")) {
      const modifiers = fileModifiers.get(edge.target) || [];
      modifiers.push(edge.source);
      fileModifiers.set(edge.target, modifiers);
      const files = modifierFiles.get(edge.source) ?? new Map<string, number>();
      files.set(edge.target, (files.get(edge.target) ?? 0) + 1);
      modifierFiles.set(edge.source, files);
    }

    // Link modifiers of the same file
    for (const [fileId, modifiers] of fileModifiers) {
      const previousSources = new Set<string>();

      for (let i = 0; i < modifiers.length; i++) {
        const modI = modifiers[i];
        if (modI === undefined || previousSources.has(modI)) continue;
        previousSources.add(modI);
        const targets = new Set<string>();
        for (let j = i + 1; j < modifiers.length; j++) {
          const modJ = modifiers[j];
          if (modJ === undefined) continue;
          if (targets.has(modJ) || (modI !== modJ && previousSources.has(modJ))) continue;
          targets.add(modJ);
          const sourceFiles = modifierFiles.get(modI);
          const targetFiles = modifierFiles.get(modJ);
          if (!sourceFiles || !targetFiles) continue; // unreachable: every modifier has a file map
          let seen = false;
          for (const [sharedFile, count] of sourceFiles) {
            if (previousFiles.has(sharedFile) && targetFiles.has(sharedFile) && (modI !== modJ || count > 1)) {
              seen = true;
              break;
            }
          }
          if (seen) continue;

          yield createEdge("relates_to", modI, modJ, FILE_OVERLAP_WEIGHT, {
            source: "inference:file-overlap",
            sharedFile: fileId,
          });
        }
      }
      previousFiles.add(fileId);
    }
  }

  // ============================================
  // ERROR TO FIX
  // ============================================

  /**
   * If an error is followed by a commit touching the same file,
   * infer a fixed_by edge.
   */
  private inferErrorToFix(engine: GraphEngine): GraphEdge[] {
    const edges: GraphEdge[] = [];
    const seen = new Set<string>();

    const errorNodes = engine.getNodes("error");
    const commitNodes = engine.getNodes("commit");

    if (errorNodes.length === 0 || commitNodes.length === 0) return edges;

    // Sort commits by time
    const sortedCommits = commitNodes
      .filter((c) => c.created_at)
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));

    for (const error of errorNodes) {
      const errorTime = Date.parse(error.created_at);

      // Find the error's associated files (via session -> modifies -> file)
      const errorFiles = new Set<string>();

      // Walk up from error to find session, then find files
      const backward = engine.traceBackward(error.id, 2, ["contains"]);
      for (const { node } of backward) {
        if (node.type === "session") {
          const sessionForward = engine.traceForward(node.id, 1, ["modifies"]);
          for (const { node: fileNode } of sessionForward) {
            if (fileNode.type === "file") {
              errorFiles.add(fileNode.id);
            }
          }
        }
      }

      // Find commits that came AFTER the error and touch the same files
      for (const commit of sortedCommits) {
        const commitTime = Date.parse(commit.created_at);
        if (commitTime <= errorTime) continue;
        if (commitTime - errorTime > 24 * 60 * 60 * 1000) break; // Within 24 hours

        // Check if commit touches any of the same files
        const commitFiles = engine.traceForward(commit.id, 1, ["modifies"]);
        for (const { node: fileNode } of commitFiles) {
          if (errorFiles.has(fileNode.id)) {
            const key = `${error.id}|${commit.id}`;
            if (!seen.has(key)) {
              seen.add(key);
              edges.push(
                createEdge("fixed_by", error.id, commit.id, ERROR_FIX_WEIGHT, {
                  source: "inference:error-fix",
                  sharedFile: fileNode.id,
                }),
              );
            }
          }
        }
      }
    }

    return edges;
  }

  // ============================================
  // LEARNING ATTRIBUTION
  // ============================================

  /**
   * Learnings created during a session get a learned_from edge.
   */
  private inferLearningAttribution(engine: GraphEngine): GraphEdge[] {
    const edges: GraphEdge[] = [];
    const seen = new Set<string>();

    const sessionNodes = engine.getNodes("session");
    const learningNodes = engine.getNodes("learning");

    if (sessionNodes.length === 0 || learningNodes.length === 0) return edges;

    // Sort learnings by time once. Each session then takes at most topK learnings: the nearest
    // ones after the session start, inside the window. This bounds the edge count per session.
    const sortedLearnings = learningNodes
      .map((learning) => ({ learning, time: Date.parse(learning.created_at) }))
      .filter((l) => !Number.isNaN(l.time))
      .sort((a, b) => a.time - b.time);

    for (const session of sessionNodes) {
      const sessionTime = Date.parse(session.created_at);
      if (Number.isNaN(sessionTime)) continue;

      // First learning at or after the session start (binary search).
      let lo = 0;
      let hi = sortedLearnings.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if ((sortedLearnings[mid]?.time ?? Infinity) < sessionTime) lo = mid + 1;
        else hi = mid;
      }

      let taken = 0;
      for (let i = lo; i < sortedLearnings.length && taken < this.learningAttributionTopK; i++) {
        const entry = sortedLearnings[i];
        if (!entry || entry.time - sessionTime >= LEARNING_WINDOW_MS) break;
        const key = `${session.id}|${entry.learning.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        taken++;
        edges.push(
          createEdge("learned_from", entry.learning.id, session.id, LEARNING_WEIGHT, {
            source: "inference:learning-attribution",
          }),
        );
      }
    }

    return edges;
  }

  // ============================================
  // TAG OVERLAP
  // ============================================

  /**
   * Decision nodes that share 2+ tags get an influenced edge (older → newer).
   */
  private inferTagOverlap(engine: GraphEngine): GraphEdge[] {
    const edges: GraphEdge[] = [];
    const seen = new Set<string>();
    const decisionNodes = engine.getNodes("decision");

    // Structural tags assigned to every node of a type — not meaningful for overlap
    const STRUCTURAL_TAGS = new Set([
      "decision",
      "work-item",
      "learning",
      "algorithm",
      "context",
      "feedback",
      "outcome",
      "session",
      "commit",
      "error",
      "skill_change",
    ]);

    for (let i = 0; i < decisionNodes.length; i++) {
      const nodeA = decisionNodes[i];
      if (!nodeA?.tags || nodeA.tags.length === 0) continue;
      const tagsA = new Set<string>(nodeA.tags);

      for (let j = i + 1; j < decisionNodes.length; j++) {
        const nodeB = decisionNodes[j];
        if (!nodeB?.tags || nodeB.tags.length === 0) continue;

        // Compute tag intersection, excluding structural tags
        const sharedTags = nodeB.tags.filter((t) => tagsA.has(t) && !STRUCTURAL_TAGS.has(t));
        if (sharedTags.length < 2) continue;

        // Avoid duplicate edges
        const key = [nodeA.id, nodeB.id].sort().join("|");
        if (seen.has(key)) continue;
        seen.add(key);

        // Weight scaled by tag overlap ratio, capped at max
        const maxTagCount = Math.max(nodeA.tags.length, nodeB.tags.length);
        const weight = Math.min(
          TAG_OVERLAP_MIN_WEIGHT + TAG_OVERLAP_MAX_WEIGHT * (sharedTags.length / maxTagCount),
          TAG_OVERLAP_MAX_WEIGHT,
        );

        // Older node is the source (influenced the newer one)
        const timeA = Date.parse(nodeA.created_at);
        const timeB = Date.parse(nodeB.created_at);
        const [source, target] = timeA <= timeB ? [nodeA.id, nodeB.id] : [nodeB.id, nodeA.id];

        edges.push(
          createEdge("influenced", source, target, Math.round(weight * 100) / 100, {
            source: "inference:tag-overlap",
            sharedTags,
          }),
        );

        if (edges.length >= 200) return edges;
      }
    }

    return edges;
  }

  // ============================================
  // GOAL ALIGNMENT
  // ============================================

  /**
   * Decision nodes with overlapping tags on a goal node get a goal_aligned edge.
   */
  private inferGoalAlignment(engine: GraphEngine): GraphEdge[] {
    const edges: GraphEdge[] = [];
    const seen = new Set<string>();

    const goalNodes = engine.getNodes("goal");
    const decisionNodes = engine.getNodes("decision");

    if (goalNodes.length === 0 || decisionNodes.length === 0) return edges;

    for (const goal of goalNodes) {
      if (!goal.tags || goal.tags.length === 0) continue;
      const goalTags = new Set<string>(goal.tags);

      for (const decision of decisionNodes) {
        if (!decision.tags || decision.tags.length === 0) continue;

        const sharedTags = decision.tags.filter((t) => goalTags.has(t));
        if (sharedTags.length < 1) continue;

        const key = `${decision.id}|${goal.id}`;
        if (seen.has(key)) continue;
        seen.add(key);

        edges.push(
          createEdge("goal_aligned", decision.id, goal.id, GOAL_ALIGNMENT_WEIGHT, {
            source: "inference:goal-alignment",
            sharedTags,
          }),
        );

        if (edges.length >= 200) return edges;
      }
    }

    return edges;
  }
}

// ============================================
// CLI
// ============================================

if (import.meta.main) {
  console.log("RelationInferrer");
  console.log("================\n");

  const inferrer = new RelationInferrer();
  const result = await inferrer.infer();

  console.log(`Source: ${result.source}`);
  console.log(`Edges added: ${result.edgesAdded}`);
  console.log(`Edges skipped: ${result.edgesSkipped}`);
  console.log(`Duration: ${result.duration}ms`);

  if (result.errors.length > 0) {
    console.log(`\nErrors (${result.errors.length}):`);
    for (const err of result.errors) {
      console.log(`  - ${err}`);
    }
  }
}
