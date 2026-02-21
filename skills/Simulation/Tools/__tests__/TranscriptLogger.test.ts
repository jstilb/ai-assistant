import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync, readFileSync, mkdirSync } from "fs";
import { join } from "path";
import {
  createTranscriptLogger,
  type TranscriptEvent,
} from "../TranscriptLogger.ts";

// ============================================
// ISC #5: Transcript Logger Tests
// JSONL format, flush-on-write, structured events
// ============================================

const TEST_DIR = "/tmp/simulation-transcript-tests";
const TEST_FILE = join(TEST_DIR, "test-transcript.jsonl");

describe("TranscriptLogger", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    if (existsSync(TEST_FILE)) unlinkSync(TEST_FILE);
  });

  afterEach(() => {
    if (existsSync(TEST_FILE)) unlinkSync(TEST_FILE);
  });

  test("creates JSONL file on first log", () => {
    const logger = createTranscriptLogger(TEST_FILE);
    logger.log({
      timestamp: new Date().toISOString(),
      agent_id: "test-agent",
      tool_name: "Read",
      trigger_condition: "call_count",
      fault_type: "network_timeout",
      fault_params: { delay_ms: 5000 },
      outcome: "fault_injected",
    });

    expect(existsSync(TEST_FILE)).toBe(true);
  });

  test("writes valid JSON per line", () => {
    const logger = createTranscriptLogger(TEST_FILE);

    logger.log({
      timestamp: "2026-02-09T12:00:00Z",
      agent_id: "agent-1",
      tool_name: "Read",
      trigger_condition: "call_count",
      fault_type: "network_timeout",
      fault_params: { threshold: 3 },
      outcome: "fault_injected",
    });

    logger.log({
      timestamp: "2026-02-09T12:00:01Z",
      agent_id: "agent-1",
      tool_name: "Bash",
      trigger_condition: "random_probability",
      fault_type: "tool_unavailable",
      fault_params: { probability: 0.5 },
      outcome: "pass_through",
    });

    const content = readFileSync(TEST_FILE, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(2);

    const event1 = JSON.parse(lines[0]);
    expect(event1.tool_name).toBe("Read");
    expect(event1.agent_id).toBe("agent-1");

    const event2 = JSON.parse(lines[1]);
    expect(event2.tool_name).toBe("Bash");
    expect(event2.outcome).toBe("pass_through");
  });

  test("each event has all required fields", () => {
    const logger = createTranscriptLogger(TEST_FILE);
    const event: TranscriptEvent = {
      timestamp: new Date().toISOString(),
      agent_id: "test-agent",
      tool_name: "WebFetch",
      trigger_condition: "time_window",
      fault_type: "malformed_response",
      fault_params: { start: 0, end: 30 },
      outcome: "fault_injected",
    };

    logger.log(event);

    const content = readFileSync(TEST_FILE, "utf-8");
    const parsed = JSON.parse(content.trim());

    expect(parsed).toHaveProperty("timestamp");
    expect(parsed).toHaveProperty("agent_id");
    expect(parsed).toHaveProperty("tool_name");
    expect(parsed).toHaveProperty("trigger_condition");
    expect(parsed).toHaveProperty("fault_type");
    expect(parsed).toHaveProperty("fault_params");
    expect(parsed).toHaveProperty("outcome");
  });

  test("flush-on-write: content persisted immediately", () => {
    const logger = createTranscriptLogger(TEST_FILE);

    logger.log({
      timestamp: new Date().toISOString(),
      agent_id: "agent-crash",
      tool_name: "Read",
      trigger_condition: "call_count",
      fault_type: "network_timeout",
      fault_params: {},
      outcome: "fault_injected",
    });

    // Immediately read - should be there (no buffering)
    const content = readFileSync(TEST_FILE, "utf-8");
    expect(content.length).toBeGreaterThan(0);
    const parsed = JSON.parse(content.trim());
    expect(parsed.agent_id).toBe("agent-crash");
  });

  test("getEventCount returns correct number", () => {
    const logger = createTranscriptLogger(TEST_FILE);

    expect(logger.getEventCount()).toBe(0);

    logger.log({
      timestamp: new Date().toISOString(),
      agent_id: "a",
      tool_name: "Read",
      trigger_condition: "call_count",
      fault_type: "none",
      fault_params: {},
      outcome: "pass_through",
    });

    logger.log({
      timestamp: new Date().toISOString(),
      agent_id: "a",
      tool_name: "Bash",
      trigger_condition: "call_count",
      fault_type: "none",
      fault_params: {},
      outcome: "pass_through",
    });

    expect(logger.getEventCount()).toBe(2);
  });

  test("getPath returns configured path", () => {
    const logger = createTranscriptLogger(TEST_FILE);
    expect(logger.getPath()).toBe(TEST_FILE);
  });

  test("readAll returns all events", () => {
    const logger = createTranscriptLogger(TEST_FILE);

    for (let i = 0; i < 5; i++) {
      logger.log({
        timestamp: new Date().toISOString(),
        agent_id: `agent-${i}`,
        tool_name: "Read",
        trigger_condition: "call_count",
        fault_type: "none",
        fault_params: {},
        outcome: "pass_through",
      });
    }

    const events = logger.readAll();
    expect(events.length).toBe(5);
    expect(events[0].agent_id).toBe("agent-0");
    expect(events[4].agent_id).toBe("agent-4");
  });
});
