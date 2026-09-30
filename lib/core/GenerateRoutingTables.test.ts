#!/usr/bin/env bun
/**
 * GenerateRoutingTables.test.ts - Unit + smoke tests for GenerateRoutingTables
 *
 * Tests cover:
 * - isCategoryDir detection logic
 * - scanCategorySubSkills sub-skill enumeration and trigger extraction
 * - buildSubSkillsTable markdown table generation
 * - regenerateCategorySkillMd content preservation and replacement
 * - generateAllRoutingTables full-scan with dry-run
 * - Smoke: real filesystem dry-run produces no errors
 */

import { describe, it, expect, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  isCategoryDir,
  scanCategorySubSkills,
  buildSubSkillsTable,
  regenerateCategorySkillMd,
  generateAllRoutingTables,
  generateCommandFiles,
  type SubSkillEntry,
  type CategoryResult,
} from "./GenerateRoutingTables";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(suffix: string): string {
  const dir = join(tmpdir(), `generate-routing-tables-test-${suffix}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write a minimal SKILL.md with a description containing USE WHEN triggers. */
function writeSkillMd(dir: string, description: string): void {
  const content = [
    "---",
    `description: ${description}`,
    "---",
    "",
    "# Skill",
    "",
    "Some prose.",
  ].join("\n");
  writeFileSync(join(dir, "SKILL.md"), content, "utf-8");
}

/** Write a category SKILL.md that has a ## Sub-Skills heading. */
function writeCategorySkillMd(dir: string, name: string): void {
  const content = [
    "---",
    `description: ${name} category. USE WHEN ${name.toLowerCase()}.`,
    "---",
    "",
    `# ${name}`,
    "",
    "Category prose.",
    "",
    "## Sub-Skills",
    "",
    "| Sub-Skill | Triggers | Load |",
    "|-----------|----------|------|",
    "| **OldSkill** | old | `OldSkill/SKILL.md` |",
    "",
    "## Workflow Routing",
    "",
    "old boilerplate",
    "",
    "## Voice Notification",
    "",
    "old boilerplate",
  ].join("\n");
  writeFileSync(join(dir, "SKILL.md"), content, "utf-8");
}

// ---------------------------------------------------------------------------
// isCategoryDir
// ---------------------------------------------------------------------------

describe("isCategoryDir", () => {
  const tmpDir = makeTmpDir("is-category");

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns true when dir has SKILL.md and at least one sub-dir with SKILL.md", () => {
    const catDir = join(tmpDir, "ValidCategory");
    const subDir = join(catDir, "SubSkill");
    mkdirSync(subDir, { recursive: true });
    writeSkillMd(catDir, "Category. USE WHEN cat.");
    writeSkillMd(subDir, "Sub. USE WHEN sub.");

    expect(isCategoryDir(catDir)).toBe(true);
  });

  it("returns false when dir has SKILL.md but no sub-skill SKILL.md", () => {
    const catDir = join(tmpDir, "NoSubSkills");
    const subDir = join(catDir, "EmptySubDir");
    mkdirSync(subDir, { recursive: true });
    writeSkillMd(catDir, "Category. USE WHEN cat.");
    // subDir intentionally has no SKILL.md

    expect(isCategoryDir(catDir)).toBe(false);
  });

  it("returns false when dir has no SKILL.md at category level", () => {
    const catDir = join(tmpDir, "NoTopLevelSkillMd");
    const subDir = join(catDir, "SubSkill");
    mkdirSync(subDir, { recursive: true });
    writeSkillMd(subDir, "Sub. USE WHEN sub.");
    // catDir intentionally has no SKILL.md

    expect(isCategoryDir(catDir)).toBe(false);
  });

  it("returns false for a nonexistent directory", () => {
    expect(isCategoryDir(join(tmpDir, "DoesNotExist"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// scanCategorySubSkills
// ---------------------------------------------------------------------------

describe("scanCategorySubSkills", () => {
  const tmpDir = makeTmpDir("scan-sub-skills");

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns correct entries with names, triggers, and paths for 2 sub-skills", () => {
    const skillsDir = join(tmpDir, "skills-a");
    const catDir = join(skillsDir, "Intelligence");
    const researchDir = join(catDir, "Research");
    const analysisDir = join(catDir, "Analysis");

    mkdirSync(researchDir, { recursive: true });
    mkdirSync(analysisDir, { recursive: true });
    writeSkillMd(catDir, "Intelligence category. USE WHEN intelligence.");
    writeSkillMd(researchDir, "Research sub-skill. USE WHEN research, investigate, deep dive.");
    writeSkillMd(analysisDir, "Analysis sub-skill. USE WHEN analyze, breakdown.");

    const entries = scanCategorySubSkills("Intelligence", skillsDir);

    expect(entries).toHaveLength(2);

    // Results are sorted alphabetically — Analysis before Research
    expect(entries[0].name).toBe("Analysis");
    expect(entries[0].triggers).toEqual(["analyze", "breakdown"]);
    expect(entries[0].path).toBe("Intelligence/Analysis/SKILL.md");

    expect(entries[1].name).toBe("Research");
    expect(entries[1].triggers).toEqual(["research", "investigate", "deep dive"]);
    expect(entries[1].path).toBe("Intelligence/Research/SKILL.md");
  });

  it("falls back to lowercased name when sub-skill has no USE WHEN clause", () => {
    const skillsDir = join(tmpDir, "skills-b");
    const catDir = join(skillsDir, "Tools");
    const toolDir = join(catDir, "HammerTool");

    mkdirSync(toolDir, { recursive: true });
    writeSkillMd(catDir, "Tools category. USE WHEN tools.");
    // Description without USE WHEN
    writeFileSync(
      join(toolDir, "SKILL.md"),
      "---\ndescription: Just a hammer tool.\n---\n# HammerTool\n",
      "utf-8"
    );

    const entries = scanCategorySubSkills("Tools", skillsDir);

    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("HammerTool");
    expect(entries[0].triggers).toEqual(["hammertool"]);
    expect(entries[0].path).toBe("Tools/HammerTool/SKILL.md");
  });

  it("returns empty array for nonexistent category", () => {
    const entries = scanCategorySubSkills("DoesNotExist", join(tmpDir, "skills-c"));
    expect(entries).toEqual([]);
  });

  it("skips sub-directories without SKILL.md", () => {
    const skillsDir = join(tmpDir, "skills-d");
    const catDir = join(skillsDir, "Mixed");
    const withSkill = join(catDir, "HasSkill");
    const withoutSkill = join(catDir, "NoSkill");

    mkdirSync(withSkill, { recursive: true });
    mkdirSync(withoutSkill, { recursive: true });
    writeSkillMd(catDir, "Mixed. USE WHEN mixed.");
    writeSkillMd(withSkill, "HasSkill. USE WHEN hasskill.");
    // withoutSkill intentionally has no SKILL.md

    const entries = scanCategorySubSkills("Mixed", skillsDir);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("HasSkill");
  });
});

// ---------------------------------------------------------------------------
// buildSubSkillsTable
// ---------------------------------------------------------------------------

describe("buildSubSkillsTable", () => {
  it("produces correct markdown table with heading, separator, and data rows", () => {
    const subSkills: SubSkillEntry[] = [
      { name: "Alpha", triggers: ["alpha", "first"], path: "Cat/Alpha/SKILL.md", description: "Alpha skill" },
      { name: "Beta", triggers: ["beta"], path: "Cat/Beta/SKILL.md", description: "Beta skill" },
    ];

    const table = buildSubSkillsTable("Cat", subSkills);

    expect(table).toContain("## Sub-Skills");
    expect(table).toContain("| Sub-Skill | Triggers | Load |");
    expect(table).toContain("|-----------|----------|------|");
    expect(table).toContain("| **Alpha** | alpha, first | `Cat/Alpha/SKILL.md` |");
    expect(table).toContain("| **Beta** | beta | `Cat/Beta/SKILL.md` |");
  });

  it("respects alphabetical order when entries are already sorted", () => {
    const subSkills: SubSkillEntry[] = [
      { name: "Aardvark", triggers: ["aardvark"], path: "Cat/Aardvark/SKILL.md", description: "" },
      { name: "Zebra", triggers: ["zebra"], path: "Cat/Zebra/SKILL.md", description: "" },
    ];

    const table = buildSubSkillsTable("Cat", subSkills);
    const aardvarkPos = table.indexOf("Aardvark");
    const zebraPos = table.indexOf("Zebra");
    expect(aardvarkPos).toBeLessThan(zebraPos);
  });

  it("handles a single sub-skill with multiple triggers", () => {
    const subSkills: SubSkillEntry[] = [
      { name: "Research", triggers: ["research", "investigate", "deep dive"], path: "Int/Research/SKILL.md", description: "" },
    ];

    const table = buildSubSkillsTable("Int", subSkills);
    expect(table).toContain("research, investigate, deep dive");
  });
});

// ---------------------------------------------------------------------------
// regenerateCategorySkillMd
// ---------------------------------------------------------------------------

describe("regenerateCategorySkillMd", () => {
  const existingContent = [
    "---",
    "description: Intelligence category. USE WHEN intelligence.",
    "---",
    "",
    "# Intelligence",
    "",
    "Category prose that should be preserved.",
    "",
    "## Sub-Skills",
    "",
    "| Sub-Skill | Triggers | Load |",
    "|-----------|----------|------|",
    "| **OldSkill** | old | `Intelligence/OldSkill/SKILL.md` |",
    "",
    "## Workflow Routing",
    "",
    "Old workflow routing content.",
    "",
    "## Voice Notification",
    "",
    "Old voice notification content.",
  ].join("\n");

  const subSkills: SubSkillEntry[] = [
    { name: "NewSkill", triggers: ["newskill", "fresh"], path: "Intelligence/NewSkill/SKILL.md", description: "" },
  ];

  it("preserves frontmatter and prose above ## Sub-Skills", () => {
    const result = regenerateCategorySkillMd(existingContent, "Intelligence", subSkills);

    expect(result).toContain("---");
    expect(result).toContain("description: Intelligence category. USE WHEN intelligence.");
    expect(result).toContain("# Intelligence");
    expect(result).toContain("Category prose that should be preserved.");
  });

  it("replaces the Sub-Skills table with fresh content", () => {
    const result = regenerateCategorySkillMd(existingContent, "Intelligence", subSkills);

    expect(result).not.toContain("OldSkill");
    expect(result).toContain("| **NewSkill** | newskill, fresh | `Intelligence/NewSkill/SKILL.md` |");
  });

  it("regenerates Workflow Routing boilerplate section", () => {
    const result = regenerateCategorySkillMd(existingContent, "Intelligence", subSkills);

    expect(result).toContain("## Workflow Routing");
    expect(result).toContain("Read the sub-skill's SKILL.md for its full routing");
    expect(result).not.toContain("Old workflow routing content.");
  });

  it("regenerates Voice Notification boilerplate section", () => {
    const result = regenerateCategorySkillMd(existingContent, "Intelligence", subSkills);

    expect(result).toContain("## Voice Notification");
    expect(result).toContain("notifySync()");
    expect(result).not.toContain("Old voice notification content.");
  });

  it("returns original content unchanged when ## Sub-Skills heading is absent", () => {
    const contentWithoutHeading = [
      "---",
      "description: No heading here. USE WHEN nothing.",
      "---",
      "",
      "# JustProse",
      "",
      "This file has no Sub-Skills heading.",
    ].join("\n");

    const result = regenerateCategorySkillMd(contentWithoutHeading, "JustProse", subSkills);

    expect(result).toBe(contentWithoutHeading);
  });
});

// ---------------------------------------------------------------------------
// generateAllRoutingTables
// ---------------------------------------------------------------------------

describe("generateAllRoutingTables", () => {
  const tmpDir = makeTmpDir("generate-all");

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("finds 2 categories, 4 sub-skills total, 0 errors, skips non-category dir", () => {
    const skillsDir = join(tmpDir, "skills");

    // Category 1: Automation
    const autoDir = join(skillsDir, "Automation");
    const autoSub1 = join(autoDir, "Queue");
    const autoSub2 = join(autoDir, "Scheduler");
    mkdirSync(autoSub1, { recursive: true });
    mkdirSync(autoSub2, { recursive: true });
    writeCategorySkillMd(autoDir, "Automation");
    writeSkillMd(autoSub1, "Queue management. USE WHEN queue, manage queue.");
    writeSkillMd(autoSub2, "Scheduling tasks. USE WHEN schedule, cron.");

    // Category 2: Intelligence
    const intelDir = join(skillsDir, "Intelligence");
    const intelSub1 = join(intelDir, "Research");
    const intelSub2 = join(intelDir, "Analysis");
    mkdirSync(intelSub1, { recursive: true });
    mkdirSync(intelSub2, { recursive: true });
    writeCategorySkillMd(intelDir, "Intelligence");
    writeSkillMd(intelSub1, "Research tasks. USE WHEN research, investigate.");
    writeSkillMd(intelSub2, "Analysis tasks. USE WHEN analyze, breakdown.");

    // Non-category dir: no sub-skills with SKILL.md
    const utilsDir = join(skillsDir, "Utils");
    const utilsSub = join(utilsDir, "Helper");
    mkdirSync(utilsSub, { recursive: true });
    // No SKILL.md in utilsDir, so not a valid category
    // (also no SKILL.md in utilsSub for category detection)
    writeSkillMd(utilsSub, "Helper utility. USE WHEN help.");
    // utilsDir lacks its own SKILL.md — not a category

    const result = generateAllRoutingTables({ skillsDir, dryRun: true, commands: false });

    expect(result.errors).toHaveLength(0);
    expect(result.categories).toHaveLength(2);
    expect(result.totalSubSkills).toBe(4);

    const categoryNames = result.categories.map((c) => c.category).sort();
    expect(categoryNames).toEqual(["Automation", "Intelligence"]);

    // All categories processed (not skipped) since dryRun=true
    for (const cat of result.categories) {
      expect(cat.skipped).toBe(false);
      expect(cat.written).toBe(false); // dryRun — no files written
      expect(cat.subSkills).toHaveLength(2);
    }
  });
});

// ---------------------------------------------------------------------------
// generateCommandFiles
// ---------------------------------------------------------------------------

describe("generateCommandFiles", () => {
  const tmpDir = makeTmpDir("generate-commands");
  const commandsDir = join(tmpDir, "Commands");

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("generates command files for sub-skills", () => {
    mkdirSync(commandsDir, { recursive: true });

    const categories: CategoryResult[] = [
      {
        category: "Intelligence",
        subSkills: [
          { name: "Research", triggers: ["research"], path: "Intelligence/Research/SKILL.md", description: "Research skill. USE WHEN research." },
          { name: "Analysis", triggers: ["analyze"], path: "Intelligence/Analysis/SKILL.md", description: "Analysis skill. USE WHEN analyze." },
        ],
        written: true,
        skipped: false,
      },
    ];

    const results = generateCommandFiles(categories, commandsDir, false);

    expect(results).toHaveLength(2);
    expect(results[0].name).toBe("research");
    expect(results[0].written).toBe(true);
    expect(results[0].skipped).toBe(false);
    expect(results[1].name).toBe("analysis");
    expect(results[1].written).toBe(true);

    // Verify file content
    const content = readFileSync(join(commandsDir, "research.md"), "utf-8");
    expect(content).toContain("auto-generated by GenerateRoutingTables");
    expect(content).toContain("Intelligence/Research/SKILL.md");
    expect(content).toContain("/research");
  });

  it("skips hand-written command files", () => {
    const handWrittenDir = join(tmpDir, "Commands-handwritten");
    mkdirSync(handWrittenDir, { recursive: true });

    // Write a hand-written command (no marker)
    writeFileSync(
      join(handWrittenDir, "research.md"),
      "# /research\nHand-written command.\n",
      "utf-8"
    );

    const categories: CategoryResult[] = [
      {
        category: "Intelligence",
        subSkills: [
          { name: "Research", triggers: ["research"], path: "Intelligence/Research/SKILL.md", description: "Research skill." },
        ],
        written: true,
        skipped: false,
      },
    ];

    const results = generateCommandFiles(categories, handWrittenDir, false);

    expect(results).toHaveLength(1);
    expect(results[0].skipped).toBe(true);
    expect(results[0].reason).toBe("Hand-written command exists");

    // Verify original content preserved
    const content = readFileSync(join(handWrittenDir, "research.md"), "utf-8");
    expect(content).toContain("Hand-written command");
  });

  it("overwrites previously auto-generated commands", () => {
    const overwriteDir = join(tmpDir, "Commands-overwrite");
    mkdirSync(overwriteDir, { recursive: true });

    // Write an auto-generated command (with marker)
    writeFileSync(
      join(overwriteDir, "research.md"),
      "<!-- auto-generated by GenerateRoutingTables -->\n# Old content\n",
      "utf-8"
    );

    const categories: CategoryResult[] = [
      {
        category: "Intelligence",
        subSkills: [
          { name: "Research", triggers: ["research"], path: "Intelligence/Research/SKILL.md", description: "Research skill." },
        ],
        written: true,
        skipped: false,
      },
    ];

    const results = generateCommandFiles(categories, overwriteDir, false);

    expect(results).toHaveLength(1);
    expect(results[0].written).toBe(true);
    expect(results[0].skipped).toBe(false);

    const content = readFileSync(join(overwriteDir, "research.md"), "utf-8");
    expect(content).not.toContain("Old content");
    expect(content).toContain("Intelligence/Research/SKILL.md");
  });

  it("skips categories that were skipped", () => {
    const categories: CategoryResult[] = [
      {
        category: "Empty",
        subSkills: [],
        written: false,
        skipped: true,
        reason: "No sub-skills",
      },
    ];

    const results = generateCommandFiles(categories, commandsDir, false);
    expect(results).toHaveLength(0);
  });

  it("respects dry-run mode", () => {
    const dryDir = join(tmpDir, "Commands-dry");
    mkdirSync(dryDir, { recursive: true });

    const categories: CategoryResult[] = [
      {
        category: "Life",
        subSkills: [
          { name: "Cooking", triggers: ["cooking"], path: "Life/Cooking/SKILL.md", description: "Cooking skill." },
        ],
        written: true,
        skipped: false,
      },
    ];

    const results = generateCommandFiles(categories, dryDir, true);

    expect(results).toHaveLength(1);
    expect(results[0].written).toBe(false);
    expect(results[0].skipped).toBe(false);
    expect(existsSync(join(dryDir, "cooking.md"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Smoke: real filesystem
// ---------------------------------------------------------------------------

describe("Smoke: real filesystem", () => {
  it("dry-run on real skills dir produces no errors", () => {
    const result = generateAllRoutingTables({ dryRun: true });
    expect(result.errors).toHaveLength(0);
    expect(result.totalSubSkills).toBeGreaterThan(40);
    expect(result.categories.length).toBeGreaterThanOrEqual(10);
  });

  it("dry-run generates command entries for sub-skills", () => {
    const result = generateAllRoutingTables({ dryRun: true });
    expect(result.commands.length).toBeGreaterThan(40);
    // All should be not-written (dry run)
    for (const cmd of result.commands) {
      expect(cmd.written).toBe(false);
    }
  });
});
