import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const SKILL_DIR = join(import.meta.dir, "..", "..");
const WORKFLOWS_DIR = join(SKILL_DIR, "Workflows");
const SKILL_MD = join(SKILL_DIR, "SKILL.md");

// ============================================
// WORKFLOW FILE EXISTENCE
// ============================================

describe("Phase 4: Workflow Files", () => {
  const EXPECTED_WORKFLOWS = [
    "ImprovGenerate.md",
    "ArchitectMonster.md",
    "ArchitectEncounter.md",
    "ArchitectHomebrew.md",
    "SessionDesigner.md",
    "WarMechanics.md",
    "WorldBuilder.md",
  ];

  test("Workflows directory exists", () => {
    expect(existsSync(WORKFLOWS_DIR)).toBe(true);
  });

  for (const workflow of EXPECTED_WORKFLOWS) {
    test(`${workflow} exists`, () => {
      const path = join(WORKFLOWS_DIR, workflow);
      expect(existsSync(path)).toBe(true);
    });
  }

  test("exactly 7 workflow files present", () => {
    const files = require("fs")
      .readdirSync(WORKFLOWS_DIR)
      .filter((f: string) => f.endsWith(".md"));
    expect(files.length).toBe(7);
  });
});

// ============================================
// WORKFLOW FILE STRUCTURE
// ============================================

describe("Phase 4: Workflow File Structure", () => {
  const EXPECTED_WORKFLOWS = [
    "ImprovGenerate.md",
    "ArchitectMonster.md",
    "ArchitectEncounter.md",
    "ArchitectHomebrew.md",
    "SessionDesigner.md",
    "WarMechanics.md",
    "WorldBuilder.md",
  ];

  for (const workflow of EXPECTED_WORKFLOWS) {
    describe(workflow, () => {
      const path = join(WORKFLOWS_DIR, workflow);
      let content: string;

      try {
        content = readFileSync(path, "utf-8");
      } catch {
        content = "";
      }

      test("has YAML frontmatter", () => {
        expect(content.startsWith("---\n")).toBe(true);
        const secondDash = content.indexOf("---", 4);
        expect(secondDash).toBeGreaterThan(4);
      });

      test("has name field in frontmatter", () => {
        const match = content.match(/^---\n([\s\S]*?)\n---/);
        expect(match).not.toBeNull();
        expect(match![1]).toContain("name:");
      });

      test("has description field in frontmatter", () => {
        const match = content.match(/^---\n([\s\S]*?)\n---/);
        expect(match).not.toBeNull();
        expect(match![1]).toContain("description:");
      });

      test("has trigger field in frontmatter", () => {
        const match = content.match(/^---\n([\s\S]*?)\n---/);
        expect(match).not.toBeNull();
        expect(match![1]).toContain("trigger:");
      });

      test("has mode field in frontmatter", () => {
        const match = content.match(/^---\n([\s\S]*?)\n---/);
        expect(match).not.toBeNull();
        expect(match![1]).toContain("mode:");
      });

      test("has 'When to Use' section", () => {
        expect(content).toContain("## When to Use");
      });

      test("has 'Steps' section or numbered steps", () => {
        expect(
          content.includes("## Steps") || content.includes("### Step 1")
        ).toBe(true);
      });

      test("has 'Example' section", () => {
        expect(content).toContain("## Example");
      });

      test("has 'Notes' section", () => {
        expect(content).toContain("## Notes");
      });

      test("references at least one tool", () => {
        const toolRefs = [
          "CRCalculator",
          "StatBlock",
          "CampaignState",
          "MonsterGenerator",
          "EncounterBalancer",
          "LootGenerator",
          "SpellForge",
          "HomebrewValidator",
          "MonsterArt",
          "MapPrompt",
          "VTTExporter",
        ];
        const hasToolRef = toolRefs.some((tool) => content.includes(tool));
        expect(hasToolRef).toBe(true);
      });
    });
  }
});

// ============================================
// WORKFLOW MODE ASSIGNMENTS
// ============================================

describe("Phase 4: Workflow Mode Assignments", () => {
  test("ImprovGenerate is mode: improv", () => {
    const content = readFileSync(
      join(WORKFLOWS_DIR, "ImprovGenerate.md"),
      "utf-8"
    );
    const frontmatter = content.match(/^---\n([\s\S]*?)\n---/)![1];
    expect(frontmatter).toContain("mode: improv");
  });

  const architectWorkflows = [
    "ArchitectMonster.md",
    "ArchitectEncounter.md",
    "ArchitectHomebrew.md",
    "SessionDesigner.md",
    "WarMechanics.md",
    "WorldBuilder.md",
  ];

  for (const workflow of architectWorkflows) {
    test(`${workflow} is mode: architect`, () => {
      const content = readFileSync(join(WORKFLOWS_DIR, workflow), "utf-8");
      const frontmatter = content.match(/^---\n([\s\S]*?)\n---/)![1];
      expect(frontmatter).toContain("mode: architect");
    });
  }
});

// ============================================
// SKILL.MD Kaya VALIDATION
// ============================================

describe("Phase 4: SKILL.md Kaya Sections", () => {
  let skillContent: string;

  try {
    skillContent = readFileSync(SKILL_MD, "utf-8");
  } catch {
    skillContent = "";
  }

  test("has YAML frontmatter with name", () => {
    expect(skillContent.startsWith("---\n")).toBe(true);
    const match = skillContent.match(/^---\n([\s\S]*?)\n---/);
    expect(match).not.toBeNull();
    expect(match![1]).toContain("name: DnD");
  });

  test("has description with USE WHEN in frontmatter", () => {
    const match = skillContent.match(/^---\n([\s\S]*?)\n---/);
    expect(match).not.toBeNull();
    expect(match![1]).toContain("description:");
    expect(match![1]).toContain("USE WHEN");
  });

  test("has version in frontmatter", () => {
    const match = skillContent.match(/^---\n([\s\S]*?)\n---/);
    expect(match).not.toBeNull();
    expect(match![1]).toContain("version:");
  });

  // Kaya Required Sections
  test("has Customization section", () => {
    expect(skillContent).toContain("## Customization");
  });

  test("has Voice Notification section", () => {
    expect(skillContent).toContain("## Voice Notification");
  });

  test("has Workflow Routing section", () => {
    expect(skillContent).toContain("## Workflow Routing");
  });

  test("has Examples section", () => {
    expect(skillContent).toContain("## Examples");
  });

  test("has Integration section", () => {
    expect(skillContent).toContain("## Integration");
  });
});

// ============================================
// SKILL.MD TOOL REFERENCES
// ============================================

describe("Phase 4: SKILL.md Tool Coverage", () => {
  let skillContent: string;

  try {
    skillContent = readFileSync(SKILL_MD, "utf-8");
  } catch {
    skillContent = "";
  }

  const ALL_TOOLS = [
    "CRCalculator",
    "StatBlock",
    "CampaignState",
    "MonsterGenerator",
    "EncounterBalancer",
    "LootGenerator",
    "SpellForge",
    "HomebrewValidator",
    "MonsterArt",
    "MapPrompt",
    "VTTExporter",
  ];

  for (const tool of ALL_TOOLS) {
    test(`references ${tool}`, () => {
      expect(skillContent).toContain(tool);
    });
  }

  test("references all 12 tools (11 named + StatBlock enhanced)", () => {
    // Each tool should appear in both the table AND the CLI reference
    for (const tool of ALL_TOOLS) {
      const count = (skillContent.match(new RegExp(tool, "g")) || []).length;
      // At minimum: once in table, once in CLI reference
      expect(count).toBeGreaterThanOrEqual(2);
    }
  });
});

// ============================================
// SKILL.MD WORKFLOW ROUTING COMPLETENESS
// ============================================

describe("Phase 4: SKILL.md Workflow Routing", () => {
  let skillContent: string;

  try {
    skillContent = readFileSync(SKILL_MD, "utf-8");
  } catch {
    skillContent = "";
  }

  const EXPECTED_WORKFLOW_REFS = [
    "Workflows/ImprovGenerate.md",
    "Workflows/ArchitectMonster.md",
    "Workflows/ArchitectEncounter.md",
    "Workflows/ArchitectHomebrew.md",
    "Workflows/SessionDesigner.md",
    "Workflows/WarMechanics.md",
    "Workflows/WorldBuilder.md",
  ];

  for (const ref of EXPECTED_WORKFLOW_REFS) {
    test(`routing table references ${ref}`, () => {
      expect(skillContent).toContain(ref);
    });
  }

  test("routing table has 7 workflow entries", () => {
    const matches = skillContent.match(/Workflows\/\w+\.md/g) || [];
    // Should find at least 7 unique workflow references
    const unique = [...new Set(matches)];
    expect(unique.length).toBe(7);
  });
});

// ============================================
// SKILL.MD INTEGRATION SECTION
// ============================================

describe("Phase 4: SKILL.md Integration", () => {
  let skillContent: string;

  try {
    skillContent = readFileSync(SKILL_MD, "utf-8");
  } catch {
    skillContent = "";
  }

  test("references Art skill for image generation", () => {
    expect(skillContent).toContain("Art skill");
  });

  test("references Inference.ts for AI content", () => {
    expect(skillContent).toContain("Inference.ts");
  });

  test("references StateManager for persistence", () => {
    expect(skillContent).toContain("StateManager");
  });

  test("references NotificationService for voice", () => {
    expect(skillContent).toContain("NotificationService");
  });

  test("references Gemini MCP for image generation", () => {
    expect(skillContent).toContain("Gemini");
  });
});

// ============================================
// SKILL.MD EXAMPLES SECTION
// ============================================

describe("Phase 4: SKILL.md Examples", () => {
  let skillContent: string;

  try {
    skillContent = readFileSync(SKILL_MD, "utf-8");
  } catch {
    skillContent = "";
  }

  test("has at least 3 improv examples", () => {
    // Count improv example blocks (they are under "### Improv Examples")
    const improvSection = skillContent.split("### Improv Examples")[1]?.split("### Architect Examples")[0] || "";
    const exampleBlocks = (improvSection.match(/```/g) || []).length / 2;
    expect(exampleBlocks).toBeGreaterThanOrEqual(3);
  });

  test("has at least 3 architect examples", () => {
    const architectSection = skillContent.split("### Architect Examples")[1]?.split("---")[0] || "";
    const exampleBlocks = (architectSection.match(/```/g) || []).length / 2;
    expect(exampleBlocks).toBeGreaterThanOrEqual(3);
  });
});

// ============================================
// CUSTOMIZATION SECTION SPECIFICS
// ============================================

describe("Phase 4: SKILL.md Customization Details", () => {
  let skillContent: string;

  try {
    skillContent = readFileSync(SKILL_MD, "utf-8");
  } catch {
    skillContent = "";
  }

  test("documents integration section", () => {
    expect(skillContent).toContain("Integration");
  });

  test("documents default CR range", () => {
    expect(skillContent).toContain("CR range");
  });

  test("documents preferred art style", () => {
    expect(skillContent).toContain("art style");
  });

  test("documents default VTT format", () => {
    expect(skillContent).toContain("VTT format");
  });

  test("documents campaign save location", () => {
    expect(skillContent).toContain("Campaign save location");
  });
});

// ============================================
// VOICE NOTIFICATION SPECIFICS
// ============================================

describe("Phase 4: SKILL.md Voice Notification", () => {
  let skillContent: string;

  try {
    skillContent = readFileSync(SKILL_MD, "utf-8");
  } catch {
    skillContent = "";
  }

  test("references notifySync", () => {
    expect(skillContent).toContain("notifySync");
  });

  test("references NotificationService path", () => {
    expect(skillContent).toContain("CORE/Tools/NotificationService.ts");
  });
});
