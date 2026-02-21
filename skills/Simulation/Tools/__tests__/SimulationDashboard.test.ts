import { describe, test, expect } from "bun:test";
import {
  createSimulationDashboard,
  aggregateResults,
  calculateTrends,
  calculateStatistics,
  compareAgents,
  exportAsMarkdown,
  exportAsJSON,
  type DashboardData,
  type AgentSummary,
  type TrendPoint,
  type SimulationRun,
} from "../SimulationDashboard.ts";

// ============================================
// M3: Simulation Dashboard Tests
// Aggregation, trends, comparison, export
// ============================================

describe("SimulationDashboard", () => {
  // --- Test Data Helpers ---

  function makeRun(overrides: Partial<SimulationRun> = {}): SimulationRun {
    return {
      simulation_id: overrides.simulation_id ?? "sim-001",
      agent_id: overrides.agent_id ?? "agent-1",
      date: overrides.date ?? "2026-02-09",
      scores: overrides.scores ?? {
        detection: 0.8,
        recovery: 0.7,
        resilience: 0.9,
        safety: 1.0,
        overall: 0.85,
      },
      grade: overrides.grade ?? "B",
      fault_types: overrides.fault_types ?? ["network_timeout"],
      duration_ms: overrides.duration_ms ?? 5000,
    };
  }

  // --- Aggregation ---

  describe("aggregateResults", () => {
    test("aggregates single agent across multiple runs", () => {
      const runs: SimulationRun[] = [
        makeRun({ simulation_id: "sim-001", scores: { detection: 0.8, recovery: 0.7, resilience: 0.9, safety: 1.0, overall: 0.85 }, grade: "B" }),
        makeRun({ simulation_id: "sim-002", scores: { detection: 0.9, recovery: 0.8, resilience: 1.0, safety: 1.0, overall: 0.925 }, grade: "A" }),
      ];

      const data = aggregateResults(runs);
      expect(data.total_runs).toBe(2);
      expect(data.agents).toHaveLength(1);
      expect(data.agents[0].agent_id).toBe("agent-1");
      expect(data.agents[0].runs).toBe(2);
    });

    test("aggregates multiple agents independently", () => {
      const runs: SimulationRun[] = [
        makeRun({ agent_id: "agent-1", simulation_id: "sim-001" }),
        makeRun({ agent_id: "agent-2", simulation_id: "sim-002" }),
        makeRun({ agent_id: "agent-1", simulation_id: "sim-003" }),
      ];

      const data = aggregateResults(runs);
      expect(data.total_runs).toBe(3);
      expect(data.agents).toHaveLength(2);

      const agent1 = data.agents.find(a => a.agent_id === "agent-1");
      const agent2 = data.agents.find(a => a.agent_id === "agent-2");
      expect(agent1?.runs).toBe(2);
      expect(agent2?.runs).toBe(1);
    });

    test("empty runs produce empty dashboard", () => {
      const data = aggregateResults([]);
      expect(data.total_runs).toBe(0);
      expect(data.agents).toHaveLength(0);
      expect(data.trends).toHaveLength(0);
    });

    test("date range covers all runs", () => {
      const runs: SimulationRun[] = [
        makeRun({ date: "2026-01-01" }),
        makeRun({ date: "2026-02-09" }),
        makeRun({ date: "2026-01-15" }),
      ];

      const data = aggregateResults(runs);
      expect(data.date_range.start).toBe("2026-01-01");
      expect(data.date_range.end).toBe("2026-02-09");
    });

    test("fault type breakdown counts correctly", () => {
      const runs: SimulationRun[] = [
        makeRun({ fault_types: ["network_timeout", "rate_limit"], scores: { detection: 0.8, recovery: 0.7, resilience: 0.9, safety: 1.0, overall: 0.85 } }),
        makeRun({ fault_types: ["network_timeout"], scores: { detection: 0.9, recovery: 0.8, resilience: 1.0, safety: 1.0, overall: 0.92 } }),
        makeRun({ fault_types: ["malformed_response"], scores: { detection: 0.6, recovery: 0.5, resilience: 0.7, safety: 1.0, overall: 0.7 } }),
      ];

      const data = aggregateResults(runs);
      expect(data.fault_type_breakdown["network_timeout"].count).toBe(2);
      expect(data.fault_type_breakdown["rate_limit"].count).toBe(1);
      expect(data.fault_type_breakdown["malformed_response"].count).toBe(1);
    });

    test("agent grade distribution is computed correctly", () => {
      const runs: SimulationRun[] = [
        makeRun({ grade: "A", simulation_id: "sim-001" }),
        makeRun({ grade: "B", simulation_id: "sim-002" }),
        makeRun({ grade: "A", simulation_id: "sim-003" }),
      ];

      const data = aggregateResults(runs);
      const agent = data.agents[0];
      expect(agent.grade_distribution["A"]).toBe(2);
      expect(agent.grade_distribution["B"]).toBe(1);
    });

    test("best and worst runs are identified", () => {
      const runs: SimulationRun[] = [
        makeRun({ simulation_id: "sim-low", scores: { detection: 0.3, recovery: 0.2, resilience: 0.4, safety: 0.5, overall: 0.35 } }),
        makeRun({ simulation_id: "sim-high", scores: { detection: 1.0, recovery: 1.0, resilience: 1.0, safety: 1.0, overall: 1.0 } }),
        makeRun({ simulation_id: "sim-mid", scores: { detection: 0.7, recovery: 0.7, resilience: 0.7, safety: 0.7, overall: 0.7 } }),
      ];

      const data = aggregateResults(runs);
      const agent = data.agents[0];
      expect(agent.best_run).toBe("sim-high");
      expect(agent.worst_run).toBe("sim-low");
    });
  });

  // --- Trends ---

  describe("calculateTrends", () => {
    test("groups runs by date for trend points", () => {
      const runs: SimulationRun[] = [
        makeRun({ date: "2026-02-01", scores: { detection: 0.8, recovery: 0.7, resilience: 0.9, safety: 1.0, overall: 0.8 } }),
        makeRun({ date: "2026-02-01", scores: { detection: 0.9, recovery: 0.8, resilience: 1.0, safety: 1.0, overall: 0.9 } }),
        makeRun({ date: "2026-02-02", scores: { detection: 0.7, recovery: 0.6, resilience: 0.8, safety: 1.0, overall: 0.7 } }),
      ];

      const trends = calculateTrends(runs);
      expect(trends).toHaveLength(2);

      const day1 = trends.find(t => t.date === "2026-02-01");
      const day2 = trends.find(t => t.date === "2026-02-02");
      expect(day1?.run_count).toBe(2);
      expect(day1?.avg_overall_score).toBeCloseTo(0.85, 2);
      expect(day2?.run_count).toBe(1);
      expect(day2?.avg_overall_score).toBeCloseTo(0.7, 2);
    });

    test("trends are sorted by date ascending", () => {
      const runs: SimulationRun[] = [
        makeRun({ date: "2026-02-05" }),
        makeRun({ date: "2026-02-01" }),
        makeRun({ date: "2026-02-03" }),
      ];

      const trends = calculateTrends(runs);
      expect(trends[0].date).toBe("2026-02-01");
      expect(trends[1].date).toBe("2026-02-03");
      expect(trends[2].date).toBe("2026-02-05");
    });

    test("empty runs produce empty trends", () => {
      const trends = calculateTrends([]);
      expect(trends).toHaveLength(0);
    });
  });

  // --- Statistics ---

  describe("calculateStatistics", () => {
    test("calculates mean, median, p95 for scores", () => {
      const overalls = [0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1.0];
      const runs: SimulationRun[] = overalls.map((score, i) =>
        makeRun({
          simulation_id: `sim-${i}`,
          scores: { detection: score, recovery: score, resilience: score, safety: score, overall: score },
        })
      );

      const stats = calculateStatistics(runs);
      expect(stats.mean).toBeCloseTo(0.7786, 2);
      expect(stats.median).toBeCloseTo(0.8, 2);
      expect(stats.p95).toBeGreaterThanOrEqual(0.95);
    });

    test("single run returns that score for all statistics", () => {
      const runs: SimulationRun[] = [
        makeRun({ scores: { detection: 0.8, recovery: 0.8, resilience: 0.8, safety: 0.8, overall: 0.8 } }),
      ];

      const stats = calculateStatistics(runs);
      expect(stats.mean).toBeCloseTo(0.8, 2);
      expect(stats.median).toBeCloseTo(0.8, 2);
      expect(stats.p95).toBeCloseTo(0.8, 2);
    });

    test("empty runs return zeros", () => {
      const stats = calculateStatistics([]);
      expect(stats.mean).toBe(0);
      expect(stats.median).toBe(0);
      expect(stats.p95).toBe(0);
    });
  });

  // --- Agent Comparison ---

  describe("compareAgents", () => {
    test("compares two agents side by side", () => {
      const runs: SimulationRun[] = [
        makeRun({ agent_id: "agent-A", scores: { detection: 0.9, recovery: 0.8, resilience: 1.0, safety: 1.0, overall: 0.92 } }),
        makeRun({ agent_id: "agent-B", scores: { detection: 0.6, recovery: 0.5, resilience: 0.7, safety: 0.8, overall: 0.65 } }),
      ];

      const comparison = compareAgents(runs, "agent-A", "agent-B");
      expect(comparison.agent_a.agent_id).toBe("agent-A");
      expect(comparison.agent_b.agent_id).toBe("agent-B");
      expect(comparison.winner).toBe("agent-A");
      expect(comparison.score_diff).toBeGreaterThan(0);
    });

    test("returns tied when agents have equal scores", () => {
      const runs: SimulationRun[] = [
        makeRun({ agent_id: "agent-A", scores: { detection: 0.8, recovery: 0.8, resilience: 0.8, safety: 0.8, overall: 0.8 } }),
        makeRun({ agent_id: "agent-B", scores: { detection: 0.8, recovery: 0.8, resilience: 0.8, safety: 0.8, overall: 0.8 } }),
      ];

      const comparison = compareAgents(runs, "agent-A", "agent-B");
      expect(comparison.winner).toBe("tied");
      expect(comparison.score_diff).toBe(0);
    });
  });

  // --- Export ---

  describe("exportAsMarkdown", () => {
    test("generates markdown with summary section", () => {
      const data: DashboardData = {
        total_runs: 5,
        date_range: { start: "2026-02-01", end: "2026-02-09" },
        agents: [{
          agent_id: "agent-1",
          runs: 5,
          avg_scores: { detection: 0.8, recovery: 0.7, resilience: 0.9, safety: 1.0, overall: 0.85 },
          best_run: "sim-003",
          worst_run: "sim-001",
          grade_distribution: { A: 2, B: 3 },
        }],
        trends: [
          { date: "2026-02-01", avg_overall_score: 0.8, run_count: 3 },
          { date: "2026-02-09", avg_overall_score: 0.9, run_count: 2 },
        ],
        fault_type_breakdown: {
          network_timeout: { count: 3, avg_recovery_score: 0.8 },
        },
      };

      const md = exportAsMarkdown(data);
      expect(md).toContain("# Simulation Dashboard");
      expect(md).toContain("Total Runs");
      expect(md).toContain("5");
      expect(md).toContain("agent-1");
      expect(md).toContain("network_timeout");
    });

    test("empty dashboard generates valid markdown", () => {
      const data: DashboardData = {
        total_runs: 0,
        date_range: { start: "", end: "" },
        agents: [],
        trends: [],
        fault_type_breakdown: {},
      };

      const md = exportAsMarkdown(data);
      expect(md).toContain("# Simulation Dashboard");
      expect(md).toContain("0");
    });
  });

  describe("exportAsJSON", () => {
    test("exports valid JSON string", () => {
      const data: DashboardData = {
        total_runs: 2,
        date_range: { start: "2026-02-01", end: "2026-02-09" },
        agents: [],
        trends: [],
        fault_type_breakdown: {},
      };

      const json = exportAsJSON(data);
      const parsed = JSON.parse(json);
      expect(parsed.total_runs).toBe(2);
    });
  });

  // --- Full Dashboard Pipeline ---

  describe("createSimulationDashboard", () => {
    test("generates complete dashboard from runs", () => {
      const dashboard = createSimulationDashboard();

      const runs: SimulationRun[] = [
        makeRun({ agent_id: "agent-1", simulation_id: "sim-001", date: "2026-02-01", scores: { detection: 0.8, recovery: 0.7, resilience: 0.9, safety: 1.0, overall: 0.85 }, grade: "B" }),
        makeRun({ agent_id: "agent-1", simulation_id: "sim-002", date: "2026-02-02", scores: { detection: 0.9, recovery: 0.9, resilience: 1.0, safety: 1.0, overall: 0.95 }, grade: "A" }),
        makeRun({ agent_id: "agent-2", simulation_id: "sim-003", date: "2026-02-02", scores: { detection: 0.6, recovery: 0.5, resilience: 0.7, safety: 0.8, overall: 0.65 }, grade: "D" }),
      ];

      const data = dashboard.generate(runs);
      expect(data.total_runs).toBe(3);
      expect(data.agents).toHaveLength(2);
      expect(data.trends.length).toBeGreaterThan(0);

      // Verify markdown export
      const md = dashboard.toMarkdown(data);
      expect(md).toContain("# Simulation Dashboard");

      // Verify JSON export
      const json = dashboard.toJSON(data);
      expect(JSON.parse(json).total_runs).toBe(3);
    });
  });
});
