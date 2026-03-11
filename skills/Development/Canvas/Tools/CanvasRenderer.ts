#!/usr/bin/env bun
/**
 * CanvasRenderer — Shared rendering utility for Canvas ecosystem integration
 *
 * Provides:
 * - renderToCanvas()           — render one or more specs to Canvas containers
 * - buildBriefingCanvasSpecs() — convert BlockResult[] to RenderSpec[]
 * - deliverBriefingToCanvas()  — high-level briefing delivery to Canvas
 * - mapBriefingBlockToContainerType() — block name → container type mapping
 * - buildRenderSpecs()         — convert RenderSpec[] to ContainerSpec[] with grid positioning
 *
 * CLI:
 *   echo '{"type":"markdown","title":"Test","content":"# Hello"}' | bun CanvasRenderer.ts
 *   bun CanvasRenderer.ts render '{"type":"markdown","title":"T","content":"C"}'
 *
 * @module CanvasRenderer
 * @version 1.0.0
 */

import { join } from "path";
import { canvasAvailable, type CanvasAvailabilityOptions } from "./CanvasUtils.ts";
import { positionContainersGrid, type ContainerSpec } from "./ContainerBuilder.ts";
import type { BlockResult } from "../../../Productivity/DailyBriefing/Tools/types.ts";

// ============================================================================
// Types
// ============================================================================

/** Simplified spec for rendering — consumers don't need to know ContainerSpec internals */
export interface RenderSpec {
  /** Container type matching Canvas container registry */
  type: "weather" | "table" | "markdown" | "list" | "chart" | "stat" | "calendar" | "custom";
  /** Display title for the container */
  title: string;
  /** Content: string, JSON string, or serialized data */
  content: string | unknown;
  /** Optional override for grid position */
  position?: { x: number; y: number };
}

/** Result returned by renderToCanvas() — never throws */
export interface RenderResult {
  success: boolean;
  containersRendered: number;
  containersAttempted: number;
  error?: string;
}

/** Result returned by deliverBriefingToCanvas() */
export type BriefingCanvasResult =
  | { rendered: true; containersRendered: number }
  | { rendered: false; containersRendered: 0; error: string };

/** Options for Canvas rendering calls */
export interface CanvasRenderOptions extends CanvasAvailabilityOptions {
  /** If true, skip availability check (assume connected) */
  skipAvailabilityCheck?: boolean;
  /** @internal Test hook — inject a mock CanvasClient factory */
  _clientFactory?: () => { connect: () => Promise<void>; applyLayout: (specs: ContainerSpec[]) => Promise<{ applied: number }>; destroy: () => void };
}

// ============================================================================
// Block type mapping (ISC 9, 10, 11, 12)
// ============================================================================

/**
 * Map a briefing block name to a Canvas container type.
 *
 * Spec-defined mappings:
 *  weather    → weather
 *  calendar   → table    (spec overrides ContainerBuilder default of "calendar")
 *  tasks      → table
 *  lucidTasks → table
 *  goals      → markdown
 *  habits     → list
 *  habitTracking → list
 *  unknown    → markdown (safe fallback)
 */
export function mapBriefingBlockToContainerType(
  blockName: string
): RenderSpec["type"] {
  const typeMap: Record<string, RenderSpec["type"]> = {
    weather: "weather",
    calendar: "table",
    tasks: "table",
    lucidtasks: "table",
    goals: "markdown",
    habits: "list",
    habittracking: "list",
    notes: "markdown",
    news: "markdown",
    strategies: "markdown",
    approvalqueue: "table",
    prioritycandidates: "table",
    learningpulse: "markdown",
    staleitems: "table",
    missiongrouped: "markdown",
  };

  return typeMap[blockName.toLowerCase()] ?? "markdown";
}

// ============================================================================
// buildRenderSpecs() — RenderSpec[] → positioned ContainerSpec[]
// ============================================================================

/**
 * Convert RenderSpec[] to fully positioned ContainerSpec[] ready for applyLayout().
 * Uses ContainerBuilder's grid packing to prevent overlaps (ISC 13).
 */
export function buildRenderSpecs(specs: RenderSpec[]): ContainerSpec[] {
  const rawSpecs: ContainerSpec[] = specs.map((spec, index) => ({
    id: `render-${spec.type}-${index}-${Date.now()}`,
    type: spec.type as ContainerSpec["type"],
    position: spec.position ?? { x: 0, y: 0 }, // Grid packer will reposition
    size: { width: 2, height: 1 },
    props: {
      title: spec.title,
      ...buildPropsForType(spec),
    },
    priority: index + 1,
  }));

  // Apply grid positioning to ensure no overlaps (ISC 13)
  return positionContainersGrid(rawSpecs, 4);
}

function buildPropsForType(spec: RenderSpec): Record<string, unknown> {
  const contentStr =
    typeof spec.content === "string"
      ? spec.content
      : JSON.stringify(spec.content);

  switch (spec.type) {
    case "weather":
      return { data: spec.content };
    case "table":
      return { columns: [], rows: spec.content };
    case "markdown":
      return { content: contentStr };
    case "list":
      return { items: spec.content };
    case "stat":
      return { value: spec.content };
    default:
      return { content: contentStr };
  }
}

// ============================================================================
// buildBriefingCanvasSpecs() — BlockResult[] → RenderSpec[] (ISC 6)
// ============================================================================

/**
 * Convert DailyBriefing BlockResult[] to Canvas RenderSpec[].
 * Maps each block to the correct container type per spec.
 * Failed blocks render as markdown error containers (preserves layout).
 */
export function buildBriefingCanvasSpecs(blocks: BlockResult[]): RenderSpec[] {
  return blocks.map((block): RenderSpec => {
    const hasError = !block.success || block.error !== undefined;

    if (hasError) {
      // Failed blocks fall back to markdown (ISC 14 — preserves layout)
      return {
        type: "markdown",
        title: block.blockName.charAt(0).toUpperCase() + block.blockName.slice(1),
        content: `Error: ${block.error ?? "No data available"}`,
      };
    }

    const containerType = mapBriefingBlockToContainerType(block.blockName);
    const title = block.blockName.charAt(0).toUpperCase() + block.blockName.slice(1);

    // Build content appropriate for the container type
    let content: string | unknown;
    switch (containerType) {
      case "weather":
        content = block.data;
        break;
      case "table":
        // For table types, try to extract arrays from data
        content = extractTableContent(block);
        break;
      case "markdown":
        // Use the block's own markdown rendering
        content = block.markdown;
        break;
      case "list":
        content = extractListContent(block);
        break;
      default:
        content = block.markdown;
    }

    return { type: containerType, title, content };
  });
}

function extractTableContent(block: BlockResult): unknown[] {
  // Try common data shapes for table content
  const data = block.data;
  if (Array.isArray(data.events)) return data.events as unknown[];
  if (Array.isArray(data.dueToday)) return data.dueToday as unknown[];
  if (Array.isArray(data.priorities)) return data.priorities as unknown[];
  if (Array.isArray(data.rows)) return data.rows as unknown[];
  if (Array.isArray(data.items)) return data.items as unknown[];
  // Fallback: wrap in array
  return [data];
}

function extractListContent(block: BlockResult): string[] {
  const data = block.data;
  if (Array.isArray(data.habits)) {
    return (data.habits as Array<{ name: string; rollingAvg?: number }>).map(
      (h) => h.rollingAvg !== undefined ? `${h.name}: ${h.rollingAvg}%` : h.name
    );
  }
  if (Array.isArray(data.items)) {
    return (data.items as unknown[]).map(String);
  }
  // Fallback to markdown lines
  return block.markdown.split("\n").filter((line) => line.trim().length > 0);
}

// ============================================================================
// renderToCanvas() — Core rendering utility (ISC 4, 5)
// ============================================================================

/**
 * Render one or more RenderSpecs as Canvas containers.
 *
 * Always returns a RenderResult — never throws.
 * Returns success: false with an error message if Canvas is unavailable or
 * if any connection/rendering error occurs (ISC 5, ISC 14).
 */
export async function renderToCanvas(
  specs: RenderSpec[],
  options: CanvasRenderOptions = {}
): Promise<RenderResult> {
  const { skipAvailabilityCheck = false, _clientFactory, ...availabilityOptions } = options;

  // Step 1: Check Canvas availability (unless skipped)
  if (!skipAvailabilityCheck) {
    const available = await canvasAvailable(availabilityOptions);
    if (!available) {
      return {
        success: false,
        containersRendered: 0,
        containersAttempted: specs.length,
        error: "Canvas is not available — daemon unreachable or no browser connected",
      };
    }
  }

  // Step 2: Build positioned ContainerSpec array
  const containerSpecs = buildRenderSpecs(specs);

  // Step 3: Connect and apply layout
  const daemonUrl = availabilityOptions.daemonUrl ?? "ws://localhost:18000";

  try {
    const client = _clientFactory
      ? _clientFactory()
      : await import("./CanvasClient.ts").then((m) => new m.CanvasClient());

    // Connect with timeout matching availability options
    const connectTimeout = availabilityOptions.timeoutMs ?? 5000;

    await Promise.race([
      client.connect(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("Canvas connection timeout during render")),
          connectTimeout
        )
      ),
    ]);

    try {
      const result = await client.applyLayout(containerSpecs);
      client.destroy();

      return {
        success: true,
        containersRendered: result.applied,
        containersAttempted: specs.length,
      };
    } catch (err) {
      client.destroy();
      const message = err instanceof Error ? err.message : String(err);
      console.error("[CanvasRenderer] applyLayout failed:", message);
      return {
        success: false,
        containersRendered: 0,
        containersAttempted: specs.length,
        error: `Canvas render failed: ${message}`,
      };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[CanvasRenderer] Canvas connection failed:", message);
    return {
      success: false,
      containersRendered: 0,
      containersAttempted: specs.length,
      error: `Canvas connection failed: ${message}`,
    };
  }
}

// ============================================================================
// deliverBriefingToCanvas() — High-level briefing delivery (ISC 6, 7, 8)
// ============================================================================

/**
 * Deliver a full DailyBriefing to Canvas.
 *
 * Converts BlockResult[] to RenderSpec[], then calls renderToCanvas().
 * Returns a discriminated union for easy conditional handling:
 *   { rendered: true, containersRendered: N }     — success
 *   { rendered: false, containersRendered: 0, error } — failure (ISC 7)
 *
 * Never throws. On failure, caller falls back to Telegram (ISC 8).
 */
export async function deliverBriefingToCanvas(
  blocks: BlockResult[],
  options: CanvasRenderOptions = {}
): Promise<BriefingCanvasResult> {
  try {
    const specs = buildBriefingCanvasSpecs(blocks);

    if (specs.length === 0) {
      return {
        rendered: false,
        containersRendered: 0,
        error: "No briefing blocks to render",
      };
    }

    const result = await renderToCanvas(specs, options);

    if (result.success) {
      console.log(
        `[CanvasRenderer] Briefing rendered in Canvas with ${result.containersRendered} containers.`
      );
      return {
        rendered: true,
        containersRendered: result.containersRendered,
      };
    }

    console.error("[CanvasRenderer] Briefing Canvas delivery failed:", result.error);
    return {
      rendered: false,
      containersRendered: 0,
      error: result.error ?? "Unknown render error",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[CanvasRenderer] Unexpected error during briefing delivery:", message);
    return {
      rendered: false,
      containersRendered: 0,
      error: `Unexpected error: ${message}`,
    };
  }
}

// ============================================================================
// CLI Interface (Article II compliance)
// ============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);
  const [command] = args;

  async function main(): Promise<void> {
    // Stdin pipe mode: echo '{"type":"markdown","title":"T","content":"C"}' | bun CanvasRenderer.ts
    if (!command || command === "render") {
      let specJson: string;

      if (!command) {
        // Read from stdin
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) {
          chunks.push(chunk as Buffer);
        }
        specJson = Buffer.concat(chunks).toString("utf-8").trim();
      } else {
        specJson = args[1];
        if (!specJson) {
          console.error('Usage: bun CanvasRenderer.ts render \'{"type":"markdown","title":"T","content":"C"}\'');
          process.exit(1);
        }
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(specJson);
      } catch {
        console.error("[CanvasRenderer] Invalid JSON input");
        process.exit(1);
      }

      const specs: RenderSpec[] = Array.isArray(parsed)
        ? (parsed as RenderSpec[])
        : [parsed as RenderSpec];

      const result = await renderToCanvas(specs);
      console.log(JSON.stringify(result, null, 2));

      if (!result.success) {
        process.exit(1);
      }
    } else {
      console.error(
        "Usage: echo '<json>' | bun CanvasRenderer.ts\n" +
        "   or: bun CanvasRenderer.ts render '<json>'\n" +
        "\nExample:\n" +
        "  echo '{\"type\":\"markdown\",\"title\":\"Test\",\"content\":\"# Hello\"}' | bun CanvasRenderer.ts"
      );
      process.exit(1);
    }
  }

  main().catch((err) => {
    console.error(
      "[CanvasRenderer] Error:",
      err instanceof Error ? err.message : String(err)
    );
    process.exit(1);
  });
}
