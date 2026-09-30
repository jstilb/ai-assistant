/**
 * ReplayEngine.ts — Threshold Replay Engine for AgentMonitor
 *
 * Loads historical .jsonl traces, recalculates per-trace baselines,
 * runs them through a hypothetical detector config, and emits a diff report.
 *
 * Usage:
 *   import { runThresholdReplay } from './ReplayEngine.ts';
 *   const result = await runThresholdReplay(traceFile, thresholdsFile);
 */

import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'fs';
import { join, basename } from 'path';
import { parseTraceLine, type AgentTrace } from './TraceCollector.ts';
import type { AnomalyDetectorConfig, Anomaly } from './AnomalyDetector.ts';
import { createAnomalyDetector, deterministicRepetitionAssessor } from './AnomalyDetector.ts';
import { computePercentiles } from './Percentiles.ts';
import type { LatencyPercentiles } from './Percentiles.ts';
import { getKayaHome } from '../../../../lib/core/KayaHome.ts';

// ============================================================================
// Types
// ============================================================================

export type AnomalyType =
  | 'token_spike'
  | 'error_burst'
  | 'infinite_loop'
  | 'stale_workflow'
  | 'high_load'
  | 'communication_deadlock'
  | 'message_flood'
  | 'orphaned_member'
  | 'team_divergence';

export interface ReplayResult {
  traceCount: number;
  originalFired: AnomalyType[];
  hypotheticalFired: AnomalyType[];
  wouldHaveCaught: AnomalyType[];
  wouldHaveMissed: AnomalyType[];
  falsePositives: AnomalyType[];
  detectionRateChange: number;
  perAnomaly: Record<string, { original: number; hypothetical: number }>;
  derivedBaseline?: LatencyPercentiles;
  reportPath?: string;
}

export interface ReplayOptions {
  fromDate?: string;
  toDate?: string;
  anomalyFilter?: string;
}

// ============================================================================
// Constants
// ============================================================================

const KAYA_HOME = getKayaHome();
const TRACES_DIR = join(KAYA_HOME, 'MEMORY', 'MONITORING', 'traces');
const REPORTS_DIR = join(KAYA_HOME, 'MEMORY', 'MONITORING', 'reports');

// ============================================================================
// JSONL Parsing
// ============================================================================

function parseJsonlFile(filePath: string): AgentTrace[] {
  if (!existsSync(filePath)) {
    throw new Error(`Trace file does not exist: ${filePath}`);
  }
  const lines = readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim());
  const traces: AgentTrace[] = [];
  for (const line of lines) {
    // Delegate to TraceCollector's dual-format parser rather than forking a
    // second inline parser here — the previous version accepted any object
    // with truthy workflowId/agentId via an unsafe `as AgentTrace` cast, so
    // new-format ({ts, category, payload}) lines silently passed through
    // with `timestamp`/`eventType`/`metadata` all `undefined` (corrupting
    // deriveBaseline's metadata.latencyMs extraction and every
    // eventType-gated AnomalyDetector check) instead of being skipped.
    const trace = parseTraceLine(line);
    if (trace) {
      traces.push(trace);
    } else {
      console.warn(`[ReplayEngine] Skipping malformed/corrupt trace line: ${line.slice(0, 80)}`);
    }
  }
  return traces;
}

// ============================================================================
// Date Range File Selection
// ============================================================================

export function selectTraceFilesByDateRange(fromDate: string, toDate: string): string[] {
  if (!existsSync(TRACES_DIR)) return [];
  const files = readdirSync(TRACES_DIR).filter(f => f.endsWith('.jsonl'));
  const from = new Date(fromDate).getTime();
  const to = new Date(toDate).getTime();

  return files
    .filter(f => {
      // Extract date from filename — look for YYYY-MM-DD pattern
      const match = f.match(/(\d{4}-\d{2}-\d{2})/);
      if (!match) return false;
      const fileDate = new Date(match[1]).getTime();
      return fileDate >= from && fileDate <= to;
    })
    .map(f => join(TRACES_DIR, f));
}

// ============================================================================
// Threshold Config Loading
// ============================================================================

function loadThresholdsConfig(thresholdsFile: string): Partial<AnomalyDetectorConfig> {
  if (!existsSync(thresholdsFile)) {
    throw new Error(`Thresholds file does not exist: ${thresholdsFile}`);
  }
  try {
    const raw = JSON.parse(readFileSync(thresholdsFile, 'utf-8'));
    if (typeof raw !== 'object' || raw === null) {
      throw new Error('Thresholds JSON must be an object');
    }
    // Pick only known AnomalyDetectorConfig keys, ignore unknown
    const knownKeys: Array<keyof AnomalyDetectorConfig> = [
      'tokenSpikeThreshold', 'tokenSpikeWindowMs', 'errorBurstThreshold',
      'errorBurstWindowMs', 'infiniteLoopThreshold', 'infiniteLoopWindow',
      'staleWorkflowThresholdMs', 'highLoadEventsPerSecond', 'highLoadWindowMs',
      'voiceAlerts', 'jsonlAlerts', 'messageFloodThreshold', 'messageFloodWindowMs',
      'orphanedMemberThresholdMs', 'teamDivergenceRatio',
    ];
    const config: Partial<AnomalyDetectorConfig> = {};
    for (const key of knownKeys) {
      if (key in raw) {
        (config as Record<string, unknown>)[key] = raw[key];
      }
    }
    return config;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Thresholds JSON validation failed: ${msg}`);
  }
}

// ============================================================================
// Baseline Recalculation
// ============================================================================

function deriveBaseline(traces: AgentTrace[]): LatencyPercentiles {
  const latencies = traces
    .map(t => t.metadata?.latencyMs)
    .filter((v): v is number => typeof v === 'number');
  return computePercentiles(latencies);
}

// ============================================================================
// Core Replay Logic
// ============================================================================

async function runDetector(traces: AgentTrace[], config: Partial<AnomalyDetectorConfig>): Promise<AnomalyType[]> {
  // Replay is a read-only what-if analysis: force allowSimulation, disable alerts,
  // and keep it hermetic — persistState:false (never writes active-anomalies.json,
  // the invariant P1-07 checks) and the deterministic repetition assessor (no live
  // LLM in checkInfiniteLoop).
  const detector = createAnomalyDetector({
    ...config,
    voiceAlerts: false,
    jsonlAlerts: false,
    allowSimulation: true,
    repetitionAssessor: deterministicRepetitionAssessor,
    persistState: false,
  });
  const fired = new Set<AnomalyType>();
  for (const trace of traces) {
    // Mark as simulation source so live detector ignores but replay detector processes
    const traceWithSim: AgentTrace = {
      ...trace,
      context: { ...trace.context, source: 'simulation' },
    };
    const anomalies = await detector.ingest(traceWithSim);
    for (const a of anomalies) {
      fired.add(a.type as AnomalyType);
    }
  }
  return Array.from(fired);
}

// ============================================================================
// Report Generation
// ============================================================================

function writeReplayReport(
  result: Omit<ReplayResult, 'reportPath'>,
  hypotheticalConfig: Partial<AnomalyDetectorConfig>,
  traceFile: string,
): string {
  mkdirSync(REPORTS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = join(REPORTS_DIR, `replay-${ts}.md`);

  const lines: string[] = [
    `# Threshold Replay Report`,
    ``,
    `## Run Metadata`,
    ``,
    `- **Trace file:** ${traceFile}`,
    `- **Trace count:** ${result.traceCount}`,
    `- **Run at:** ${new Date().toISOString()}`,
    ``,
    `## Threshold Comparison`,
    ``,
    `| Parameter | Hypothetical Value |`,
    `|-----------|-------------------|`,
    ...Object.entries(hypotheticalConfig).map(([k, v]) => `| ${k} | ${JSON.stringify(v)} |`),
    ``,
    `## Detection Results`,
    ``,
    `| Anomaly Type | Original Fires | Hypothetical Fires |`,
    `|-------------|---------------|-------------------|`,
    ...Object.entries(result.perAnomaly).map(([k, v]) =>
      `| ${k} | ${v.original} | ${v.hypothetical} |`
    ),
    ``,
    `### Would Have Caught`,
    result.wouldHaveCaught.length > 0
      ? result.wouldHaveCaught.map(t => `- ${t}`).join('\n')
      : '_None_',
    ``,
    `### Would Have Missed`,
    result.wouldHaveMissed.length > 0
      ? result.wouldHaveMissed.map(t => `- ${t}`).join('\n')
      : '_None_',
    ``,
    `### False Positives`,
    result.falsePositives.length > 0
      ? result.falsePositives.map(t => `- ${t}`).join('\n')
      : '_None_',
    ``,
    `## Detection Rate Change`,
    ``,
    `**${result.detectionRateChange >= 0 ? '+' : ''}${result.detectionRateChange.toFixed(1)}%**`,
    ``,
    `## Recommendation`,
    ``,
    generateRecommendation(result),
    ``,
  ];

  writeFileSync(reportPath, lines.join('\n'), 'utf-8');
  return reportPath;
}

function generateRecommendation(result: Omit<ReplayResult, 'reportPath'>): string {
  if (result.wouldHaveCaught.length > 0 && result.falsePositives.length === 0) {
    return `The hypothetical config would improve detection without false positives. Consider applying it.`;
  } else if (result.falsePositives.length > result.wouldHaveCaught.length) {
    return `The hypothetical config introduces more false positives (${result.falsePositives.length}) than new catches (${result.wouldHaveCaught.length}). Review before applying.`;
  } else if (result.detectionRateChange === 0) {
    return `The hypothetical config produces no change in detection rate. The current config may be optimal.`;
  }
  return `Detection rate change: ${result.detectionRateChange.toFixed(1)}%. Review the per-anomaly table before applying.`;
}

// ============================================================================
// Main Export
// ============================================================================

export async function runThresholdReplay(
  traceFileOrDir: string,
  thresholdsFile: string,
  options: ReplayOptions = {},
): Promise<ReplayResult> {
  // Load traces
  let traces: AgentTrace[];

  if (options.fromDate && options.toDate) {
    // Date-range mode: load multiple files from traces dir
    const files = selectTraceFilesByDateRange(options.fromDate, options.toDate);
    if (files.length === 0) {
      throw new Error(`Date range ${options.fromDate}–${options.toDate} selected zero trace files`);
    }
    traces = files.flatMap(f => parseJsonlFile(f));
  } else {
    // Single file mode
    traces = parseJsonlFile(traceFileOrDir);
  }

  if (traces.length === 0) {
    return {
      traceCount: 0,
      originalFired: [],
      hypotheticalFired: [],
      wouldHaveCaught: [],
      wouldHaveMissed: [],
      falsePositives: [],
      detectionRateChange: 0,
      perAnomaly: {},
    };
  }

  // Load hypothetical thresholds config
  const hypotheticalConfig = loadThresholdsConfig(thresholdsFile);

  // Derive baseline from trace data (not from live baselines.json)
  const derivedBaseline = deriveBaseline(traces);

  // Merge derived baseline's p99 into config for fair comparison
  const configWithBaseline = { ...hypotheticalConfig };

  // Run original detector (default config) against traces
  const originalFired = await runDetector(traces, {
    voiceAlerts: false,
    jsonlAlerts: false,
    allowSimulation: true,
  });

  // Run hypothetical detector against same traces
  const hypotheticalFired = await runDetector(traces, {
    ...configWithBaseline,
    voiceAlerts: false,
    jsonlAlerts: false,
    allowSimulation: true,
  });

  // Calculate diffs
  const allTypes = new Set([...originalFired, ...hypotheticalFired]);
  const wouldHaveCaught: AnomalyType[] = hypotheticalFired.filter(t => !originalFired.includes(t));
  const wouldHaveMissed: AnomalyType[] = originalFired.filter(t => !hypotheticalFired.includes(t));
  const falsePositives: AnomalyType[] = hypotheticalFired.filter(t => !originalFired.includes(t));

  const detectionRateChange = originalFired.length > 0
    ? ((hypotheticalFired.length - originalFired.length) / originalFired.length) * 100
    : hypotheticalFired.length > 0 ? 100 : 0;

  // Build perAnomaly record
  const perAnomaly: Record<string, { original: number; hypothetical: number }> = {};
  const typesToReport = options.anomalyFilter
    ? [options.anomalyFilter]
    : Array.from(allTypes);

  for (const type of typesToReport) {
    perAnomaly[type] = {
      original: originalFired.filter(t => t === type).length,
      hypothetical: hypotheticalFired.filter(t => t === type).length,
    };
  }

  const resultWithoutPath = {
    traceCount: traces.length,
    originalFired,
    hypotheticalFired,
    wouldHaveCaught,
    wouldHaveMissed,
    falsePositives,
    detectionRateChange,
    perAnomaly,
    derivedBaseline,
  };

  const reportPath = writeReplayReport(resultWithoutPath, hypotheticalConfig, traceFileOrDir);

  return { ...resultWithoutPath, reportPath };
}
