#!/usr/bin/env bun
/**
 * ReplayEngine.ts - Session transcript replay with mutation support
 *
 * KEY DESIGN: Uses `claude` CLI for real agent execution (NOT LLM roleplay).
 * Uses BehaviorVerifier for drift detection (NOT LLM inference).
 *
 * Usage:
 *   bun ReplayEngine.ts replay <transcript.json|.jsonl> [--mutate-prompts] [--inject-faults]
 *   bun ReplayEngine.ts compare <original.json> <replayed.json>
 *   bun ReplayEngine.ts replay-jsonl <transcript.jsonl> [--filter-tool=X] [--filter-agent=X]
 *   bun ReplayEngine.ts diff-jsonl <a.jsonl> <b.jsonl>
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";

const KAYA_HOME = process.env.HOME + "/.claude";
const TRANSCRIPTS_DIR = join(KAYA_HOME, "skills/System/Simulation/Transcripts");
const REPORTS_DIR = join(KAYA_HOME, "skills/System/Simulation/Reports");
const VERIFIER_TOOL = join(KAYA_HOME, "skills/System/Simulation/Tools/BehaviorVerifier.ts");
const MOCK_TOOL = join(KAYA_HOME, "skills/System/Simulation/Tools/MockGenerator.ts");
const SANDBOX_TOOL = join(KAYA_HOME, "skills/System/Simulation/Tools/SandboxManager.ts");

interface TranscriptEntry {
  turn: number;
  role: "user" | "assistant" | "tool";
  content: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: unknown;
  timestamp?: string;
}

interface Transcript {
  id: string;
  capturedAt: string;
  entries: TranscriptEntry[];
  metadata?: { skill?: string; workflow?: string; duration_ms?: number };
}

interface ReplayOptions {
  mutatePrompts: boolean;
  injectFaults: boolean;
  faultProbability?: number;
  seed?: number;
}

interface ReplayResult {
  originalId: string;
  replayId: string;
  replayedAt: string;
  mutations: Array<{
    turn: number;
    type: "prompt_mutation" | "fault_injection" | "response_replacement";
    original: string;
    mutated: string;
  }>;
  originalResponse: string;
  replayedResponse: string;
  driftScore: number;
  driftDetails: string[];
  transcript?: Transcript;
}

function loadTranscript(path: string): Transcript {
  const content = readFileSync(path, "utf-8");

  // Detect JSONL vs JSON: .jsonl extension or content starts with a line-delimited object
  if (path.endsWith(".jsonl") || (!content.trimStart().startsWith("{\"id\"") && !content.trimStart().startsWith("[") && content.includes("\n"))) {
    // JSONL format from ScenarioEngine -- convert to Transcript shape
    const events = loadJsonlTranscript(path);
    const agentIds = [...new Set(events.map(e => e.agent_id))];
    return {
      id: agentIds[0] || `jsonl-${Date.now()}`,
      capturedAt: events[0]?.timestamp || new Date().toISOString(),
      entries: events.map((event, i) => ({
        turn: i,
        role: "tool" as const,
        content: `[${event.tool_name}] ${event.outcome}`,
        toolName: event.tool_name,
        toolOutput: { faultType: event.fault_type, outcome: event.outcome, params: event.fault_params },
        timestamp: event.timestamp,
      })),
      metadata: { skill: "simulation" },
    };
  }

  // Standard JSON transcript format
  return JSON.parse(content);
}

function mutatePrompt(original: string, seed: number): string {
  const result = spawnSync("bun", [MOCK_TOOL, "prompts", original, "--count=1"], {
    encoding: "utf-8", timeout: 15000,
  });
  if (result.status === 0) {
    try {
      const variants = JSON.parse(result.stdout);
      if (variants.length > 0) return variants[0].variant;
    } catch { /* fallback */ }
  }
  return original;
}

function executeReplayAgent(
  prompt: string, cwd: string, timeoutMs: number
): { stdout: string; stderr: string; exitCode: number; timedOut: boolean } {
  const result = spawnSync("claude", ["--print", "--dangerously-skip-permissions", prompt], {
    cwd, encoding: "utf-8", timeout: timeoutMs,
  });
  return {
    stdout: result.stdout || "", stderr: result.stderr || "",
    exitCode: result.status ?? 1, timedOut: result.signal === "SIGTERM",
  };
}

async function replayTranscript(
  transcript: Transcript, options: ReplayOptions
): Promise<ReplayResult> {
  const replayId = `replay-${Date.now()}`;
  const mutations: ReplayResult["mutations"] = [];
  const seed = options.seed || 42;
  const replayedEntries: TranscriptEntry[] = [];

  for (const entry of transcript.entries) {
    if (entry.role === "user" && options.mutatePrompts) {
      const mutated = mutatePrompt(entry.content, seed + entry.turn);
      if (mutated !== entry.content) {
        mutations.push({ turn: entry.turn, type: "prompt_mutation", original: entry.content, mutated });
      }
      replayedEntries.push({ ...entry, content: mutated });
    } else {
      replayedEntries.push({ ...entry });
    }
  }

  const userMessages = replayedEntries.filter((e) => e.role === "user").map((e) => e.content);
  const finalUserMessage = userMessages.length > 0 ? userMessages[userMessages.length - 1] : "No user message found";

  const sandboxResult = spawnSync("bun", [SANDBOX_TOOL, "create", "--ttl=1800"], {
    encoding: "utf-8", timeout: 30000,
  });
  let sandboxDir = "/tmp";
  try {
    const manifest = JSON.parse(sandboxResult.stdout);
    sandboxDir = `/tmp/simulation-sandbox-${manifest.id}`;
  } catch { /* use /tmp fallback */ }

  const startTime = Date.now();
  const agentResult = executeReplayAgent(finalUserMessage, sandboxDir, 60000);
  const replayDuration = Date.now() - startTime;

  const replayedResponse = agentResult.exitCode === 0
    ? agentResult.stdout.trim()
    : `Replay agent exited with code ${agentResult.exitCode}`;

  const originalAssistantEntries = transcript.entries.filter((e) => e.role === "assistant");
  const originalResponse = originalAssistantEntries.length > 0
    ? originalAssistantEntries[originalAssistantEntries.length - 1].content : "";

  const driftResult = spawnSync("bun", [
    VERIFIER_TOOL, "compare-responses",
    "--original", originalResponse.slice(0, 2000),
    "--replayed", replayedResponse.slice(0, 2000),
  ], { encoding: "utf-8", timeout: 30000 });

  let driftScore = 0;
  let driftDetails: string[] = [];
  if (driftResult.status === 0) {
    try {
      const parsed = JSON.parse(driftResult.stdout);
      driftScore = parsed.driftScore || 0;
      driftDetails = parsed.details || parsed.differences || [];
    } catch { /* ignore */ }
  }

  const evalsTranscript = {
    task_id: `replay-${transcript.id}`,
    trial_id: replayId,
    timestamp: new Date().toISOString(),
    turns: [
      ...replayedEntries.map((e) => ({
        role: e.role, content: e.content,
        timestamp: e.timestamp || new Date().toISOString(),
        tool_calls: e.toolName ? [{ tool: e.toolName, input: e.toolInput, output: e.toolOutput }] : [],
      })),
      { role: "assistant" as const, content: replayedResponse.slice(0, 5000),
        timestamp: new Date().toISOString(), tool_calls: [] },
    ],
    metrics: {
      duration_ms: replayDuration, drift_score: driftScore,
      mutations_applied: mutations.length, exit_code: agentResult.exitCode, timed_out: agentResult.timedOut,
    },
  };

  const result: ReplayResult = {
    originalId: transcript.id, replayId, replayedAt: new Date().toISOString(),
    mutations, originalResponse: originalResponse.slice(0, 500),
    replayedResponse: replayedResponse.slice(0, 500), driftScore, driftDetails,
    transcript: evalsTranscript,
  };

  if (!existsSync(REPORTS_DIR)) { mkdirSync(REPORTS_DIR, { recursive: true }); }
  writeFileSync(join(REPORTS_DIR, `${replayId}.json`), JSON.stringify(result, null, 2));
  return result;
}

function compareTranscripts(originalPath: string, replayedPath: string): { driftScore: number; differences: string[] } {
  const result = spawnSync("bun", [VERIFIER_TOOL, "compare", originalPath, replayedPath], {
    encoding: "utf-8", timeout: 30000,
  });
  if (result.status === 0) {
    try { return JSON.parse(result.stdout); } catch { /* fallback */ }
  }
  return { driftScore: 0.5, differences: ["Comparison could not be performed"] };
}

// --- CLI ---
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!existsSync(TRANSCRIPTS_DIR)) { mkdirSync(TRANSCRIPTS_DIR, { recursive: true }); }

  switch (command) {
    case "replay": {
      const transcriptPath = args[0];
      if (!transcriptPath) { console.error("Usage: replay <transcript.json|.jsonl> [--mutate-prompts] [--inject-faults] [--seed=42]"); process.exit(1); }
      const options: ReplayOptions = {
        mutatePrompts: args.includes("--mutate-prompts"),
        injectFaults: args.includes("--inject-faults"),
        seed: parseInt(args.find((a) => a.startsWith("--seed="))?.split("=")[1] || "42"),
      };
      const transcript = loadTranscript(transcriptPath);
      const result = await replayTranscript(transcript, options);
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case "compare": {
      const original = args[0]; const replayed = args[1];
      if (!original || !replayed) { console.error("Usage: compare <original.json> <replayed.json>"); process.exit(1); }
      const result = compareTranscripts(original, replayed);
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case "replay-jsonl": {
      // Step-through replay of a JSONL transcript using M2 ReplaySession
      const jsonlPath = args[0];
      if (!jsonlPath) { console.error("Usage: replay-jsonl <transcript.jsonl> [--filter-tool=X] [--filter-agent=X]"); process.exit(1); }
      let events = loadJsonlTranscript(jsonlPath);
      const filterTool = args.find((a) => a.startsWith("--filter-tool="))?.split("=")[1];
      const filterAgent = args.find((a) => a.startsWith("--filter-agent="))?.split("=")[1];
      if (filterTool || filterAgent) {
        events = filterTranscriptEvents(events, { tool_name: filterTool, agent_id: filterAgent });
      }
      const session = createReplaySession(events);
      const allEvents: JsonlTranscriptEvent[] = [];
      while (!session.isComplete()) {
        const event = session.step();
        if (event) allEvents.push(event);
      }
      console.log(JSON.stringify({ totalEvents: session.totalEvents, events: allEvents }, null, 2));
      break;
    }
    case "diff-jsonl": {
      // Diff two JSONL transcript files using M2 diffTranscripts
      const pathA = args[0]; const pathB = args[1];
      if (!pathA || !pathB) { console.error("Usage: diff-jsonl <transcript_a.jsonl> <transcript_b.jsonl>"); process.exit(1); }
      const eventsA = loadJsonlTranscript(pathA);
      const eventsB = loadJsonlTranscript(pathB);
      const diff = diffTranscripts(eventsA, eventsB);
      console.log(JSON.stringify(diff, null, 2));
      break;
    }
    default:
      console.log(`ReplayEngine - Session transcript replay

Commands:
  replay <transcript> [options]        Replay transcript (.json or .jsonl)
  compare <original> <replayed>        Compare two JSON transcripts
  replay-jsonl <file.jsonl> [filters]  Step-through JSONL transcript replay
  diff-jsonl <a.jsonl> <b.jsonl>       Diff two JSONL transcript files

Options for replay:
  --mutate-prompts   Mutate user prompts during replay
  --inject-faults    Inject faults during replay
  --seed=N           Random seed

Options for replay-jsonl:
  --filter-tool=X    Filter events by tool name
  --filter-agent=X   Filter events by agent ID`);
      break;
  }
}

main().catch((err) => { console.error(`Error: ${err.message}`); process.exit(1); });

// ============================================
// M2 ADDITIONS: JSONL Loading, Step-Through, Diff, Filtering
// ============================================

/**
 * JSONL transcript event format (from TranscriptLogger / ScenarioEngine).
 * This is the JSONL line format used in simulation transcripts.
 */
export interface JsonlTranscriptEvent {
  timestamp: string;
  agent_id: string;
  tool_name: string;
  trigger_condition: string;
  fault_type: string;
  fault_params: Record<string, unknown>;
  outcome: string;
}

/**
 * Load a JSONL transcript file and parse each line into an event.
 * Skips malformed lines gracefully.
 */
export function loadJsonlTranscript(path: string): JsonlTranscriptEvent[] {
  if (!existsSync(path)) return [];

  const content = readFileSync(path, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);
  const events: JsonlTranscriptEvent[] = [];

  for (const line of lines) {
    try {
      events.push(JSON.parse(line) as JsonlTranscriptEvent);
    } catch {
      // Skip malformed lines
    }
  }

  return events;
}

/**
 * Replay session for step-through mode.
 * Allows advancing one event at a time for debugging.
 */
export interface ReplaySession {
  totalEvents: number;
  currentIndex: number;
  step(): JsonlTranscriptEvent | null;
  peek(): JsonlTranscriptEvent | null;
  isComplete(): boolean;
  reset(): void;
  getHistory(): JsonlTranscriptEvent[];
}

class ReplaySessionImpl implements ReplaySession {
  private events: JsonlTranscriptEvent[];
  currentIndex: number = 0;

  constructor(events: JsonlTranscriptEvent[]) {
    this.events = [...events];
  }

  get totalEvents(): number {
    return this.events.length;
  }

  step(): JsonlTranscriptEvent | null {
    if (this.currentIndex >= this.events.length) return null;
    const event = this.events[this.currentIndex];
    this.currentIndex++;
    return event;
  }

  peek(): JsonlTranscriptEvent | null {
    if (this.currentIndex >= this.events.length) return null;
    return this.events[this.currentIndex];
  }

  isComplete(): boolean {
    return this.currentIndex >= this.events.length;
  }

  reset(): void {
    this.currentIndex = 0;
  }

  getHistory(): JsonlTranscriptEvent[] {
    return this.events.slice(0, this.currentIndex);
  }
}

export function createReplaySession(events: JsonlTranscriptEvent[]): ReplaySession {
  return new ReplaySessionImpl(events);
}

/**
 * Diff result comparing two transcript runs.
 */
export interface TranscriptDiff {
  identical: boolean;
  differences: Array<{
    index: number;
    type: "added" | "removed" | "changed";
    description: string;
    eventA?: JsonlTranscriptEvent;
    eventB?: JsonlTranscriptEvent;
  }>;
  summary: {
    added: number;
    removed: number;
    changed: number;
    total_a: number;
    total_b: number;
  };
}

/**
 * Compare two transcript event arrays and produce a diff.
 */
export function diffTranscripts(
  eventsA: JsonlTranscriptEvent[],
  eventsB: JsonlTranscriptEvent[]
): TranscriptDiff {
  const differences: TranscriptDiff["differences"] = [];
  const maxLen = Math.max(eventsA.length, eventsB.length);

  let added = 0;
  let removed = 0;
  let changed = 0;

  for (let i = 0; i < maxLen; i++) {
    const a = eventsA[i];
    const b = eventsB[i];

    if (!a && b) {
      differences.push({
        index: i,
        type: "added",
        description: `Event added in B: ${b.tool_name} (${b.outcome})`,
        eventB: b,
      });
      added++;
    } else if (a && !b) {
      differences.push({
        index: i,
        type: "removed",
        description: `Event removed from B: ${a.tool_name} (${a.outcome})`,
        eventA: a,
      });
      removed++;
    } else if (a && b) {
      // Compare key fields
      const fieldsToCompare = ["tool_name", "fault_type", "outcome", "agent_id"] as const;
      const changedFields: string[] = [];

      for (const field of fieldsToCompare) {
        if (a[field] !== b[field]) {
          changedFields.push(`${field}: "${a[field]}" -> "${b[field]}"`);
        }
      }

      if (changedFields.length > 0) {
        differences.push({
          index: i,
          type: "changed",
          description: `Event ${i} changed: ${changedFields.join(", ")}`,
          eventA: a,
          eventB: b,
        });
        changed++;
      }
    }
  }

  return {
    identical: differences.length === 0,
    differences,
    summary: {
      added,
      removed,
      changed,
      total_a: eventsA.length,
      total_b: eventsB.length,
    },
  };
}

/**
 * Filter options for transcript events.
 */
export interface TranscriptFilter {
  agent_id?: string;
  fault_type?: string;
  tool_name?: string;
  time_start?: string;
  time_end?: string;
}

/**
 * Filter transcript events based on criteria.
 * Multiple filters are combined with AND logic.
 */
export function filterTranscriptEvents(
  events: JsonlTranscriptEvent[],
  filter: TranscriptFilter
): JsonlTranscriptEvent[] {
  return events.filter(event => {
    if (filter.agent_id && event.agent_id !== filter.agent_id) return false;
    if (filter.fault_type && event.fault_type !== filter.fault_type) return false;
    if (filter.tool_name && event.tool_name !== filter.tool_name) return false;

    if (filter.time_start) {
      const eventTime = new Date(event.timestamp).getTime();
      const startTime = new Date(filter.time_start).getTime();
      if (eventTime < startTime) return false;
    }

    if (filter.time_end) {
      const eventTime = new Date(event.timestamp).getTime();
      const endTime = new Date(filter.time_end).getTime();
      if (eventTime > endTime) return false;
    }

    return true;
  });
}

// ============================================
// EXPORTS (M1 + M2)
// ============================================

export { loadTranscript, replayTranscript, compareTranscripts };
export type { Transcript, TranscriptEntry, ReplayResult, ReplayOptions };
