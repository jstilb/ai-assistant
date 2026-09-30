/**
 * SkillCategorizer.test.ts — Unit tests for SkillCategorizer's ground-truth categorization.
 *
 * Fable-audit batch5 (2026-07-17): SkillCategorizer.categorizeSkill() used to guess a skill's
 * Meta/Orchestration/Specialized bucket by keyword-matching over its description/trigger text —
 * content interpretation the dedeterminization doctrine forbids once ground truth exists. The
 * 2026-03-03 skill-category reorg made the skill's parent directory (skills/<Category>/<Skill>/)
 * an objective, on-disk fact; categorizeSkill() now reads that instead of guessing.
 *
 * These tests assert (1) the ground-truth category is read correctly for a real skill on disk
 * (this very skill: skills/Content/SystemFlowchart -> category "Content"), and (2) the bucket
 * decision is driven solely by that ground-truth category, not by description/trigger keywords.
 */

import { describe, test, expect } from "bun:test";
import { scanSkills, type SkillInfo } from "./SystemScanner.ts";
import { categorizeSkill } from "./SkillCategorizer.ts";

function makeSkill(overrides: Partial<SkillInfo>): SkillInfo {
  return {
    name: "TestSkill",
    directory: "TestSkill",
    category: "",
    description: "",
    triggers: [],
    workflows: [],
    tools: [],
    dependencies: [],
    isPrivate: false,
    hasTools: false,
    workflowCount: 0,
    ...overrides,
  };
}

describe("SystemScanner.scanSkills — ground-truth category", () => {
  test("skills/Content/SystemFlowchart scans with category 'Content'", async () => {
    const skills = await scanSkills();
    const self = skills.find((s) => s.name === "SystemFlowchart");
    expect(self).toBeDefined();
    expect(self?.category).toBe("Content");
  });
});

describe("SkillCategorizer.categorizeSkill — ground-truth bucket mapping", () => {
  test("category 'System' maps to bucket 'Meta'", () => {
    const { bucket } = categorizeSkill(makeSkill({ category: "System" }));
    expect(bucket).toBe("Meta");
  });

  test("category 'Agents' maps to bucket 'Orchestration'", () => {
    const { bucket } = categorizeSkill(makeSkill({ category: "Agents" }));
    expect(bucket).toBe("Orchestration");
  });

  test("category 'Automation' maps to bucket 'Orchestration'", () => {
    const { bucket } = categorizeSkill(makeSkill({ category: "Automation" }));
    expect(bucket).toBe("Orchestration");
  });

  test("an unmapped category (e.g. 'Content') defaults to bucket 'Specialized'", () => {
    const { bucket } = categorizeSkill(makeSkill({ category: "Content" }));
    expect(bucket).toBe("Specialized");
  });

  test("empty category (no parent dir) defaults to bucket 'Specialized'", () => {
    const { bucket, reason } = categorizeSkill(makeSkill({ category: "" }));
    expect(bucket).toBe("Specialized");
    expect(reason).toContain("No parent category directory found");
  });

  test("description/trigger keywords no longer influence the bucket (delete-the-heuristic check)", () => {
    // Under the old heuristic, 2+ hits from ["system","skill","audit","architecture",
    // "flowchart","sync",...] in name/description/triggers would have forced bucket "Meta"
    // regardless of the skill's real category. Ground truth must win instead.
    const loadedWithMetaKeywords = makeSkill({
      category: "Content",
      name: "SystemFlowchart",
      description:
        "Kaya system architecture visualization. USE WHEN system audit, skill sync, architecture flowchart.",
      triggers: ["system diagram", "skill audit", "architecture sync"],
    });
    const { bucket, reason } = categorizeSkill(loadedWithMetaKeywords);
    expect(bucket).toBe("Specialized");
    expect(reason).toBe("Parent directory category: Content");
  });

  test("an Orchestration-sounding name/description with a Specialized category is not reclassified", () => {
    const orchestrationSoundingButSpecialized = makeSkill({
      category: "Life",
      name: "AutonomousAdventurePlanner",
      description: "USE WHEN autonomous agent orchestration workflow queue schedule coordinate.",
      triggers: ["orchestrate", "spawn agents", "parallel workflow"],
    });
    const { bucket } = categorizeSkill(orchestrationSoundingButSpecialized);
    expect(bucket).toBe("Specialized");
  });
});
