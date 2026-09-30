/**
 * AutoMemoryConsolidator.test.ts — Context Integrity Program, Slice E2.
 *
 * Hermetic: every git-touching test operates on a fresh mkdtemp'd directory
 * (never ~/.kaya/memory), matching the assertNotLiveAutoMemoryDirUnderTest()
 * guard the tool itself enforces. No test calls the real `inference()` — all
 * LLM-judgment paths are exercised via an injected fake InferenceFn, so this
 * suite costs zero tokens and is fully deterministic.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { InferenceResult } from "./Inference.ts";
import {
  DEFAULT_THRESHOLD_BYTES,
  INDEX_FILENAME,
  parseMemoryFile,
  renderMemoryFile,
  requestSplitPlan,
  buildOutputFrontmatter,
  buildOutputFiles,
  verifySplitPreservesContent,
  updateMemoryIndex,
  writeAndVerifySplit,
  listCandidateFiles,
  findOversizedFiles,
  consolidateFile,
  type MemoryFrontmatter,
  type MemoryBlock,
  type SplitPlan,
  type PlannedOutputFile,
  type GitFn,
} from "./AutoMemoryConsolidator.ts";

// ============================================================================
// Fixtures
// ============================================================================

const SMALL_FIXTURE = `---
name: fixture-small
description: "A small test fixture"
metadata:
  node_type: memory
  type: project
  originSessionId: aaaa1111-0000-0000-0000-000000000000
---

## Overview section

Some overview prose with no date. [[some_wikilink]]

---

### 2026-01-02: first dated finding

Root cause was X. **NEEDS JM**: approve the migration.

---

### 2026-03-15: second dated finding

Fixed by Y. Related: [[other_link]].

---

### Undated followup note

No date here, just a note.
`;

function fakeInferenceFn(response: unknown): (opts: unknown) => Promise<InferenceResult> {
  return async () =>
    ({
      success: true,
      output: JSON.stringify(response),
      parsed: response,
      latencyMs: 1,
      level: "standard",
      estimatedTokens: { input: 0, output: 0, total: 0 },
      estimatedCostUSD: 0,
    }) as InferenceResult;
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "auto-memory-consolidator-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function initGitRepo(dir: string): void {
  git(["init", "-q"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "Test"], dir);
}

// ============================================================================
// Parsing
// ============================================================================

describe("parseMemoryFile", () => {
  it("parses frontmatter and blocks in order", () => {
    const parsed = parseMemoryFile(SMALL_FIXTURE, "fixture");
    expect(parsed.frontmatter.name).toBe("fixture-small");
    expect(parsed.frontmatter.description).toBe("A small test fixture");
    expect(parsed.frontmatter.metadata.type).toBe("project");
    expect(parsed.blocks.length).toBe(4);
    expect(parsed.blocks[0].headingTitle).toBe("Overview section");
    expect(parsed.blocks[1].headingTitle).toBe("2026-01-02: first dated finding");
    expect(parsed.blocks[3].headingTitle).toBe("Undated followup note");
  });

  it("detects dated blocks correctly", () => {
    const parsed = parseMemoryFile(SMALL_FIXTURE, "fixture");
    expect(parsed.blocks[0].hasDate).toBe(false);
    expect(parsed.blocks[1].hasDate).toBe(true);
    expect(parsed.blocks[1].dates).toEqual(["2026-01-02"]);
    expect(parsed.blocks[2].hasDate).toBe(true);
    expect(parsed.blocks[2].dates).toEqual(["2026-03-15"]);
    expect(parsed.blocks[3].hasDate).toBe(false);
  });

  it("detects NEEDS JM markers", () => {
    const parsed = parseMemoryFile(SMALL_FIXTURE, "fixture");
    expect(parsed.blocks[1].needsJmMarkers).toEqual(["NEEDS JM"]);
    expect(parsed.blocks[0].needsJmMarkers).toEqual([]);
  });

  it("does not flag title-case 'Needs Jm' prose as a marker (only ALL-CAPS)", () => {
    const raw = `---
name: x
description: "d"
metadata:
  node_type: memory
  type: project
---

### A section

Escalations land in the "Kaya — Needs Jm" project, per Needs-Jm: convention.
`;
    const parsed = parseMemoryFile(raw, "fixture");
    expect(parsed.blocks[0].needsJmMarkers).toEqual([]);
  });

  it("detects wikilinks", () => {
    const parsed = parseMemoryFile(SMALL_FIXTURE, "fixture");
    expect(parsed.blocks[0].wikilinks).toEqual(["some_wikilink"]);
    expect(parsed.blocks[2].wikilinks).toEqual(["other_link"]);
  });

  it("throws loudly when frontmatter is missing", () => {
    expect(() => parseMemoryFile("# Just a heading\n\nNo frontmatter.\n", "no-fm")).toThrow(/no YAML frontmatter/);
  });

  it("throws loudly when frontmatter fails schema validation", () => {
    const raw = `---
description: "missing name field"
metadata:
  type: project
---

body
`;
    expect(() => parseMemoryFile(raw, "bad-fm")).toThrow(/schema validation/);
  });
});

describe("renderMemoryFile / parseMemoryFile round-trip", () => {
  it("reconstructs byte-identical content for an unmodified block set", () => {
    const parsed = parseMemoryFile(SMALL_FIXTURE, "fixture");
    const rendered = renderMemoryFile(parsed.frontmatter, parsed.blocks);
    // Re-parse the rendered output — its blocks must be byte-identical to
    // the originals (this is the same invariant the production guard checks).
    const reparsed = parseMemoryFile(rendered, "rendered");
    expect(reparsed.blocks.map((b) => b.raw)).toEqual(parsed.blocks.map((b) => b.raw));
  });
});

// ============================================================================
// Size / threshold math
// ============================================================================

describe("findOversizedFiles / listCandidateFiles", () => {
  it("excludes MEMORY.md and flags only files over threshold", () => {
    writeFileSync(join(tmpDir, INDEX_FILENAME), "x".repeat(50_000));
    writeFileSync(join(tmpDir, "project_small.md"), "x".repeat(100));
    writeFileSync(join(tmpDir, "project_big.md"), "x".repeat(30_000));

    const candidates = listCandidateFiles(tmpDir);
    expect(candidates).toEqual(["project_big.md", "project_small.md"]);

    const oversized = findOversizedFiles(tmpDir, DEFAULT_THRESHOLD_BYTES);
    expect(oversized).toEqual([{ filename: "project_big.md", sizeBytes: 30_000 }]);
  });

  it("respects a custom threshold", () => {
    writeFileSync(join(tmpDir, "project_a.md"), "x".repeat(5_000));
    writeFileSync(join(tmpDir, "project_b.md"), "x".repeat(15_000));
    const oversized = findOversizedFiles(tmpDir, 10_000);
    expect(oversized.map((f) => f.filename)).toEqual(["project_b.md"]);
  });
});

// ============================================================================
// Split plan validation (business rules the LLM's JSON must satisfy)
// ============================================================================

describe("requestSplitPlan", () => {
  const frontmatter: MemoryFrontmatter = {
    name: "fixture-small",
    description: "d",
    metadata: { node_type: "memory", type: "project" },
  };
  const blocks: MemoryBlock[] = parseMemoryFile(SMALL_FIXTURE, "fixture").blocks;

  it("accepts a valid split plan covering every index exactly once", async () => {
    const plan = await requestSplitPlan({
      originalFilename: "project_fixture.md",
      frontmatter,
      blocks,
      existingFilenames: [],
      inferenceFn: fakeInferenceFn({
        action: "split",
        files: [
          { filename: "project_fixture_overview.md", description: "overview", blockIndices: [0, 3] },
          { filename: "project_fixture_findings.md", description: "findings", blockIndices: [1, 2] },
        ],
        conflictNotes: [],
      }),
    });
    expect(plan.action).toBe("split");
    if (plan.action === "split") {
      expect(plan.files.length).toBe(2);
    }
  });

  it("passes through a flag_for_human verdict without validating indices", async () => {
    const plan = await requestSplitPlan({
      originalFilename: "project_fixture.md",
      frontmatter,
      blocks,
      existingFilenames: [],
      inferenceFn: fakeInferenceFn({ action: "flag_for_human", reason: "sections are too interdependent" }),
    });
    expect(plan).toEqual({ action: "flag_for_human", reason: "sections are too interdependent" });
  });

  it("retries once on a plan that drops a block index, then throws if still invalid", async () => {
    let calls = 0;
    const inferenceFn = async (): Promise<InferenceResult> => {
      calls++;
      // Every attempt drops index 3 — always invalid.
      const response = {
        action: "split",
        files: [
          { filename: "project_fixture_a.md", description: "a", blockIndices: [0] },
          { filename: "project_fixture_b.md", description: "b", blockIndices: [1, 2] },
        ],
      };
      return {
        success: true,
        output: JSON.stringify(response),
        parsed: response,
        latencyMs: 1,
        level: "standard",
        estimatedTokens: { input: 0, output: 0, total: 0 },
        estimatedCostUSD: 0,
      };
    };

    await expect(
      requestSplitPlan({
        originalFilename: "project_fixture.md",
        frontmatter,
        blocks,
        existingFilenames: [],
        inferenceFn,
      }),
    ).rejects.toThrow(/not been assigned|indices \[3\]/);
    expect(calls).toBe(2); // exactly one retry, then a loud failure — never a silent default
  });

  it("rejects a plan whose new filename collides with an existing file", async () => {
    await expect(
      requestSplitPlan({
        originalFilename: "project_fixture.md",
        frontmatter,
        blocks,
        existingFilenames: ["project_taken.md"],
        inferenceFn: fakeInferenceFn({
          action: "split",
          files: [
            { filename: "project_taken.md", description: "a", blockIndices: [0, 1] },
            { filename: "project_fixture_b.md", description: "b", blockIndices: [2, 3] },
          ],
        }),
      }),
    ).rejects.toThrow(/collides with an existing file/);
  });
});

// ============================================================================
// Output construction
// ============================================================================

describe("buildOutputFrontmatter", () => {
  it("preserves metadata.type and originSessionId, defaults node_type", () => {
    const original: MemoryFrontmatter = {
      name: "project-fixture",
      description: "d",
      metadata: { type: "feedback", originSessionId: "sess-123" },
    };
    const fm = buildOutputFrontmatter("project_fixture_part1.md", "new description", original, "project_fixture.md");
    expect(fm.name).toBe("project_fixture_part1");
    expect(fm.description).toBe("new description");
    expect(fm.metadata.type).toBe("feedback");
    expect(fm.metadata.node_type).toBe("memory");
    expect(fm.metadata.originSessionId).toBe("sess-123");
    expect(fm.metadata.splitFrom).toBe("project_fixture.md");
    expect(typeof fm.metadata.modified).toBe("string");
  });
});

describe("buildOutputFiles", () => {
  it("orders blocks by original index regardless of plan order, and copies text verbatim", () => {
    const parsed = parseMemoryFile(SMALL_FIXTURE, "fixture");
    const plan: Extract<SplitPlan, { action: "split" }> = {
      action: "split",
      files: [
        // blockIndices given out of order on purpose — construction must sort them.
        { filename: "project_fixture_a.md", description: "a", blockIndices: [3, 0] },
      ],
      conflictNotes: [],
    };
    const outputs = buildOutputFiles("project_fixture.md", parsed.frontmatter, parsed.blocks, plan);
    const reparsed = parseMemoryFile(outputs[0].raw, outputs[0].filename);
    expect(reparsed.blocks.map((b) => b.raw)).toEqual([parsed.blocks[0].raw, parsed.blocks[3].raw]);
  });
});

// ============================================================================
// The core guard: verifySplitPreservesContent
// ============================================================================

describe("verifySplitPreservesContent", () => {
  function validSplit(): PlannedOutputFile[] {
    const parsed = parseMemoryFile(SMALL_FIXTURE, "fixture");
    const planA: Extract<SplitPlan, { action: "split" }> = {
      action: "split",
      files: [{ filename: "project_fixture_a.md", description: "a", blockIndices: [0, 1] }],
      conflictNotes: [],
    };
    const planB: Extract<SplitPlan, { action: "split" }> = {
      action: "split",
      files: [{ filename: "project_fixture_b.md", description: "b", blockIndices: [2, 3] }],
      conflictNotes: [],
    };
    return [
      ...buildOutputFiles("project_fixture.md", parsed.frontmatter, parsed.blocks, planA),
      ...buildOutputFiles("project_fixture.md", parsed.frontmatter, parsed.blocks, planB),
    ];
  }

  it("passes (ok:true) on a correct, lossless split and enumerates dated findings", () => {
    const outputs = validSplit();
    const result = verifySplitPreservesContent(
      SMALL_FIXTURE,
      "fixture",
      outputs.map((o) => ({ filename: o.filename, raw: o.raw })),
    );
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.datedFindingsBefore.length).toBe(2);
    expect(result.datedFindingsAfter.length).toBe(2);
    expect(result.datedFindingsBefore.map((f) => f.dates)).toEqual([["2026-01-02"], ["2026-03-15"]]);
    expect(result.needsJmMarkersBefore).toEqual(["NEEDS JM"]);
    expect(result.needsJmMarkersAfter).toEqual(["NEEDS JM"]);
  });

  it("FAILS LOUD when a dated block containing a NEEDS JM marker is dropped", () => {
    const outputs = validSplit();
    // Deliberately drop the output file containing block 1 (the dated
    // finding with the NEEDS JM marker) — simulates the exact failure mode
    // the guard exists to catch.
    const lossy = outputs.filter((o) => o.filename !== "project_fixture_a.md");
    const result = verifySplitPreservesContent(
      SMALL_FIXTURE,
      "fixture",
      lossy.map((o) => ({ filename: o.filename, raw: o.raw })),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("MISSING"))).toBe(true);
    expect(result.errors.some((e) => e.includes("NEEDS JM marker"))).toBe(true);
    // The dropped dated finding must NOT appear in "after".
    expect(result.datedFindingsAfter.some((f) => f.dates.includes("2026-01-02"))).toBe(false);
  });

  it("FAILS LOUD when a block is duplicated across two outputs", () => {
    const outputs = validSplit();
    const duplicated = [...outputs, outputs[0]];
    const result = verifySplitPreservesContent(
      SMALL_FIXTURE,
      "fixture",
      duplicated.map((o) => ({ filename: o.filename, raw: o.raw })),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("duplicated"))).toBe(true);
  });

  it("FAILS LOUD when a NEEDS JM marker is silently stripped from an otherwise-present block", () => {
    const outputs = validSplit();
    // Simulate a hypothetical serialization bug: block text present, but the
    // marker text itself got mangled. Layer 2 (independent regex re-scan)
    // must catch this even though Layer 1 will also flag the block mismatch.
    const corrupted = outputs.map((o) =>
      o.filename === "project_fixture_a.md" ? { ...o, raw: o.raw.replace("NEEDS JM", "needs jm (later)") } : o,
    );
    const result = verifySplitPreservesContent(
      SMALL_FIXTURE,
      "fixture",
      corrupted.map((o) => ({ filename: o.filename, raw: o.raw })),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("NEEDS JM marker"))).toBe(true);
  });
});

// ============================================================================
// MEMORY.md index update
// ============================================================================

describe("updateMemoryIndex", () => {
  const index = `# Auto Memory

- [First entry](project_first.md)
- [Second entry — the one being split](project_fixture.md)
- [Third entry](project_third.md)
`;

  it("replaces the single matching line with one line per new file, in place", () => {
    const updated = updateMemoryIndex(index, "project_fixture.md", [
      { filename: "project_fixture_a.md", description: "Part A" },
      { filename: "project_fixture_b.md", description: "Part B" },
    ]);
    const lines = updated.split("\n");
    expect(lines).toContain("- [Part A](project_fixture_a.md)");
    expect(lines).toContain("- [Part B](project_fixture_b.md)");
    expect(updated).not.toContain("(project_fixture.md)");
    // Position preserved: still between First and Third.
    const idxA = lines.indexOf("- [Part A](project_fixture_a.md)");
    const idxFirst = lines.indexOf("- [First entry](project_first.md)");
    const idxThird = lines.indexOf("- [Third entry](project_third.md)");
    expect(idxA).toBeGreaterThan(idxFirst);
    expect(idxA).toBeLessThan(idxThird);
  });

  it("throws loudly when no line links to the old filename", () => {
    expect(() => updateMemoryIndex(index, "project_nonexistent.md", [{ filename: "x.md", description: "d" }])).toThrow(
      /no index line found/,
    );
  });
});

// ============================================================================
// writeAndVerifySplit — the tool's actual disk+git mutation, including the
// fail-loud + revert path, exercised directly against a real git repo.
// ============================================================================

describe("writeAndVerifySplit", () => {
  function setupRepo(): { memoryDir: string; sourceRaw: string } {
    initGitRepo(tmpDir);
    writeFileSync(join(tmpDir, "project_fixture.md"), SMALL_FIXTURE);
    writeFileSync(
      join(tmpDir, INDEX_FILENAME),
      "# Auto Memory\n\n- [A small test fixture](project_fixture.md)\n",
    );
    git(["add", "-A"], tmpDir);
    git(["commit", "-m", "baseline"], tmpDir);
    return { memoryDir: tmpDir, sourceRaw: SMALL_FIXTURE };
  }

  function validOutputs(sourceRaw: string): PlannedOutputFile[] {
    const parsed = parseMemoryFile(sourceRaw, "fixture");
    const planA: Extract<SplitPlan, { action: "split" }> = {
      action: "split",
      files: [{ filename: "project_fixture_a.md", description: "Part A", blockIndices: [0, 1] }],
      conflictNotes: [],
    };
    const planB: Extract<SplitPlan, { action: "split" }> = {
      action: "split",
      files: [{ filename: "project_fixture_b.md", description: "Part B", blockIndices: [2, 3] }],
      conflictNotes: [],
    };
    return [
      ...buildOutputFiles("project_fixture.md", parsed.frontmatter, parsed.blocks, planA),
      ...buildOutputFiles("project_fixture.md", parsed.frontmatter, parsed.blocks, planB),
    ];
  }

  it("commits before AND after a successful split; revert restores exact prior bytes", () => {
    const { memoryDir, sourceRaw } = setupRepo();
    const beforeShaExpected = git(["rev-parse", "HEAD"], memoryDir);
    const outputs = validOutputs(sourceRaw);

    const result = writeAndVerifySplit({ memoryDir, filename: "project_fixture.md", sourceRaw, outputs, git });

    expect(result.postCheck.ok).toBe(true);
    expect(result.beforeSha).toBe(beforeShaExpected);
    expect(result.afterSha).not.toBe(result.beforeSha);
    expect(existsSync(join(memoryDir, "project_fixture.md"))).toBe(false);
    expect(existsSync(join(memoryDir, "project_fixture_a.md"))).toBe(true);
    expect(existsSync(join(memoryDir, "project_fixture_b.md"))).toBe(true);
    expect(readFileSync(join(memoryDir, INDEX_FILENAME), "utf-8")).toContain("project_fixture_a.md");

    // Two real, distinct commits exist.
    const log = git(["log", "--oneline"], memoryDir).split("\n");
    expect(log.length).toBeGreaterThanOrEqual(2);

    // Revert proof: git revert restores the ORIGINAL file's exact prior bytes.
    const sha256Before = Bun.SHA256.hash(sourceRaw, "hex");
    git(["revert", "--no-commit", result.afterSha], memoryDir);
    const restored = readFileSync(join(memoryDir, "project_fixture.md"), "utf-8");
    const sha256Restored = Bun.SHA256.hash(restored, "hex");
    expect(sha256Restored).toBe(sha256Before);
    expect(existsSync(join(memoryDir, "project_fixture_a.md"))).toBe(false);
    expect(existsSync(join(memoryDir, "project_fixture_b.md"))).toBe(false);

    // Snap back to the committed post-split tree (discard the uncommitted
    // revert — `git revert --no-commit` stages its inverse patch, so a plain
    // `checkout -- .` can't fully unstage it; `reset --hard <sha>` is the
    // correct discard here, and this is a disposable per-test tmpdir, not
    // the live repo).
    git(["reset", "--hard", result.afterSha], memoryDir);
    expect(existsSync(join(memoryDir, "project_fixture_a.md"))).toBe(true);
    expect(git(["status", "--porcelain"], memoryDir)).toBe("");
  });

  it("FAILS LOUD and reverts — commits nothing — when given a lossy outputs array (dropped dated+NEEDS-JM block)", () => {
    const { memoryDir, sourceRaw } = setupRepo();
    const beforeSha = git(["rev-parse", "HEAD"], memoryDir);
    const outputs = validOutputs(sourceRaw).filter((o) => o.filename !== "project_fixture_a.md");

    expect(() =>
      writeAndVerifySplit({ memoryDir, filename: "project_fixture.md", sourceRaw, outputs, git }),
    ).toThrow(/POST-WRITE invariant check FAILED/);

    // Nothing committed: HEAD unchanged.
    expect(git(["rev-parse", "HEAD"], memoryDir)).toBe(beforeSha);
    // Working tree restored exactly: original file back, no partial outputs left behind.
    expect(existsSync(join(memoryDir, "project_fixture.md"))).toBe(true);
    expect(readFileSync(join(memoryDir, "project_fixture.md"), "utf-8")).toBe(sourceRaw);
    expect(existsSync(join(memoryDir, "project_fixture_b.md"))).toBe(false);
    expect(git(["status", "--porcelain"], memoryDir)).toBe("");
  });

  it("refuses to run against a directory that isn't a git repository", () => {
    const noGitDir = mkdtempSync(join(tmpdir(), "auto-memory-no-git-"));
    try {
      writeFileSync(join(noGitDir, INDEX_FILENAME), "# Auto Memory\n");
      expect(() =>
        writeAndVerifySplit({
          memoryDir: noGitDir,
          filename: "project_fixture.md",
          sourceRaw: SMALL_FIXTURE,
          outputs: [],
          git,
        }),
      ).toThrow(/not a git repository/);
    } finally {
      rmSync(noGitDir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// consolidateFile — full orchestration, including the under-threshold and
// unsplittable no-op paths.
// ============================================================================

describe("consolidateFile", () => {
  it("returns skipped_under_threshold and touches nothing when the file is small", async () => {
    initGitRepo(tmpDir);
    writeFileSync(join(tmpDir, "project_small.md"), SMALL_FIXTURE);
    writeFileSync(join(tmpDir, INDEX_FILENAME), "# Auto Memory\n\n- [d](project_small.md)\n");
    git(["add", "-A"], tmpDir);
    git(["commit", "-m", "baseline"], tmpDir);
    const beforeSha = git(["rev-parse", "HEAD"], tmpDir);

    const result = await consolidateFile("project_small.md", { memoryDir: tmpDir, thresholdBytes: 1_000_000, git });
    expect(result.action).toBe("skipped_under_threshold");
    expect(git(["rev-parse", "HEAD"], tmpDir)).toBe(beforeSha);
  });

  it("returns skipped_unsplittable for an oversized file with fewer than 2 blocks", async () => {
    const singleBlock = `---
name: project-single
description: "one giant block, no separators"
metadata:
  node_type: memory
  type: project
---

## Just one section

${"x".repeat(25_000)}
`;
    initGitRepo(tmpDir);
    writeFileSync(join(tmpDir, "project_single.md"), singleBlock);
    writeFileSync(join(tmpDir, INDEX_FILENAME), "# Auto Memory\n\n- [d](project_single.md)\n");
    git(["add", "-A"], tmpDir);
    git(["commit", "-m", "baseline"], tmpDir);

    const result = await consolidateFile("project_single.md", { memoryDir: tmpDir, git });
    expect(result.action).toBe("skipped_unsplittable");
    expect(result.reason).toMatch(/only 1 content block/);
  });

  it("end-to-end: splits an oversized file via an injected plan and commits before+after", async () => {
    const big = `---
name: project-big
description: "oversized fixture"
metadata:
  node_type: memory
  type: project
---

## Overview

${"a".repeat(12_000)}

---

### 2026-02-01: dated finding one

${"b".repeat(12_000)}
`;
    initGitRepo(tmpDir);
    writeFileSync(join(tmpDir, "project_big.md"), big);
    writeFileSync(join(tmpDir, INDEX_FILENAME), "# Auto Memory\n\n- [oversized fixture](project_big.md)\n");
    git(["add", "-A"], tmpDir);
    git(["commit", "-m", "baseline"], tmpDir);
    const beforeSha = git(["rev-parse", "HEAD"], tmpDir);

    const result = await consolidateFile("project_big.md", {
      memoryDir: tmpDir,
      thresholdBytes: 1000,
      git,
      inferenceFn: fakeInferenceFn({
        action: "split",
        files: [
          { filename: "project_big_overview.md", description: "overview", blockIndices: [0] },
          { filename: "project_big_findings.md", description: "findings", blockIndices: [1] },
        ],
        conflictNotes: [],
      }),
    });

    expect(result.action).toBe("split");
    expect(result.beforeSha).toBe(beforeSha);
    expect(result.afterSha).toBeTruthy();
    expect(result.afterSha).not.toBe(beforeSha);
    expect(result.invariantCheck?.ok).toBe(true);
    expect(existsSync(join(tmpDir, "project_big.md"))).toBe(false);
    expect(existsSync(join(tmpDir, "project_big_overview.md"))).toBe(true);
    expect(existsSync(join(tmpDir, "project_big_findings.md"))).toBe(true);
  });
});
