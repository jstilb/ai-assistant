#!/usr/bin/env bun
/**
 * CalendarOrchestrator.ts - Main Entry Point
 *
 * Routes natural language calendar requests through the complete pipeline:
 * Intent Parser -> Temporal Resolver -> Calendar Adapter -> Goal Alignment ->
 * Conflict Detector -> Break Engine -> Scheduling Optimizer -> Approval Router ->
 * Safety Guardrails -> Audit Logger -> Rationale Generator
 *
 * CLI Usage:
 *   echo "Schedule 2 hours for deep work" | bun run CalendarOrchestrator.ts
 *   bun run CalendarOrchestrator.ts analyze
 *   bun run CalendarOrchestrator.ts optimize
 *   bun run CalendarOrchestrator.ts goal add "Goal title" --level quarterly
 *   echo "Delete meeting" | bun run CalendarOrchestrator.ts --dry-run
 *
 * @module CalendarOrchestrator
 */

import type {
  OrchestratorResponse,
  OrchestratorConfig,
  ParsedIntent,
  CalendarEvent,
  Rationale,
} from "./types";
import { IntentType } from "./types";

// Component imports
import { parseIntent } from "./IntentParser";
import { resolveTime, isResolvedTime, isClarification } from "./TemporalResolver";
import {
  getAgenda,
  getTodayEvents,
  getWeekEvents,
  createEvent,
  deleteEvent,
  searchEvents,
} from "./GoogleCalendarAdapter";
import { addGoal, getGoalHierarchy, getActiveGoals } from "./GoalStore";
import { scoreEvent, scoreEvents, checkAlignment, generateAlignmentReport } from "./GoalAlignmentEngine";
import { analyzeBreaks, getFrameworkConfig } from "./BreakInsertionEngine";
import { detectConflicts, checkProposedConflicts } from "./ConflictDetector";
import { scoreSlot, findBestSlots, generateOptimizationSuggestions } from "./SchedulingOptimizer";
import { checkApproval, formatApprovalPrompt } from "./ApprovalRouter";
import { loadPreferences } from "./PreferenceStore";
import { createAuditEntry } from "./AuditLogger";
import {
  generateCreateRationale,
  generateDeleteRationale,
  generateQueryRationale,
  generateOptimizationRationale,
} from "./RationaleGenerator";
import { checkSafetyRules, checkDryRunMode } from "./SafetyGuardrails";
import { GoalLevel, BreakFramework } from "./types";

// ============================================
// CONFIG
// ============================================

const KAYA_DIR = process.env.KAYA_DIR || `${process.env.HOME}/.claude`;

function loadConfig(): OrchestratorConfig {
  let timezone = "America/Los_Angeles";
  try {
    const settings = JSON.parse(
      require("fs").readFileSync(`${KAYA_DIR}/settings.json`, "utf-8")
    );
    timezone = settings.principal?.timezone || timezone;
  } catch {
    // Use default
  }

  return {
    dryRun: process.argv.includes("--dry-run"),
    timezone,
    kayaDir: KAYA_DIR,
  };
}

// ============================================
// MAIN PIPELINE
// ============================================

/**
 * Process a natural language calendar request through the full pipeline.
 */
async function processRequest(
  input: string,
  config: OrchestratorConfig
): Promise<OrchestratorResponse> {
  // Step 1: Parse intent
  const intentResult = await parseIntent(input);
  if (!intentResult.success) {
    return {
      action: "error",
      success: false,
      rationale: {
        summary: `Failed to parse intent: ${intentResult.error.message}`,
        dimensions: [],
      },
      dryRun: config.dryRun,
    };
  }

  const intent = intentResult.data;

  // Step 2: Route by intent type
  switch (intent.type) {
    case IntentType.Create:
      return handleCreate(intent, config);
    case IntentType.Delete:
      return handleDelete(intent, config);
    case IntentType.Move:
      return handleMove(intent, config);
    case IntentType.Modify:
      return handleModify(intent, config);
    case IntentType.Query:
      return handleQuery(intent, config);
    case IntentType.Optimize:
      return handleOptimize(config);
    case IntentType.Analyze:
      return handleAnalyze(config);
    default:
      return {
        action: "unknown",
        success: false,
        rationale: {
          summary: `Unrecognized intent type: ${intent.type}`,
          dimensions: [],
        },
        dryRun: config.dryRun,
      };
  }
}

// ============================================
// INTENT HANDLERS
// ============================================

async function handleCreate(
  intent: ParsedIntent,
  config: OrchestratorConfig
): Promise<OrchestratorResponse> {
  // Load preferences
  const prefsResult = await loadPreferences();
  const prefs = prefsResult.success ? prefsResult.data : undefined;

  // Resolve time
  const timeExpression = intent.entities.time;
  if (!timeExpression) {
    return {
      action: "create",
      success: false,
      rationale: {
        summary: "No time specified for the event. Please include when you want to schedule it.",
        dimensions: [],
      },
      dryRun: config.dryRun,
    };
  }

  const timeResult = await resolveTime(
    timeExpression,
    intent.entities.duration || prefs?.defaultEventDuration || 60
  );

  if (!timeResult.success) {
    return {
      action: "create",
      success: false,
      rationale: {
        summary: `Failed to resolve time "${timeExpression}": ${timeResult.error.message}`,
        dimensions: [],
      },
      dryRun: config.dryRun,
    };
  }

  if (isClarification(timeResult.data)) {
    return {
      action: "create",
      success: false,
      rationale: {
        summary: timeResult.data.question,
        dimensions: [],
      },
      dryRun: config.dryRun,
    };
  }

  const resolvedTime = timeResult.data;

  // Safety check
  const safetyCheck = checkSafetyRules({
    intent,
    protectedBlocks: prefs?.protectedBlocks,
    dryRun: config.dryRun,
  });

  if (!safetyCheck.success && safetyCheck.error.code === "SAFETY_BLOCKED") {
    return {
      action: "create",
      success: false,
      rationale: {
        summary: safetyCheck.error.message,
        dimensions: [],
      },
      dryRun: config.dryRun,
    };
  }

  // Check approval
  const approval = checkApproval({
    intent,
    protectedBlocks: prefs?.protectedBlocks,
  });

  if (approval) {
    return {
      action: "create",
      success: false,
      approvalRequired: approval,
      rationale: {
        summary: formatApprovalPrompt(approval),
        dimensions: [],
      },
      dryRun: config.dryRun,
    };
  }

  // Get existing events for conflict detection
  const existingResult = await getAgenda(
    resolvedTime.start,
    resolvedTime.end
  );
  const existing = existingResult.success ? existingResult.data : [];

  // Check conflicts
  const conflicts = checkProposedConflicts(
    resolvedTime.start,
    resolvedTime.end,
    intent.entities.title || "New Event",
    existing
  );

  // Check goal alignment
  const goalAlignments = await checkAlignment(
    intent.entities.title || "",
    intent.entities.description
  );

  // Score the slot
  const slotResult = await scoreSlot({
    start: resolvedTime.start,
    end: resolvedTime.end,
    title: intent.entities.title || "",
    existingEvents: existing,
    preference: prefs?.preferredFocusTime,
    weights: prefs?.optimizationWeights,
  });

  // Break analysis
  const breakConfig = prefs?.breakFramework
    ? prefs.breakFramework
    : getFrameworkConfig(BreakFramework.FiftyTwoSeventeen);
  const allEvents = [
    ...existing,
    {
      id: "proposed",
      title: intent.entities.title || "New Event",
      start: resolvedTime.start,
      end: resolvedTime.end,
      isAllDay: false,
      isRecurring: false,
    },
  ];
  const breakAnalysis = analyzeBreaks(allEvents, breakConfig);

  // Generate rationale
  const rationale = generateCreateRationale({
    intent,
    slotScore: slotResult.success ? slotResult.data.score : undefined,
    goalAlignments: goalAlignments.success ? goalAlignments.data : undefined,
    conflicts: conflicts.length > 0 ? conflicts : undefined,
    breakAnalysis,
  });

  // Dry-run check
  const dryRunCheck = checkDryRunMode(intent.type, config.dryRun);
  if (!dryRunCheck.allowed) {
    // Log the dry-run action
    createAuditEntry({
      actionType: intent.type,
      confidence: intent.confidence,
      rationalePreview: rationale.summary.slice(0, 200),
      approvalStatus: "auto",
      dryRun: true,
    });

    return {
      action: "create",
      success: true,
      rationale: {
        ...rationale,
        summary: `[DRY-RUN] ${rationale.summary}`,
      },
      conflicts: conflicts.length > 0 ? conflicts : undefined,
      breakAnalysis,
      dryRun: true,
    };
  }

  // Execute: create the event
  const createResult = await createEvent({
    title: intent.entities.title || "New Event",
    start: resolvedTime.start,
    end: resolvedTime.end,
    location: intent.entities.location,
    description: intent.entities.description,
    attendees: intent.entities.attendees,
  });

  if (!createResult.success) {
    return {
      action: "create",
      success: false,
      rationale: {
        summary: `Failed to create event: ${createResult.error.message}`,
        dimensions: [],
      },
      dryRun: config.dryRun,
    };
  }

  // Audit log
  createAuditEntry({
    actionType: intent.type,
    confidence: intent.confidence,
    rationalePreview: rationale.summary.slice(0, 200),
    approvalStatus: "auto",
    dryRun: false,
  });

  return {
    action: "create",
    success: true,
    rationale,
    conflicts: conflicts.length > 0 ? conflicts : undefined,
    breakAnalysis,
    dryRun: false,
  };
}

async function handleDelete(
  intent: ParsedIntent,
  config: OrchestratorConfig
): Promise<OrchestratorResponse> {
  const title = intent.entities.title || intent.entities.eventId;

  if (!title) {
    return {
      action: "delete",
      success: false,
      rationale: {
        summary: "No event specified for deletion. Please provide the event name.",
        dimensions: [],
      },
      dryRun: config.dryRun,
    };
  }

  // All deletes require approval
  const approval = checkApproval({ intent });
  if (approval) {
    return {
      action: "delete",
      success: false,
      approvalRequired: approval,
      rationale: {
        summary: formatApprovalPrompt(approval),
        dimensions: [],
      },
      dryRun: config.dryRun,
    };
  }

  // Dry-run check
  const dryRunCheck = checkDryRunMode(intent.type, config.dryRun);
  if (!dryRunCheck.allowed) {
    const rationale = generateDeleteRationale({
      eventTitle: title,
      isRecurring: false,
      confirmed: true,
    });

    createAuditEntry({
      actionType: intent.type,
      confidence: intent.confidence,
      rationalePreview: `[DRY-RUN] ${rationale.summary}`,
      approvalStatus: "auto",
      dryRun: true,
    });

    return {
      action: "delete",
      success: true,
      rationale: { ...rationale, summary: `[DRY-RUN] ${rationale.summary}` },
      dryRun: true,
    };
  }

  // Execute deletion
  const deleteResult = await deleteEvent(title);
  if (!deleteResult.success) {
    return {
      action: "delete",
      success: false,
      rationale: {
        summary: `Failed to delete event: ${deleteResult.error.message}`,
        dimensions: [],
      },
      dryRun: config.dryRun,
    };
  }

  const rationale = generateDeleteRationale({
    eventTitle: title,
    isRecurring: false,
    confirmed: true,
  });

  createAuditEntry({
    actionType: intent.type,
    confidence: intent.confidence,
    rationalePreview: rationale.summary.slice(0, 200),
    approvalStatus: "approved",
    dryRun: false,
  });

  return {
    action: "delete",
    success: true,
    rationale,
    dryRun: false,
  };
}

async function handleMove(
  intent: ParsedIntent,
  config: OrchestratorConfig
): Promise<OrchestratorResponse> {
  // Move = search for event + create new + delete old
  // Simplified: return informational response
  return {
    action: "move",
    success: false,
    rationale: {
      summary: `Move operations require identifying the specific event. Please use: "Move [event name] to [new time]"`,
      dimensions: [],
    },
    dryRun: config.dryRun,
  };
}

async function handleModify(
  intent: ParsedIntent,
  config: OrchestratorConfig
): Promise<OrchestratorResponse> {
  return {
    action: "modify",
    success: false,
    rationale: {
      summary: `Modify operations require identifying the specific event and changes. Please use: "Change [event name] to [new details]"`,
      dimensions: [],
    },
    dryRun: config.dryRun,
  };
}

async function handleQuery(
  intent: ParsedIntent,
  config: OrchestratorConfig
): Promise<OrchestratorResponse> {
  // Determine query scope
  const timeRange = intent.entities.timeRange;
  let events: CalendarEvent[] = [];

  if (timeRange) {
    const result = await getAgenda(timeRange.start, timeRange.end);
    if (result.success) events = result.data;
  } else {
    // Default to today
    const result = await getTodayEvents();
    if (result.success) events = result.data;
  }

  const rationale = generateQueryRationale({
    queryType: timeRange ? "time range" : "today's agenda",
    resultCount: events.length,
  });

  createAuditEntry({
    actionType: intent.type,
    confidence: intent.confidence,
    rationalePreview: rationale.summary,
    approvalStatus: "auto",
    dryRun: config.dryRun,
  });

  return {
    action: "query",
    success: true,
    events,
    rationale,
    dryRun: config.dryRun,
  };
}

async function handleOptimize(
  config: OrchestratorConfig
): Promise<OrchestratorResponse> {
  // Get today's events
  const eventsResult = await getTodayEvents();
  if (!eventsResult.success) {
    return {
      action: "optimize",
      success: false,
      rationale: {
        summary: `Failed to fetch today's events: ${eventsResult.error.message}`,
        dimensions: [],
      },
      dryRun: config.dryRun,
    };
  }

  const events = eventsResult.data;

  // Score events for goal alignment
  const alignmentResult = await scoreEvents(events);
  const alignmentScore = alignmentResult.success
    ? alignmentResult.data.aggregateScore
    : 0;

  // Analyze breaks
  const breakConfig = getFrameworkConfig(BreakFramework.FiftyTwoSeventeen);
  const breakAnalysis = analyzeBreaks(events, breakConfig);

  // Detect conflicts
  const conflictResult = detectConflicts(events);
  const conflicts = conflictResult.success ? conflictResult.data : [];

  // Generate optimization suggestions
  const suggestionsResult = await generateOptimizationSuggestions(events);
  const suggestions = suggestionsResult.success
    ? suggestionsResult.data
    : [];

  const rationale = generateOptimizationRationale({
    suggestionCount: suggestions.length,
    goalAlignmentScore: alignmentScore,
    breakCoverage: breakAnalysis.coverage,
    conflictCount: conflicts.length,
  });

  createAuditEntry({
    actionType: "optimization",
    confidence: 1.0,
    rationalePreview: rationale.summary.slice(0, 200),
    approvalStatus: "auto",
    dryRun: config.dryRun,
  });

  return {
    action: "optimize",
    success: true,
    events,
    rationale,
    conflicts: conflicts.length > 0 ? conflicts : undefined,
    suggestions,
    breakAnalysis,
    dryRun: config.dryRun,
  };
}

async function handleAnalyze(
  config: OrchestratorConfig
): Promise<OrchestratorResponse> {
  // Get week events
  const eventsResult = await getWeekEvents();
  if (!eventsResult.success) {
    return {
      action: "analyze",
      success: false,
      rationale: {
        summary: `Failed to fetch events: ${eventsResult.error.message}`,
        dimensions: [],
      },
      dryRun: config.dryRun,
    };
  }

  const events = eventsResult.data;

  // Score for goal alignment
  const alignmentResult = await scoreEvents(events);
  const alignments = alignmentResult.success
    ? alignmentResult.data.alignments
    : [];
  const aggregateScore = alignmentResult.success
    ? alignmentResult.data.aggregateScore
    : 0;

  // Generate report
  const reportResult = await generateAlignmentReport(events);
  const report = reportResult.success ? reportResult.data : "Report generation failed";

  const rationale: Rationale = {
    summary: `Goal alignment analysis: ${aggregateScore}% overall alignment across ${events.length} events this week`,
    dimensions: [
      {
        name: "Overall Alignment",
        score: aggregateScore,
        explanation: `${alignments.filter((a) => a.overallScore > 0).length} of ${events.length} events align with active goals`,
      },
    ],
    recommendation: report,
  };

  createAuditEntry({
    actionType: "optimization",
    confidence: 1.0,
    rationalePreview: rationale.summary.slice(0, 200),
    approvalStatus: "auto",
    dryRun: config.dryRun,
  });

  return {
    action: "analyze",
    success: true,
    events,
    alignments,
    rationale,
    dryRun: config.dryRun,
  };
}

// ============================================
// GOAL MANAGEMENT
// ============================================

async function handleGoalCommand(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (subcommand === "add") {
    const title = args[1];
    if (!title) {
      console.error("Usage: goal add <title> [--level yearly|quarterly|weekly]");
      process.exit(1);
    }

    const levelIndex = args.indexOf("--level");
    const level =
      levelIndex >= 0
        ? (args[levelIndex + 1] as "yearly" | "quarterly" | "weekly")
        : "quarterly";

    const result = await addGoal(title, level as GoalLevel);
    console.log(JSON.stringify(result, null, 2));
  } else if (subcommand === "list" || subcommand === "hierarchy") {
    const result = await getGoalHierarchy();
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Goal Management:
  goal add "Title" [--level yearly|quarterly|weekly]
  goal list
  goal hierarchy`);
  }
}

// ============================================
// CLI ENTRY POINT
// ============================================

async function main(): Promise<void> {
  const config = loadConfig();
  const args = process.argv.slice(2).filter((a) => a !== "--dry-run");
  const command = args[0];

  // Handle subcommands
  if (command === "analyze") {
    const result = await handleAnalyze(config);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "optimize") {
    const result = await handleOptimize(config);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "goal") {
    await handleGoalCommand(args.slice(1));
    return;
  }

  // Read from stdin for natural language requests
  const input = await Bun.stdin.text();

  if (!input.trim() && !command) {
    console.log(`CalendarAssistant - Intelligent Calendar Management

Usage:
  echo "Schedule 2 hours for deep work tomorrow morning" | bun run CalendarOrchestrator.ts
  echo "What's on my calendar today?" | bun run CalendarOrchestrator.ts
  bun run CalendarOrchestrator.ts analyze
  bun run CalendarOrchestrator.ts optimize
  bun run CalendarOrchestrator.ts goal add "Complete Q1 report" --level quarterly
  echo "Delete all meetings tomorrow" | bun run CalendarOrchestrator.ts --dry-run

Flags:
  --dry-run    Simulate without calendar changes

Intent Types: create, modify, delete, move, query, optimize, analyze
`);
    return;
  }

  const requestInput = input.trim() || command || "";
  const result = await processRequest(requestInput, config);
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("CalendarOrchestrator error:", err);
    process.exit(1);
  });
}
