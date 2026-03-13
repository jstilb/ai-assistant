/**
 * Tests for GenerateContextRouting.ts
 *
 * Tests:
 * - --dry-run produces markdown to stdout without writing to disk
 * - Script exits 0 on clean filesystem
 * - Output contains all 7 required categories
 * - File paths are relative (no leading slash or ~/)
 * - Line count is <= 200
 * - context/*.md files have routing entries
 * - skills/SKILL.md files have routing entries
 * - USER/TELOS/*.md non-compressed files have entries
 * - Dates are in YYYY-MM-DD format or "—"
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const SCRIPT_DIR = import.meta.dir;
const SCRIPT_PATH = path.join(
  SCRIPT_DIR,
  "GenerateContextRouting.ts"
);

const HOME = process.env.HOME ?? "/Users/[user]";
const KAYA_DIR = path.join(HOME, ".claude");
const OUTPUT_PATH = path.join(KAYA_DIR, "CONTEXT-ROUTING.md");

// ============================================================================
// Helper: run the script (uses Bun.spawnSync for correct stdout capture in test runner)
// ============================================================================

function runScript(args: string[] = []): { stdout: string; stderr: string; exitCode: number } {
  const tmpOut = path.join(os.tmpdir(), `gcr-test-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  const result = Bun.spawnSync(["bash", "-c", `bun "${SCRIPT_PATH}" ${args.map(a => `"${a}"`).join(" ")} > "${tmpOut}" 2>&1`], {
    cwd: SCRIPT_DIR,
    env: { ...process.env },
  });
  let stdout = "";
  try {
    stdout = fs.readFileSync(tmpOut, "utf8");
    fs.unlinkSync(tmpOut);
  } catch {}
  return {
    stdout,
    stderr: "",
    exitCode: result.exitCode ?? 1,
  };
}

// ============================================================================
// Test Suite
// ============================================================================

describe("GenerateContextRouting.ts", () => {
  // ISC 8120: exits 0 on clean filesystem
  describe("ISC 8120 — exits 0 on clean filesystem", () => {
    it("should exit with code 0 when run with --dry-run", () => {
      const { exitCode } = runScript(["--dry-run"]);
      expect(exitCode).toBe(0);
    });
  });

  // ISC 6236: --dry-run produces output to stdout without writing to disk
  describe("ISC 6236 — --dry-run produces stdout, no disk write", () => {
    it("should produce markdown output to stdout", () => {
      const { stdout, exitCode } = runScript(["--dry-run"]);
      expect(exitCode).toBe(0);
      expect(stdout.length).toBeGreaterThan(100);
      expect(stdout).toContain("# Context Routing Index");
    });

    it("should not write or modify CONTEXT-ROUTING.md when --dry-run is used", () => {
      // Record pre-run mtime if file exists
      let preMtime: number | null = null;
      if (fs.existsSync(OUTPUT_PATH)) {
        preMtime = fs.statSync(OUTPUT_PATH).mtimeMs;
      }

      runScript(["--dry-run"]);

      // File should not have been created or modified
      if (preMtime !== null) {
        // If it existed before, mtime should be unchanged
        const postMtime = fs.statSync(OUTPUT_PATH).mtimeMs;
        expect(postMtime).toBe(preMtime);
      } else {
        // If it didn't exist before, it still should not exist
        expect(fs.existsSync(OUTPUT_PATH)).toBe(false);
      }
    });
  });

  // ISC 2720: Routing index contains all 7 required categories
  describe("ISC 2720 — contains all 7 required categories", () => {
    let dryRunOutput: string;

    beforeAll(() => {
      const { stdout } = runScript(["--dry-run"]);
      dryRunOutput = stdout;
    });

    const REQUIRED_CATEGORIES = [
      "## Kaya System",
      "## User Identity",
      "## Life Goals / Telos",
      "## Projects",
      "## Live Context Sources",
      "## Memory System",
      "## Configuration",
    ];

    for (const category of REQUIRED_CATEGORIES) {
      it(`should contain category: ${category}`, () => {
        expect(dryRunOutput).toContain(category);
      });
    }

    it("should contain exactly 7 category headers (##)", () => {
      const categoryHeaders = dryRunOutput
        .split("\n")
        .filter((line) => /^## /.test(line));
      expect(categoryHeaders.length).toBe(7);
    });
  });

  // ISC 1436: All file paths are relative (no leading / or ~)
  describe("ISC 1436 — all file paths are relative to ~/.claude/", () => {
    it("should not contain absolute paths starting with / in table rows", () => {
      const { stdout } = runScript(["--dry-run"]);
      const tableRows = stdout
        .split("\n")
        .filter((line) => line.startsWith("| ") && !line.startsWith("| Topic"));

      const absolutePaths = tableRows.filter((row) => {
        // Extract the second column (file path)
        const cols = row.split("|").map((c) => c.trim());
        if (cols.length < 3) return false;
        const filePath = cols[2];
        return filePath.startsWith("/") || filePath.startsWith("~/");
      });

      expect(absolutePaths).toHaveLength(0);
    });
  });

  // ISC 6680: Routing index is <= 200 lines
  describe("ISC 6680 — routing index is <= 200 lines", () => {
    it("should produce output with 200 lines or fewer", () => {
      const { stdout } = runScript(["--dry-run"]);
      const lines = stdout.split("\n").length;
      expect(lines).toBeLessThanOrEqual(200);
    });
  });

  // ISC 7060: Every file in context/*.md has a routing entry
  describe("ISC 7060 — every context/*.md file has a routing entry", () => {
    it("should include all context/*.md files in the routing index", () => {
      const contextDir = path.join(KAYA_DIR, "context");
      if (!fs.existsSync(contextDir)) {
        // Skip if context dir doesn't exist
        return;
      }

      const contextFiles = fs
        .readdirSync(contextDir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => `context/${f}`);

      const { stdout } = runScript(["--dry-run"]);

      for (const filePath of contextFiles) {
        expect(stdout).toContain(filePath);
      }
    });
  });

  // ISC 1456: Every skills/*/SKILL.md has a routing entry
  describe("ISC 1456 — every skills/*/SKILL.md has a routing entry", () => {
    it("should include all skills/SKILL.md files under Kaya System", () => {
      const skillsDir = path.join(KAYA_DIR, "skills");
      if (!fs.existsSync(skillsDir)) return;

      const skillFiles: string[] = [];
      for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const skillPath = path.join(skillsDir, entry.name, "SKILL.md");
        if (fs.existsSync(skillPath)) {
          skillFiles.push(`skills/${entry.name}/SKILL.md`);
        }
      }

      const { stdout } = runScript(["--dry-run"]);
      // The Kaya System section should contain all skill entries
      const kayaSystemSection = stdout.split("## User Identity")[0];

      for (const skillPath of skillFiles) {
        expect(kayaSystemSection).toContain(skillPath);
      }
    });
  });

  // ISC 6592: Every non-compressed USER/*.md and USER/TELOS/*.md has an entry
  describe("ISC 6592 — every non-compressed USER and USER/TELOS md has an entry", () => {
    it("should include all non-compressed USER/*.md files", () => {
      const userDir = path.join(KAYA_DIR, "USER");
      if (!fs.existsSync(userDir)) return;

      const userFiles = fs
        .readdirSync(userDir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith(".md") && !e.name.endsWith(".compressed.md"))
        .map((e) => `USER/${e.name}`);

      const { stdout } = runScript(["--dry-run"]);

      for (const filePath of userFiles) {
        expect(stdout).toContain(filePath);
      }
    });

    it("should include all non-compressed USER/TELOS/*.md files", () => {
      const telosDir = path.join(KAYA_DIR, "USER", "TELOS");
      if (!fs.existsSync(telosDir)) return;

      const telosFiles = fs
        .readdirSync(telosDir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith(".md") && !e.name.endsWith(".compressed.md"))
        .map((e) => `USER/TELOS/${e.name}`);

      const { stdout } = runScript(["--dry-run"]);

      for (const filePath of telosFiles) {
        expect(stdout).toContain(filePath);
      }
    });
  });

  // ISC 8640: Dates match file mtime
  describe("ISC 8640 — dates in table match file mtime on disk", () => {
    it("should use YYYY-MM-DD format or — for dates", () => {
      const { stdout } = runScript(["--dry-run"]);
      const tableRows = stdout
        .split("\n")
        .filter((line) => line.startsWith("| ") && !line.startsWith("| Topic") && !line.startsWith("|---"));

      const datePattern = /^\d{4}-\d{2}-\d{2}$|^—$/;

      for (const row of tableRows) {
        const cols = row.split("|").map((c) => c.trim());
        if (cols.length < 4) continue;
        const date = cols[3];
        // Skip empty or header-like entries
        if (!date || date === "Last Updated") continue;
        expect(date).toMatch(datePattern);
      }
    });

    it("should use mtime date for context/CalendarContext.md if it exists", () => {
      const calPath = path.join(KAYA_DIR, "context", "CalendarContext.md");
      if (!fs.existsSync(calPath)) return;

      const stat = fs.statSync(calPath);
      const d = stat.mtime;
      const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

      const { stdout } = runScript(["--dry-run"]);
      // The CalendarContext.md row should contain the correct mtime date
      expect(stdout).toContain(`context/CalendarContext.md | ${expected}`);
    });
  });

  // ISC 9408: Model can resolve any context/*.md path in 1 read call
  describe("ISC 9408 — any context/*.md path resolvable in 1 read call", () => {
    it("should list context/CalendarContext.md as a direct file path in the routing table", () => {
      const { stdout } = runScript(["--dry-run"]);
      // The path should be directly readable — a relative path, not a directory reference
      const rows = stdout.split("\n").filter((l) => l.includes("context/CalendarContext.md"));
      expect(rows.length).toBeGreaterThanOrEqual(1);
      // The path should be the exact file path, not a directory
      expect(rows[0]).toContain("context/CalendarContext.md");
      expect(rows[0]).not.toContain("(directory");
    });
  });

  // ISC 3272: File gets written when run normally (tested separately to avoid side effects)
  describe("ISC 3272 — CONTEXT-ROUTING.md written correctly", () => {
    it("should write a valid markdown file to the output path", () => {
      // Run without --dry-run to test actual write
      const { exitCode, stderr } = runScript([]);
      expect(exitCode).toBe(0);
      expect(fs.existsSync(OUTPUT_PATH)).toBe(true);

      const content = fs.readFileSync(OUTPUT_PATH, "utf8");
      expect(content).toContain("# Context Routing Index");
      expect(content).toContain("## Kaya System");
      expect(content).toContain("## Live Context Sources");
    });
  });
});
