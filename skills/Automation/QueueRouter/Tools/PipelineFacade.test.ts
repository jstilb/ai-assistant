#!/usr/bin/env bun
/**
 * PipelineFacade.test.ts — Codec unit tests for queueItemToPipelineParams
 *
 * Slice A5: pipeline_items.lucid_task_id is a first-class, indexed column
 * (PipelineDB.ts idx_pipeline_lucid) but the write path never populated it —
 * queueItemToPipelineParams() only ever wrote the cross-reference into the
 * opaque context JSON blob (context.lucidTaskId), even though
 * PipelineRepository.upsert() has always accepted and persisted a top-level
 * lucid_task_id field (see PipelineRepository.ts:658). Confirmed against a
 * live pipeline.db clone: 0/402 rows had lucid_task_id populated while 85
 * rows carried context.lucidTaskId.
 *
 * This file tests the codec extraction only (present / absent / malformed
 * context) — no KAYA_HOME pinning needed since queueItemToPipelineParams is a
 * pure function with no I/O.
 */

import { describe, test, expect } from "bun:test";
import { queueItemToPipelineParams } from "./PipelineFacade.ts";
import type { QueueItem } from "./QueueManager.ts";

function baseItem(overrides: Partial<QueueItem> = {}): QueueItem {
  const now = new Date().toISOString();
  return {
    id: "test-id",
    created: now,
    updated: now,
    source: "test",
    priority: 2,
    status: "pending",
    type: "task",
    queue: "approved-work",
    payload: { title: "t", description: "d" },
    ...overrides,
  };
}

describe("queueItemToPipelineParams — lucid_task_id extraction", () => {
  test("present: context.lucidTaskId (string) is copied to the top-level lucid_task_id field", () => {
    const item = baseItem({
      payload: { title: "t", description: "d", context: { lucidTaskId: "t-abc123" } },
    });
    const params = queueItemToPipelineParams(item);
    expect(params.lucid_task_id).toBe("t-abc123");
  });

  test("absent: no payload.context at all -> lucid_task_id is undefined", () => {
    const item = baseItem({ payload: { title: "t", description: "d" } });
    const params = queueItemToPipelineParams(item);
    expect(params.lucid_task_id).toBeUndefined();
  });

  test("absent: payload.context present but has no lucidTaskId key -> lucid_task_id is undefined", () => {
    const item = baseItem({
      payload: { title: "t", description: "d", context: { notes: "no lucid ref here" } },
    });
    const params = queueItemToPipelineParams(item);
    expect(params.lucid_task_id).toBeUndefined();
  });

  test("malformed: context.lucidTaskId is a number, not a string -> lucid_task_id is undefined (no throw)", () => {
    const item = baseItem({
      payload: { title: "t", description: "d", context: { lucidTaskId: 12345 as unknown as string } },
    });
    expect(() => queueItemToPipelineParams(item)).not.toThrow();
    const params = queueItemToPipelineParams(item);
    expect(params.lucid_task_id).toBeUndefined();
  });

  test("malformed: context.lucidTaskId is null -> lucid_task_id is undefined (no throw)", () => {
    const item = baseItem({
      payload: { title: "t", description: "d", context: { lucidTaskId: null as unknown as string } },
    });
    expect(() => queueItemToPipelineParams(item)).not.toThrow();
    const params = queueItemToPipelineParams(item);
    expect(params.lucid_task_id).toBeUndefined();
  });

  test("malformed: context.lucidTaskId is an empty string -> lucid_task_id is undefined (treated as absent)", () => {
    const item = baseItem({
      payload: { title: "t", description: "d", context: { lucidTaskId: "" } },
    });
    const params = queueItemToPipelineParams(item);
    expect(params.lucid_task_id).toBeUndefined();
  });

  test("the context blob itself is preserved unchanged alongside the new first-class field", () => {
    const item = baseItem({
      payload: { title: "t", description: "d", context: { lucidTaskId: "t-xyz", notes: "keep me" } },
    });
    const params = queueItemToPipelineParams(item);
    expect(params.lucid_task_id).toBe("t-xyz");
    expect(params.context).toEqual({ lucidTaskId: "t-xyz", notes: "keep me" });
  });
});
