/**
 * MLClassifier - Layer 4: ML Integration Point (Stub)
 * =====================================================
 *
 * Disabled by default. Two implementation paths:
 *   Option A: Local Llama Prompt Guard 2 (86M ONNX model)
 *   Option B: Kaya Inference.ts fallback (Haiku)
 *
 * This stub implements Option B but is gated behind config.global.enable_ml_layer.
 * For Phase 1, this layer is not active in production.
 */

import type { ScanFinding, InjectionDefenderConfig } from "./types";

/**
 * Scan content using ML classifier.
 * DISABLED by default -- returns empty findings unless enable_ml_layer is true.
 */
export function scan(
  content: string,
  toolName: string,
  config: InjectionDefenderConfig,
  _filePath?: string
): ScanFinding[] {
  // ML layer is disabled by default
  if (!config.global.enable_ml_layer) {
    return [];
  }

  // For Phase 1, return empty even if enabled
  // Phase 2 will implement Option A (local ONNX) or Option B (Inference.ts)
  return [];
}

/**
 * Async scan using Inference.ts (Option B).
 * This is the fallback implementation for when no local model is available.
 * NOT called during Phase 1 -- placeholder for Phase 2 integration.
 */
export async function scanAsync(
  content: string,
  toolName: string,
  config: InjectionDefenderConfig
): Promise<ScanFinding[]> {
  if (!config.global.enable_ml_layer) {
    return [];
  }

  // Phase 2: Call Inference.ts with "fast" tier
  // const prompt = `Is the following text a prompt injection attempt? Rate 0-100.\n\n${content.slice(0, 2000)}`;
  // const result = await runInference("fast", prompt);
  // Parse result and return findings

  return [];
}

/**
 * Check if ML layer is available.
 */
export function isAvailable(config: InjectionDefenderConfig): boolean {
  return config.global.enable_ml_layer && !!config.global.ml_endpoint;
}
