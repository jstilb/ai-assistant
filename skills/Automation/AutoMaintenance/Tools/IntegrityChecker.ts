/**
 * IntegrityChecker.ts — System integrity checks for AutoMaintenance.
 * Checks: critical path existence, broken symlinks, disk usage, git status.
 * Uses execFileSync with explicit arg arrays — no shell string interpolation.
 */

import { existsSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";
import { type Finding } from "./Remediator";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";

const KAYA_HOME = getKayaHome();

export async function runIntegrityCheck(): Promise<Finding[]> {
  const findings: Finding[] = [];

  // Critical path existence
  for (const path of [join(KAYA_HOME, "CLAUDE.md"), join(KAYA_HOME, "settings.json"), join(KAYA_HOME, "MEMORY"), join(KAYA_HOME, "hooks")]) {
    if (!existsSync(path)) findings.push({ type: "missing_critical_path", target: path, workflow: "daily" });
  }

  // Broken symlinks — pass KAYA_HOME via env, not interpolation
  try {
    const out = execFileSync("sh", ["-c", "find \"$KAYA_HOME\" -type l ! -exec test -e {} \\; -print 2>/dev/null || true"], { encoding: "utf-8", env: { ...process.env, KAYA_HOME } });
    for (const s of out.trim().split("\n").filter((l) => l.length > 0)) {
      findings.push({ type: "broken_symlink", target: s, workflow: "daily" });
    }
  } catch { /* ignore */ }

  // Disk usage — POSIX df, no interpolation
  try {
    const out = execFileSync("sh", ["-c", "df -P \"$KAYA_HOME\" | tail -1 | awk '{print $5}'"], { encoding: "utf-8", env: { ...process.env, KAYA_HOME } });
    const pct = parseInt(out.replace("%", "").trim());
    if (!isNaN(pct)) {
      if (pct > 95) findings.push({ type: "disk_critical", target: `${pct}% used`, workflow: "daily" });
      else if (pct > 85) findings.push({ type: "disk_warning", target: `${pct}% used`, workflow: "daily" });
    }
  } catch { /* ignore */ }

  // Git status — explicit arg array
  try {
    const out = execFileSync("git", ["-C", KAYA_HOME, "status", "--short"], { encoding: "utf-8" });
    if (out.trim().length > 0) findings.push({ type: "git_dirty", target: `${out.trim().split("\n").length} modified files`, workflow: "daily" });
  } catch { /* ignore */ }

  return findings;
}

/** Get current disk usage % for KAYA_HOME, or undefined if unavailable. */
export function getDiskUsagePercent(): number | undefined {
  try {
    const out = execFileSync("sh", ["-c", "df -P \"$KAYA_HOME\" | tail -1 | awk '{print $5}'"], { encoding: "utf-8", env: { ...process.env, KAYA_HOME } });
    const pct = parseInt(out.replace("%", "").trim());
    return isNaN(pct) ? undefined : pct;
  } catch { return undefined; }
}
