#!/usr/bin/env bun
/**
 * EstimationAccuracyCapture.hook.ts - SessionEnd hook for estimation calibration
 *
 * Captures estimate-vs-actual signals from LucidTasks and WorkQueue,
 * appending to MEMORY/LEARNING/SIGNALS/estimation-accuracy.jsonl.
 *
 * Hook: SessionEnd
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";

const KAYA_HOME = process.env.KAYA_HOME || join(process.env.HOME || "", ".claude");
const SIGNALS_DIR = join(KAYA_HOME, "MEMORY", "LEARNING", "SIGNALS");
const SIGNAL_FILE = join(SIGNALS_DIR, "estimation-accuracy.jsonl");
const TRACKER_FILE = join(KAYA_HOME, "MEMORY", "State", "estimation-tracker.json");

interface EstimationSignal {
  timestamp: string;
  taskTitle: string;
  estimatedMinutes: number;
  actualMinutes: number;
  ratio: number;
  source: "lucidtasks" | "workqueue";
}

interface TrackerState {
  lastCheckedAt: string;
  lastLucidTaskIds: string[];
  lastWorkQueueIds: string[];
}

function loadTracker(): TrackerState {
  if (!existsSync(TRACKER_FILE)) {
    return { lastCheckedAt: "1970-01-01T00:00:00Z", lastLucidTaskIds: [], lastWorkQueueIds: [] };
  }
  try {
    return JSON.parse(readFileSync(TRACKER_FILE, "utf-8")) as TrackerState;
  } catch {
    return { lastCheckedAt: "1970-01-01T00:00:00Z", lastLucidTaskIds: [], lastWorkQueueIds: [] };
  }
}

function saveTracker(state: TrackerState): void {
  const dir = dirname(TRACKER_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(TRACKER_FILE, JSON.stringify(state, null, 2));
}

function appendSignals(signals: EstimationSignal[]): void {
  if (signals.length === 0) return;
  if (!existsSync(SIGNALS_DIR)) mkdirSync(SIGNALS_DIR, { recursive: true });
  const lines = signals.map((s) => JSON.stringify(s)).join("\n") + "\n";
  appendFileSync(SIGNAL_FILE, lines);
}

async function captureFromLucidTasks(tracker: TrackerState): Promise<{ signals: EstimationSignal[]; taskIds: string[] }> {
  const signals: EstimationSignal[] = [];
  const newIds: string[] = [];

  try {
    const { getTaskDB } = await import("../skills/Productivity/LucidTasks/Tools/TaskDB.ts");
    const db = getTaskDB();
    const accuracy = db.getEstimateAccuracy();

    const seen = new Set(tracker.lastLucidTaskIds);
    for (const task of accuracy.tasks) {
      // Use title as dedup key since getEstimateAccuracy doesn't return IDs
      const key = `${task.title}:${task.estimated_minutes}:${task.actual_minutes}`;
      if (seen.has(key)) continue;

      signals.push({
        timestamp: new Date().toISOString(),
        taskTitle: task.title,
        estimatedMinutes: task.estimated_minutes,
        actualMinutes: task.actual_minutes,
        ratio: task.ratio,
        source: "lucidtasks",
      });
      newIds.push(key);
    }

    db.close();
  } catch {
    // LucidTasks unavailable
  }

  return { signals, taskIds: [...tracker.lastLucidTaskIds, ...newIds] };
}

async function captureFromWorkQueue(tracker: TrackerState): Promise<{ signals: EstimationSignal[]; itemIds: string[] }> {
  const signals: EstimationSignal[] = [];
  const newIds: string[] = [];

  try {
    const { WorkQueue } = await import("../skills/Automation/AutonomousWork/Tools/WorkQueue.ts");
    const wq = new WorkQueue();
    const items = wq.getAllItems();

    const seen = new Set(tracker.lastWorkQueueIds);
    for (const item of items) {
      if (item.status !== "completed") continue;
      if (!item.estimatedMinutes || !item.startedAt || !item.completedAt) continue;
      if (seen.has(item.id)) continue;

      const started = new Date(item.startedAt).getTime();
      const completed = new Date(item.completedAt).getTime();
      const actualMinutes = Math.round((completed - started) / 60000 * 10) / 10;

      if (actualMinutes <= 0) continue;

      signals.push({
        timestamp: new Date().toISOString(),
        taskTitle: item.title,
        estimatedMinutes: item.estimatedMinutes,
        actualMinutes,
        ratio: Math.round((item.estimatedMinutes / actualMinutes) * 100) / 100,
        source: "workqueue",
      });
      newIds.push(item.id);
    }
  } catch {
    // WorkQueue unavailable
  }

  return { signals, itemIds: [...tracker.lastWorkQueueIds, ...newIds] };
}

async function main(): Promise<void> {
  const tracker = loadTracker();

  const [lucidResult, wqResult] = await Promise.all([
    captureFromLucidTasks(tracker),
    captureFromWorkQueue(tracker),
  ]);

  const allSignals = [...lucidResult.signals, ...wqResult.signals];
  appendSignals(allSignals);

  saveTracker({
    lastCheckedAt: new Date().toISOString(),
    lastLucidTaskIds: lucidResult.taskIds,
    lastWorkQueueIds: wqResult.itemIds,
  });

  if (allSignals.length > 0) {
    console.error(`[EstimationAccuracyCapture] Logged ${allSignals.length} estimation signals`);
  }
}

if (import.meta.main) {
  main().catch(console.error);
}

export { main as captureEstimationAccuracy };
