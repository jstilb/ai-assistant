/**
 * Tests for GoalConnector.ts - parseGoals, parseMissions, connectToGoals
 *
 * All tests use in-memory fixtures only.
 * Zero filesystem reads, zero network calls, zero shared mutable state.
 */

import { describe, it, expect } from "bun:test";
import { parseGoals, parseMissions, connectToGoals, getGoal, getMission, getGoalsByMission, getWIGs } from "../GoalConnector";
import type { Goal, Mission, TelosContext } from "../GoalConnector";
import {
  VALID_GOALS_MD,
  EMPTY_GOALS_MD,
  MALFORMED_GOALS_MD,
  SPECIAL_CHARS_GOALS_MD,
  SINGLE_GOAL_MD,
  EXPECTED_VALID_GOALS,
} from "./fixtures/goals.fixture";
import {
  VALID_MISSIONS_MD,
  EMPTY_MISSIONS_MD,
  MALFORMED_MISSIONS_MD,
  SINGLE_MISSION_MD,
  EXPECTED_VALID_MISSIONS,
} from "./fixtures/missions.fixture";

// ============================================================================
// parseGoals tests
// ============================================================================

describe("parseGoals", () => {
  it("parses valid multi-goal markdown with WIG and regular sections", () => {
    const goals = parseGoals(VALID_GOALS_MD);

    expect(goals).toHaveLength(5);

    // Check first WIG
    const g0 = goals.find((g) => g.id === "G0");
    expect(g0).toBeDefined();
    expect(g0!.title).toBe("Reduce daily screen time");
    expect(g0!.status).toBe("Active");
    expect(g0!.supports).toBe("M6 Self");
    expect(g0!.isWIG).toBe(true);
    expect(g0!.target).toBe("Under 2 hours");
    expect(g0!.metric).toBe("Screen Time App");
    expect(g0!.current).toBe("3.5 hours average");
    expect(g0!.section).toBe("WIGs (Wildly Important Goals)");
  });

  it("correctly distinguishes WIG from non-WIG goals by section", () => {
    const goals = parseGoals(VALID_GOALS_MD);

    const wigs = goals.filter((g) => g.isWIG);
    const nonWigs = goals.filter((g) => !g.isWIG);

    expect(wigs).toHaveLength(2);
    expect(nonWigs).toHaveLength(3);

    // G0 and G1 are WIGs
    expect(wigs.map((w) => w.id).sort()).toEqual(["G0", "G1"]);
  });

  it("parses all metadata fields including optional ones", () => {
    const goals = parseGoals(VALID_GOALS_MD);

    const g25 = goals.find((g) => g.id === "G25");
    expect(g25).toBeDefined();
    expect(g25!.leadMeasures).toBe("Weekly feature releases");
    expect(g25!.current).toBe("12 users");
    expect(g25!.target).toBe("100 beta users");
  });

  it("handles goals without optional fields gracefully", () => {
    const goals = parseGoals(VALID_GOALS_MD);

    const g28 = goals.find((g) => g.id === "G28");
    expect(g28).toBeDefined();
    expect(g28!.current).toBeUndefined();
    expect(g28!.leadMeasures).toBeUndefined();
  });

  it("returns empty array for content with no goal headers", () => {
    const goals = parseGoals(EMPTY_GOALS_MD);
    expect(goals).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    const goals = parseGoals("");
    expect(goals).toEqual([]);
  });

  it("handles malformed content - goals with missing metadata", () => {
    const goals = parseGoals(MALFORMED_GOALS_MD);

    // G99 has an id but no metadata fields
    const g99 = goals.find((g) => g.id === "G99");
    expect(g99).toBeDefined();
    expect(g99!.title).toBe("Goal with no metadata");
    expect(g99!.status).toBe("");
    expect(g99!.supports).toBe("");

    // "NotAGoal" should not be parsed as a goal (doesn't match ### G pattern)
    const notAGoal = goals.find((g) => g.title === "This should be skipped");
    expect(notAGoal).toBeUndefined();
  });

  it("parses partial goals that have some but not all metadata", () => {
    const goals = parseGoals(MALFORMED_GOALS_MD);

    const g100 = goals.find((g) => g.id === "G100");
    expect(g100).toBeDefined();
    expect(g100!.status).toBe("Active");
    expect(g100!.supports).toBe("");

    const g101 = goals.find((g) => g.id === "G101");
    expect(g101).toBeDefined();
    expect(g101!.supports).toBe("M0 Adventure");
    expect(g101!.status).toBe("");
  });

  it("handles special characters in goal titles and values", () => {
    const goals = parseGoals(SPECIAL_CHARS_GOALS_MD);

    expect(goals.length).toBeGreaterThanOrEqual(2);

    const g50 = goals.find((g) => g.id === "G50");
    expect(g50).toBeDefined();
    expect(g50!.title).toContain("quotes");
    expect(g50!.title).toContain("&");
    expect(g50!.status).toBe("Active -- with dashes");
    expect(g50!.supports).toBe("M6 Self (primary)");
    expect(g50!.target).toBe("100% compliance");

    const g51 = goals.find((g) => g.id === "G51");
    expect(g51).toBeDefined();
    expect(g51!.title).toContain("unicode");
  });

  it("parses single goal correctly", () => {
    const goals = parseGoals(SINGLE_GOAL_MD);

    expect(goals).toHaveLength(1);
    expect(goals[0].id).toBe("G7");
    expect(goals[0].title).toBe("Join local organization");
    expect(goals[0].isWIG).toBe(true);
  });

  it("preserves goal ordering based on document order", () => {
    const goals = parseGoals(VALID_GOALS_MD);

    // Goals should appear in document order
    const ids = goals.map((g) => g.id);
    expect(ids).toEqual(["G0", "G1", "G25", "G28", "G13"]);
  });
});

// ============================================================================
// parseMissions tests
// ============================================================================

describe("parseMissions", () => {
  it("parses valid multi-mission markdown", () => {
    const missions = parseMissions(VALID_MISSIONS_MD);

    expect(missions).toHaveLength(3);

    const m0 = missions.find((m) => m.id === "M0");
    expect(m0).toBeDefined();
    expect(m0!.name).toBe("Adventurer");
    expect(m0!.definition).toBe("Explore the world through travel and new experiences");
    expect(m0!.focus).toBe("International and domestic travel");
    expect(m0!.theme2026).toBe("Year of Discovery");
  });

  it("extracts goal IDs from mapping table when separator does not contain triple dashes", () => {
    // Note: The current regex in parseMissions terminates at the first "---"
    // sequence, which can collide with markdown table separator rows like
    // "|---------|". A table using single-dash separators avoids this.
    const mdWithSimpleTable = `# MISSIONS

### M0: Adventurer
**Definition:** Explore the world
**Focus:** Travel
**2026 Theme:** Discover

## Mission \u2192 Goal Mapping

| Mission | Goals |
| M0 | G3, G4, G5 |

---
`;
    const missions = parseMissions(mdWithSimpleTable);
    const m0 = missions.find((m) => m.id === "M0");
    expect(m0!.goalIds).toEqual(["G3", "G4", "G5"]);
  });

  it("returns empty goalIds when table separator row contains triple dashes (known regex limitation)", () => {
    // The standard markdown table with |---| separator matches the regex
    // terminator "---" before reaching the data rows.
    const missions = parseMissions(VALID_MISSIONS_MD);

    // Characterization: goalIds are empty due to regex limitation
    for (const m of missions) {
      expect(m.goalIds).toEqual([]);
    }
  });

  it("returns empty array for content with no mission headers", () => {
    const missions = parseMissions(EMPTY_MISSIONS_MD);
    expect(missions).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    const missions = parseMissions("");
    expect(missions).toEqual([]);
  });

  it("handles malformed missions with missing fields", () => {
    const missions = parseMissions(MALFORMED_MISSIONS_MD);

    // M99 should exist with empty fields
    const m99 = missions.find((m) => m.id === "M99");
    expect(m99).toBeDefined();
    expect(m99!.name).toBe("Mission with no fields");
    expect(m99!.definition).toBe("");
    expect(m99!.focus).toBe("");
    expect(m99!.theme2026).toBe("");

    // NotAMission should not be parsed
    const notAMission = missions.find((m) => m.name === "Should be skipped");
    expect(notAMission).toBeUndefined();
  });

  it("handles partial missions with some fields", () => {
    const missions = parseMissions(MALFORMED_MISSIONS_MD);

    const m100 = missions.find((m) => m.id === "M100");
    expect(m100).toBeDefined();
    expect(m100!.definition).toBe("Only has definition");
    expect(m100!.focus).toBe("");

    const m101 = missions.find((m) => m.id === "M101");
    expect(m101).toBeDefined();
    expect(m101!.focus).toBe("Only has focus");
    expect(m101!.definition).toBe("");
  });

  it("parses single mission correctly", () => {
    const missions = parseMissions(SINGLE_MISSION_MD);

    expect(missions).toHaveLength(1);
    expect(missions[0].id).toBe("M6");
    expect(missions[0].name).toBe("Self");
    expect(missions[0].theme2026).toBe("Rebuild");
  });

  it("defaults goalIds to empty array when no mapping table exists", () => {
    const missions = parseMissions(SINGLE_MISSION_MD);

    expect(missions[0].goalIds).toEqual([]);
  });

  it("preserves mission ordering from document", () => {
    const missions = parseMissions(VALID_MISSIONS_MD);

    const ids = missions.map((m) => m.id);
    expect(ids).toEqual(["M0", "M1", "M5"]);
  });
});

// ============================================================================
// connectToGoals tests
// ============================================================================

describe("connectToGoals", () => {
  // Build a test context from fixture data to avoid filesystem access
  const testContext: TelosContext = {
    goals: [
      {
        id: "G28",
        title: "Master AI tooling",
        status: "Active",
        supports: "M5 Professional",
        isWIG: false,
        section: "M5: Professional",
      },
      {
        id: "G25",
        title: "Launch beta application",
        status: "Active",
        supports: "M5 Professional",
        isWIG: false,
        section: "M5: Professional",
      },
      {
        id: "G13",
        title: "Complete first novel draft",
        status: "Active",
        supports: "M2 Creative",
        isWIG: false,
        section: "M2: Creative",
      },
      {
        id: "G9",
        title: "Join surf community",
        status: "Active",
        supports: "M1 Community Member",
        isWIG: false,
        section: "M1: Community Member",
      },
      {
        id: "G0",
        title: "Reduce daily screen time",
        status: "Active",
        supports: "M6 Self",
        isWIG: true,
        section: "WIGs",
      },
    ],
    missions: [
      { id: "M5", name: "Professional", definition: "", focus: "", theme2026: "", goalIds: ["G25", "G28"] },
      { id: "M2", name: "Creative", definition: "", focus: "", theme2026: "", goalIds: ["G13"] },
      { id: "M1", name: "Community Member", definition: "", focus: "", theme2026: "", goalIds: ["G9"] },
      { id: "M6", name: "Self", definition: "", focus: "", theme2026: "", goalIds: ["G0"] },
    ],
    strategies: [],
  };

  it("finds goal connections via keyword matching", async () => {
    const connections = await connectToGoals("I want to improve my AI workflow with Claude and LLM tools", testContext);

    expect(connections.length).toBeGreaterThan(0);

    // Should connect to G28 (AI tooling) via keywords
    const aiConnection = connections.find((c) => c.goalId === "G28");
    expect(aiConnection).toBeDefined();
    expect(aiConnection!.matchedKeywords.length).toBeGreaterThan(0);
    expect(aiConnection!.relevanceScore).toBeGreaterThan(0);
  });

  it("matches keywords case-insensitively", async () => {
    const connections = await connectToGoals("Working with AI and CLAUDE for my PROJECT", testContext);

    const aiConnection = connections.find((c) => c.goalId === "G28");
    expect(aiConnection).toBeDefined();
  });

  it("returns connections sorted by relevance score descending", async () => {
    const connections = await connectToGoals("AI tools for my startup application beta", testContext);

    for (let i = 1; i < connections.length; i++) {
      expect(connections[i - 1].relevanceScore).toBeGreaterThanOrEqual(connections[i].relevanceScore);
    }
  });

  it("includes mission information in connections", async () => {
    const connections = await connectToGoals("surfing at the beach waves", testContext);

    const surfConnection = connections.find((c) => c.goalId === "G9");
    expect(surfConnection).toBeDefined();
    expect(surfConnection!.missionId).toBe("M1");
    expect(surfConnection!.missionName).toBe("Community Member");
  });

  it("matches goal title words longer than 3 characters", async () => {
    const connections = await connectToGoals("I want to master something new", testContext);

    // "master" appears in G28's title "Master AI tooling"
    const g28 = connections.find((c) => c.goalId === "G28");
    expect(g28).toBeDefined();
    expect(g28!.matchedKeywords).toContain("master");
  });

  it("returns empty array for text with no related goals", async () => {
    // Note: avoid words containing "ai" (e.g. "rain") as substring matching
    // will trigger the "ai" keyword for G28.
    const connections = await connectToGoals("the sun is shining brightly outside today", testContext);

    expect(connections).toEqual([]);
  });

  it("returns empty array for empty text", async () => {
    const connections = await connectToGoals("", testContext);
    expect(connections).toEqual([]);
  });

  it("handles context with no goals", async () => {
    const emptyContext: TelosContext = { goals: [], missions: [], strategies: [] };
    const connections = await connectToGoals("AI tools for work", emptyContext);

    expect(connections).toEqual([]);
  });

  it("handles context with no missions", async () => {
    const noMissionsContext: TelosContext = {
      goals: [
        {
          id: "G28",
          title: "Master AI tooling",
          status: "Active",
          supports: "M5 Professional",
          isWIG: false,
          section: "M5",
        },
      ],
      missions: [],
      strategies: [],
    };
    const connections = await connectToGoals("AI and claude tools", noMissionsContext);

    // Should still find connection even without mission lookup
    const g28 = connections.find((c) => c.goalId === "G28");
    expect(g28).toBeDefined();
    // Mission name falls back to full supports field when mission not found
    expect(g28!.missionName).toBe("M5 Professional");
  });

  it("caps relevance score at 1.0", async () => {
    // Text that matches many keywords for a single goal
    const connections = await connectToGoals(
      "ai artificial intelligence machine learning claude llm gpt tools workflow",
      testContext,
    );

    const g28 = connections.find((c) => c.goalId === "G28");
    expect(g28).toBeDefined();
    expect(g28!.relevanceScore).toBeLessThanOrEqual(1.0);
  });

  it("includes reason string explaining the match", async () => {
    const connections = await connectToGoals("writing a novel draft", testContext);

    const novelConnection = connections.find((c) => c.goalId === "G13");
    expect(novelConnection).toBeDefined();
    expect(novelConnection!.reason).toContain("Matched keywords");
  });

  it("adds mission-level connections when no specific goal matches", async () => {
    // "career" is a mission keyword for M5 but not a specific goal keyword
    const connections = await connectToGoals("career development", testContext);

    // Should get a mission-level connection via M5 Professional keywords
    const m5Connection = connections.find((c) => c.missionId === "M5");
    expect(m5Connection).toBeDefined();
    expect(m5Connection!.reason).toContain("Mission-level match");
  });
});

// ============================================================================
// Utility function tests (getGoal, getMission, getGoalsByMission, getWIGs)
// ============================================================================

describe("getGoal", () => {
  const ctx: TelosContext = {
    goals: [
      { id: "G0", title: "Screen time", status: "Active", supports: "M6", isWIG: true, section: "WIG" },
      { id: "G28", title: "AI tooling", status: "Active", supports: "M5", isWIG: false, section: "M5" },
    ],
    missions: [],
    strategies: [],
  };

  it("finds a goal by ID", async () => {
    const goal = await getGoal("G28", ctx);
    expect(goal).toBeDefined();
    expect(goal!.title).toBe("AI tooling");
  });

  it("returns undefined for non-existent goal", async () => {
    const goal = await getGoal("G999", ctx);
    expect(goal).toBeUndefined();
  });
});

describe("getMission", () => {
  const ctx: TelosContext = {
    goals: [],
    missions: [
      { id: "M5", name: "Professional", definition: "", focus: "", theme2026: "", goalIds: [] },
    ],
    strategies: [],
  };

  it("finds a mission by ID", async () => {
    const mission = await getMission("M5", ctx);
    expect(mission).toBeDefined();
    expect(mission!.name).toBe("Professional");
  });

  it("returns undefined for non-existent mission", async () => {
    const mission = await getMission("M99", ctx);
    expect(mission).toBeUndefined();
  });
});

describe("getGoalsByMission", () => {
  const ctx: TelosContext = {
    goals: [
      { id: "G25", title: "Beta app", status: "Active", supports: "M5 Professional", isWIG: false, section: "M5" },
      { id: "G28", title: "AI tools", status: "Active", supports: "M5 Professional", isWIG: false, section: "M5" },
      { id: "G13", title: "Novel draft", status: "Active", supports: "M2 Creative", isWIG: false, section: "M2" },
    ],
    missions: [],
    strategies: [],
  };

  it("returns goals for a given mission", async () => {
    const goals = await getGoalsByMission("M5", ctx);
    expect(goals).toHaveLength(2);
    expect(goals.map((g) => g.id).sort()).toEqual(["G25", "G28"]);
  });

  it("returns empty array for mission with no goals", async () => {
    const goals = await getGoalsByMission("M0", ctx);
    expect(goals).toEqual([]);
  });
});

describe("getWIGs", () => {
  const ctx: TelosContext = {
    goals: [
      { id: "G0", title: "Screen time", status: "Active", supports: "M6", isWIG: true, section: "WIG" },
      { id: "G1", title: "Friendships", status: "Active", supports: "M4", isWIG: true, section: "WIG" },
      { id: "G28", title: "AI tools", status: "Active", supports: "M5", isWIG: false, section: "M5" },
    ],
    missions: [],
    strategies: [],
  };

  it("returns only WIG goals", async () => {
    const wigs = await getWIGs(ctx);
    expect(wigs).toHaveLength(2);
    expect(wigs.every((g) => g.isWIG)).toBe(true);
  });

  it("returns empty array when no WIGs exist", async () => {
    const noWigCtx: TelosContext = {
      goals: [{ id: "G28", title: "AI", status: "Active", supports: "M5", isWIG: false, section: "M5" }],
      missions: [],
      strategies: [],
    };
    const wigs = await getWIGs(noWigCtx);
    expect(wigs).toEqual([]);
  });
});
