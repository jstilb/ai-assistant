import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, existsSync, rmSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";

/**
 * ReplayEngine.m2.test.ts - M2 Enhanced Replay Engine Tests
 *
 * Tests for new M2 features:
 * - Load JSONL transcript files
 * - Step-through mode (advance one event at a time)
 * - Diff mode (compare two transcript runs)
 * - Filter by agent ID, fault type, or time range
 * - Replay fault sequences for debugging
 */

import {
  loadJsonlTranscript,
  createReplaySession,
  diffTranscripts,
  filterTranscriptEvents,
  type JsonlTranscriptEvent,
  type ReplaySession,
  type TranscriptDiff,
  type TranscriptFilter,
} from "../ReplayEngine.ts";

const TEST_DIR = "/tmp/simulation-replay-m2-test";

function makeEvent(overrides: Partial<JsonlTranscriptEvent> = {}): JsonlTranscriptEvent {
  return {
    timestamp: new Date().toISOString(),
    agent_id: "agent-1",
    tool_name: "Read",
    trigger_condition: "call_count",
    fault_type: "network_timeout",
    fault_params: {},
    outcome: "fault_injected",
    ...overrides,
  };
}

function writeJsonlFile(path: string, events: JsonlTranscriptEvent[]): void {
  const content = events.map(e => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(path, content);
}

describe("ReplayEngine M2 - Enhanced Features", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // -- JSONL Loading --

  describe("loadJsonlTranscript", () => {
    test("loads valid JSONL transcript file", () => {
      const events = [
        makeEvent({ agent_id: "a1", tool_name: "Read" }),
        makeEvent({ agent_id: "a1", tool_name: "Bash" }),
        makeEvent({ agent_id: "a2", tool_name: "Edit" }),
      ];
      const path = join(TEST_DIR, "test.jsonl");
      writeJsonlFile(path, events);

      const loaded = loadJsonlTranscript(path);
      expect(loaded).toHaveLength(3);
      expect(loaded[0].tool_name).toBe("Read");
      expect(loaded[2].agent_id).toBe("a2");
    });

    test("returns empty array for non-existent file", () => {
      const loaded = loadJsonlTranscript(join(TEST_DIR, "nonexistent.jsonl"));
      expect(loaded).toHaveLength(0);
    });

    test("skips malformed lines gracefully", () => {
      const path = join(TEST_DIR, "mixed.jsonl");
      const goodEvent = makeEvent({ tool_name: "Read" });
      const content = JSON.stringify(goodEvent) + "\n" + "not-valid-json\n" + JSON.stringify(makeEvent({ tool_name: "Bash" })) + "\n";
      writeFileSync(path, content);

      const loaded = loadJsonlTranscript(path);
      expect(loaded).toHaveLength(2);
      expect(loaded[0].tool_name).toBe("Read");
      expect(loaded[1].tool_name).toBe("Bash");
    });
  });

  // -- Step-Through Replay --

  describe("Step-Through Mode", () => {
    test("creates replay session from events", () => {
      const events = [
        makeEvent({ tool_name: "Read" }),
        makeEvent({ tool_name: "Bash" }),
        makeEvent({ tool_name: "Edit" }),
      ];

      const session = createReplaySession(events);
      expect(session.totalEvents).toBe(3);
      expect(session.currentIndex).toBe(0);
      expect(session.isComplete()).toBe(false);
    });

    test("step advances by one event", () => {
      const events = [
        makeEvent({ tool_name: "Read" }),
        makeEvent({ tool_name: "Bash" }),
      ];

      const session = createReplaySession(events);
      const event1 = session.step();
      expect(event1!.tool_name).toBe("Read");
      expect(session.currentIndex).toBe(1);

      const event2 = session.step();
      expect(event2!.tool_name).toBe("Bash");
      expect(session.currentIndex).toBe(2);
      expect(session.isComplete()).toBe(true);
    });

    test("step returns null when complete", () => {
      const events = [makeEvent({ tool_name: "Read" })];
      const session = createReplaySession(events);

      session.step();
      const result = session.step();
      expect(result).toBeNull();
    });

    test("peek shows next event without advancing", () => {
      const events = [
        makeEvent({ tool_name: "Read" }),
        makeEvent({ tool_name: "Bash" }),
      ];

      const session = createReplaySession(events);
      const peeked = session.peek();
      expect(peeked!.tool_name).toBe("Read");
      expect(session.currentIndex).toBe(0); // Not advanced
    });

    test("reset returns to beginning", () => {
      const events = [
        makeEvent({ tool_name: "Read" }),
        makeEvent({ tool_name: "Bash" }),
      ];

      const session = createReplaySession(events);
      session.step();
      session.step();
      expect(session.isComplete()).toBe(true);

      session.reset();
      expect(session.currentIndex).toBe(0);
      expect(session.isComplete()).toBe(false);
    });

    test("getHistory returns events up to current position", () => {
      const events = [
        makeEvent({ tool_name: "Read" }),
        makeEvent({ tool_name: "Bash" }),
        makeEvent({ tool_name: "Edit" }),
      ];

      const session = createReplaySession(events);
      session.step();
      session.step();

      const history = session.getHistory();
      expect(history).toHaveLength(2);
      expect(history[0].tool_name).toBe("Read");
      expect(history[1].tool_name).toBe("Bash");
    });
  });

  // -- Diff Mode --

  describe("Diff Mode", () => {
    test("diffs two identical transcripts", () => {
      const events = [
        makeEvent({ agent_id: "a1", tool_name: "Read", outcome: "fault_injected" }),
        makeEvent({ agent_id: "a1", tool_name: "Bash", outcome: "pass_through" }),
      ];

      const diff = diffTranscripts(events, events);
      expect(diff.identical).toBe(true);
      expect(diff.differences).toHaveLength(0);
      expect(diff.summary.added).toBe(0);
      expect(diff.summary.removed).toBe(0);
      expect(diff.summary.changed).toBe(0);
    });

    test("detects added events in second transcript", () => {
      const eventsA = [makeEvent({ tool_name: "Read" })];
      const eventsB = [
        makeEvent({ tool_name: "Read" }),
        makeEvent({ tool_name: "Bash" }),
      ];

      const diff = diffTranscripts(eventsA, eventsB);
      expect(diff.identical).toBe(false);
      expect(diff.summary.added).toBeGreaterThan(0);
    });

    test("detects removed events in second transcript", () => {
      const eventsA = [
        makeEvent({ tool_name: "Read" }),
        makeEvent({ tool_name: "Bash" }),
      ];
      const eventsB = [makeEvent({ tool_name: "Read" })];

      const diff = diffTranscripts(eventsA, eventsB);
      expect(diff.identical).toBe(false);
      expect(diff.summary.removed).toBeGreaterThan(0);
    });

    test("detects changed outcomes between transcripts", () => {
      const eventsA = [makeEvent({ tool_name: "Read", outcome: "fault_injected" })];
      const eventsB = [makeEvent({ tool_name: "Read", outcome: "pass_through" })];

      const diff = diffTranscripts(eventsA, eventsB);
      expect(diff.identical).toBe(false);
      expect(diff.summary.changed).toBeGreaterThan(0);
    });
  });

  // -- Filtering --

  describe("Event Filtering", () => {
    const events = [
      makeEvent({ agent_id: "agent-1", tool_name: "Read", fault_type: "network_timeout", timestamp: "2026-02-09T12:00:00Z" }),
      makeEvent({ agent_id: "agent-2", tool_name: "Bash", fault_type: "rate_limit", timestamp: "2026-02-09T12:01:00Z" }),
      makeEvent({ agent_id: "agent-1", tool_name: "Edit", fault_type: "none", timestamp: "2026-02-09T12:02:00Z" }),
      makeEvent({ agent_id: "agent-3", tool_name: "Read", fault_type: "tool_unavailable", timestamp: "2026-02-09T12:03:00Z" }),
      makeEvent({ agent_id: "agent-1", tool_name: "Bash", fault_type: "malformed_response", timestamp: "2026-02-09T12:04:00Z" }),
    ];

    test("filters by agent_id", () => {
      const filtered = filterTranscriptEvents(events, { agent_id: "agent-1" });
      expect(filtered).toHaveLength(3);
      expect(filtered.every(e => e.agent_id === "agent-1")).toBe(true);
    });

    test("filters by fault_type", () => {
      const filtered = filterTranscriptEvents(events, { fault_type: "network_timeout" });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].tool_name).toBe("Read");
    });

    test("filters by tool_name", () => {
      const filtered = filterTranscriptEvents(events, { tool_name: "Bash" });
      expect(filtered).toHaveLength(2);
    });

    test("filters by time range", () => {
      const filtered = filterTranscriptEvents(events, {
        time_start: "2026-02-09T12:01:00Z",
        time_end: "2026-02-09T12:03:00Z",
      });
      expect(filtered).toHaveLength(3); // events at 12:01, 12:02, 12:03
    });

    test("combines multiple filters with AND logic", () => {
      const filtered = filterTranscriptEvents(events, {
        agent_id: "agent-1",
        fault_type: "network_timeout",
      });
      expect(filtered).toHaveLength(1);
    });

    test("returns all events when no filter applied", () => {
      const filtered = filterTranscriptEvents(events, {});
      expect(filtered).toHaveLength(5);
    });
  });
});
