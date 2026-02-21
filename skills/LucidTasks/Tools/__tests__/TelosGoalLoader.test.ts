/**
 * TelosGoalLoader.test.ts - Test Suite for TelosGoalLoader
 *
 * Tests for parseGoals, parseMissions, and expandGoalIds.
 */

import { describe, it, expect } from "bun:test";
import { parseGoals, parseMissions, expandGoalIds } from "../TelosGoalLoader.ts";

// ============================================================================
// parseGoals
// ============================================================================

describe("parseGoals", () => {
  it("parses a single goal with all fields", () => {
    const content = `
### G25: Decrease Low-Value Media Consumption

**Status:** In Progress
**Supports:** M6 (Self)
**Target:** 3/29/26
**Metric:** 4wk-rolling avg daily low-value media consumption < 2 hrs
**Current:** 5.3 hrs
**Lead Measures:** S0 (Boredom Blocks), S2 (STORER)
**Related:** G0
`;

    const goals = parseGoals(content);
    expect(goals.length).toBe(1);
    expect(goals[0].id).toBe("G25");
    expect(goals[0].title).toBe("Decrease Low-Value Media Consumption");
    expect(goals[0].status).toBe("In Progress");
    expect(goals[0].missionId).toBe("M6");
    expect(goals[0].missionName).toBe("Self");
    expect(goals[0].target).toBe("3/29/26");
    expect(goals[0].metric).toBe("4wk-rolling avg daily low-value media consumption < 2 hrs");
    expect(goals[0].current).toBe("5.3 hrs");
    expect(goals[0].leadMeasures).toBe("S0 (Boredom Blocks), S2 (STORER)");
    expect(goals[0].relatedGoal).toBe("G0");
  });

  it("parses multiple goals", () => {
    const content = `
### G1: First Goal

**Status:** Active
**Supports:** M1 (Mission1)

### G2: Second Goal

**Status:** Paused
**Supports:** M2 (Mission2)

### G3: Third Goal

**Status:** Completed
**Supports:** M3 (Mission3)
`;

    const goals = parseGoals(content);
    expect(goals.length).toBe(3);
    expect(goals[0].id).toBe("G1");
    expect(goals[0].title).toBe("First Goal");
    expect(goals[1].id).toBe("G2");
    expect(goals[1].title).toBe("Second Goal");
    expect(goals[2].id).toBe("G3");
    expect(goals[2].title).toBe("Third Goal");
  });

  it("handles goals with missing optional fields", () => {
    const content = `
### G10: Minimal Goal

**Status:** Active
**Supports:** M5 (MinimalMission)
`;

    const goals = parseGoals(content);
    expect(goals.length).toBe(1);
    expect(goals[0].id).toBe("G10");
    expect(goals[0].title).toBe("Minimal Goal");
    expect(goals[0].status).toBe("Active");
    expect(goals[0].missionId).toBe("M5");
    expect(goals[0].missionName).toBe("MinimalMission");
    expect(goals[0].target).toBeUndefined();
    expect(goals[0].metric).toBeUndefined();
    expect(goals[0].current).toBeUndefined();
  });

  it("extracts mission ID and name from Supports field", () => {
    const content = `
### G15: Test Goal

**Status:** In Progress
**Supports:** M99 (TestMission)
`;

    const goals = parseGoals(content);
    expect(goals[0].missionId).toBe("M99");
    expect(goals[0].missionName).toBe("TestMission");
  });

  it("handles missing Supports field gracefully", () => {
    const content = `
### G20: No Mission Goal

**Status:** Active
`;

    const goals = parseGoals(content);
    expect(goals[0].missionId).toBe("");
    expect(goals[0].missionName).toBe("");
  });
});

// ============================================================================
// parseMissions
// ============================================================================

describe("parseMissions", () => {
  it("parses a single mission with all fields", () => {
    const content = `
### M6: Self

**Definition:** Cultivate discipline, self-awareness, and personal growth.
**Focus:** Mental health, habit formation, and self-improvement.
**2026 Theme:** Build sustainable systems for productivity and well-being.

## Mission-Goal Mapping

| Mission | Goals |
|---------|-------|
| M6 (Self) | G25, G26, G27 |
`;

    const missions = parseMissions(content);
    expect(missions.length).toBe(1);
    expect(missions[0].id).toBe("M6");
    expect(missions[0].name).toBe("Self");
    expect(missions[0].definition).toBe("Cultivate discipline, self-awareness, and personal growth.");
    expect(missions[0].focus).toBe("Mental health, habit formation, and self-improvement.");
    expect(missions[0].theme2026).toBe("Build sustainable systems for productivity and well-being.");
    expect(missions[0].goalIds).toEqual(["G25", "G26", "G27"]);
  });

  it("parses multiple missions", () => {
    const content = `
### M0: Adventurer

**Definition:** Explore the world.
**Focus:** Travel
**2026 Theme:** Explore Mexico

### M1: Creator

**Definition:** Create content.
**Focus:** Writing and art
**2026 Theme:** Publish a book

## Mission-Goal Mapping

| Mission | Goals |
|---------|-------|
| M0 (Adventurer) | G3-G6 |
| M1 (Creator) | G7, G8 |
`;

    const missions = parseMissions(content);
    expect(missions.length).toBe(2);
    expect(missions[0].id).toBe("M0");
    expect(missions[0].name).toBe("Adventurer");
    expect(missions[0].goalIds).toEqual(["G3", "G4", "G5", "G6"]);
    expect(missions[1].id).toBe("M1");
    expect(missions[1].name).toBe("Creator");
    expect(missions[1].goalIds).toEqual(["G7", "G8"]);
  });

  it("handles missions with no goal mapping", () => {
    const content = `
### M99: Test Mission

**Definition:** A test mission.
**Focus:** Testing
**2026 Theme:** Test all the things
`;

    const missions = parseMissions(content);
    expect(missions.length).toBe(1);
    expect(missions[0].goalIds).toEqual([]);
  });

  it("expands goal ranges in mission mapping", () => {
    const content = `
### M5: TestMission

**Definition:** Test
**Focus:** Test
**2026 Theme:** Test

## Mission-Goal Mapping

| Mission | Goals |
|---------|-------|
| M5 (TestMission) | G10-G15 |
`;

    const missions = parseMissions(content);
    expect(missions[0].goalIds).toEqual(["G10", "G11", "G12", "G13", "G14", "G15"]);
  });
});

// ============================================================================
// expandGoalIds
// ============================================================================

describe("expandGoalIds", () => {
  it("expands a simple range (G3-G6)", () => {
    const result = expandGoalIds("G3-G6");
    expect(result).toEqual(["G3", "G4", "G5", "G6"]);
  });

  it("expands a range with larger numbers (G21-G24)", () => {
    const result = expandGoalIds("G21-G24");
    expect(result).toEqual(["G21", "G22", "G23", "G24"]);
  });

  it("handles a single goal ID (G5)", () => {
    const result = expandGoalIds("G5");
    expect(result).toEqual(["G5"]);
  });

  it("handles comma-separated list (G1, G21-G24)", () => {
    const result = expandGoalIds("G1, G21-G24");
    expect(result).toEqual(["G1", "G21", "G22", "G23", "G24"]);
  });

  it("handles multiple ranges (G1-G3, G10-G12)", () => {
    const result = expandGoalIds("G1-G3, G10-G12");
    expect(result).toEqual(["G1", "G2", "G3", "G10", "G11", "G12"]);
  });

  it("handles mixed single IDs and ranges (G5, G10-G12, G20)", () => {
    const result = expandGoalIds("G5, G10-G12, G20");
    expect(result).toEqual(["G5", "G10", "G11", "G12", "G20"]);
  });

  it("handles whitespace around commas and ranges", () => {
    const result = expandGoalIds("G1 , G5 - G7 , G20");
    expect(result).toEqual(["G1", "G5", "G6", "G7", "G20"]);
  });

  it("returns empty array for empty string", () => {
    const result = expandGoalIds("");
    expect(result).toEqual([]);
  });

  it("ignores invalid formats", () => {
    const result = expandGoalIds("G1, invalid, G5");
    expect(result).toEqual(["G1", "G5"]);
  });
});
