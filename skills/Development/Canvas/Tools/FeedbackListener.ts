#!/usr/bin/env bun
/**
 * FeedbackListener — Canvas Tier 3: Self-Improving
 *
 * Processes canvas.layout.feedback events received via WebSocket and
 * stores layout preference deltas in LayoutIntelligence.
 *
 * Wiring:
 *   Browser → canvas.layout.feedback event → processFeedbackEvent()
 *   → LayoutIntelligence.store() for each position/size/type delta
 *   → layout-preferences.json updated
 *
 * Skipped fields: "removed", "added" (per RespondToFeedback.md spec)
 *
 * Usage (standalone):
 *   bun FeedbackListener.ts
 *
 * @module FeedbackListener
 * @version 1.0.0
 */

import {
  createLayoutIntelligence,
  type LayoutIntelligence,
  type LayoutDelta,
} from "./LayoutIntelligence.ts";
import { CanvasClient } from "./CanvasClient.ts";

// ============================================================================
// Types
// ============================================================================

/**
 * The canvas.layout.feedback event format emitted by the browser's
 * feedback-encoder.ts after a user drag, resize, or container change.
 */
export interface LayoutFeedbackDelta {
  containerId: string;
  containerType: string;
  field: "position" | "size" | "removed" | "added";
  before: { x: number; y: number } | { width: number; height: number } | null;
  after: { x: number; y: number } | { width: number; height: number } | null;
}

export interface LayoutFeedbackEvent {
  method: "canvas.layout.feedback";
  params: {
    deltas: LayoutFeedbackDelta[];
    timestamp: number;
    intentContext?: string;
  };
}

// ============================================================================
// Core Processing Logic
// ============================================================================

/**
 * Fields to store as preferences.
 * "removed" and "added" are skipped per RespondToFeedback.md spec.
 */
const STORABLE_FIELDS = new Set(["position", "size", "type"]);

/**
 * Process a canvas.layout.feedback event.
 *
 * For each delta in the event:
 *   - If field is "position" or "size": call LayoutIntelligence.store()
 *   - If field is "removed" or "added": skip (deferred learning)
 *
 * @param event  The feedback event from the browser
 * @param li     LayoutIntelligence instance (injected for testability)
 */
export async function processFeedbackEvent(
  event: LayoutFeedbackEvent,
  li: LayoutIntelligence
): Promise<void> {
  const { deltas, timestamp, intentContext } = event.params;

  // Default to "dashboard" if no intent context provided
  const intent = intentContext ?? "dashboard";

  for (const delta of deltas) {
    // Skip removed and added — not stored as preferences
    if (!STORABLE_FIELDS.has(delta.field)) {
      continue;
    }

    // Convert browser LayoutFeedbackDelta → LayoutIntelligence LayoutDelta
    const layoutDelta: LayoutDelta = {
      containerId: delta.containerId,
      field: delta.field as LayoutDelta["field"],
      from: delta.before,
      to: delta.after,
      timestamp,
    };

    await li.store(intent, delta.containerType, layoutDelta);
  }
}

// ============================================================================
// Standalone Listener (connects to daemon and processes feedback events)
// ============================================================================

/**
 * Start the feedback listener as a persistent process.
 * Connects to the daemon via CanvasClient and routes
 * canvas.layout.feedback notifications to processFeedbackEvent().
 */
async function startFeedbackListener(): Promise<void> {
  const li = createLayoutIntelligence();
  const client = new CanvasClient();

  console.log("[FeedbackListener] Connecting to daemon...");

  try {
    await client.connect();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[FeedbackListener] Failed to connect:", msg);
    process.exit(1);
  }

  console.log("[FeedbackListener] Connected — listening for canvas.layout.feedback events");

  // Register feedback handler on the client via the container event system.
  // CanvasClient already has a stub for canvas.layout.feedback in handleCanvasRpc().
  // We extend it by registering a raw notification handler.
  client.onLayoutFeedback(async (event: LayoutFeedbackEvent) => {
    try {
      const deltaCount = event.params.deltas.length;
      const intent = event.params.intentContext ?? "dashboard";
      console.log(
        `[FeedbackListener] Processing ${deltaCount} delta(s) for intent="${intent}"`
      );
      await processFeedbackEvent(event, li);
      console.log("[FeedbackListener] Preferences updated.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[FeedbackListener] Error processing feedback:", msg);
    }
  });

  process.on("SIGINT", () => {
    console.log("[FeedbackListener] Shutting down");
    client.destroy();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    console.log("[FeedbackListener] Terminated");
    client.destroy();
    process.exit(0);
  });
}

// ============================================================================
// CLI Entry Point
// ============================================================================

if (import.meta.main) {
  startFeedbackListener().catch((err) => {
    console.error("[FeedbackListener] Fatal:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
