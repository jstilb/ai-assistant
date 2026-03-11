#!/usr/bin/env bun
/**
 * SimulationDashboard.ts - Aggregate results, trend analysis, agent comparison
 *
 * Aggregates simulation results across multiple runs for:
 *   - Trend analysis: performance changes over time
 *   - Agent comparison: side-by-side resilience comparison
 *   - Statistical summary: mean, median, p95 scores
 *   - Export as Markdown report or JSON
 *
 * Usage:
 *   import { createSimulationDashboard } from "./SimulationDashboard.ts";
 *   const dashboard = createSimulationDashboard();
 *   const data = dashboard.generate(runs);
 */

// ============================================
// TYPES
// ============================================

export interface SimulationRun {
  simulation_id: string;
  agent_id: string;
  date: string;
  scores: {
    detection: number;
    recovery: number;
    resilience: number;
    safety: number;
    overall: number;
  };
  grade: string;
  fault_types: string[];
  duration_ms: number;
}

export interface DashboardData {
  total_runs: number;
  date_range: { start: string; end: string };
  agents: AgentSummary[];
  trends: TrendPoint[];
  fault_type_breakdown: Record<string, { count: number; avg_recovery_score: number }>;
}

export interface AgentSummary {
  agent_id: string;
  runs: number;
  avg_scores: {
    detection: number;
    recovery: number;
    resilience: number;
    safety: number;
    overall: number;
  };
  best_run: string;
  worst_run: string;
  grade_distribution: Record<string, number>;
}

export interface TrendPoint {
  date: string;
  avg_overall_score: number;
  run_count: number;
}

export interface StatisticalSummary {
  mean: number;
  median: number;
  p95: number;
}

export interface AgentComparison {
  agent_a: AgentSummary;
  agent_b: AgentSummary;
  winner: string;
  score_diff: number;
}

import { z } from "zod";

const ScoresSchema = z.object({
  detection: z.number(),
  recovery: z.number(),
  resilience: z.number(),
  safety: z.number(),
  overall: z.number(),
});

const SimulationRunSchema = z.object({
  simulation_id: z.string(),
  agent_id: z.string(),
  date: z.string(),
  scores: ScoresSchema,
  grade: z.string(),
  fault_types: z.array(z.string()),
  duration_ms: z.number(),
});

const AgentSummarySchema = z.object({
  agent_id: z.string(),
  runs: z.number(),
  avg_scores: ScoresSchema,
  best_run: z.string(),
  worst_run: z.string(),
  grade_distribution: z.record(z.string(), z.number()),
});

const TrendPointSchema = z.object({
  date: z.string(),
  avg_overall_score: z.number(),
  run_count: z.number(),
});

const DashboardDataSchema = z.object({
  total_runs: z.number(),
  date_range: z.object({ start: z.string(), end: z.string() }),
  agents: z.array(AgentSummarySchema),
  trends: z.array(TrendPointSchema),
  fault_type_breakdown: z.record(z.string(), z.object({
    count: z.number(),
    avg_recovery_score: z.number(),
  })),
});

// ============================================
// AGGREGATION
// ============================================

/**
 * Aggregate simulation runs into a complete DashboardData structure.
 */
export function aggregateResults(runs: SimulationRun[]): DashboardData {
  if (runs.length === 0) {
    return {
      total_runs: 0,
      date_range: { start: "", end: "" },
      agents: [],
      trends: [],
      fault_type_breakdown: {},
    };
  }

  // Date range
  const dates = runs.map(r => r.date).sort();
  const date_range = { start: dates[0], end: dates[dates.length - 1] };

  // Group by agent
  const agentMap: Record<string, SimulationRun[]> = {};
  for (const run of runs) {
    if (!agentMap[run.agent_id]) agentMap[run.agent_id] = [];
    agentMap[run.agent_id].push(run);
  }

  // Build agent summaries
  const agents: AgentSummary[] = Object.entries(agentMap).map(([agent_id, agentRuns]) => {
    const avg_scores = {
      detection: average(agentRuns.map(r => r.scores.detection)),
      recovery: average(agentRuns.map(r => r.scores.recovery)),
      resilience: average(agentRuns.map(r => r.scores.resilience)),
      safety: average(agentRuns.map(r => r.scores.safety)),
      overall: average(agentRuns.map(r => r.scores.overall)),
    };

    // Best and worst runs
    const sorted = [...agentRuns].sort((a, b) => a.scores.overall - b.scores.overall);
    const best_run = sorted[sorted.length - 1].simulation_id;
    const worst_run = sorted[0].simulation_id;

    // Grade distribution
    const grade_distribution: Record<string, number> = {};
    for (const run of agentRuns) {
      grade_distribution[run.grade] = (grade_distribution[run.grade] || 0) + 1;
    }

    return {
      agent_id,
      runs: agentRuns.length,
      avg_scores,
      best_run,
      worst_run,
      grade_distribution,
    };
  });

  // Trends
  const trends = calculateTrends(runs);

  // Fault type breakdown
  const fault_type_breakdown: Record<string, { count: number; recovery_scores: number[] }> = {};
  for (const run of runs) {
    for (const ft of run.fault_types) {
      if (!fault_type_breakdown[ft]) {
        fault_type_breakdown[ft] = { count: 0, recovery_scores: [] };
      }
      fault_type_breakdown[ft].count++;
      fault_type_breakdown[ft].recovery_scores.push(run.scores.recovery);
    }
  }

  const faultBreakdown: Record<string, { count: number; avg_recovery_score: number }> = {};
  for (const [ft, data] of Object.entries(fault_type_breakdown)) {
    faultBreakdown[ft] = {
      count: data.count,
      avg_recovery_score: average(data.recovery_scores),
    };
  }

  return {
    total_runs: runs.length,
    date_range,
    agents,
    trends,
    fault_type_breakdown: faultBreakdown,
  };
}

// ============================================
// TRENDS
// ============================================

/**
 * Calculate trend points by grouping runs by date.
 */
export function calculateTrends(runs: SimulationRun[]): TrendPoint[] {
  if (runs.length === 0) return [];

  const dateMap: Record<string, number[]> = {};
  for (const run of runs) {
    if (!dateMap[run.date]) dateMap[run.date] = [];
    dateMap[run.date].push(run.scores.overall);
  }

  return Object.entries(dateMap)
    .map(([date, scores]) => ({
      date,
      avg_overall_score: average(scores),
      run_count: scores.length,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ============================================
// STATISTICS
// ============================================

/**
 * Calculate mean, median, and p95 for overall scores across runs.
 */
export function calculateStatistics(runs: SimulationRun[]): StatisticalSummary {
  if (runs.length === 0) {
    return { mean: 0, median: 0, p95: 0 };
  }

  const scores = runs.map(r => r.scores.overall).sort((a, b) => a - b);
  const mean = average(scores);

  // Median
  const mid = Math.floor(scores.length / 2);
  const median = scores.length % 2 === 0
    ? (scores[mid - 1] + scores[mid]) / 2
    : scores[mid];

  // P95 (95th percentile)
  const p95Index = Math.ceil(scores.length * 0.95) - 1;
  const p95 = scores[Math.min(p95Index, scores.length - 1)];

  return { mean, median, p95 };
}

// ============================================
// COMPARISON
// ============================================

/**
 * Compare two agents side-by-side using their simulation runs.
 */
export function compareAgents(
  runs: SimulationRun[],
  agentAId: string,
  agentBId: string,
): AgentComparison {
  const agentARuns = runs.filter(r => r.agent_id === agentAId);
  const agentBRuns = runs.filter(r => r.agent_id === agentBId);

  const buildSummary = (agentId: string, agentRuns: SimulationRun[]): AgentSummary => {
    if (agentRuns.length === 0) {
      return {
        agent_id: agentId,
        runs: 0,
        avg_scores: { detection: 0, recovery: 0, resilience: 0, safety: 0, overall: 0 },
        best_run: "",
        worst_run: "",
        grade_distribution: {},
      };
    }

    const avg_scores = {
      detection: average(agentRuns.map(r => r.scores.detection)),
      recovery: average(agentRuns.map(r => r.scores.recovery)),
      resilience: average(agentRuns.map(r => r.scores.resilience)),
      safety: average(agentRuns.map(r => r.scores.safety)),
      overall: average(agentRuns.map(r => r.scores.overall)),
    };

    const sorted = [...agentRuns].sort((a, b) => a.scores.overall - b.scores.overall);
    const grade_distribution: Record<string, number> = {};
    for (const run of agentRuns) {
      grade_distribution[run.grade] = (grade_distribution[run.grade] || 0) + 1;
    }

    return {
      agent_id: agentId,
      runs: agentRuns.length,
      avg_scores,
      best_run: sorted[sorted.length - 1].simulation_id,
      worst_run: sorted[0].simulation_id,
      grade_distribution,
    };
  };

  const agent_a = buildSummary(agentAId, agentARuns);
  const agent_b = buildSummary(agentBId, agentBRuns);

  const scoreA = agent_a.avg_scores.overall;
  const scoreB = agent_b.avg_scores.overall;
  const diff = Math.abs(scoreA - scoreB);

  let winner: string;
  if (Math.abs(scoreA - scoreB) < 0.001) {
    winner = "tied";
  } else if (scoreA > scoreB) {
    winner = agentAId;
  } else {
    winner = agentBId;
  }

  return {
    agent_a,
    agent_b,
    winner,
    score_diff: Math.round(diff * 1000) / 1000,
  };
}

// ============================================
// EXPORT
// ============================================

/**
 * Export dashboard data as a Markdown report.
 */
export function exportAsMarkdown(data: DashboardData): string {
  let md = "";

  md += `# Simulation Dashboard\n\n`;
  md += `**Total Runs:** ${data.total_runs}\n`;
  if (data.date_range.start) {
    md += `**Date Range:** ${data.date_range.start} to ${data.date_range.end}\n`;
  }
  md += `\n---\n\n`;

  // Agent Summaries
  if (data.agents.length > 0) {
    md += `## Agent Performance\n\n`;
    md += `| Agent | Runs | Detection | Recovery | Resilience | Safety | Overall | Grade Distribution |\n`;
    md += `|-------|------|-----------|----------|------------|--------|---------|--------------------|\n`;

    for (const agent of data.agents) {
      const grades = Object.entries(agent.grade_distribution)
        .map(([g, c]) => `${g}:${c}`)
        .join(", ");
      md += `| ${agent.agent_id} | ${agent.runs} | ${agent.avg_scores.detection.toFixed(2)} | ${agent.avg_scores.recovery.toFixed(2)} | ${agent.avg_scores.resilience.toFixed(2)} | ${agent.avg_scores.safety.toFixed(2)} | ${agent.avg_scores.overall.toFixed(2)} | ${grades} |\n`;
    }
    md += `\n`;
  }

  // Trends
  if (data.trends.length > 0) {
    md += `## Trends\n\n`;
    md += `| Date | Avg Score | Runs |\n`;
    md += `|------|-----------|------|\n`;
    for (const trend of data.trends) {
      md += `| ${trend.date} | ${trend.avg_overall_score.toFixed(2)} | ${trend.run_count} |\n`;
    }
    md += `\n`;
  }

  // Fault Type Breakdown
  if (Object.keys(data.fault_type_breakdown).length > 0) {
    md += `## Fault Type Breakdown\n\n`;
    md += `| Fault Type | Count | Avg Recovery Score |\n`;
    md += `|------------|-------|--------------------|  \n`;
    for (const [ft, info] of Object.entries(data.fault_type_breakdown)) {
      md += `| ${ft} | ${info.count} | ${info.avg_recovery_score.toFixed(2)} |\n`;
    }
    md += `\n`;
  }

  md += `---\n\n`;
  md += `*Generated by SimulationDashboard | ${new Date().toISOString()}*\n`;

  return md;
}

/**
 * Export dashboard data as a JSON string.
 */
export function exportAsJSON(data: DashboardData): string {
  return JSON.stringify(data, null, 2);
}

// ============================================
// DASHBOARD FACTORY
// ============================================

export interface SimulationDashboard {
  generate(runs: SimulationRun[]): DashboardData;
  toMarkdown(data: DashboardData): string;
  toJSON(data: DashboardData): string;
}

export function createSimulationDashboard(): SimulationDashboard {
  return {
    generate(runs: SimulationRun[]): DashboardData {
      return aggregateResults(runs);
    },
    toMarkdown(data: DashboardData): string {
      return exportAsMarkdown(data);
    },
    toJSON(data: DashboardData): string {
      return exportAsJSON(data);
    },
  };
}

// ============================================
// HELPERS
// ============================================

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

// ============================================
// CLI
// ============================================

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case "generate": {
      const filePath = args[0];
      if (!filePath) {
        console.error("Usage: generate <runs.json>");
        process.exit(1);
      }
      const { readFileSync } = await import("fs");
      const genParsed = z.array(SimulationRunSchema).safeParse(JSON.parse(readFileSync(filePath, "utf-8")));
      if (!genParsed.success) { console.error("Invalid runs:", genParsed.error.format()); process.exit(1); }
      const runs = genParsed.data as SimulationRun[];
      const data = aggregateResults(runs);
      console.log(JSON.stringify(data, null, 2));
      break;
    }

    case "markdown": {
      const filePath = args[0];
      if (!filePath) {
        console.error("Usage: markdown <dashboard.json>");
        process.exit(1);
      }
      const { readFileSync } = await import("fs");
      const mdParsed = DashboardDataSchema.safeParse(JSON.parse(readFileSync(filePath, "utf-8")));
      if (!mdParsed.success) { console.error("Invalid dashboard data:", mdParsed.error.format()); process.exit(1); }
      const data = mdParsed.data as DashboardData;
      console.log(exportAsMarkdown(data));
      break;
    }

    case "compare": {
      const filePath = args[0];
      const agentA = args[1];
      const agentB = args[2];
      if (!filePath || !agentA || !agentB) {
        console.error("Usage: compare <runs.json> <agent-a> <agent-b>");
        process.exit(1);
      }
      const { readFileSync } = await import("fs");
      const cmpParsed = z.array(SimulationRunSchema).safeParse(JSON.parse(readFileSync(filePath, "utf-8")));
      if (!cmpParsed.success) { console.error("Invalid runs:", cmpParsed.error.format()); process.exit(1); }
      const runs = cmpParsed.data as SimulationRun[];
      const comparison = compareAgents(runs, agentA, agentB);
      console.log(JSON.stringify(comparison, null, 2));
      break;
    }

    case "stats": {
      const filePath = args[0];
      if (!filePath) {
        console.error("Usage: stats <runs.json>");
        process.exit(1);
      }
      const { readFileSync } = await import("fs");
      const statsParsed = z.array(SimulationRunSchema).safeParse(JSON.parse(readFileSync(filePath, "utf-8")));
      if (!statsParsed.success) { console.error("Invalid runs:", statsParsed.error.format()); process.exit(1); }
      const runs = statsParsed.data as SimulationRun[];
      const stats = calculateStatistics(runs);
      console.log(JSON.stringify(stats, null, 2));
      break;
    }

    default:
      console.log(`SimulationDashboard - Aggregate results and trend analysis

Commands:
  generate <runs.json>                     Generate dashboard data
  markdown <dashboard.json>                Export as Markdown
  compare <runs.json> <agent-a> <agent-b>  Compare two agents
  stats <runs.json>                        Calculate statistics`);
      break;
  }
}
