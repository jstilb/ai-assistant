/**
 * Pipeline - Single source of truth for the PID scan control flow
 * ===================================================================
 *
 * Runs layers 1-3 (regex/encoding/structural) plus the conditional Layer 4
 * (ML escalation, T7-05) with the EXACT same control flow the hook uses.
 * PromptInjectionDefender.hook.ts and this module's own tests both call
 * `runScanPipeline()` directly, so the tested logic and the shipped logic
 * cannot drift apart -- unlike hand-reimplementing the pipeline in a test
 * file (as tests/hooks/pid/integration.test.ts's `fullPipelineScan` helper
 * does for layers 1-3 only, predating this module).
 *
 * SECURITY INVARIANT (the point of this file's existence): a block-tier
 * verdict from layers 1-3 is returned immediately, before Layer 4 is ever
 * reached. The gate below Layer 4 checks `preliminary.recommended_action
 * === "warn"` specifically -- not `!== "block"` -- so it is impossible for a
 * "block" (or a "log") verdict to reach the ML layer, structurally, not by
 * convention.
 */

import * as RegexScanner from "./RegexScanner";
import * as EncodingDetector from "./EncodingDetector";
import * as StructuralAnalyzer from "./StructuralAnalyzer";
import * as MLClassifier from "./MLClassifier";
import type { InferenceFn } from "./MLClassifier";
import { decide, applyMlOutcome } from "./DecisionEngine";
import type { ScanFinding, ScanResult, InjectionDefenderConfig, ToolScanConfig } from "./types";

export interface PipelineOptions {
  /** Injectable for tests. Defaults to MLClassifier.scanAsync's own default
   *  (the real `inference()` from lib/core/Inference.ts). A test that omits
   *  this AND has enable_ml_layer:true AND lands in the warn band would make
   *  a real inference call -- always pass a fake here in tests. */
  inferenceFn?: InferenceFn;
  /** Start-of-scan timestamp for `scan_time_ms` bookkeeping. Defaults to
   *  `performance.now()` at call time; the hook passes its own startTime
   *  (captured before stdin read) to preserve the existing metric semantics. */
  startTime?: number;
}

/**
 * Run the full PID scanning pipeline for one piece of content.
 */
export async function runScanPipeline(
  scanText: string,
  toolName: string,
  filePath: string | undefined,
  config: InjectionDefenderConfig,
  layers: ToolScanConfig["layers"],
  options: PipelineOptions = {}
): Promise<ScanResult> {
  const startTime = options.startTime ?? performance.now();
  const findings: ScanFinding[] = [];
  const layersExecuted: string[] = [];

  // Layer 1: Regex
  if (layers.includes("regex")) {
    const regexFindings = RegexScanner.scan(scanText, toolName, config, filePath);
    findings.push(...regexFindings);
    layersExecuted.push("regex");

    // Early termination: a critical + high-confidence regex finding is a
    // hard block. This returns BEFORE layers 2-4 run at all -- preserved
    // exactly as it existed before T7-05, per the plan's explicit
    // instruction not to disturb it.
    const hasCriticalBlock = regexFindings.some(
      (f) => f.severity === "critical" && f.confidence >= 0.8
    );
    if (hasCriticalBlock) {
      const scanTime = performance.now() - startTime;
      return decide(findings, scanTime, layersExecuted, config);
    }
  }

  // Layer 2: Encoding
  if (layers.includes("encoding")) {
    findings.push(...EncodingDetector.scan(scanText, toolName, config, filePath));
    layersExecuted.push("encoding");
  }

  // Layer 3: Structural
  if (layers.includes("structural")) {
    findings.push(...StructuralAnalyzer.scan(scanText, toolName, config, filePath));
    layersExecuted.push("structural");
  }

  const preliminaryScanTime = performance.now() - startTime;
  const preliminary = decide(findings, preliminaryScanTime, layersExecuted, config);

  // Layer 4: ML escalation -- warn/ask band ONLY.
  //
  // preliminary.recommended_action can be "block" here WITHOUT having hit
  // the early-termination branch above: encoding/structural findings alone
  // can produce a critical + confidence>=0.8 finding that only surfaces once
  // decide() runs its step-1 check across ALL findings. The `=== "warn"`
  // check (not `!== "block"`, not `!== "log"`) is therefore the actual
  // security gate here, not an optimization -- it is the only line standing
  // between "block" and the ML layer for that case.
  if (
    layers.includes("ml") &&
    config.global.enable_ml_layer &&
    preliminary.recommended_action === "warn"
  ) {
    const mlOutcome = await MLClassifier.scanAsync(
      scanText,
      toolName,
      findings,
      config,
      options.inferenceFn
    );
    const finalScanTime = performance.now() - startTime;
    return applyMlOutcome(findings, mlOutcome, finalScanTime, layersExecuted, config);
  }

  return preliminary;
}
