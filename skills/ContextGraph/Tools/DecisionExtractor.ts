#!/usr/bin/env bun
// DecisionExtractor.ts - Heuristic extraction from Kaya data sources
//
// Extracts decision points from 5 data sources using rule-based heuristics
// (no LLM inference for v1). Creates decision nodes and edges per
// EdgeRules.yaml, deduplicates via content hash, and tracks extraction
// state in State/last-capture.json.
//
// Data Sources:
//   1. ratings          - MEMORY/LEARNING/SIGNALS/ratings.jsonl
//   2. work_items       - MEMORY/WORK/ directories
//   3. learnings        - MEMORY/LEARNING/ALGORITHM/ md files
//   4. context_feedback - MEMORY/LEARNING/SIGNALS/context-feedback.jsonl
//   5. isc              - MEMORY/WORK/current-isc.json
//
// CLI:
//   bun DecisionExtractor.ts --since 7d
//   bun DecisionExtractor.ts --sources ratings,learnings
//   bun DecisionExtractor.ts --dry-run
//   bun DecisionExtractor.ts --dry-run --json
//   bun DecisionExtractor.ts --help
//
// @module ContextGraph/DecisionExtractor
// @version 1.0.0

import { join, basename } from "path";
import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
} from "fs";
import { createGraphManager } from "./GraphManager";
import { createStateManager } from "../../CORE/Tools/StateManager";
import { z } from "zod";
import type {
  DecisionNode,
  DecisionEdge,
  DecisionNodeType,
  DecisionEdgeType,
  GraphEvent,
  ExtractionState,
  SourceCursor,
} from "./types";

// ============================================
// CONSTANTS
// ============================================

const BASE_DIR = join(process.env.HOME!, ".claude");
const MEMORY_DIR = join(BASE_DIR, "MEMORY");
const STATE_FILE = join(
  BASE_DIR,
  "skills",
  "ContextGraph",
  "State",
  "last-capture.json"
);
const ALL_SOURCES = [
  "ratings",
  "work_items",
  "learnings",
  "context_feedback",
  "isc",
] as const;
type SourceName = (typeof ALL_SOURCES)[number];

// ============================================
// EXTRACTION STATE SCHEMA
// ============================================

const ExtractionStateSchema = z.object({
  sources: z.record(
    z.string(),
    z.object({
      name: z.string(),
      lastTimestamp: z.string(),
      lastLine: z.number(),
      extracted: z.number(),
    })
  ),
  lastRun: z.string(),
  totalExtracted: z.number(),
});

function createDefaultExtractionState(): ExtractionState {
  const sources: Record<string, SourceCursor> = {};
  for (const name of ALL_SOURCES) {
    sources[name] = {
      name,
      lastTimestamp: "",
      lastLine: 0,
      extracted: 0,
    };
  }
  return {
    sources,
    lastRun: "",
    totalExtracted: 0,
  };
}

// ============================================
// CONTENT HASHING
// ============================================

function hashContent(content: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  return hasher.digest("hex").slice(0, 16);
}

function generateNodeId(
  source: string,
  content: string,
  timestamp: string
): string {
  return `${source}-${hashContent(content + timestamp)}`;
}

function generateEdgeId(
  source: string,
  target: string,
  type: string
): string {
  return `e-${hashContent(source + target + type)}`;
}

// ============================================
// TIME PARSING
// ============================================

function parseSince(since: string): Date {
  const match = since.match(/^(\d+)(d|h|m|w)$/);
  if (!match) {
    // Try ISO date
    const d = new Date(since);
    if (!isNaN(d.getTime())) return d;
    throw new Error(
      `Invalid --since format: ${since}. Use "7d", "24h", "30m", "2w", or ISO date.`
    );
  }

  const [, numStr, unit] = match;
  const num = parseInt(numStr, 10);
  const now = Date.now();

  switch (unit) {
    case "m":
      return new Date(now - num * 60 * 1000);
    case "h":
      return new Date(now - num * 60 * 60 * 1000);
    case "d":
      return new Date(now - num * 24 * 60 * 60 * 1000);
    case "w":
      return new Date(now - num * 7 * 24 * 60 * 60 * 1000);
    default:
      throw new Error(`Unknown time unit: ${unit}`);
  }
}

// ============================================
// EXTRACTION RESULTS
// ============================================

interface ExtractionResult {
  nodes: DecisionNode[];
  edges: DecisionEdge[];
  source: SourceName;
  skipped: number;
}

// ============================================
// SOURCE EXTRACTORS
// ============================================

/**
 * Extract decision signals from ratings.jsonl
 *
 * Heuristics:
 * - Rating <= 3: failure/problem decision (outcome node)
 * - Rating >= 8: successful outcome (outcome node)
 * - Rating delta >= 3 between consecutive entries: course correction (decision node)
 */
function extractRatings(
  since: Date | null,
  cursor: SourceCursor
): ExtractionResult {
  const filePath = join(MEMORY_DIR, "LEARNING", "SIGNALS", "ratings.jsonl");
  if (!existsSync(filePath)) {
    return { nodes: [], edges: [], source: "ratings", skipped: 0 };
  }

  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim());

  const nodes: DecisionNode[] = [];
  const edges: DecisionEdge[] = [];
  let skipped = 0;
  let prevRating: number | null = null;
  let prevTimestamp: string | null = null;
  let prevNodeId: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    // Skip already-processed lines
    if (i < cursor.lastLine) {
      try {
        const entry = JSON.parse(lines[i]);
        prevRating = entry.rating;
        prevTimestamp = entry.timestamp;
        prevNodeId = generateNodeId(
          "ratings",
          `rating-${entry.rating}-${entry.sentiment_summary || ""}`,
          entry.timestamp
        );
      } catch {
        // skip
      }
      continue;
    }

    let entry: any;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      skipped++;
      continue;
    }

    const ts = new Date(entry.timestamp);
    if (since && ts < since) {
      prevRating = entry.rating;
      prevTimestamp = entry.timestamp;
      skipped++;
      continue;
    }

    const rating = entry.rating as number;
    const sessionId = entry.session_id || "";
    const sentiment = entry.sentiment_summary || "";
    const now = new Date().toISOString();

    // Low rating: failure outcome
    if (rating <= 3) {
      const nodeId = generateNodeId(
        "ratings",
        `low-rating-${rating}-${sentiment}`,
        entry.timestamp
      );
      nodes.push({
        id: nodeId,
        type: "outcome",
        title: `Low rating (${rating}/10): ${sentiment.slice(0, 80) || "Problem detected"}`,
        content: `Rating: ${rating}/10. Session: ${sessionId}. ${sentiment}`,
        timestamp: entry.timestamp,
        recordedAt: now,
        tags: ["low-rating", "problem", `rating-${rating}`, `session-${sessionId.slice(0, 8)}`],
        metadata: {
          rating,
          session_id: sessionId,
          source: entry.source || "unknown",
          confidence: entry.confidence,
          sentiment_summary: sentiment,
        },
        confidence: 0.85,
      });

      // If previous entry had higher rating, create supersedes edge
      if (prevNodeId && prevRating !== null && prevRating >= 5) {
        edges.push({
          id: generateEdgeId(nodeId, prevNodeId, "supersedes"),
          source: nodeId,
          target: prevNodeId,
          type: "supersedes",
          weight: 0.7,
          created_at: now,
          metadata: { delta: prevRating - rating },
        });
      }

      prevNodeId = nodeId;
    }

    // High rating: successful outcome
    if (rating >= 8) {
      const nodeId = generateNodeId(
        "ratings",
        `high-rating-${rating}-${sentiment}`,
        entry.timestamp
      );
      nodes.push({
        id: nodeId,
        type: "outcome",
        title: `High rating (${rating}/10): ${sentiment.slice(0, 80) || "Success"}`,
        content: `Rating: ${rating}/10. Session: ${sessionId}. ${sentiment}`,
        timestamp: entry.timestamp,
        recordedAt: now,
        tags: ["high-rating", "success", `rating-${rating}`, `session-${sessionId.slice(0, 8)}`],
        metadata: {
          rating,
          session_id: sessionId,
          source: entry.source || "unknown",
          confidence: entry.confidence,
          sentiment_summary: sentiment,
        },
        confidence: 0.75,
      });
      prevNodeId = nodeId;
    }

    // Course correction: large rating delta
    if (prevRating !== null && Math.abs(rating - prevRating) >= 3) {
      const direction = rating > prevRating ? "improvement" : "decline";
      const nodeId = generateNodeId(
        "ratings",
        `correction-${direction}-${prevRating}-to-${rating}`,
        entry.timestamp
      );
      nodes.push({
        id: nodeId,
        type: "decision",
        title: `Course ${direction}: rating ${prevRating} -> ${rating}`,
        content: `Rating shifted from ${prevRating} to ${rating} (delta: ${rating - prevRating}). ${sentiment}. Session: ${sessionId}`,
        timestamp: entry.timestamp,
        recordedAt: now,
        tags: [
          "course-correction",
          direction,
          `session-${sessionId.slice(0, 8)}`,
        ],
        metadata: {
          prevRating,
          newRating: rating,
          delta: rating - prevRating,
          session_id: sessionId,
        },
        confidence: 0.80,
      });

      // Link to previous node
      if (prevNodeId) {
        edges.push({
          id: generateEdgeId(nodeId, prevNodeId, "caused"),
          source: prevNodeId,
          target: nodeId,
          type: "caused",
          weight: 0.8,
          created_at: now,
          metadata: { delta: rating - prevRating },
        });
      }

      prevNodeId = nodeId;
    }

    // Temporal edge between consecutive entries in same session
    if (
      prevNodeId &&
      prevTimestamp &&
      sessionId &&
      entry.session_id === sessionId
    ) {
      const prevTs = new Date(prevTimestamp);
      const currTs = new Date(entry.timestamp);
      const deltaMin =
        (currTs.getTime() - prevTs.getTime()) / (1000 * 60);
      if (deltaMin > 0 && deltaMin <= 60) {
        // Only add if we have a node from this entry
        const latestNodeId =
          nodes.length > 0 ? nodes[nodes.length - 1].id : null;
        if (latestNodeId && latestNodeId !== prevNodeId) {
          edges.push({
            id: generateEdgeId(prevNodeId, latestNodeId, "preceded"),
            source: prevNodeId,
            target: latestNodeId,
            type: "preceded",
            weight: 0.5,
            created_at: now,
            metadata: { deltaMinutes: Math.round(deltaMin) },
          });
        }
      }
    }

    prevRating = rating;
    prevTimestamp = entry.timestamp;
  }

  return { nodes, edges, source: "ratings", skipped };
}

/**
 * Extract decisions from MEMORY/WORK directories
 */
function extractWorkItems(
  since: Date | null,
  cursor: SourceCursor
): ExtractionResult {
  const workDir = join(MEMORY_DIR, "WORK");
  if (!existsSync(workDir)) {
    return { nodes: [], edges: [], source: "work_items", skipped: 0 };
  }

  const dirs = readdirSync(workDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  const nodes: DecisionNode[] = [];
  const edges: DecisionEdge[] = [];
  let skipped = 0;
  const now = new Date().toISOString();

  for (const dirName of dirs) {
    // Parse timestamp from directory name: YYYYMMDD-HHMMSS_description
    const tsMatch = dirName.match(/^(\d{8})-(\d{6})_(.+)/);
    if (!tsMatch) {
      skipped++;
      continue;
    }

    const [, dateStr, timeStr, descSlug] = tsMatch;
    const year = dateStr.slice(0, 4);
    const month = dateStr.slice(4, 6);
    const day = dateStr.slice(6, 8);
    const hour = timeStr.slice(0, 2);
    const min = timeStr.slice(2, 4);
    const sec = timeStr.slice(4, 6);
    const timestamp = `${year}-${month}-${day}T${hour}:${min}:${sec}`;

    const ts = new Date(timestamp);
    if (since && ts < since) {
      skipped++;
      continue;
    }

    // Skip already processed
    if (cursor.lastTimestamp && timestamp <= cursor.lastTimestamp) {
      skipped++;
      continue;
    }

    const title = descSlug.replace(/-/g, " ").slice(0, 100);
    const nodeId = generateNodeId("work", title, timestamp);

    nodes.push({
      id: nodeId,
      type: "decision",
      title: `Work session: ${title}`,
      content: `Work item initiated: "${title}". Directory: MEMORY/WORK/${dirName}`,
      timestamp,
      recordedAt: now,
      tags: ["work-item", "session"],
      metadata: {
        directoryName: dirName,
        slug: descSlug,
      },
      confidence: 0.70,
    });
  }

  return { nodes, edges, source: "work_items", skipped };
}

/**
 * Extract decisions from learning markdown files with YAML frontmatter
 */
function extractLearnings(
  since: Date | null,
  cursor: SourceCursor
): ExtractionResult {
  const learningDir = join(MEMORY_DIR, "LEARNING", "ALGORITHM");
  if (!existsSync(learningDir)) {
    return { nodes: [], edges: [], source: "learnings", skipped: 0 };
  }

  const nodes: DecisionNode[] = [];
  const edges: DecisionEdge[] = [];
  let skipped = 0;
  const now = new Date().toISOString();

  // Scan month directories
  const monthDirs = readdirSync(learningDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const monthDir of monthDirs) {
    const monthPath = join(learningDir, monthDir);
    const files = readdirSync(monthPath).filter((f) => f.endsWith(".md"));

    for (const file of files) {
      // Parse timestamp from filename: YYYY-MM-DD-HHMMSS_LEARNING_description.md
      const tsMatch = file.match(
        /^(\d{4}-\d{2}-\d{2})-(\d{6})_LEARNING_(.+)\.md$/
      );
      if (!tsMatch) {
        skipped++;
        continue;
      }

      const [, dateStr, timeStr, descSlug] = tsMatch;
      const hour = timeStr.slice(0, 2);
      const min = timeStr.slice(2, 4);
      const sec = timeStr.slice(4, 6);
      const timestamp = `${dateStr}T${hour}:${min}:${sec}`;

      const ts = new Date(timestamp);
      if (since && ts < since) {
        skipped++;
        continue;
      }

      if (cursor.lastTimestamp && timestamp <= cursor.lastTimestamp) {
        skipped++;
        continue;
      }

      const filePath = join(monthPath, file);
      let content: string;
      try {
        content = readFileSync(filePath, "utf-8");
      } catch {
        skipped++;
        continue;
      }

      // Parse YAML frontmatter
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      let tags: string[] = ["learning"];
      let captureType = "LEARNING";

      if (fmMatch) {
        const fm = fmMatch[1];
        // Extract tags
        const tagsMatch = fm.match(/tags:\s*\[([^\]]*)\]/);
        if (tagsMatch) {
          tags = [
            ...tags,
            ...tagsMatch[1].split(",").map((t) => t.trim().replace(/['"]/g, "")),
          ];
        }
        // Extract capture_type
        const ctMatch = fm.match(/capture_type:\s*(.+)/);
        if (ctMatch) {
          captureType = ctMatch[1].trim();
        }
      }

      // Extract summary from content
      const summaryMatch = content.match(/## Summary\n\n([\s\S]*?)(?=\n##|\n---|\Z)/);
      const summary = summaryMatch ? summaryMatch[1].trim().slice(0, 200) : "";

      const title = descSlug.replace(/-/g, " ").slice(0, 100);
      const nodeId = generateNodeId("learning", title, timestamp);

      // Determine type based on content signals
      let nodeType: DecisionNodeType = "decision";
      if (descSlug.includes("rating-3") || descSlug.includes("rating-2")) {
        nodeType = "outcome";
        tags.push("low-rating");
      } else if (descSlug.includes("pattern")) {
        nodeType = "pattern";
        tags.push("pattern");
      }

      nodes.push({
        id: nodeId,
        type: nodeType,
        title: `Learning: ${title}`,
        content: summary || `Learning captured: ${title}. Type: ${captureType}`,
        timestamp,
        recordedAt: now,
        tags,
        metadata: {
          captureType,
          fileName: file,
          monthDir,
        },
        confidence: 0.75,
      });
    }
  }

  return { nodes, edges, source: "learnings", skipped };
}

/**
 * Extract context signals from context-feedback.jsonl
 */
function extractContextFeedback(
  since: Date | null,
  cursor: SourceCursor
): ExtractionResult {
  const filePath = join(
    MEMORY_DIR,
    "LEARNING",
    "SIGNALS",
    "context-feedback.jsonl"
  );
  if (!existsSync(filePath)) {
    return { nodes: [], edges: [], source: "context_feedback", skipped: 0 };
  }

  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim());

  const nodes: DecisionNode[] = [];
  const edges: DecisionEdge[] = [];
  let skipped = 0;
  const now = new Date().toISOString();

  // Track session profile changes
  const sessionProfiles = new Map<string, string>();

  for (let i = 0; i < lines.length; i++) {
    if (i < cursor.lastLine) {
      skipped++;
      continue;
    }

    let entry: any;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      skipped++;
      continue;
    }

    const ts = new Date(entry.timestamp);
    if (since && ts < since) {
      skipped++;
      continue;
    }

    const sessionId = entry.sessionId || "";
    const profile = entry.profile || "";
    const confidence = entry.classificationConfidence || 0;
    const profileChanges = entry.profileChanges || 0;

    // Detect profile changes (context shifts)
    const prevProfile = sessionProfiles.get(sessionId);
    if (prevProfile && prevProfile !== profile) {
      const nodeId = generateNodeId(
        "context",
        `profile-change-${prevProfile}-${profile}`,
        entry.timestamp
      );
      nodes.push({
        id: nodeId,
        type: "context",
        title: `Context shift: ${prevProfile} -> ${profile}`,
        content: `Session ${sessionId.slice(0, 8)} changed context from ${prevProfile} to ${profile}. Classification confidence: ${confidence}. Profile changes: ${profileChanges}`,
        timestamp: entry.timestamp,
        recordedAt: now,
        tags: [
          "context-shift",
          `profile-${profile}`,
          `session-${sessionId.slice(0, 8)}`,
        ],
        metadata: {
          sessionId,
          fromProfile: prevProfile,
          toProfile: profile,
          classificationConfidence: confidence,
          classificationStage: entry.classificationStage,
          profileChanges,
          sessionDurationMinutes: entry.sessionDurationMinutes,
        },
        confidence: 0.65,
      });
    }
    sessionProfiles.set(sessionId, profile);

    // Low confidence classification
    if (confidence <= 0.5 && confidence > 0) {
      const nodeId = generateNodeId(
        "context",
        `low-confidence-${confidence}-${profile}`,
        entry.timestamp
      );
      nodes.push({
        id: nodeId,
        type: "context",
        title: `Low confidence context: ${profile} (${Math.round(confidence * 100)}%)`,
        content: `Session ${sessionId.slice(0, 8)} classified as "${profile}" with only ${Math.round(confidence * 100)}% confidence. Stage: ${entry.classificationStage}`,
        timestamp: entry.timestamp,
        recordedAt: now,
        tags: [
          "low-confidence",
          `profile-${profile}`,
          `session-${sessionId.slice(0, 8)}`,
        ],
        metadata: {
          sessionId,
          profile,
          classificationConfidence: confidence,
          classificationStage: entry.classificationStage,
        },
        confidence: 0.60,
      });
    }
  }

  return { nodes, edges, source: "context_feedback", skipped };
}

/**
 * Extract decisions from ISC files (if they exist)
 */
function extractISC(
  since: Date | null,
  cursor: SourceCursor
): ExtractionResult {
  const iscFile = join(MEMORY_DIR, "WORK", "current-isc.json");
  if (!existsSync(iscFile)) {
    return { nodes: [], edges: [], source: "isc", skipped: 0 };
  }

  const nodes: DecisionNode[] = [];
  const edges: DecisionEdge[] = [];
  const now = new Date().toISOString();

  try {
    const content = readFileSync(iscFile, "utf-8");
    const isc = JSON.parse(content);

    // Extract ISC rows as decisions
    const rows = isc.rows || isc.criteria || [];
    if (Array.isArray(rows)) {
      for (const row of rows) {
        const rowId = row.id || row.criterion || "";
        const status = row.status || row.state || "";
        const description = row.description || row.criterion || rowId;
        const timestamp = row.updated || row.timestamp || now;

        const ts = new Date(timestamp);
        if (since && ts < since) continue;

        const nodeId = generateNodeId("isc", `${rowId}-${status}`, timestamp);
        nodes.push({
          id: nodeId,
          type: "decision",
          title: `ISC: ${description.slice(0, 80)}`,
          content: `ISC criterion "${rowId}": ${description}. Status: ${status}`,
          timestamp,
          recordedAt: now,
          tags: ["isc", `status-${status}`, `isc-${rowId}`],
          metadata: {
            iscId: rowId,
            status,
            rawRow: row,
          },
          confidence: 0.80,
        });
      }
    }
  } catch {
    // ISC file may be empty or malformed
  }

  return { nodes, edges, source: "isc", skipped: 0 };
}

// ============================================
// DEDUPLICATION
// ============================================

function deduplicateNodes(
  nodes: DecisionNode[],
  existingIds: Set<string>
): DecisionNode[] {
  const seen = new Set<string>();
  return nodes.filter((node) => {
    if (existingIds.has(node.id) || seen.has(node.id)) return false;
    seen.add(node.id);
    return true;
  });
}

function deduplicateEdges(
  edges: DecisionEdge[],
  existingIds: Set<string>
): DecisionEdge[] {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    if (existingIds.has(edge.id) || seen.has(edge.id)) return false;
    seen.add(edge.id);
    return true;
  });
}

// ============================================
// MAIN EXTRACTION
// ============================================

export interface ExtractorOptions {
  since?: string;
  sources?: SourceName[];
  dryRun?: boolean;
  json?: boolean;
}

export async function runExtraction(
  options: ExtractorOptions
): Promise<{
  totalNodes: number;
  totalEdges: number;
  bySource: Record<string, { nodes: number; edges: number; skipped: number }>;
}> {
  const stateDir = join(
    BASE_DIR,
    "skills",
    "ContextGraph",
    "State"
  );
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });

  const stateManager = createStateManager<ExtractionState>({
    path: STATE_FILE,
    schema: ExtractionStateSchema as any,
    defaults: createDefaultExtractionState,
    version: 1,
  });

  const extractionState = await stateManager.load();
  const gm = createGraphManager();

  // Load existing graph to check for duplicates
  const currentState = await gm.loadState();
  const existingNodeIds = new Set(Object.keys(currentState.nodes));
  const existingEdgeIds = new Set(Object.keys(currentState.edges));

  // Parse since
  const sinceDate = options.since ? parseSince(options.since) : null;
  const sources = options.sources || [...ALL_SOURCES];

  // Run extractors
  const extractors: Record<SourceName, () => ExtractionResult> = {
    ratings: () =>
      extractRatings(sinceDate, extractionState.sources.ratings || { name: "ratings", lastTimestamp: "", lastLine: 0, extracted: 0 }),
    work_items: () =>
      extractWorkItems(sinceDate, extractionState.sources.work_items || { name: "work_items", lastTimestamp: "", lastLine: 0, extracted: 0 }),
    learnings: () =>
      extractLearnings(sinceDate, extractionState.sources.learnings || { name: "learnings", lastTimestamp: "", lastLine: 0, extracted: 0 }),
    context_feedback: () =>
      extractContextFeedback(sinceDate, extractionState.sources.context_feedback || { name: "context_feedback", lastTimestamp: "", lastLine: 0, extracted: 0 }),
    isc: () =>
      extractISC(sinceDate, extractionState.sources.isc || { name: "isc", lastTimestamp: "", lastLine: 0, extracted: 0 }),
  };

  const allEvents: GraphEvent[] = [];
  const bySource: Record<
    string,
    { nodes: number; edges: number; skipped: number }
  > = {};
  let totalNodes = 0;
  let totalEdges = 0;

  for (const source of sources) {
    const extractor = extractors[source];
    if (!extractor) continue;

    const result = extractor();

    // Deduplicate
    const newNodes = deduplicateNodes(result.nodes, existingNodeIds);
    const newEdges = deduplicateEdges(result.edges, existingEdgeIds);

    // Register new IDs
    for (const n of newNodes) existingNodeIds.add(n.id);
    for (const e of newEdges) existingEdgeIds.add(e.id);

    // Create events
    for (const node of newNodes) {
      allEvents.push({
        type: "node_added",
        payload: node,
        timestamp: new Date().toISOString(),
      });
    }
    for (const edge of newEdges) {
      allEvents.push({
        type: "edge_added",
        payload: edge,
        timestamp: new Date().toISOString(),
      });
    }

    bySource[source] = {
      nodes: newNodes.length,
      edges: newEdges.length,
      skipped: result.skipped,
    };
    totalNodes += newNodes.length;
    totalEdges += newEdges.length;

    // Update cursor
    if (newNodes.length > 0) {
      const latestNode = newNodes[newNodes.length - 1];
      if (!extractionState.sources[source]) {
        extractionState.sources[source] = {
          name: source,
          lastTimestamp: "",
          lastLine: 0,
          extracted: 0,
        };
      }
      extractionState.sources[source].lastTimestamp = latestNode.timestamp;
      extractionState.sources[source].extracted += newNodes.length;
    }

    // Update last line for JSONL sources
    if (source === "ratings") {
      const filePath = join(
        MEMORY_DIR,
        "LEARNING",
        "SIGNALS",
        "ratings.jsonl"
      );
      if (existsSync(filePath)) {
        const lineCount = readFileSync(filePath, "utf-8")
          .split("\n")
          .filter((l) => l.trim()).length;
        extractionState.sources[source].lastLine = lineCount;
      }
    }
    if (source === "context_feedback") {
      const filePath = join(
        MEMORY_DIR,
        "LEARNING",
        "SIGNALS",
        "context-feedback.jsonl"
      );
      if (existsSync(filePath)) {
        const lineCount = readFileSync(filePath, "utf-8")
          .split("\n")
          .filter((l) => l.trim()).length;
        extractionState.sources[source].lastLine = lineCount;
      }
    }
  }

  // Persist (unless dry run)
  if (!options.dryRun && allEvents.length > 0) {
    await gm.appendEvents(allEvents);

    extractionState.lastRun = new Date().toISOString();
    extractionState.totalExtracted += totalNodes;
    await stateManager.save(extractionState);
  }

  return { totalNodes, totalEdges, bySource };
}

// ============================================
// CLI INTERFACE
// ============================================

async function runCli(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
DecisionExtractor - Extract decision signals from Kaya data sources

Usage:
  bun DecisionExtractor.ts                       Extract from all sources
  bun DecisionExtractor.ts --since 7d            Extract since 7 days ago
  bun DecisionExtractor.ts --sources ratings,learnings  Specific sources only
  bun DecisionExtractor.ts --dry-run             Preview without persisting
  bun DecisionExtractor.ts --dry-run --json      Preview as JSON
  bun DecisionExtractor.ts --help                Show this help

Sources:
  ratings          - MEMORY/LEARNING/SIGNALS/ratings.jsonl
  work_items       - MEMORY/WORK/*/ directories
  learnings        - MEMORY/LEARNING/ALGORITHM/**/*.md
  context_feedback - MEMORY/LEARNING/SIGNALS/context-feedback.jsonl
  isc              - MEMORY/WORK/current-isc.json

Options:
  --since <duration>   Time window: 7d, 24h, 30m, 2w, or ISO date
  --sources <list>     Comma-separated source names
  --dry-run            Extract but don't persist to graph
  --json               Output as JSON (with --dry-run)
  --help               Show this help
`);
    process.exit(0);
  }

  const options: ExtractorOptions = {
    dryRun: args.includes("--dry-run"),
    json: args.includes("--json"),
  };

  const sinceIdx = args.indexOf("--since");
  if (sinceIdx !== -1 && args[sinceIdx + 1]) {
    options.since = args[sinceIdx + 1];
  }

  const sourcesIdx = args.indexOf("--sources");
  if (sourcesIdx !== -1 && args[sourcesIdx + 1]) {
    options.sources = args[sourcesIdx + 1].split(",") as SourceName[];
  }

  try {
    const result = await runExtraction(options);

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const mode = options.dryRun ? "[DRY RUN] " : "";
      console.log(
        `${mode}Extraction complete: ${result.totalNodes} nodes, ${result.totalEdges} edges`
      );
      console.log("");
      for (const [source, stats] of Object.entries(result.bySource)) {
        console.log(
          `  ${source}: ${stats.nodes} nodes, ${stats.edges} edges (${stats.skipped} skipped)`
        );
      }
      if (options.dryRun) {
        console.log(
          "\nNo changes persisted (dry run). Remove --dry-run to persist."
        );
      }
    }
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : error}`
    );
    process.exit(1);
  }
}

if (import.meta.main) {
  runCli();
}
