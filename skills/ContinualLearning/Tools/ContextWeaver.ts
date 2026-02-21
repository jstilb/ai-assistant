#!/usr/bin/env bun
/**
 * ContextWeaver - Combine multiple knowledge sources into unified context
 *
 * Weaves together:
 * - MemoryStore learnings
 * - TELOS goals and missions
 * - Obsidian vault notes
 * - Synthesis patterns
 * - External enrichment
 *
 * Produces context packages optimized for different use cases:
 * - Session context (quick, relevant)
 * - Deep context (comprehensive, research-grade)
 * - Goal context (focused on specific goals)
 * - Topic context (centered on a topic)
 *
 * Commands:
 *   --session         Generate session context (default)
 *   --deep            Generate comprehensive context
 *   --goal GOAL_ID    Generate goal-focused context
 *   --topic TOPIC     Generate topic-centered context
 *   --limit N         Max entries per source (default: 5)
 *   --json            Output as JSON
 *
 * Examples:
 *   bun run ContextWeaver.ts --session
 *   bun run ContextWeaver.ts --goal G28
 *   bun run ContextWeaver.ts --topic "productivity" --deep
 */

import { parseArgs } from "util";
import { existsSync, readdirSync } from "fs";
import * as path from "path";
import { memoryStore } from "../../CORE/Tools/MemoryStore";
import { loadTelosContext, connectToGoals, getGoal, type Goal, type Mission } from "./GoalConnector";
import { searchObsidian, type ObsidianNote } from "./ExternalEnricher";

// ============================================================================
// Configuration
// ============================================================================

const CLAUDE_DIR = path.join(process.env.HOME!, ".claude");
const SYNTHESIS_DIR = path.join(CLAUDE_DIR, "MEMORY", "LEARNING", "SYNTHESIS");

// ============================================================================
// Types
// ============================================================================

export interface ContextSource {
  name: string;
  type: "memory" | "telos" | "obsidian" | "synthesis";
  entries: ContextEntry[];
  relevanceScore: number;
}

export interface ContextEntry {
  title: string;
  content: string;
  source: string;
  timestamp?: string;
  relevance?: number;
  metadata?: Record<string, unknown>;
}

export interface WovenContext {
  timestamp: string;
  contextType: "session" | "deep" | "goal" | "topic";
  focus?: string;
  sources: ContextSource[];
  summary: string;
  totalEntries: number;
  estimatedTokens: number;
  markdown: string;
}

// ============================================================================
// Context Loaders
// ============================================================================

async function loadMemoryContext(options: {
  limit: number;
  topic?: string;
  goalId?: string;
}): Promise<ContextSource> {
  const entries: ContextEntry[] = [];

  // Search by topic if provided
  const searchOptions: Parameters<typeof memoryStore.search>[0] = {
    type: "learning",
    limit: options.limit * 2, // Fetch more for filtering
  };

  if (options.topic) {
    searchOptions.fullText = options.topic;
  }

  const learnings = await memoryStore.search(searchOptions);

  // Filter by goal if provided
  let filtered = learnings;
  if (options.goalId) {
    const telosContext = await loadTelosContext();
    filtered = [];
    for (const l of learnings) {
      const connections = await connectToGoals(l.content, telosContext);
      if (connections.some((c) => c.goalId === options.goalId)) {
        filtered.push(l);
      }
    }
  }

  for (const learning of filtered.slice(0, options.limit)) {
    entries.push({
      title: learning.title,
      content: learning.content.slice(0, 500),
      source: `MemoryStore/${learning.category || "learning"}`,
      timestamp: learning.timestamp,
      metadata: { id: learning.id, tags: learning.tags },
    });
  }

  return {
    name: "Memory Learnings",
    type: "memory",
    entries,
    relevanceScore: 0.9,
  };
}

async function loadTelosContextSource(options: {
  limit: number;
  goalId?: string;
}): Promise<ContextSource> {
  const entries: ContextEntry[] = [];
  const telos = await loadTelosContext();

  if (options.goalId) {
    // Focus on specific goal
    const goal = await getGoal(options.goalId, telos);
    if (goal) {
      entries.push({
        title: `${goal.id}: ${goal.title}`,
        content: `Status: ${goal.status}\nSupports: ${goal.supports}\n${goal.metric ? `Metric: ${goal.metric}` : ""}`,
        source: "TELOS/GOALS",
        metadata: { isWIG: goal.isWIG },
      });

      // Add related mission
      const missionId = goal.supports.split(" ")[0];
      const mission = telos.missions.find((m) => m.id === missionId);
      if (mission) {
        entries.push({
          title: `${mission.id}: ${mission.name}`,
          content: `Focus: ${mission.focus}\n2026 Theme: ${mission.theme2026}`,
          source: "TELOS/MISSIONS",
        });
      }
    }
  } else {
    // Add WIGs
    const wigs = telos.goals.filter((g) => g.isWIG);
    for (const wig of wigs.slice(0, options.limit)) {
      entries.push({
        title: `[WIG] ${wig.id}: ${wig.title}`,
        content: `Status: ${wig.status}\n${wig.metric ? `Metric: ${wig.metric}` : ""}`,
        source: "TELOS/GOALS",
        metadata: { isWIG: true },
      });
    }

    // Add missions summary
    for (const mission of telos.missions.slice(0, Math.min(3, options.limit))) {
      entries.push({
        title: `${mission.id}: ${mission.name}`,
        content: `Focus: ${mission.focus}`,
        source: "TELOS/MISSIONS",
      });
    }
  }

  return {
    name: "TELOS Goals & Missions",
    type: "telos",
    entries,
    relevanceScore: 0.95,
  };
}

async function loadObsidianContext(options: {
  limit: number;
  topic?: string;
}): Promise<ContextSource> {
  const entries: ContextEntry[] = [];

  if (!options.topic) {
    return {
      name: "Obsidian Notes",
      type: "obsidian",
      entries: [],
      relevanceScore: 0.7,
    };
  }

  const notes = await searchObsidian(options.topic, options.limit);

  for (const note of notes) {
    entries.push({
      title: note.name,
      content: note.content.slice(0, 400),
      source: "Obsidian",
      timestamp: note.modified.toISOString(),
      metadata: { tags: note.tags, links: note.links },
    });
  }

  return {
    name: "Obsidian Notes",
    type: "obsidian",
    entries,
    relevanceScore: 0.7,
  };
}

async function loadSynthesisContext(options: { limit: number }): Promise<ContextSource> {
  const entries: ContextEntry[] = [];

  if (!existsSync(SYNTHESIS_DIR)) {
    return {
      name: "Pattern Synthesis",
      type: "synthesis",
      entries: [],
      relevanceScore: 0.85,
    };
  }

  // Find recent synthesis files
  const monthDirs = readdirSync(SYNTHESIS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .reverse()
    .slice(0, 2);

  for (const monthDir of monthDirs) {
    const dirPath = path.join(SYNTHESIS_DIR, monthDir);
    const files = readdirSync(dirPath)
      .filter((f: string) => f.endsWith(".md"))
      .sort()
      .reverse()
      .slice(0, options.limit);

    for (const file of files) {
      try {
        const content = await Bun.file(path.join(dirPath, file)).text();
        const titleMatch = content.match(/^#\s+(.+)/m);
        entries.push({
          title: titleMatch ? titleMatch[1] : file,
          content: content.slice(0, 400),
          source: "Synthesis",
          timestamp: file.slice(0, 10),
        });
      } catch {
        // Skip unreadable files
      }
    }

    if (entries.length >= options.limit) break;
  }

  return {
    name: "Pattern Synthesis",
    type: "synthesis",
    entries: entries.slice(0, options.limit),
    relevanceScore: 0.85,
  };
}

// ============================================================================
// Context Weaving
// ============================================================================

export async function weaveSessionContext(limit: number = 5): Promise<WovenContext> {
  const sources: ContextSource[] = [];

  // Load from each source
  sources.push(await loadTelosContextSource({ limit }));
  sources.push(await loadMemoryContext({ limit }));
  sources.push(await loadSynthesisContext({ limit }));

  return buildWovenContext("session", sources);
}

export async function weaveDeepContext(
  topic?: string,
  limit: number = 10
): Promise<WovenContext> {
  const sources: ContextSource[] = [];

  sources.push(await loadTelosContextSource({ limit }));
  sources.push(await loadMemoryContext({ limit, topic }));
  sources.push(await loadSynthesisContext({ limit }));

  if (topic) {
    sources.push(await loadObsidianContext({ limit, topic }));
  }

  return buildWovenContext("deep", sources, topic);
}

export async function weaveGoalContext(
  goalId: string,
  limit: number = 5
): Promise<WovenContext> {
  const sources: ContextSource[] = [];

  sources.push(await loadTelosContextSource({ limit, goalId }));
  sources.push(await loadMemoryContext({ limit, goalId }));

  // Get goal title for Obsidian search
  const goal = await getGoal(goalId);
  if (goal) {
    sources.push(await loadObsidianContext({ limit, topic: goal.title }));
  }

  sources.push(await loadSynthesisContext({ limit }));

  return buildWovenContext("goal", sources, goalId);
}

export async function weaveTopicContext(
  topic: string,
  limit: number = 5
): Promise<WovenContext> {
  const sources: ContextSource[] = [];

  sources.push(await loadTelosContextSource({ limit }));
  sources.push(await loadMemoryContext({ limit, topic }));
  sources.push(await loadObsidianContext({ limit, topic }));
  sources.push(await loadSynthesisContext({ limit }));

  return buildWovenContext("topic", sources, topic);
}

function buildWovenContext(
  contextType: WovenContext["contextType"],
  sources: ContextSource[],
  focus?: string
): WovenContext {
  // Sort sources by relevance
  sources.sort((a, b) => b.relevanceScore - a.relevanceScore);

  // Count total entries
  const totalEntries = sources.reduce((sum, s) => sum + s.entries.length, 0);

  // Estimate tokens (rough: 4 chars per token)
  const totalChars = sources.reduce(
    (sum, s) => sum + s.entries.reduce((eSum, e) => eSum + e.title.length + e.content.length, 0),
    0
  );
  const estimatedTokens = Math.round(totalChars / 4);

  // Generate markdown
  const markdown = formatContextAsMarkdown(contextType, sources, focus);

  // Generate summary
  const summary = generateContextSummary(contextType, sources, focus);

  return {
    timestamp: new Date().toISOString(),
    contextType,
    focus,
    sources,
    summary,
    totalEntries,
    estimatedTokens,
    markdown,
  };
}

function formatContextAsMarkdown(
  contextType: WovenContext["contextType"],
  sources: ContextSource[],
  focus?: string
): string {
  let md = `# Woven Context: ${contextType}${focus ? ` - ${focus}` : ""}\n\n`;
  md += `*Generated: ${new Date().toISOString()}*\n\n`;
  md += `---\n\n`;

  for (const source of sources) {
    if (source.entries.length === 0) continue;

    md += `## ${source.name}\n\n`;

    for (const entry of source.entries) {
      md += `### ${entry.title}\n`;
      if (entry.timestamp) {
        md += `*${entry.source} | ${entry.timestamp.split("T")[0]}*\n\n`;
      } else {
        md += `*${entry.source}*\n\n`;
      }
      md += `${entry.content}\n\n`;
    }
  }

  return md;
}

function generateContextSummary(
  contextType: WovenContext["contextType"],
  sources: ContextSource[],
  focus?: string
): string {
  const sourceSummary = sources
    .filter((s) => s.entries.length > 0)
    .map((s) => `${s.entries.length} from ${s.name}`)
    .join(", ");

  switch (contextType) {
    case "session":
      return `Quick session context with ${sourceSummary}`;
    case "deep":
      return `Comprehensive context${focus ? ` for "${focus}"` : ""} with ${sourceSummary}`;
    case "goal":
      return `Goal-focused context for ${focus} with ${sourceSummary}`;
    case "topic":
      return `Topic-centered context for "${focus}" with ${sourceSummary}`;
    default:
      return `Context with ${sourceSummary}`;
  }
}

// ============================================================================
// CLI
// ============================================================================

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      session: { type: "boolean" },
      deep: { type: "boolean" },
      goal: { type: "string" },
      topic: { type: "string" },
      limit: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(`
ContextWeaver - Combine multiple knowledge sources into unified context

Usage:
  bun run ContextWeaver.ts --session         Session context (default)
  bun run ContextWeaver.ts --deep            Comprehensive context
  bun run ContextWeaver.ts --goal GOAL_ID    Goal-focused context
  bun run ContextWeaver.ts --topic TOPIC     Topic-centered context
  bun run ContextWeaver.ts --limit N         Max entries per source
  bun run ContextWeaver.ts --json            Output as JSON

Examples:
  bun run ContextWeaver.ts --session
  bun run ContextWeaver.ts --goal G28 --limit 10
  bun run ContextWeaver.ts --topic "AI tools" --deep
`);
    process.exit(0);
  }

  const limit = values.limit ? parseInt(values.limit) : 5;

  let context: WovenContext;

  if (values.goal) {
    context = await weaveGoalContext(values.goal, limit);
  } else if (values.topic) {
    if (values.deep) {
      context = await weaveDeepContext(values.topic, limit);
    } else {
      context = await weaveTopicContext(values.topic, limit);
    }
  } else if (values.deep) {
    context = await weaveDeepContext(undefined, limit);
  } else {
    context = await weaveSessionContext(limit);
  }

  if (values.json) {
    // Exclude markdown from JSON output for brevity
    const { markdown, ...rest } = context;
    console.log(JSON.stringify(rest, null, 2));
  } else {
    console.log(context.markdown);
    console.log(`---`);
    console.log(`📊 ${context.summary}`);
    console.log(`📝 ${context.totalEntries} entries | ~${context.estimatedTokens} tokens`);
  }
}

// Run if executed directly
if (import.meta.main) {
  main().catch(console.error);
}

// Functions are already exported inline with 'export async function'
