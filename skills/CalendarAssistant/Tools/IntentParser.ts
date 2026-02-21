#!/usr/bin/env bun
/**
 * IntentParser.ts - Natural Language to Structured Intent
 *
 * Parses user natural language into structured intent using LLM inference.
 * Uses Haiku (fast) for simple CRUD requests and Sonnet (standard) for
 * complex optimization/analysis requests.
 *
 * Supports 7 intent types: create, modify, delete, move, query, optimize, analyze
 *
 * @module IntentParser
 */

import type { ParsedIntent, IntentEntities, Result, CalendarError } from "./types";
import { IntentType } from "./types";

const KAYA_DIR = process.env.KAYA_DIR || `${process.env.HOME}/.claude`;
const INFERENCE_TOOL = `${KAYA_DIR}/skills/CORE/Tools/Inference.ts`;

// ============================================
// INTENT CLASSIFICATION
// ============================================

/**
 * Quick regex-based pre-classification to determine LLM routing.
 * Returns whether request is simple (Haiku) or complex (Sonnet).
 */
function isComplexRequest(input: string): boolean {
  const complexPatterns = [
    /optimi[sz]e/i,
    /analy[sz]e/i,
    /suggest/i,
    /recommend/i,
    /best time/i,
    /how aligned/i,
    /goal alignment/i,
    /schedule health/i,
    /rearrange/i,
    /reorgani[sz]e/i,
    /when should/i,
    /improve.*schedule/i,
  ];
  return complexPatterns.some((p) => p.test(input));
}

/**
 * Build the prompt for intent classification.
 */
function buildClassificationPrompt(input: string): string {
  return `You are a calendar intent classifier. Parse the following natural language request into a structured intent.

Intent types:
- create: Schedule a new event (e.g., "schedule a meeting", "add an event", "block time for")
- modify: Change existing event details (e.g., "change the title", "update the description", "add attendees to")
- delete: Remove an event (e.g., "cancel", "delete", "remove")
- move: Reschedule to different time (e.g., "move to", "reschedule", "push back")
- query: Ask about calendar state (e.g., "what's on", "am I free", "show my schedule", "when is")
- optimize: Request scheduling optimization (e.g., "optimize", "suggest", "improve", "best time for")
- analyze: Get goal alignment analysis (e.g., "how aligned", "analyze", "goal progress", "time audit")

User request: "${input}"

Respond with ONLY a JSON object (no markdown, no explanation):
{
  "type": "<intent_type>",
  "confidence": <0.0-1.0>,
  "entities": {
    "title": "<event title or null>",
    "time": "<time expression or null>",
    "endTime": "<end time expression or null>",
    "duration": <duration in minutes or null>,
    "attendees": [<email addresses>] or null,
    "location": "<location or null>",
    "recurrence": "<recurrence pattern or null>",
    "description": "<description or null>",
    "eventId": "<event identifier or null>",
    "timeRange": {"start": "<start>", "end": "<end>"} or null
  }
}`;
}

/**
 * Parse LLM response into a structured intent.
 */
function parseIntentResponse(
  response: string,
  rawInput: string
): Result<ParsedIntent, CalendarError> {
  try {
    // Extract JSON from response (handle markdown wrapping)
    let jsonStr = response.trim();
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim();
    }

    // Try to find JSON object in the response
    const objectMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      jsonStr = objectMatch[0];
    }

    const parsed = JSON.parse(jsonStr);

    // Validate intent type
    const validTypes = Object.values(IntentType);
    if (!validTypes.includes(parsed.type as IntentType)) {
      return {
        success: false,
        error: {
          code: "PARSE_ERROR",
          message: `Invalid intent type: ${parsed.type}`,
          retryable: true,
        },
      };
    }

    // Build entities, filtering out null values
    const entities: IntentEntities = {};
    if (parsed.entities) {
      if (parsed.entities.title) entities.title = parsed.entities.title;
      if (parsed.entities.time) entities.time = parsed.entities.time;
      if (parsed.entities.endTime) entities.endTime = parsed.entities.endTime;
      if (parsed.entities.duration) entities.duration = parsed.entities.duration;
      if (parsed.entities.attendees?.length)
        entities.attendees = parsed.entities.attendees;
      if (parsed.entities.location) entities.location = parsed.entities.location;
      if (parsed.entities.recurrence)
        entities.recurrence = parsed.entities.recurrence;
      if (parsed.entities.description)
        entities.description = parsed.entities.description;
      if (parsed.entities.eventId) entities.eventId = parsed.entities.eventId;
      if (parsed.entities.timeRange)
        entities.timeRange = parsed.entities.timeRange;
    }

    return {
      success: true,
      data: {
        type: parsed.type as IntentType,
        confidence: Math.max(0, Math.min(1, parsed.confidence || 0.5)),
        entities,
        rawInput,
      },
    };
  } catch (err) {
    return {
      success: false,
      error: {
        code: "PARSE_ERROR",
        message: `Failed to parse LLM intent response: ${err instanceof Error ? err.message : String(err)}`,
        retryable: true,
      },
    };
  }
}

// ============================================
// PUBLIC API
// ============================================

/**
 * Parse a natural language calendar request into a structured intent.
 *
 * Routes to fast (Haiku) for simple CRUD or standard (Sonnet) for
 * complex optimization/analysis requests.
 *
 * @param input - Natural language calendar request
 * @returns Parsed intent with type, confidence, and entities
 */
export async function parseIntent(
  input: string
): Promise<Result<ParsedIntent, CalendarError>> {
  if (!input || input.trim().length === 0) {
    return {
      success: false,
      error: {
        code: "VALIDATION",
        message: "Empty input - please provide a calendar request",
        retryable: false,
      },
    };
  }

  const inferenceLevel = isComplexRequest(input) ? "standard" : "fast";
  const prompt = buildClassificationPrompt(input);

  try {
    // Shell-escape the prompt for piping
    const escapedPrompt = prompt.replace(/'/g, "'\\''");
    const proc = Bun.spawn(
      ["bash", "-c", `echo '${escapedPrompt}' | bun ${INFERENCE_TOOL} ${inferenceLevel}`],
      { stdout: "pipe", stderr: "pipe" }
    );

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      return {
        success: false,
        error: {
          code: "API_UNAVAILABLE",
          message: `Inference tool failed (exit ${exitCode}): ${stderr.slice(0, 200)}`,
          retryable: true,
          retryAfterMs: 2000,
        },
      };
    }

    return parseIntentResponse(output, input);
  } catch (err) {
    // Fallback: try regex-based classification
    return fallbackClassification(input);
  }
}

/**
 * Fallback regex-based classification when LLM is unavailable.
 * Provides degraded but functional intent parsing.
 */
function fallbackClassification(
  input: string
): Result<ParsedIntent, CalendarError> {
  const lower = input.toLowerCase().trim();
  let type: IntentType = IntentType.Query;
  let confidence = 0.6;

  // Create patterns
  if (/\b(schedule|add|create|book|block|set up|plan)\b/i.test(lower)) {
    type = IntentType.Create;
    confidence = 0.7;
  }
  // Delete patterns
  else if (/\b(delete|cancel|remove|drop)\b/i.test(lower)) {
    type = IntentType.Delete;
    confidence = 0.75;
  }
  // Move patterns
  else if (/\b(move|reschedule|push|shift|postpone)\b/i.test(lower)) {
    type = IntentType.Move;
    confidence = 0.7;
  }
  // Modify patterns
  else if (/\b(change|update|edit|modify|rename)\b/i.test(lower)) {
    type = IntentType.Modify;
    confidence = 0.7;
  }
  // Optimize patterns
  else if (/\b(optimize|suggest|recommend|best time|improve)\b/i.test(lower)) {
    type = IntentType.Optimize;
    confidence = 0.65;
  }
  // Analyze patterns
  else if (/\b(analyze|alignment|audit|goal|progress|health)\b/i.test(lower)) {
    type = IntentType.Analyze;
    confidence = 0.65;
  }
  // Query (default)
  else if (
    /\b(what|when|show|list|tell|am i free|do i have|how many|agenda)\b/i.test(
      lower
    )
  ) {
    type = IntentType.Query;
    confidence = 0.7;
  }

  // Try to extract basic entities
  const entities: IntentEntities = {};

  // Extract quoted title
  const quotedTitle = input.match(/"([^"]+)"|'([^']+)'/);
  if (quotedTitle) {
    entities.title = quotedTitle[1] || quotedTitle[2];
  }

  // Extract duration
  const durationMatch = input.match(
    /(\d+)\s*(?:hour|hr|h)(?:s)?(?:\s*(?:and\s*)?(\d+)\s*(?:min|minute|m))?/i
  );
  if (durationMatch) {
    entities.duration =
      parseInt(durationMatch[1]) * 60 +
      (durationMatch[2] ? parseInt(durationMatch[2]) : 0);
  } else {
    const minMatch = input.match(/(\d+)\s*(?:min|minute)s?/i);
    if (minMatch) {
      entities.duration = parseInt(minMatch[1]);
    }
  }

  return {
    success: true,
    data: {
      type,
      confidence,
      entities,
      rawInput: input,
    },
  };
}

// CLI interface
if (import.meta.main) {
  const input = await Bun.stdin.text();

  if (!input.trim()) {
    console.log(`IntentParser - Natural Language Calendar Intent Classification

Usage:
  echo "Schedule a meeting tomorrow at 2pm" | bun run IntentParser.ts

Intent Types: create, modify, delete, move, query, optimize, analyze
`);
    process.exit(0);
  }

  const result = await parseIntent(input.trim());
  console.log(JSON.stringify(result, null, 2));
}
