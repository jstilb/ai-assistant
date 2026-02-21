#!/usr/bin/env bun
/**
 * VoiceEventSynthesis - Extract patterns from voice notification events
 *
 * Must run BEFORE any cleanup of voice-events.jsonl.
 *
 * Patterns extracted:
 * - Error rate trends (connectivity issues, server down)
 * - Peak usage times (when voice is used most)
 * - Session correlation (which work types trigger voice)
 * - Message patterns (what gets announced)
 *
 * Output: MEMORY/LEARNING/SYNTHESIS/voice/YYYY-MM-patterns.md
 *
 * Usage:
 *   bun run VoiceEventSynthesis.ts [--json] [--dry-run]
 */

import { parseArgs } from "util";
import * as fs from "fs";
import * as path from "path";
import { prepareOutputPath } from "./OutputPathResolver";

// ============================================================================
// Configuration
// ============================================================================

const CLAUDE_DIR = path.join(process.env.HOME!, ".claude");
const VOICE_EVENTS_FILE = path.join(CLAUDE_DIR, "MEMORY", "VOICE", "voice-events.jsonl");
const SYNTHESIS_DIR = path.join(CLAUDE_DIR, "MEMORY", "LEARNING", "SYNTHESIS", "voice");

// ============================================================================
// Types
// ============================================================================

interface VoiceEvent {
  timestamp: string;
  session_id: string;
  message: string;
  character_count: number;
  voice_id: string;
  event_type: "success" | "failed";
  error?: string;
}

interface HourlyDistribution {
  [hour: number]: number;
}

interface SynthesisResult {
  period: string;
  totalEvents: number;
  successCount: number;
  failureCount: number;
  errorRate: number;
  peakHours: number[];
  commonErrors: { error: string; count: number }[];
  sessionCount: number;
  avgMessagesPerSession: number;
  messagePatterns: { pattern: string; count: number }[];
  recommendations: string[];
}

// ============================================================================
// Analysis Functions
// ============================================================================

function analyzeVoiceEvents(events: VoiceEvent[]): SynthesisResult {
  if (events.length === 0) {
    return {
      period: new Date().toISOString().slice(0, 7),
      totalEvents: 0,
      successCount: 0,
      failureCount: 0,
      errorRate: 0,
      peakHours: [],
      commonErrors: [],
      sessionCount: 0,
      avgMessagesPerSession: 0,
      messagePatterns: [],
      recommendations: ["No voice events to analyze"],
    };
  }

  // Basic counts
  const successCount = events.filter(e => e.event_type === "success").length;
  const failureCount = events.filter(e => e.event_type === "failed").length;
  const errorRate = failureCount / events.length;

  // Hourly distribution
  const hourlyDist: HourlyDistribution = {};
  for (let h = 0; h < 24; h++) hourlyDist[h] = 0;

  for (const event of events) {
    const hour = new Date(event.timestamp).getHours();
    hourlyDist[hour]++;
  }

  // Find peak hours (top 3)
  const peakHours = Object.entries(hourlyDist)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([hour]) => parseInt(hour));

  // Common errors
  const errorMap = new Map<string, number>();
  for (const event of events.filter(e => e.error)) {
    const count = errorMap.get(event.error!) || 0;
    errorMap.set(event.error!, count + 1);
  }
  const commonErrors = Array.from(errorMap.entries())
    .map(([error, count]) => ({ error, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // Session analysis
  const sessions = new Set(events.map(e => e.session_id));
  const sessionCount = sessions.size;
  const avgMessagesPerSession = events.length / sessionCount;

  // Message pattern analysis
  const patternCounts = new Map<string, number>();
  const patterns: Record<string, RegExp> = {
    "Task Completion": /complete|done|finish|success/i,
    "System Status": /status|check|health|running/i,
    "Error/Warning": /error|fail|issue|warn/i,
    "Progress Update": /progress|update|working|process/i,
    "Session Start/End": /start|begin|end|stop/i,
  };

  for (const event of events) {
    for (const [name, pattern] of Object.entries(patterns)) {
      if (pattern.test(event.message)) {
        patternCounts.set(name, (patternCounts.get(name) || 0) + 1);
      }
    }
  }

  const messagePatterns = Array.from(patternCounts.entries())
    .map(([pattern, count]) => ({ pattern, count }))
    .sort((a, b) => b.count - a.count);

  // Generate recommendations
  const recommendations: string[] = [];

  if (errorRate > 0.5) {
    recommendations.push("High error rate (>50%) - check voice server connectivity");
  }
  if (commonErrors.some(e => e.error?.includes("connect"))) {
    recommendations.push("Connection errors detected - verify voice server is running");
  }
  if (peakHours.some(h => h < 7 || h > 22)) {
    recommendations.push("Voice notifications during off-hours - consider quiet hours");
  }
  if (avgMessagesPerSession > 20) {
    recommendations.push("High message volume per session - consider consolidating notifications");
  }

  if (recommendations.length === 0) {
    recommendations.push("Voice notification system operating normally");
  }

  return {
    period: new Date().toISOString().slice(0, 7),
    totalEvents: events.length,
    successCount,
    failureCount,
    errorRate,
    peakHours,
    commonErrors,
    sessionCount,
    avgMessagesPerSession,
    messagePatterns,
    recommendations,
  };
}

// ============================================================================
// Report Generation
// ============================================================================

function formatReport(result: SynthesisResult): string {
  const date = new Date().toISOString().split("T")[0];

  return `# Voice Event Synthesis

**Period:** ${result.period}
**Generated:** ${date}
**Total Events:** ${result.totalEvents}

---

## Summary Statistics

| Metric | Value |
|--------|-------|
| Success Rate | ${((1 - result.errorRate) * 100).toFixed(1)}% |
| Successful | ${result.successCount} |
| Failed | ${result.failureCount} |
| Sessions | ${result.sessionCount} |
| Avg/Session | ${result.avgMessagesPerSession.toFixed(1)} |

## Peak Usage Hours

${result.peakHours.length > 0
    ? result.peakHours.map(h => `- ${h}:00 - ${h + 1}:00`).join("\n")
    : "*No peak hours detected*"}

## Common Errors

${result.commonErrors.length > 0
    ? result.commonErrors.map(e => `- **${e.count}x** ${e.error}`).join("\n")
    : "*No errors detected*"}

## Message Patterns

${result.messagePatterns.length > 0
    ? result.messagePatterns.map(p => `- **${p.pattern}:** ${p.count} messages`).join("\n")
    : "*No patterns detected*"}

## Recommendations

${result.recommendations.map((r, i) => `${i + 1}. ${r}`).join("\n")}

---

*Generated by VoiceEventSynthesis tool*
`;
}

async function writeSynthesis(result: SynthesisResult): Promise<string> {
  const { path: filepath } = await prepareOutputPath({
    skill: 'LEARNING/SYNTHESIS/voice',
    title: 'patterns',
    extension: 'md',
    includeTimestamp: false,
  });

  // Use date-based filename for this synthesis
  const date = new Date().toISOString().split("T")[0];
  const actualPath = path.join(path.dirname(filepath), `${date}-patterns.md`);

  fs.writeFileSync(actualPath, formatReport(result));
  return actualPath;
}

// ============================================================================
// CLI
// ============================================================================

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    json: { type: "boolean" },
    "dry-run": { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(`
VoiceEventSynthesis - Extract patterns from voice notification events

Usage:
  bun run VoiceEventSynthesis.ts           Run synthesis
  bun run VoiceEventSynthesis.ts --json    Output JSON instead of markdown
  bun run VoiceEventSynthesis.ts --dry-run Preview without writing

Output: MEMORY/LEARNING/SYNTHESIS/voice/YYYY-MM-DD-patterns.md
`);
  process.exit(0);
}

// Check file exists
if (!fs.existsSync(VOICE_EVENTS_FILE)) {
  const result = {
    success: false,
    message: "No voice events file found",
    eventsProcessed: 0,
  };
  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("No voice events file found at:", VOICE_EVENTS_FILE);
  }
  process.exit(0);
}

// Read events
const content = fs.readFileSync(VOICE_EVENTS_FILE, "utf-8");
const events: VoiceEvent[] = content
  .split("\n")
  .filter(line => line.trim())
  .map(line => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  })
  .filter((e): e is VoiceEvent => e !== null);

// Analyze
const result = analyzeVoiceEvents(events);

if (values.json) {
  const output = {
    success: true,
    eventsProcessed: events.length,
    errorRate: result.errorRate,
    peakHours: result.peakHours,
    recommendations: result.recommendations,
    outputFile: values["dry-run"] ? null : await writeSynthesis(result),
  };
  console.log(JSON.stringify(output, null, 2));
} else {
  console.log(`Voice Event Synthesis`);
  console.log(`Processed ${events.length} events`);
  console.log(`Error rate: ${(result.errorRate * 100).toFixed(1)}%`);
  console.log(`Sessions: ${result.sessionCount}`);

  if (values["dry-run"]) {
    console.log("\n[DRY RUN] Would write synthesis report");
  } else {
    const filepath = await writeSynthesis(result);
    console.log(`\nWrote synthesis: ${filepath}`);
  }
}
