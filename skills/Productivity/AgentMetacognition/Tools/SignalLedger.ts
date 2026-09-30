#!/usr/bin/env bun
/**
 * SignalLedger — Append qualified signals to JSONL files
 *
 * Enforces quality gate before writing. Writers: IssueTrace/IssueLearningBridge
 * (dev-issues.jsonl). The signal files are read by Graph ingesters and
 * on-demand AgentMetacognition runs (the weekly learning-weekly-digest cron
 * that also read them was deleted 2026-09-30), not by a deterministic cursor
 * pipeline — the weekly
 * wisdom-frame synthesis that consumed them was deleted 2026-07-09 (frames
 * were retired 2026-05-02; CLAUDE.md and auto-memory are the canonical home
 * for behavioral rules; Jm applies them).
 */

import * as fs from "fs";
import * as path from "path";
import { SignalQualityGate, type RawSignal, type QualifiedSignal } from "./SignalQualityGate";
import { createAppendLog, type AppendLog } from "../../../../lib/core/AppendLog.ts";

export class SignalLedger {
  private readonly signalsDir: string;
  /** Per-file AppendLog instances, keyed by absolute path (filename varies per call). */
  private readonly logs = new Map<string, AppendLog>();

  constructor(signalsDir: string) {
    this.signalsDir = signalsDir;
    fs.mkdirSync(signalsDir, { recursive: true });
  }

  private getLog(filePath: string): AppendLog {
    let log = this.logs.get(filePath);
    if (!log) {
      log = createAppendLog(filePath);
      this.logs.set(filePath, log);
    }
    return log;
  }

  /**
   * Append a signal to the ledger if it passes the quality gate.
   * Returns the qualified signal, or null if rejected.
   */
  async append(signal: RawSignal, filename: string = "ratings.jsonl"): Promise<QualifiedSignal | null> {
    const qualified = await SignalQualityGate.evaluate(signal);
    if (!qualified) return null;
    const filePath = path.join(this.signalsDir, filename);
    this.getLog(filePath).append(qualified);
    return qualified;
  }
}
