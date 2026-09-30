#!/usr/bin/env bun
/**
 * FreshnessClassifier.test.ts — hermetic tests for Context Integrity Program
 * Slice A2's freshness classification schema/parser.
 *
 * Covers the pure functions only (parseFreshnessDeclaration,
 * parseArtifactFreshnessRegistry, classifyArtifact) — no filesystem access,
 * no live config/artifact directories. Live-tree verification (every real
 * artifact classifies, GatheringOrchestrator still loads all 9 configs) is
 * done separately by running FreshnessClassifier.ts's main() and
 * GatheringOrchestrator's own test suite.
 *
 * Run: bun test ~/.claude/.claude/worktrees/context-integrity-20260729/skills/Productivity/InformationManager/Tools/__tests__/FreshnessClassifier.test.ts
 */
import { describe, test, expect } from "bun:test";
import {
  parseFreshnessDeclaration,
  parseArtifactFreshnessRegistry,
  classifyArtifact,
  FreshnessClassificationError,
  type SourceConfigLike,
  type FreshnessDeclaration,
  analyzeArtifactContent,
} from "./FreshnessClassifier.ts";

describe("parseFreshnessDeclaration", () => {
  test("valid timeless declaration parses", () => {
    const result = parseFreshnessDeclaration(
      { class: "timeless", reason: "durable statement of intent" },
      "USER/TELOS/MISSIONS.md",
    );
    expect(result).toEqual({ class: "timeless", reason: "durable statement of intent" });
  });

  test("valid dated-snapshot declaration parses", () => {
    const result = parseFreshnessDeclaration(
      { class: "dated-snapshot", maxAgeMs: 3600000, reason: "hourly cache" },
      "context/LucidTasksContext.md",
    );
    expect(result).toEqual({ class: "dated-snapshot", maxAgeMs: 3600000, reason: "hourly cache" });
  });

  test("valid pointer declaration parses", () => {
    const result = parseFreshnessDeclaration(
      { class: "pointer", pointsTo: "Asana", reason: "live source is Asana" },
      "USER/TELOS/PROJECTS.md",
    );
    expect(result).toEqual({ class: "pointer", pointsTo: "Asana", reason: "live source is Asana" });
  });

  test("missing value entirely throws with artifact label in the message", () => {
    expect(() => parseFreshnessDeclaration(undefined, "USER/TELOS/UNCLASSIFIED.md")).toThrow(
      FreshnessClassificationError,
    );
    try {
      parseFreshnessDeclaration(undefined, "USER/TELOS/UNCLASSIFIED.md");
      throw new Error("expected parseFreshnessDeclaration to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(FreshnessClassificationError);
      expect((error as Error).message).toContain("USER/TELOS/UNCLASSIFIED.md");
    }
  });

  test("non-object value throws", () => {
    expect(() => parseFreshnessDeclaration("1h", "lucidtasks")).toThrow(FreshnessClassificationError);
  });

  test("array value throws (arrays are typeof object but not valid declarations)", () => {
    expect(() => parseFreshnessDeclaration([], "lucidtasks")).toThrow(FreshnessClassificationError);
  });

  test("missing reason throws", () => {
    expect(() => parseFreshnessDeclaration({ class: "timeless" }, "x")).toThrow(FreshnessClassificationError);
  });

  test("empty-string reason throws", () => {
    expect(() => parseFreshnessDeclaration({ class: "timeless", reason: "   " }, "x")).toThrow(
      FreshnessClassificationError,
    );
  });

  test("unrecognised class fails loud instead of silently defaulting", () => {
    expect(() =>
      parseFreshnessDeclaration({ class: "sometimes-stale", reason: "made up class" }, "x"),
    ).toThrow(FreshnessClassificationError);
  });

  test("dated-snapshot missing maxAgeMs throws", () => {
    expect(() => parseFreshnessDeclaration({ class: "dated-snapshot", reason: "x" }, "x")).toThrow(
      FreshnessClassificationError,
    );
  });

  test("dated-snapshot with non-positive maxAgeMs throws", () => {
    expect(() =>
      parseFreshnessDeclaration({ class: "dated-snapshot", maxAgeMs: 0, reason: "x" }, "x"),
    ).toThrow(FreshnessClassificationError);
    expect(() =>
      parseFreshnessDeclaration({ class: "dated-snapshot", maxAgeMs: -5, reason: "x" }, "x"),
    ).toThrow(FreshnessClassificationError);
  });

  test("dated-snapshot with non-finite maxAgeMs throws", () => {
    expect(() =>
      parseFreshnessDeclaration({ class: "dated-snapshot", maxAgeMs: Infinity, reason: "x" }, "x"),
    ).toThrow(FreshnessClassificationError);
  });

  test("pointer missing pointsTo throws", () => {
    expect(() => parseFreshnessDeclaration({ class: "pointer", reason: "x" }, "x")).toThrow(
      FreshnessClassificationError,
    );
  });

  test("pointer with empty pointsTo throws", () => {
    expect(() =>
      parseFreshnessDeclaration({ class: "pointer", pointsTo: "", reason: "x" }, "x"),
    ).toThrow(FreshnessClassificationError);
  });
});

describe("parseArtifactFreshnessRegistry", () => {
  test("valid registry parses into a Map keyed by artifact path", () => {
    const registry = parseArtifactFreshnessRegistry({
      "USER/TELOS/MISSIONS.md": { class: "timeless", reason: "durable" },
      "USER/TELOS/STATUS.md": { class: "dated-snapshot", maxAgeMs: 43200000, reason: "6h autogen x2" },
    });
    expect(registry.size).toBe(2);
    expect(registry.get("USER/TELOS/MISSIONS.md")).toEqual({ class: "timeless", reason: "durable" });
    expect(registry.get("USER/TELOS/STATUS.md")).toEqual({
      class: "dated-snapshot",
      maxAgeMs: 43200000,
      reason: "6h autogen x2",
    });
  });

  test("non-object top-level json throws", () => {
    expect(() => parseArtifactFreshnessRegistry("not-an-object")).toThrow(FreshnessClassificationError);
    expect(() => parseArtifactFreshnessRegistry(null)).toThrow(FreshnessClassificationError);
    expect(() => parseArtifactFreshnessRegistry([])).toThrow(FreshnessClassificationError);
  });

  test("one malformed entry fails the whole load loudly, naming the artifact", () => {
    expect(() =>
      parseArtifactFreshnessRegistry({
        "USER/TELOS/MISSIONS.md": { class: "timeless", reason: "durable" },
        "USER/TELOS/BROKEN.md": { class: "not-a-real-class" },
      }),
    ).toThrow(/USER\/TELOS\/BROKEN\.md/);
  });
});

describe("classifyArtifact", () => {
  const sourceConfigs = new Map<string, SourceConfigLike>([
    [
      "lucidtasks",
      {
        source: "lucidtasks",
        output: "context/LucidTasksContext.md",
        freshness: { class: "dated-snapshot", maxAgeMs: 3600000, reason: "1h cache" },
      },
    ],
  ]);
  const registry = new Map<string, FreshnessDeclaration>([
    ["USER/TELOS/MISSIONS.md", { class: "timeless", reason: "durable mission statement" }],
  ]);

  test("resolves via a source config's `output` match", () => {
    const result = classifyArtifact("context/LucidTasksContext.md", sourceConfigs, registry);
    expect(result).toEqual({ class: "dated-snapshot", maxAgeMs: 3600000, reason: "1h cache" });
  });

  test("resolves via the artifact registry when no source config matches", () => {
    const result = classifyArtifact("USER/TELOS/MISSIONS.md", sourceConfigs, registry);
    expect(result).toEqual({ class: "timeless", reason: "durable mission statement" });
  });

  test("unclassified artifact fails loud, naming the artifact path", () => {
    expect(() => classifyArtifact("context/DoesNotExist.md", sourceConfigs, registry)).toThrow(
      FreshnessClassificationError,
    );
    try {
      classifyArtifact("context/DoesNotExist.md", sourceConfigs, registry);
      throw new Error("expected classifyArtifact to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(FreshnessClassificationError);
      expect((error as Error).message).toContain("context/DoesNotExist.md");
      expect((error as Error).message).toContain("Unclassified artifact");
    }
  });

  test("a source config whose own freshness value is malformed fails loud, not silently skipped", () => {
    const badConfigs = new Map<string, SourceConfigLike>([
      ["broken", { source: "broken", output: "context/Broken.md", freshness: { class: "not-real" } }],
    ]);
    expect(() => classifyArtifact("context/Broken.md", badConfigs, new Map())).toThrow(
      FreshnessClassificationError,
    );
  });
});

describe("analyzeArtifactContent — content beats mtime (audit 2026-09-11, FG-02 / FG-03)", () => {
  test("entries_count: 0 in frontmatter is an empty snapshot", () => {
    const a = analyzeArtifactContent("---\ntags: [x]\nentries_count: 0\n---\n\n# Calendar\n\n*Calendar data unavailable*\n");
    expect(a.emptySnapshot).toBe(true);
    expect(a.emptyTemplate).toBe(false);
  });
  test("entries_count: 12 is not an empty snapshot", () => {
    expect(analyzeArtifactContent("---\nentries_count: 12\n---\n- event\n").emptySnapshot).toBe(false);
  });
  test("an unfilled scaffold is an empty template", () => {
    const text = "# Mission\n\n### M0: [Primary Mission]\n[Your primary life mission]\n\n**Why:** [Why this matters]\n**How:** [How you pursue this]\n**Timeline:** [Ongoing / By X year]\n";
    const a = analyzeArtifactContent(text);
    expect(a.placeholderLines).toBe(4); // the "### M0: [Primary Mission]" heading is not a body line
    expect(a.emptyTemplate).toBe(true);
  });
  test("a filled file with markdown links, wikilinks, checkboxes and short tokens is not a template", () => {
    const text = "# Goals\n\nSee the [Live Snapshot](#live) and [[Wordsmith]].\n- [ ] todo\n- [x] done\nRated [D] by the review.\n**Status:** Active — period begins 2026-07-06\n";
    const a = analyzeArtifactContent(text);
    expect(a.placeholderLines).toBe(0);
    expect(a.emptyTemplate).toBe(false);
  });
  test("a long real file with one leftover [DATE] placeholder is not a template (count and share both gate)", () => {
    const lines = ["*Last Updated: [DATE]*", ...Array.from({ length: 20 }, (_, i) => `- real entry ${i}`)];
    const a = analyzeArtifactContent(lines.join("\n"));
    expect(a.placeholderLines).toBe(1);
    expect(a.emptyTemplate).toBe(false);
  });
  test("frontmatter and HTML comments are excluded from the body count", () => {
    const text = "---\nname: x\n---\n<!-- [Template comment] [Another] [Third] -->\n# Title\nreal line\n";
    const a = analyzeArtifactContent(text);
    expect(a.bodyLines).toBe(1);
    expect(a.placeholderLines).toBe(0);
  });
});
