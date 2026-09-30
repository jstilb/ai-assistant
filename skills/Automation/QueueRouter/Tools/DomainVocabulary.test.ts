import { describe, test, expect } from "bun:test";
import {
  skillNameToRegex,
  matchDomainContext,
  extractDomainVocabulary,
  loadDomainVocabularyForItem,
} from "./SpecPipelineRunner.ts";
import type { QueueItem } from "./QueueManager.ts";

// ============================================================================
// skillNameToRegex
// ============================================================================

describe("skillNameToRegex", () => {
  test("1. matches camelCase, spaced, and hyphenated variants", () => {
    const re = skillNameToRegex("SpecSheet");
    expect(re.test("improve the SpecSheet inventory")).toBe(true);
    expect(re.test("fix spec sheet screen states")).toBe(true);
    expect(re.test("spec-sheet bug")).toBe(true);
  });

  test("2. respects word boundaries (no substring false-positive)", () => {
    // "EventScout" must not match inside an unrelated word run.
    const re = skillNameToRegex("EventScout");
    expect(re.test("eventscout query parsing")).toBe(true);
    expect(re.test("preventscouting heuristics")).toBe(false);
  });

  test("3. single-token skill name", () => {
    expect(skillNameToRegex("Cooking").test("the Cooking skill")).toBe(true);
  });
});

// ============================================================================
// matchDomainContext
// ============================================================================

const CANDIDATES = [
  { skill: "SpecSheet", category: "Agents", path: "/x/Agents/SpecSheet/CONTEXT.md" },
  { skill: "AutonomousWork", category: "Automation", path: "/x/Automation/AutonomousWork/CONTEXT.md" },
  { skill: "EventScout", category: "Productivity", path: "/x/Productivity/EventScout/CONTEXT.md" },
];

describe("matchDomainContext", () => {
  test("4. returns null when nothing matches", () => {
    expect(matchDomainContext("fix the telegram bot crash", CANDIDATES)).toBeNull();
  });

  test("5. matches the named skill", () => {
    const m = matchDomainContext("add a screen to SpecSheet", CANDIDATES);
    expect(m?.skill).toBe("SpecSheet");
  });

  test("6. prefers the most specific (longest) name when several match", () => {
    // Mention both — AutonomousWork is the longer/more specific name.
    const m = matchDomainContext("AutonomousWork uses SpecSheet output", CANDIDATES);
    expect(m?.skill).toBe("AutonomousWork");
  });
});

// ============================================================================
// extractDomainVocabulary
// ============================================================================

const SAMPLE_CONTEXT = `# Some Skill

Intro line.

## Language

**Order**:
A customer's request.
_Avoid_: Purchase.

## Relationships

- An **Order** produces one or more **Invoices**

## Example dialogue

> **Dev:** something

## Flagged ambiguities

- "account" resolved.
`;

describe("extractDomainVocabulary", () => {
  test("7. extracts Language + Relationships, drops dialogue/ambiguities/intro", () => {
    const v = extractDomainVocabulary(SAMPLE_CONTEXT);
    expect(v).toContain("## Language");
    expect(v).toContain("**Order**");
    expect(v).toContain("## Relationships");
    expect(v).toContain("produces one or more");
    expect(v).not.toContain("Example dialogue");
    expect(v).not.toContain("Flagged ambiguities");
    expect(v).not.toContain("Intro line");
  });

  test("8. returns empty string when neither section present", () => {
    expect(extractDomainVocabulary("# Title\n\njust prose, no sections")).toBe("");
  });

  test("9. caps length", () => {
    const big = "## Language\n" + "x".repeat(9000);
    const v = extractDomainVocabulary(big, 1000);
    expect(v.length).toBeLessThanOrEqual(1000 + 20);
    expect(v).toContain("truncated");
  });
});

// ============================================================================
// loadDomainVocabularyForItem (integration — reads the real repo)
// ============================================================================

function makeItem(title: string, notes = ""): QueueItem {
  return {
    id: "test-1",
    created: "",
    updated: "",
    source: "test",
    priority: "medium" as QueueItem["priority"],
    status: "generating-spec" as QueueItem["status"],
    type: "test",
    queue: "spec-pipeline",
    payload: { title, description: notes, context: { notes } },
  };
}

describe("loadDomainVocabularyForItem (real repo)", () => {
  test("10. SpecSheet item gets the SpecSheet glossary injected", () => {
    const out = loadDomainVocabularyForItem(makeItem("Improve SpecSheet screen inventory handling"));
    expect(out).toContain("Domain Vocabulary (canonical");
    expect(out).toContain("Agents/SpecSheet/CONTEXT.md");
    expect(out).toContain("Screen Inventory");
  });

  test("11. unrelated item gets nothing (additive — prompt unchanged)", () => {
    const out = loadDomainVocabularyForItem(makeItem("Fix Instacart checkout retry on 500"));
    expect(out).toBe("");
  });
});
