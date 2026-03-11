#!/usr/bin/env bun
/**
 * ContainerBuilder — Phase 4: AI Orchestration
 *
 * AI layout builder that classifies user intent, negotiates content types,
 * consults LayoutIntelligence for preferences, and generates positioned
 * multi-container layouts.
 *
 * Pipeline:
 *   1. Classify intent (via Inference.ts fast tier)
 *   2. Negotiate content types (data shape -> container type)
 *   3. Consult LayoutIntelligence for preferences
 *   4. Generate positioned ContainerSpec[]
 *
 * CLI:
 *   bun ContainerBuilder.ts build "show me a dashboard"
 *   bun ContainerBuilder.ts build "render briefing" --context '{"blocks":[...]}'
 *   bun ContainerBuilder.ts negotiate '{"data":[{"name":"A","status":"done"}]}'
 *
 * @module ContainerBuilder
 * @version 1.0.0
 */

import { z } from "zod";
import { join } from "path";
import {
  createLayoutIntelligence,
  type LayoutIntelligence,
  type LayoutPreference,
} from "./LayoutIntelligence.ts";
import {
  createTemplateManager,
  type TemplateConfig,
  type ContainerPlacement,
} from "./TemplateManager.ts";

// ============================================================================
// Constants
// ============================================================================

const MAX_CONTAINERS = 12;
const DEFAULT_GRID_COLUMNS = 4;

// ============================================================================
// Schemas
// ============================================================================

export const ContainerTypeSchema = z.enum([
  "table",
  "chart",
  "markdown",
  "stat",
  "list",
  "calendar",
  "weather",
  "custom",
]);

export type AIContainerType = z.infer<typeof ContainerTypeSchema>;

export const DataSourceRefSchema = z.object({
  type: z.enum(["briefing-block", "api", "file", "inline"]),
  ref: z.string(),
});

export type DataSourceRef = z.infer<typeof DataSourceRefSchema>;

export const ContainerSpecSchema = z.object({
  id: z.string().min(1),
  type: ContainerTypeSchema,
  position: z.object({
    x: z.number().int().min(0),
    y: z.number().int().min(0),
  }),
  size: z.object({
    width: z.number().int().min(1),
    height: z.number().int().min(1),
  }),
  props: z.record(z.string(), z.unknown()),
  dataSource: DataSourceRefSchema.optional(),
  priority: z.number().int().min(1),
});

export type ContainerSpec = z.infer<typeof ContainerSpecSchema>;

// ============================================================================
// Intent Classification
// ============================================================================

export type IntentCategory = "dashboard" | "briefing" | "single-update" | "custom";

interface IntentClassification {
  category: IntentCategory;
  confidence: number;
  entities: Record<string, string>;
}

/**
 * Classify intent using keyword matching as the primary method.
 * Falls back gracefully without needing Inference.ts for common intents.
 */
export function classifyIntent(intent: string): IntentClassification {
  const lower = intent.toLowerCase().trim();

  // Briefing patterns
  if (
    lower.includes("briefing") ||
    lower.includes("morning") ||
    lower.includes("daily summary") ||
    lower.includes("daily report")
  ) {
    return { category: "briefing", confidence: 0.9, entities: {} };
  }

  // Dashboard patterns
  if (
    lower.includes("dashboard") ||
    lower.includes("overview") ||
    lower.includes("summary") ||
    lower.includes("show me")
  ) {
    return { category: "dashboard", confidence: 0.85, entities: {} };
  }

  // Single update patterns
  if (
    lower.includes("refresh") ||
    lower.includes("update") ||
    lower.includes("reload")
  ) {
    // Extract target container if possible
    const targetMatch = lower.match(/(?:refresh|update|reload)\s+(?:the\s+)?(\w+)/);
    const entities: Record<string, string> = {};
    if (targetMatch) {
      entities.targetContainer = targetMatch[1];
    }
    return { category: "single-update", confidence: 0.8, entities };
  }

  // Custom / unclear
  return { category: "custom", confidence: 0.5, entities: {} };
}

/**
 * Classify intent using Inference.ts fast tier for complex intents.
 * Falls back to keyword matching if inference is unavailable.
 */
export async function classifyIntentWithInference(
  intent: string
): Promise<IntentClassification> {
  // First try keyword classification
  const keywordResult = classifyIntent(intent);
  if (keywordResult.confidence >= 0.8) {
    return keywordResult;
  }

  // For lower-confidence classifications, try Inference.ts
  try {
    const { inference } = await import("../../../../lib/core/Inference.ts");
    const result = await inference({
      systemPrompt:
        "Classify the user intent into exactly one category: dashboard, briefing, single-update, or custom. " +
        "Respond with JSON: {\"category\":\"...\",\"confidence\":0.0-1.0,\"entities\":{}}. " +
        "dashboard = overview/summary layout, briefing = daily briefing, single-update = refresh one container, custom = anything else.",
      userPrompt: intent,
      level: "fast",
      expectJson: true,
      timeout: 2000,
    });

    if (result.success && result.parsed) {
      const parsed = result.parsed as Record<string, unknown>;
      const category = parsed.category as string;
      if (["dashboard", "briefing", "single-update", "custom"].includes(category)) {
        return {
          category: category as IntentCategory,
          confidence: Math.min(1, Number(parsed.confidence) || 0.7),
          entities: (parsed.entities as Record<string, string>) || {},
        };
      }
    }
  } catch (e) {
    console.warn('[ContainerBuilder] Intent classification failed, using keyword fallback:', e);
  }

  return keywordResult;
}

// ============================================================================
// Content-Type Negotiation
// ============================================================================

interface NegotiatedType {
  type: AIContainerType;
  props: Record<string, unknown>;
}

/**
 * Analyze data shape and select the best container type.
 * Implements the content-type negotiation rules from the spec.
 */
export function negotiateContainerType(data: unknown): NegotiatedType {
  // Single number -> stat
  if (typeof data === "number") {
    return { type: "stat", props: { value: data } };
  }

  // Short string -> stat
  if (typeof data === "string" && data.length < 50 && !hasMarkdownIndicators(data)) {
    return { type: "stat", props: { value: data } };
  }

  // Markdown string
  if (typeof data === "string" && hasMarkdownIndicators(data)) {
    return { type: "markdown", props: { content: data } };
  }

  // Plain longer string -> markdown
  if (typeof data === "string") {
    return { type: "markdown", props: { content: data } };
  }

  // Array handling
  if (Array.isArray(data)) {
    if (data.length === 0) {
      return { type: "list", props: { items: [] } };
    }

    // Array of strings -> list
    if (data.every((item) => typeof item === "string")) {
      return { type: "list", props: { items: data } };
    }

    // Array of objects with consistent keys
    if (data.every((item) => typeof item === "object" && item !== null && !Array.isArray(item))) {
      const firstItem = data[0] as Record<string, unknown>;
      const keys = Object.keys(firstItem);

      // Check for calendar data (has date/time fields)
      if (isCalendarData(keys)) {
        return { type: "calendar", props: { events: data } };
      }

      // Check for time series (timestamp + numeric)
      if (isTimeSeries(keys, data as Record<string, unknown>[])) {
        const timestampKey = findTimestampKey(keys);
        const numericKeys = keys.filter(
          (k) => k !== timestampKey && typeof firstItem[k] === "number"
        );
        return {
          type: "chart",
          props: {
            xAxis: timestampKey,
            yAxis: numericKeys,
            data,
          },
        };
      }

      // Default: table with columns from keys
      return {
        type: "table",
        props: {
          columns: keys,
          rows: data,
        },
      };
    }
  }

  // Object (non-array)
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;

    // Weather data detection
    if (isWeatherData(obj)) {
      return { type: "weather", props: { data: obj } };
    }

    // Fallback: custom
    return { type: "custom", props: { raw: data } };
  }

  // Unknown type
  return { type: "custom", props: { raw: data } };
}

function hasMarkdownIndicators(text: string): boolean {
  return (
    text.includes("#") ||
    text.includes("**") ||
    text.includes("- ") ||
    text.includes("\n\n")
  );
}

function isCalendarData(keys: string[]): boolean {
  const calendarKeys = new Set(["date", "time", "start", "end", "title", "event"]);
  const matchCount = keys.filter((k) => calendarKeys.has(k.toLowerCase())).length;
  return matchCount >= 2;
}

function isTimeSeries(keys: string[], data: Record<string, unknown>[]): boolean {
  const tsKey = findTimestampKey(keys);
  if (!tsKey) return false;
  const hasNumeric = keys.some(
    (k) => k !== tsKey && typeof data[0][k] === "number"
  );
  return hasNumeric;
}

function findTimestampKey(keys: string[]): string | undefined {
  const tsPatterns = ["timestamp", "time", "date", "datetime", "created", "updated"];
  return keys.find((k) => tsPatterns.includes(k.toLowerCase()));
}

function isWeatherData(obj: Record<string, unknown>): boolean {
  const weatherKeys = new Set(["temp", "temperature", "humidity", "condition", "weather", "forecast"]);
  const matchCount = Object.keys(obj).filter((k) => weatherKeys.has(k.toLowerCase())).length;
  return matchCount >= 2;
}

// ============================================================================
// Grid Positioning
// ============================================================================

/**
 * Position containers in a grid layout without overlaps.
 * Uses a simple row-based packing algorithm.
 */
export function positionContainersGrid(
  specs: ContainerSpec[],
  gridCols: number = DEFAULT_GRID_COLUMNS
): ContainerSpec[] {
  // Track occupied cells: Map<"x,y" -> true>
  const occupied = new Set<string>();

  function isOccupied(x: number, y: number, w: number, h: number): boolean {
    for (let dx = 0; dx < w; dx++) {
      for (let dy = 0; dy < h; dy++) {
        if (occupied.has(`${x + dx},${y + dy}`)) return true;
      }
    }
    return false;
  }

  function markOccupied(x: number, y: number, w: number, h: number): void {
    for (let dx = 0; dx < w; dx++) {
      for (let dy = 0; dy < h; dy++) {
        occupied.add(`${x + dx},${y + dy}`);
      }
    }
  }

  return specs.map((spec) => {
    // Clamp size to grid
    const w = Math.min(spec.size.width, gridCols);
    const h = spec.size.height;

    // Find first available position (left-to-right, top-to-bottom)
    for (let y = 0; y < 100; y++) {
      for (let x = 0; x <= gridCols - w; x++) {
        if (!isOccupied(x, y, w, h)) {
          markOccupied(x, y, w, h);
          return {
            ...spec,
            position: { x, y },
            size: { width: w, height: h },
          };
        }
      }
    }

    // Fallback: place at bottom
    const fallbackY = Math.max(...[...occupied].map((k) => {
      const parts = k.split(",");
      return parseInt(parts[1], 10);
    }), 0) + 1;
    markOccupied(0, fallbackY, w, h);
    return {
      ...spec,
      position: { x: 0, y: fallbackY },
      size: { width: w, height: h },
    };
  });
}

// ============================================================================
// Tier Selection
// ============================================================================

export type TierResult =
  | { tier: 1; component: string; props: Record<string, unknown> }
  | { tier: 2; type: string; schema: Record<string, unknown> }
  | { tier: 3; prompt: string };

const REGISTRY_COMPONENTS: Record<string, Record<string, unknown>> = {
  weather: { location: "auto" },
  calendar: { view: "day" },
  table: { columns: [], rows: [] },
  chart: { chartType: "bar", data: {} },
  markdown: { content: "" },
  code: { code: "", language: "typescript" },
  terminal: { lines: [] },
  image: { src: "", alt: "" },
  json: { data: "{}" },
  diff: { original: "", modified: "", language: "typescript" },
  briefing: { sections: [] },
  webview: { url: "" },
  pty: { command: "" },
};

const DECLARATIVE_TYPES = new Set(["form", "list", "detail", "metric", "status"]);

export function selectTier(intent: IntentClassification, rawIntent?: string): TierResult {
  const categoryLower = intent.category.toLowerCase();
  const intentLower = rawIntent ? rawIntent.toLowerCase() : "";

  for (const [component, defaultProps] of Object.entries(REGISTRY_COMPONENTS)) {
    if (
      categoryLower.includes(component) ||
      intent.entities.targetContainer === component ||
      intentLower.includes(component)
    ) {
      return { tier: 1, component, props: { ...defaultProps } };
    }
  }

  for (const declType of DECLARATIVE_TYPES) {
    if (categoryLower.includes(declType) || intentLower.includes(declType)) {
      return { tier: 2, type: declType, schema: { type: declType, data: {} } };
    }
  }

  return { tier: 3, prompt: intent.category };
}

// ============================================================================
// Template Conversion
// ============================================================================

export function buildFromTemplate(template: TemplateConfig): ContainerSpec[] {
  const placements = template.layout.containers;
  const specs: ContainerSpec[] = placements.map(
    (placement: ContainerPlacement, index: number) => ({
      id: `tmpl-${template.id}-${index}`,
      type: (placement.type === "briefing" ? "markdown" : placement.type) as AIContainerType,
      position: {
        x: placement.position.col,
        y: placement.position.row,
      },
      size: {
        width: placement.position.colSpan ?? 1,
        height: placement.position.rowSpan ?? 1,
      },
      props: {
        ...(placement.props ?? {}),
        ...(placement.schema ? { schema: placement.schema } : {}),
        ...(placement.title ? { title: placement.title } : {}),
      },
      priority: index + 1,
    })
  );

  return positionContainersGrid(specs, template.layout.columns);
}

// ============================================================================
// Layout Builders
// ============================================================================

/**
 * Build a default dashboard layout with sensible container choices.
 */
export function buildDefaultDashboard(): ContainerSpec[] {
  const containers: ContainerSpec[] = [
    {
      id: "weather-1",
      type: "weather",
      position: { x: 0, y: 0 },
      size: { width: 1, height: 1 },
      props: { title: "Weather", location: "auto" },
      dataSource: { type: "briefing-block", ref: "weather" },
      priority: 1,
    },
    {
      id: "calendar-1",
      type: "calendar",
      position: { x: 1, y: 0 },
      size: { width: 2, height: 2 },
      props: { title: "Today's Schedule" },
      dataSource: { type: "briefing-block", ref: "calendar" },
      priority: 2,
    },
    {
      id: "tasks-1",
      type: "table",
      position: { x: 3, y: 0 },
      size: { width: 1, height: 2 },
      props: { title: "Tasks", columns: ["task", "status", "priority"] },
      dataSource: { type: "briefing-block", ref: "tasks" },
      priority: 3,
    },
    {
      id: "goals-1",
      type: "markdown",
      position: { x: 0, y: 1 },
      size: { width: 1, height: 1 },
      props: { title: "Active Goals" },
      dataSource: { type: "briefing-block", ref: "goals" },
      priority: 4,
    },
    {
      id: "stats-1",
      type: "stat",
      position: { x: 0, y: 2 },
      size: { width: 2, height: 1 },
      props: { title: "Quick Stats", value: "—" },
      dataSource: { type: "inline", ref: "stats" },
      priority: 5,
    },
  ];

  return positionContainersGrid(containers, DEFAULT_GRID_COLUMNS);
}

/**
 * Briefing block descriptor used for layout generation.
 */
export interface BriefingBlock {
  name: string;
  title: string;
  content: string | null;
  error?: string;
}

/**
 * Build a layout from daily briefing blocks.
 * Each block becomes its own container.
 */
export function buildBriefingLayout(blocks: BriefingBlock[]): ContainerSpec[] {
  const containers: ContainerSpec[] = blocks.map((block, index) => {
    const hasError = block.error || block.content === null;
    const containerType = hasError ? "markdown" : inferBriefingBlockType(block.name);

    return {
      id: `briefing-${block.name}`,
      type: containerType,
      position: { x: 0, y: 0 }, // Will be positioned by grid
      size: { width: 2, height: 1 },
      props: {
        title: block.title,
        ...(hasError
          ? { content: `Error: ${block.error || "No data available"}` }
          : inferBriefingBlockProps(block)),
      },
      dataSource: { type: "briefing-block" as const, ref: block.name },
      priority: index + 1,
    };
  });

  return positionContainersGrid(containers, DEFAULT_GRID_COLUMNS);
}

function inferBriefingBlockType(blockName: string): AIContainerType {
  const typeMap: Record<string, AIContainerType> = {
    weather: "weather",
    calendar: "calendar",
    tasks: "table",
    lucidtasks: "table",
    goals: "markdown",
    habits: "list",
    notes: "markdown",
  };
  return typeMap[blockName.toLowerCase()] || "markdown";
}

function inferBriefingBlockProps(block: BriefingBlock): Record<string, unknown> {
  switch (inferBriefingBlockType(block.name)) {
    case "weather":
      return { data: block.content };
    case "calendar":
      return { events: block.content };
    case "table":
      return { columns: [], rows: block.content };
    case "list":
      return { items: block.content };
    default:
      return { content: block.content };
  }
}

// ============================================================================
// Main Build Layout (full pipeline)
// ============================================================================

export interface LayoutRequest {
  intent: string;
  context?: Record<string, unknown>;
  targetContainer?: string;
}

export interface BuildResult {
  specs: ContainerSpec[];
  intent: IntentClassification;
  preferencesApplied: number;
  tierResult?: TierResult;
}

/**
 * Full layout build pipeline:
 *  1. Classify intent
 *  2. Build base layout
 *  3. Consult preferences and apply high-confidence ones
 *  4. Return positioned ContainerSpec[]
 */
export async function buildLayout(
  request: LayoutRequest,
  prefsPath?: string
): Promise<BuildResult> {
  // Step 0: Template-first check
  const templateManager = createTemplateManager();
  const templateMatch = templateManager.findBestTemplate(request.intent);
  if (templateMatch) {
    const templateSpecs = buildFromTemplate(templateMatch);
    return {
      specs: templateSpecs.slice(0, MAX_CONTAINERS),
      intent: { category: "custom" as IntentCategory, confidence: 1, entities: {} },
      preferencesApplied: 0,
    };
  }

  // Step 1: Classify intent
  const intent = classifyIntent(request.intent);

  // Step 2: Select tier for non-template path (pass raw intent string for keyword matching)
  const tierResult = selectTier(intent, request.intent);

  // Step 3: Build base layout based on intent category
  let specs: ContainerSpec[];

  switch (intent.category) {
    case "briefing": {
      const blocks = (request.context?.blocks as BriefingBlock[]) || [];
      if (blocks.length > 0) {
        specs = buildBriefingLayout(blocks);
      } else {
        // Default briefing blocks
        specs = buildBriefingLayout([
          { name: "weather", title: "Weather", content: "Loading..." },
          { name: "calendar", title: "Calendar", content: "Loading..." },
          { name: "tasks", title: "Tasks", content: "Loading..." },
          { name: "goals", title: "Goals", content: "Loading..." },
          { name: "habits", title: "Habits", content: "Loading..." },
        ]);
      }
      break;
    }
    case "dashboard":
    default:
      specs = buildDefaultDashboard();
      break;
  }

  // Step 3: Consult LayoutIntelligence for preferences
  let preferencesApplied = 0;
  try {
    const li = createLayoutIntelligence(prefsPath);
    const prefs = await li.consult(intent.category);

    // Apply high-confidence preferences (>= 0.7)
    for (const pref of prefs) {
      if (pref.confidence >= 0.7) {
        const targetIdx = specs.findIndex(
          (s) => s.type === pref.containerType
        );
        if (targetIdx !== -1 && pref.field === "position") {
          const pos = pref.preferredValue as { x: number; y: number };
          specs[targetIdx] = {
            ...specs[targetIdx],
            position: { x: pos.x, y: pos.y },
          };
          preferencesApplied++;
        } else if (targetIdx !== -1 && pref.field === "size") {
          const size = pref.preferredValue as { width: number; height: number };
          specs[targetIdx] = {
            ...specs[targetIdx],
            size: { width: size.width, height: size.height },
          };
          preferencesApplied++;
        }
      }
    }
  } catch (e) {
    console.warn('[ContainerBuilder] Layout preference consult failed:', e);
  }

  // Enforce max containers limit
  if (specs.length > MAX_CONTAINERS) {
    specs = specs.slice(0, MAX_CONTAINERS);
  }

  return {
    specs,
    intent,
    preferencesApplied,
    tierResult,
  };
}

// ============================================================================
// CLI Interface (Article II compliance)
// ============================================================================

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);

  async function main(): Promise<void> {
    switch (command) {
      case "build": {
        const intent = args[0];
        if (!intent) {
          console.error('Usage: bun ContainerBuilder.ts build "show me a dashboard"');
          process.exit(1);
        }

        let context: Record<string, unknown> | undefined;
        const contextIdx = args.indexOf("--context");
        if (contextIdx !== -1 && args[contextIdx + 1]) {
          context = JSON.parse(args[contextIdx + 1]) as Record<string, unknown>;
        }

        const result = await buildLayout({ intent, context });
        console.log(JSON.stringify(result.specs, null, 2));
        break;
      }
      case "negotiate": {
        const dataJson = args[0];
        if (!dataJson) {
          console.error(
            'Usage: bun ContainerBuilder.ts negotiate \'{"data":[...]}\''
          );
          process.exit(1);
        }
        const parsed = JSON.parse(dataJson) as { data: unknown };
        const result = negotiateContainerType(parsed.data);
        console.log(JSON.stringify(result, null, 2));
        break;
      }
      case "classify": {
        const intent = args[0];
        if (!intent) {
          console.error('Usage: bun ContainerBuilder.ts classify "show me a dashboard"');
          process.exit(1);
        }
        const result = classifyIntent(intent);
        console.log(JSON.stringify(result, null, 2));
        break;
      }
      default:
        console.error(
          "Usage: bun ContainerBuilder.ts <build|negotiate|classify> [args]"
        );
        process.exit(1);
    }
  }

  main().catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
