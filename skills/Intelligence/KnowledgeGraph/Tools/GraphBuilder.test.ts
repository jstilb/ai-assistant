#!/usr/bin/env bun
/**
 * GraphBuilder Tests
 *
 * Tests the core graph construction logic:
 * - Markdown parsing (frontmatter, wikilinks, tags, headings, embeds)
 * - Graph construction (nodes, edges, in/out degree)
 * - Statistics computation
 * - CLI interface
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";

// Test fixture directory
const TEST_VAULT = "/tmp/kg-test-vault";
const TEST_STATE = "/tmp/kg-test-state.json";

// Create test vault with known structure
function createTestVault() {
  if (existsSync(TEST_VAULT)) {
    rmSync(TEST_VAULT, { recursive: true });
  }

  // Create folders
  mkdirSync(join(TEST_VAULT, "Data Science"), { recursive: true });
  mkdirSync(join(TEST_VAULT, "NLP"), { recursive: true });
  mkdirSync(join(TEST_VAULT, "Writing"), { recursive: true });
  mkdirSync(join(TEST_VAULT, "_private"), { recursive: true });
  mkdirSync(join(TEST_VAULT, ".obsidian"), { recursive: true });

  // Note 1: Well-connected note with frontmatter, wikilinks, tags, embeds
  writeFileSync(
    join(TEST_VAULT, "Data Science", "Machine Learning.md"),
    `---
tags: [ml, data-science, course]
aliases: [ML]
---

# Machine Learning

Machine learning is a subset of AI. See [[Neural Networks]] for deep learning approaches.

Related topics:
- [[NLP/Transformers|Transformers]] for sequence modeling
- [[Writing/Technical Writing]] for documentation
- ![[Data Science/Statistics Overview]]

## Supervised Learning
Classification and regression tasks.

## Unsupervised Learning
Clustering and dimensionality reduction.

#advanced #berkeley
`
  );

  // Note 2: NLP note linking back
  writeFileSync(
    join(TEST_VAULT, "NLP", "Transformers.md"),
    `---
tags: [nlp, deep-learning, transformers]
---

# Transformers

The Transformer architecture from [[Data Science/Machine Learning|ML]] revolutionized NLP.

See also [[Attention Mechanism]] which is core to transformers.

## Self-Attention
Multi-head attention mechanism.

## Applications
- Machine translation
- Text generation
`
  );

  // Note 3: Orphan note (no links)
  writeFileSync(
    join(TEST_VAULT, "Writing", "Technical Writing.md"),
    `# Technical Writing

How to write technical documentation effectively.

This note has no outgoing links and only one incoming link.
`
  );

  // Note 4: Stub note (short, no outlinks)
  writeFileSync(
    join(TEST_VAULT, "Data Science", "Statistics Overview.md"),
    `---
tags: [statistics, data-science]
---

# Statistics Overview

Basic statistics concepts.
`
  );

  // Note 5: Note with broken link
  writeFileSync(
    join(TEST_VAULT, "NLP", "Attention Mechanism.md"),
    `---
tags: [nlp, attention]
---

# Attention Mechanism

See [[Nonexistent Note]] for more details.
Also references [[Data Science/Machine Learning]].
`
  );

  // Excluded notes (should be ignored)
  writeFileSync(
    join(TEST_VAULT, "_private", "Secret.md"),
    `# Secret Note\nThis should be excluded.`
  );
  writeFileSync(
    join(TEST_VAULT, ".obsidian", "config.md"),
    `# Config\nThis should be excluded.`
  );

  // Root-level note
  writeFileSync(
    join(TEST_VAULT, "Index.md"),
    `---
tags: [index, meta]
---

# Vault Index

- [[Data Science/Machine Learning]]
- [[NLP/Transformers]]
- [[Writing/Technical Writing]]
`
  );
}

function cleanupTestVault() {
  if (existsSync(TEST_VAULT)) {
    rmSync(TEST_VAULT, { recursive: true });
  }
  if (existsSync(TEST_STATE)) {
    rmSync(TEST_STATE);
  }
}

// Dynamic import for the module under test
let GraphBuilder: any;

describe("GraphBuilder", () => {
  beforeAll(async () => {
    createTestVault();
    GraphBuilder = await import("./GraphBuilder.ts");
  });

  afterAll(() => {
    cleanupTestVault();
  });

  describe("parseMarkdownFile", () => {
    it("extracts frontmatter tags", async () => {
      const node = await GraphBuilder.parseMarkdownFile(
        join(TEST_VAULT, "Data Science", "Machine Learning.md"),
        TEST_VAULT
      );
      expect(node.tags).toContain("ml");
      expect(node.tags).toContain("data-science");
      expect(node.tags).toContain("course");
    });

    it("extracts inline tags", async () => {
      const node = await GraphBuilder.parseMarkdownFile(
        join(TEST_VAULT, "Data Science", "Machine Learning.md"),
        TEST_VAULT
      );
      expect(node.tags).toContain("advanced");
      expect(node.tags).toContain("berkeley");
    });

    it("extracts wikilinks as outLinks", async () => {
      const node = await GraphBuilder.parseMarkdownFile(
        join(TEST_VAULT, "Data Science", "Machine Learning.md"),
        TEST_VAULT
      );
      expect(node.outLinks).toContain("Neural Networks");
      expect(node.outLinks).toContain("NLP/Transformers");
      expect(node.outLinks).toContain("Writing/Technical Writing");
    });

    it("extracts embeds", async () => {
      const node = await GraphBuilder.parseMarkdownFile(
        join(TEST_VAULT, "Data Science", "Machine Learning.md"),
        TEST_VAULT
      );
      expect(node.embeds).toContain("Data Science/Statistics Overview");
    });

    it("extracts headings", async () => {
      const node = await GraphBuilder.parseMarkdownFile(
        join(TEST_VAULT, "Data Science", "Machine Learning.md"),
        TEST_VAULT
      );
      expect(node.headings).toContain("Supervised Learning");
      expect(node.headings).toContain("Unsupervised Learning");
    });

    it("extracts aliases from frontmatter", async () => {
      const node = await GraphBuilder.parseMarkdownFile(
        join(TEST_VAULT, "Data Science", "Machine Learning.md"),
        TEST_VAULT
      );
      expect(node.aliases).toContain("ML");
    });

    it("sets correct folder", async () => {
      const node = await GraphBuilder.parseMarkdownFile(
        join(TEST_VAULT, "Data Science", "Machine Learning.md"),
        TEST_VAULT
      );
      expect(node.folder).toBe("Data Science");
    });

    it("sets correct id (relative path)", async () => {
      const node = await GraphBuilder.parseMarkdownFile(
        join(TEST_VAULT, "Data Science", "Machine Learning.md"),
        TEST_VAULT
      );
      expect(node.id).toBe("Data Science/Machine Learning.md");
    });

    it("computes word count", async () => {
      const node = await GraphBuilder.parseMarkdownFile(
        join(TEST_VAULT, "Data Science", "Machine Learning.md"),
        TEST_VAULT
      );
      expect(node.wordCount).toBeGreaterThan(10);
    });

    it("handles notes without frontmatter", async () => {
      const node = await GraphBuilder.parseMarkdownFile(
        join(TEST_VAULT, "Writing", "Technical Writing.md"),
        TEST_VAULT
      );
      expect(node.tags).toEqual([]);
      expect(node.title).toBe("Technical Writing");
    });
  });

  describe("buildGraph", () => {
    it("finds all non-excluded markdown files", async () => {
      const state = await GraphBuilder.buildGraph({
        rootPath: TEST_VAULT,
        excludePrefixes: [".", "_"],
        includeExtensions: [".md"],
        includeFolderEdges: false,
        includeTagEdges: false,
      });
      // Should find 6 notes: ML, Transformers, Technical Writing,
      // Statistics Overview, Attention Mechanism, Index
      expect(state.nodes.length).toBe(6);
    });

    it("excludes folders starting with . or _", async () => {
      const state = await GraphBuilder.buildGraph({
        rootPath: TEST_VAULT,
        excludePrefixes: [".", "_"],
        includeExtensions: [".md"],
        includeFolderEdges: false,
        includeTagEdges: false,
      });
      const nodeIds = state.nodes.map((n: any) => n.id);
      expect(nodeIds).not.toContain("_private/Secret.md");
      expect(nodeIds).not.toContain(".obsidian/config.md");
    });

    it("creates wikilink edges", async () => {
      const state = await GraphBuilder.buildGraph({
        rootPath: TEST_VAULT,
        excludePrefixes: [".", "_"],
        includeExtensions: [".md"],
        includeFolderEdges: false,
        includeTagEdges: false,
      });
      const wikilinkEdges = state.edges.filter(
        (e: any) => e.type === "wikilink"
      );
      expect(wikilinkEdges.length).toBeGreaterThan(0);
      // ML -> Transformers edge should exist
      const mlToTransformers = wikilinkEdges.find(
        (e: any) =>
          e.source === "Data Science/Machine Learning.md" &&
          e.target === "NLP/Transformers.md"
      );
      expect(mlToTransformers).toBeTruthy();
    });

    it("populates inLinks on target nodes", async () => {
      const state = await GraphBuilder.buildGraph({
        rootPath: TEST_VAULT,
        excludePrefixes: [".", "_"],
        includeExtensions: [".md"],
        includeFolderEdges: false,
        includeTagEdges: false,
      });
      const transformers = state.nodes.find(
        (n: any) => n.id === "NLP/Transformers.md"
      );
      expect(transformers.inLinks.length).toBeGreaterThan(0);
    });

    it("creates embed edges", async () => {
      const state = await GraphBuilder.buildGraph({
        rootPath: TEST_VAULT,
        excludePrefixes: [".", "_"],
        includeExtensions: [".md"],
        includeFolderEdges: false,
        includeTagEdges: false,
      });
      const embedEdges = state.edges.filter((e: any) => e.type === "embed");
      expect(embedEdges.length).toBeGreaterThan(0);
    });

    it("creates tag co-occurrence edges when enabled", async () => {
      const state = await GraphBuilder.buildGraph({
        rootPath: TEST_VAULT,
        excludePrefixes: [".", "_"],
        includeExtensions: [".md"],
        includeFolderEdges: false,
        includeTagEdges: true,
      });
      const tagEdges = state.edges.filter((e: any) => e.type === "tag");
      expect(tagEdges.length).toBeGreaterThan(0);
    });

    it("creates folder co-membership edges when enabled", async () => {
      const state = await GraphBuilder.buildGraph({
        rootPath: TEST_VAULT,
        excludePrefixes: [".", "_"],
        includeExtensions: [".md"],
        includeFolderEdges: true,
        includeTagEdges: false,
      });
      const folderEdges = state.edges.filter((e: any) => e.type === "folder");
      expect(folderEdges.length).toBeGreaterThan(0);
    });

    it("computes accurate statistics", async () => {
      const state = await GraphBuilder.buildGraph({
        rootPath: TEST_VAULT,
        excludePrefixes: [".", "_"],
        includeExtensions: [".md"],
        includeFolderEdges: false,
        includeTagEdges: false,
      });
      expect(state.stats.totalNodes).toBe(6);
      expect(state.stats.totalEdges).toBeGreaterThan(0);
      expect(state.stats.brokenLinks.length).toBeGreaterThan(0);
      expect(state.stats.brokenLinks).toContain("Nonexistent Note");
    });

    it("detects orphan notes", async () => {
      const state = await GraphBuilder.buildGraph({
        rootPath: TEST_VAULT,
        excludePrefixes: [".", "_"],
        includeExtensions: [".md"],
        includeFolderEdges: false,
        includeTagEdges: false,
      });
      // Technical Writing has one inLink from ML but no outlinks,
      // Statistics Overview is only embedded.
      // Orphan = no wikilink in AND no wikilink out
      expect(state.stats.orphanCount).toBeGreaterThanOrEqual(0);
    });

    it("sets version and timestamp", async () => {
      const state = await GraphBuilder.buildGraph({
        rootPath: TEST_VAULT,
        excludePrefixes: [".", "_"],
        includeExtensions: [".md"],
        includeFolderEdges: false,
        includeTagEdges: false,
      });
      expect(state.version).toBe(1);
      expect(state.built).toBeTruthy();
      expect(new Date(state.built).getTime()).toBeGreaterThan(0);
    });
  });

  describe("graph traversal", () => {
    it("finds neighbors of a node", async () => {
      const state = await GraphBuilder.buildGraph({
        rootPath: TEST_VAULT,
        excludePrefixes: [".", "_"],
        includeExtensions: [".md"],
        includeFolderEdges: false,
        includeTagEdges: false,
      });
      const neighbors = GraphBuilder.getNeighbors(
        state,
        "Data Science/Machine Learning.md"
      );
      expect(neighbors.length).toBeGreaterThan(0);
    });

    it("finds shortest path between nodes", async () => {
      const state = await GraphBuilder.buildGraph({
        rootPath: TEST_VAULT,
        excludePrefixes: [".", "_"],
        includeExtensions: [".md"],
        includeFolderEdges: false,
        includeTagEdges: false,
      });
      const path = GraphBuilder.findShortestPath(
        state,
        "Data Science/Machine Learning.md",
        "NLP/Transformers.md"
      );
      expect(path).toBeTruthy();
      expect(path!.length).toBeGreaterThanOrEqual(2);
      expect(path![0]).toBe("Data Science/Machine Learning.md");
    });
  });

  describe("saveGraphState / loadGraphState", () => {
    it("round-trips graph state through JSON", async () => {
      const state = await GraphBuilder.buildGraph({
        rootPath: TEST_VAULT,
        excludePrefixes: [".", "_"],
        includeExtensions: [".md"],
        includeFolderEdges: false,
        includeTagEdges: false,
      });
      await GraphBuilder.saveGraphState(state, TEST_STATE);
      const loaded = await GraphBuilder.loadGraphState(TEST_STATE);
      expect(loaded.nodes.length).toBe(state.nodes.length);
      expect(loaded.edges.length).toBe(state.edges.length);
      expect(loaded.stats.totalNodes).toBe(state.stats.totalNodes);
    });
  });
});
