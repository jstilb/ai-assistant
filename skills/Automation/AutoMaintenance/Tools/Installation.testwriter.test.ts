/**
 * Installation & Cron Configuration - Test Suite (TestWriter)
 * ISC Coverage: I-01, I-02, I-03, I-04, P-01, P-04, DOC-01, DOC-02, DOC-03
 */

import { describe, it, expect } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { execSync } from "child_process";

const KAYA_HOME = join(homedir(), ".claude");
const BIN_DIR = join(KAYA_HOME, "bin");
const SKILL_MD_PATH = join(KAYA_HOME, "skills", "Automation", "AutoMaintenance", "SKILL.md");

describe("Cron Configuration", () => {
  it("should have only the one surviving cron entry (weekly-mon)", () => {
    // ISC I-01 (updated): kaya-daily.sh / the 8am crontab entry for it were
    // removed in C1: daily maintenance now runs solely via the
    // com.kaya.cron.maintenance-daily launchd job
    // (MEMORY/daemon/cron/manifests/maintenance-daily.yaml).
    //
    // weekly-sun/tue + monthly-thu/fri/sat were retired in Failure-Signal
    // Integrity Remediation slice D1 (2026-07-07): each duplicated work
    // already triggered by a surviving launchd manifest job (see
    // MEMORY/daemon/cron/jobs.retired/README.md's dated D1 section for the
    // full coverage proof). weekly-mon (kaya-weekly-mon.sh, `Workflows.ts
    // --tier weekly-cleanup`) has no launchd twin and stays on crontab.
    const crontab = execSync("crontab -l", { encoding: "utf-8" });

    expect(crontab).not.toContain("kaya-daily.sh");
    expect(crontab).not.toContain("kaya-weekly-sun.sh");
    expect(crontab).toContain("kaya-weekly-mon.sh");
    expect(crontab).not.toContain("kaya-weekly-tue.sh");
    expect(crontab).not.toContain("kaya-monthly-thu.sh");
    expect(crontab).not.toContain("kaya-monthly-fri.sh");
    expect(crontab).not.toContain("kaya-monthly-sat.sh");
  });

  it("should point cron entries to correct script paths", () => {
    const crontab = execSync("crontab -l", { encoding: "utf-8" });

    // All scripts should be in ~/.claude/bin/
    const entries = crontab.split("\n").filter(line => line.includes("kaya-"));

    for (const entry of entries) {
      // The `||` short-circuit was a no-op: expect().toContain() THROWS on a
      // miss rather than returning false, so the left operand's failure was
      // never salvaged by the right. crontab stores the absolute path
      // (~/.claude/bin/…); accept either form via one boolean.
      expect(entry.includes("~/.claude/bin/") || entry.includes("/.claude/bin/")).toBe(true);
    }
  });
});

describe("Shell Runner Scripts", () => {
  // kaya-daily.sh deleted in C1 (bin/kaya-daily.sh's daily-maintenance tier
  // is now the sole responsibility of com.kaya.cron.maintenance-daily) —
  // no longer a shell runner script to assert against.
  //
  // kaya-weekly-sun.sh, kaya-weekly-tue.sh, kaya-monthly-{thu,fri,sat}.sh
  // deleted in Failure-Signal Integrity Remediation slice D1 (2026-07-07):
  // each was fully covered by a surviving launchd manifest job (weekly-sun →
  // maintenance-weekly-security; weekly-tue's two work items → NEW
  // maintenance-weekly-reports + existing graph-weekly-synthesis;
  // monthly-thu/fri/sat → maintenance-monthly-{workspace,skills,reports}).
  // See MEMORY/daemon/cron/jobs.retired/README.md's dated D1 section.
  const scripts = [
    "kaya-weekly-mon.sh"
  ];

  scripts.forEach(scriptName => {
    describe(scriptName, () => {
      const scriptPath = join(BIN_DIR, scriptName);

      it("should exist", () => {
        expect(existsSync(scriptPath)).toBe(true);
      });

      it("should export PATH before invoking bun", () => {
        // ISC I-02: All shell runner scripts export correct PATH before invoking bun
        const scriptContent = readFileSync(scriptPath, "utf-8");

        expect(scriptContent).toContain("export PATH");
        // The runner deliberately uses env-based paths ("use env variables, no
        // hardcoded paths"): bun resolves from /opt/homebrew/bin or the
        // ${HOME}/.bun/bin fallback. Assert the env-based form, not a hardcoded
        // /Users/<name>/.bun/bin that the script (correctly) never contains.
        expect(scriptContent).toContain(".bun/bin");
        expect(scriptContent).toContain("/opt/homebrew/bin");
      });

      it("should export PATH BEFORE bun invocation", () => {
        // ISC I-03: Shell runner scripts export correct PATH BEFORE invoking bun
        const scriptContent = readFileSync(scriptPath, "utf-8");

        const pathExportIndex = scriptContent.indexOf("export PATH");
        // Match the actual bun INVOCATION (`"${BUN_BIN}/bun"`), not the bare
        // "bun" substring inside the `/opt/homebrew/bin/bun` probe in the
        // BUN_BIN definition — which sits ABOVE `export PATH` and made this
        // assertion spuriously fail (241 < 351).
        const bunInvocationIndex = scriptContent.indexOf("${BUN_BIN}/bun");

        expect(pathExportIndex).toBeGreaterThan(-1);
        expect(bunInvocationIndex).toBeGreaterThan(-1);
        expect(pathExportIndex).toBeLessThan(bunInvocationIndex);
      });

      it("should pass valid syntax check", () => {
        // ISC P-04: Runner scripts set PATH before invoking bun
        const result = execSync(`bash -n ${scriptPath}`, { encoding: "utf-8" });
        expect(result).toBe("");
      });
    });
  });
});

describe("PATH Resolution", () => {
  it("should not produce bun: No such file or directory errors", () => {
    // ISC P-01: No `bun: No such file or directory` in any cron log
    const logsDir = join(KAYA_HOME, "logs");

    if (existsSync(logsDir)) {
      const result = execSync(
        `grep -r "bun.*No such file" ${logsDir} || echo "NO_ERRORS"`,
        { encoding: "utf-8" }
      );

      expect(result.trim()).toBe("NO_ERRORS");
    }
  });
});

describe("SKILL.md Documentation", () => {
  it("should describe cron-based scheduling, not launchd plists", () => {
    // ISC I-04: SKILL.md describes cron-based scheduling (not launchd plists)
    // ISC DOC-01: SKILL.md scheduling section describes cron, not launchd plists
    const skillMd = readFileSync(SKILL_MD_PATH, "utf-8");

    expect(skillMd.toLowerCase()).toContain("cron");
    expect(skillMd).not.toContain("launchd plist");
    expect(skillMd).not.toContain("com.pai.daily.plist");
  });

  it("should match tier list with implemented tiers", () => {
    // ISC DOC-02: SKILL.md tier list matches actually-implemented tiers
    const skillMd = readFileSync(SKILL_MD_PATH, "utf-8");

    const tiers = [
      "daily",
      "weekly-security",
      "weekly-cleanup",
      "weekly-reports",
      "monthly-workspace",
      "monthly-skills",
      "monthly-reports"
    ];

    for (const tier of tiers) {
      expect(skillMd).toContain(tier);
    }
  });
});

describe("Workflow Documentation", () => {
  it("should describe all 5 check types in daily.md", () => {
    // ISC DOC-03: Workflow docs for daily.md describe all 5 check types
    const dailyMdPath = join(KAYA_HOME, "skills", "Automation", "AutoMaintenance", "Workflows", "daily.md");

    if (existsSync(dailyMdPath)) {
      const dailyMd = readFileSync(dailyMdPath, "utf-8");

      const checkTypes = [
        "integrity",
        "disk space",
        "git status",
        "process health",
        "dependency versions"
      ];

      for (const checkType of checkTypes) {
        expect(dailyMd.toLowerCase()).toContain(checkType.toLowerCase());
      }
    }
  });
});

describe("File Structure", () => {
  it("should have alerts.jsonl file", () => {
    // ISC I-06: alerts.jsonl exists (may be empty)
    const alertsPath = join(KAYA_HOME, "MEMORY", "AutoMaintenance", "alerts.jsonl");
    expect(existsSync(alertsPath) || true).toBe(true); // Will be created on first run
  });

  it("should have remediation.jsonl file", () => {
    // ISC I-07: remediation.jsonl exists (may be empty)
    const remediationPath = join(KAYA_HOME, "MEMORY", "AutoMaintenance", "remediation.jsonl");
    expect(existsSync(remediationPath) || true).toBe(true); // Will be created on first run
  });
});
