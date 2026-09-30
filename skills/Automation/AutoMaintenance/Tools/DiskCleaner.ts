/**
 * DiskCleaner.ts — Weekly cleanup tasks for AutoMaintenance.
 * Log rotation and .DS_Store sweep.
 * Uses execFileSync with explicit arg arrays — no shell string interpolation.
 */

import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";
import { Remediator } from "./Remediator";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";

const KAYA_HOME = getKayaHome();

export interface CleanupResult {
  rotatedLogs: number;
  removedDsStore: number;
}

export async function runDiskCleanup(dryRun = false): Promise<CleanupResult> {
  let rotatedLogs = 0;
  let removedDsStore = 0;

  // Log rotation
  console.log("--- Log Rotation ---");
  const logsDir = join(KAYA_HOME, "logs");
  if (existsSync(logsDir)) {
    for (const log of readdirSync(logsDir)) {
      const logPath = join(logsDir, log);
      try {
        const birthtime = parseInt(execFileSync("stat", ["-f", "%B", logPath], { encoding: "utf-8" }).trim());
        const ageDays = (Date.now() / 1000 - birthtime) / (60 * 60 * 24);
        if (ageDays > 14) {
          await Remediator.run([{ type: "rotate_log", target: logPath, ageInDays: ageDays, threshold: 14 }], { dryRun });
          rotatedLogs++;
        }
      } catch { /* skip */ }
    }
    console.log(`✓ Rotated ${rotatedLogs} logs`);
  }

  // .DS_Store sweep — explicit find args, no interpolation
  console.log("--- DS_Store Sweep ---");
  try {
    const out = execFileSync("find", [KAYA_HOME, "-name", ".DS_Store", "-type", "f"], { encoding: "utf-8" });
    for (const file of out.trim().split("\n").filter((f) => f.length > 0)) {
      await Remediator.run([{ type: "rotate_log", target: file, ageInDays: 0, threshold: 0 }], { dryRun });
      removedDsStore++;
    }
    console.log(`✓ Removed ${removedDsStore} .DS_Store files`);
  } catch {
    console.log("✓ No .DS_Store files found");
  }

  return { rotatedLogs, removedDsStore };
}
