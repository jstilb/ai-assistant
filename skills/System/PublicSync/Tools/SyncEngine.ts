#!/usr/bin/env bun
/**
 * SyncEngine.ts - PublicSync core engine
 *
 * Three-pass sanitization pipeline for mirroring ~/.claude/ to public GitHub.
 *
 * Architecture:
 *   Pass 1: BlocklistFilter  — exclude personal dirs/files/skills
 *   Pass 2: SecretScanner    — detect secret patterns line-by-line
 *   Pass 3: ContentTransformer — normalize paths, strip usernames
 *
 * Safety: SafetyValidator runs 3 independent layers before any push.
 * State:  FileHashRegistry tracks SHA-256 hashes for incremental diffs.
 *
 * Usage:
 *   bun ~/.claude/skills/System/PublicSync/Tools/SyncEngine.ts --help
 *   bun ~/.claude/skills/System/PublicSync/Tools/SyncEngine.ts --dry-run
 *   bun ~/.claude/skills/System/PublicSync/Tools/SyncEngine.ts --status
 *
 * @author Kaya System
 * @version 1.0.0
 */

import { createHash } from "crypto";
import { statSync, existsSync } from "fs";
import { basename, dirname } from "path";

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface BlocklistConfig {
  /** Top-level directories to exclude entirely */
  excludedDirs: string[];
  /** Specific filenames to exclude at any depth */
  excludedFiles: string[];
  /** Preserve README.md at the root of an excluded dir */
  preserveReadmes: boolean;
  /** Personal skill directory names under skills/ */
  excludedSkills: string[];
  /** Exclude State/ subdirs within any skill */
  excludedStateDirs: boolean;
  /** Additional path prefixes from plugins/blocklist.json */
  additionalExcludedPaths?: string[];
}

export interface SecretFinding {
  line: number;
  pattern: string;
  snippet: string;
}

export interface ScanResult {
  hasSecrets: boolean;
  findings: SecretFinding[];
}

export interface TransformResult {
  content: string;
  replacementCount: number;
  changed: boolean;
}

export interface TransformConfig {
  absolutePathPrefix: string;
  relativeReplacement: string;
  stripUsernames: string[];
}

export type HashRegistry = Record<string, string>;

export interface ValidationLayerResult {
  passed: boolean;
  layer?: "pattern-scan" | "path-audit" | "size-anomaly";
  reason?: string;
  blockedPaths?: string[];
}

export interface StagedFile {
  relativePath: string;
  absolutePath: string;
}

export interface ValidateOptions {
  diff: string;
  stagedPaths: StagedFile[];
}

// ─────────────────────────────────────────────────────────────
// Pass 1: BlocklistFilter
// ─────────────────────────────────────────────────────────────

export class BlocklistFilter {
  private config: BlocklistConfig;

  constructor(config: BlocklistConfig) {
    this.config = config;
  }

  /**
   * Returns true if the given relative path is allowed in the public repo.
   * Returns false if it should be excluded.
   */
  isAllowed(relativePath: string): boolean {
    const normalizedPath = relativePath.replace(/\\/g, "/");
    const parts = normalizedPath.split("/");

    // ── Check excluded top-level dirs ─────────────────────
    for (const excludedDir of this.config.excludedDirs) {
      if (parts[0] === excludedDir) {
        // Preserve README.md at the direct root of the excluded dir
        if (
          this.config.preserveReadmes &&
          parts.length === 2 &&
          parts[1] === "README.md"
        ) {
          return true;
        }
        return false;
      }
    }

    // ── Always exclude at any depth ────────────────────────
    const alwaysExcludeAnyDepth = ["node_modules", "__tests__", "__mocks__", ".cache", "examples", "static", "dist", "build", "Results"];
    if (parts.some((p) => alwaysExcludeAnyDepth.includes(p))) {
      return false;
    }

    // ── Exclude binary/media files by extension ────────────
    const EXCLUDED_EXTENSIONS = new Set([
      ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svg", ".bmp",
      ".mp3", ".mp4", ".wav", ".ogg", ".webm", ".mov",
      ".pdf", ".zip", ".tar", ".gz", ".bz2", ".7z",
      ".woff", ".woff2", ".ttf", ".eot", ".otf",
      ".pyc", ".o", ".so", ".dylib", ".dll", ".exe",
      ".log", ".db", ".sqlite", ".sqlite3", ".jsonl",
    ]);
    const filename = parts[parts.length - 1];
    const extIdx = filename.lastIndexOf(".");
    if (extIdx > 0 && EXCLUDED_EXTENSIONS.has(filename.slice(extIdx).toLowerCase())) {
      return false;
    }

    // ── Check excluded filenames at any depth ─────────────
    if (this.config.excludedFiles.includes(filename)) {
      return false;
    }

    // ── Check excluded personal skills ────────────────────
    // Supports both flat (skills/<Name>/...) and nested (skills/<Category>/<Name>/...)
    if (parts[0] === "skills" && parts.length >= 2) {
      // Check parts[1] (flat: skills/Designer/...) and parts[2] (nested: skills/Life/Designer/...)
      for (const skillName of this.config.excludedSkills) {
        if (parts[1] === skillName || (parts.length >= 3 && parts[2] === skillName)) {
          // Preserve README.md at the direct root of the excluded skill dir
          const readmeDepth = parts[1] === skillName ? 3 : 4;
          const readmeIdx = readmeDepth - 1;
          if (
            this.config.preserveReadmes &&
            parts.length === readmeDepth &&
            parts[readmeIdx] === "README.md"
          ) {
            return true;
          }
          return false;
        }
      }

      // ── Exclude State/ within any skill ─────────────────
      // Handles both skills/<Name>/State/ and skills/<Category>/<Name>/State/
      if (this.config.excludedStateDirs) {
        if (parts.includes("State")) {
          return false;
        }
      }
    }

    // ── Check additional excluded paths ───────────────────
    for (const additionalPath of this.config.additionalExcludedPaths ?? []) {
      if (normalizedPath.startsWith(additionalPath)) {
        return false;
      }
    }

    return true;
  }
}

// ─────────────────────────────────────────────────────────────
// Pass 2: SecretScanner
// ─────────────────────────────────────────────────────────────

const SECRET_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  // Anthropic API keys
  { name: "sk-ant-*", regex: /sk-ant-[A-Za-z0-9_\-]{10,}/ },
  // GitHub personal access tokens
  { name: "ghp_*", regex: /ghp_[A-Za-z0-9]{20,}/ },
  // Specific environment variable secrets (require literal string values, not variable refs)
  { name: "ANTHROPIC_API_KEY=", regex: /ANTHROPIC_API_KEY\s*=\s*["']?sk-[A-Za-z0-9_\-]{10,}/ },
  { name: "AWS_SECRET=", regex: /AWS_SECRET\s*=\s*["']?[A-Za-z0-9/+=]{20,}/ },
  // Generic env var secrets — require value to look like an actual secret
  // (8+ alphanumeric chars, not a placeholder like "your_key", not in regex/code context)
  { name: "[A-Z_]+_KEY=", regex: /[A-Z][A-Z0-9_]{2,}_KEY\s*=\s*[A-Za-z0-9_\-]{8,}/ },
  { name: "[A-Z_]+_SECRET=", regex: /[A-Z][A-Z0-9_]{2,}_SECRET\s*=\s*[A-Za-z0-9_\-]{8,}/ },
  { name: "[A-Z_]+_TOKEN=", regex: /[A-Z][A-Z0-9_]{2,}_TOKEN\s*=\s*[A-Za-z0-9_\-]{8,}/ },
  // Google OAuth credentials
  { name: "GOCSPX-*", regex: /GOCSPX-[A-Za-z0-9_\-]{10,}/ },
  { name: "google-oauth-client-id", regex: /\d{10,}-[a-z0-9]{20,}\.apps\.googleusercontent\.com/ },
  // Absolute paths with username
  { name: "/Users/[user]/", regex: /\/Users\/[user]\// },
];

// Patterns that look like secrets but are actually safe placeholders or code
const PLACEHOLDER_PATTERNS: RegExp[] = [
  /<[A-Z_]+>/,           // <YOUR_API_KEY>
  /\bYOUR_[A-Z_]+\b/,    // YOUR_API_KEY
  /\byour[-_][a-z_-]+\b/i, // your_api_key_here, your-token (any case)
  /\bx{3,}\b/i,          // xxx, XXXXXXXXX (any case)
  /\.match\(|\.test\(|\.replace\(|RegExp\(/, // Regex/string operations in code
  /\/[^/]+_KEY[^/]*\//,  // Inside regex literals: /SOME_KEY=.../
  /process\.env\.\w+\s*=\s*\w/,  // process.env.FOO = variable (code, not secrets)
  /os\.environ/,          // Python env access
  /\.\.\./,               // Truncated examples: sk-ant-api03-...
  /\bexample\b/i,         // Example/documentation context
];

export class SecretScanner {
  scan(content: string): ScanResult {
    const findings: SecretFinding[] = [];
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNumber = i + 1;

      // Skip lines that only contain placeholder text
      const isPlaceholder = PLACEHOLDER_PATTERNS.some((p) => p.test(line));
      if (isPlaceholder) continue;

      for (const { name, regex } of SECRET_PATTERNS) {
        if (regex.test(line)) {
          // Mask the actual secret value in the snippet
          const snippet = line.slice(0, 80).replace(regex, "[REDACTED]");
          findings.push({
            line: lineNumber,
            pattern: name,
            snippet,
          });
          break; // One finding per line is enough
        }
      }
    }

    return {
      hasSecrets: findings.length > 0,
      findings,
    };
  }
}

// ─────────────────────────────────────────────────────────────
// Pass 3: ContentTransformer
// ─────────────────────────────────────────────────────────────

export class ContentTransformer {
  private config: TransformConfig;

  constructor(config: TransformConfig) {
    this.config = config;
  }

  transform(content: string): TransformResult {
    let result = content;
    let replacementCount = 0;

    // Normalize absolute paths to relative
    const absolutePathRegex = new RegExp(
      escapeRegex(this.config.absolutePathPrefix),
      "g"
    );
    const absoluteMatches = result.match(absolutePathRegex);
    if (absoluteMatches) {
      replacementCount += absoluteMatches.length;
      result = result.replace(absolutePathRegex, this.config.relativeReplacement);
    }

    // Strip hardcoded usernames
    for (const username of this.config.stripUsernames) {
      // Only strip when not part of the path prefix (already handled above)
      // Match /Users/<username> patterns still remaining
      const usernamePathRegex = new RegExp(
        `/Users/${escapeRegex(username)}(?!/?\\.claude)`,
        "g"
      );
      const usernameMatches = result.match(usernamePathRegex);
      if (usernameMatches) {
        replacementCount += usernameMatches.length;
        result = result.replace(usernamePathRegex, "/Users/[user]");
      }

      // Match bare username references (e.g. "Owner: [user]")
      // Be conservative: only match standalone word boundaries to avoid false positives
      const bareUsernameRegex = new RegExp(`\\b${escapeRegex(username)}\\b`, "g");
      const bareMatches = result.match(bareUsernameRegex);
      if (bareMatches) {
        replacementCount += bareMatches.length;
        result = result.replace(bareUsernameRegex, "[user]");
      }
    }

    return {
      content: result,
      replacementCount,
      changed: result !== content,
    };
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─────────────────────────────────────────────────────────────
// FileHashRegistry — incremental diff via SHA-256
// ─────────────────────────────────────────────────────────────

export class FileHashRegistry {
  private registry: Map<string, string>;

  constructor() {
    this.registry = new Map();
  }

  static computeHash(content: string): string {
    return createHash("sha256").update(content, "utf8").digest("hex");
  }

  setHash(relativePath: string, hash: string): void {
    this.registry.set(relativePath, hash);
  }

  getHash(relativePath: string): string | undefined {
    return this.registry.get(relativePath);
  }

  /**
   * Returns true if the file's content hash differs from what's stored,
   * or if the file has never been seen.
   */
  hasChanged(relativePath: string, currentHash: string): boolean {
    const storedHash = this.registry.get(relativePath);
    if (storedHash === undefined) return true; // New file
    return storedHash !== currentHash;
  }

  toJSON(): HashRegistry {
    return Object.fromEntries(this.registry.entries());
  }

  static fromJSON(data: HashRegistry): FileHashRegistry {
    const instance = new FileHashRegistry();
    for (const [key, value] of Object.entries(data)) {
      instance.setHash(key, value);
    }
    return instance;
  }
}

// ─────────────────────────────────────────────────────────────
// SafetyValidator — three-layer validation
// ─────────────────────────────────────────────────────────────

export class SafetyValidator {
  private blocklist: BlocklistConfig;
  private scanner: SecretScanner;
  private filter: BlocklistFilter;

  constructor(blocklist: BlocklistConfig) {
    this.blocklist = blocklist;
    this.scanner = new SecretScanner();
    this.filter = new BlocklistFilter(blocklist);
  }

  /** Layer 1: Pattern scan on staged git diff output */
  async validateDiff(diff: string): Promise<ValidationLayerResult> {
    const scanResult = this.scanner.scan(diff);
    if (scanResult.hasSecrets) {
      const finding = scanResult.findings[0];
      return {
        passed: false,
        layer: "pattern-scan",
        reason: `Secret pattern "${finding.pattern}" detected at diff line ${finding.line}: ${finding.snippet}`,
      };
    }
    return { passed: true };
  }

  /** Layer 2: Path audit against blocklist */
  async validatePaths(
    stagedPaths: string[] | StagedFile[]
  ): Promise<ValidationLayerResult> {
    const blockedPaths: string[] = [];

    for (const pathEntry of stagedPaths) {
      const relativePath =
        typeof pathEntry === "string" ? pathEntry : pathEntry.relativePath;
      if (!this.filter.isAllowed(relativePath)) {
        blockedPaths.push(relativePath);
      }
    }

    if (blockedPaths.length > 0) {
      return {
        passed: false,
        layer: "path-audit",
        reason: `${blockedPaths.length} blocked path(s) found in staged files`,
        blockedPaths,
      };
    }
    return { passed: true };
  }

  /** Layer 3: Size anomaly detection — block files > 500KB */
  async validateFileSizes(
    stagedPaths: StagedFile[]
  ): Promise<ValidationLayerResult> {
    const MAX_SIZE_BYTES = 500 * 1024; // 500KB

    for (const { relativePath, absolutePath } of stagedPaths) {
      if (!existsSync(absolutePath)) continue;
      const stat = statSync(absolutePath);
      if (stat.size > MAX_SIZE_BYTES) {
        return {
          passed: false,
          layer: "size-anomaly",
          reason: `File "${relativePath}" is ${(stat.size / 1024).toFixed(1)}KB — exceeds 500KB limit`,
        };
      }
    }
    return { passed: true };
  }

  /** Run all three layers. All must pass. Returns first failure or overall pass. */
  async validate(options: ValidateOptions): Promise<ValidationLayerResult> {
    // Layer 1
    const diffResult = await this.validateDiff(options.diff);
    if (!diffResult.passed) return diffResult;

    // Layer 2
    const pathResult = await this.validatePaths(options.stagedPaths);
    if (!pathResult.passed) return pathResult;

    // Layer 3
    const sizeResult = await this.validateFileSizes(options.stagedPaths);
    if (!sizeResult.passed) return sizeResult;

    return { passed: true };
  }
}

// ─────────────────────────────────────────────────────────────
// Default blocklist configuration
// ─────────────────────────────────────────────────────────────

export const DEFAULT_BLOCKLIST_CONFIG: BlocklistConfig = {
  excludedDirs: ["MEMORY", "context", "USER"],
  excludedFiles: ["secrets.json"],
  preserveReadmes: true,
  excludedSkills: [
    "JobHunter",
    "JobBlitz",
    "JobEngine",
    "Gmail",
    "Telegram",
    "CalendarAssistant",
    "NetworkMatch",
    "Shopping",
    "Instacart",
    "Designer",
    "Cooking",
  ],
  excludedStateDirs: true,
};

export const DEFAULT_TRANSFORM_CONFIG: TransformConfig = {
  absolutePathPrefix: "~/.claude",
  relativeReplacement: "~/.claude",
  stripUsernames: ["[user]"],
};

// ─────────────────────────────────────────────────────────────
// SyncEngine — orchestrates the full pipeline
// ─────────────────────────────────────────────────────────────

export interface SyncEngineConfig {
  sourceDir: string;
  stagingDir: string;
  remoteUrl: string;
  blocklistConfigPath: string;
  syncStatePath: string;
  dryRun?: boolean;
}

export interface SyncResult {
  success: boolean;
  filesProcessed: number;
  filesChanged: number;
  filesExcluded: number;
  secretsBlocked: number;
  commits: string[];
  error?: string;
  dryRun: boolean;
}

export interface FileGroup {
  skill: string;
  files: string[];
}

/**
 * The main orchestrator that runs the three-pass sanitization pipeline
 * and manages the staging area + git operations.
 */
export class SyncEngine {
  private config: SyncEngineConfig;
  private filter: BlocklistFilter;
  private scanner: SecretScanner;
  private transformer: ContentTransformer;
  private validator: SafetyValidator;
  private hashRegistry: FileHashRegistry;

  constructor(config: SyncEngineConfig, blocklistConfig?: BlocklistConfig) {
    this.config = config;
    const blocklistCfg = blocklistConfig ?? DEFAULT_BLOCKLIST_CONFIG;

    this.filter = new BlocklistFilter(blocklistCfg);
    this.scanner = new SecretScanner();
    this.transformer = new ContentTransformer(DEFAULT_TRANSFORM_CONFIG);
    this.validator = new SafetyValidator(blocklistCfg);
    this.hashRegistry = new FileHashRegistry();
  }

  /**
   * Generate a conventional commit message for a group of files.
   * Groups by skill directory.
   */
  generateCommitMessage(files: string[]): string {
    const groups = this.groupBySkill(files);

    if (groups.length === 0) return "chore: sync public repo";
    if (groups.length === 1) {
      const group = groups[0];
      const action = group.files.length === 1 ? "update" : "sync";
      const fileDesc =
        group.files.length === 1
          ? basename(group.files[0])
          : `${group.files.length} files`;
      return `feat(${group.skill}): ${action} ${fileDesc}`;
    }

    const skillNames = groups.map((g) => g.skill).join(", ");
    return `feat(${skillNames}): sync changes`;
  }

  /**
   * Group relative file paths by their parent skill directory.
   * Non-skill files are grouped under "root".
   */
  groupBySkill(files: string[]): FileGroup[] {
    const groups = new Map<string, string[]>();

    for (const file of files) {
      const parts = file.split("/");
      let skill: string;

      if (parts[0] === "skills" && parts.length >= 3) {
        skill = parts[1]; // skills/<SkillName>/...
      } else if (parts.length > 1) {
        skill = parts[0]; // top-level directory
      } else {
        skill = "root";
      }

      if (!groups.has(skill)) groups.set(skill, []);
      groups.get(skill)!.push(file);
    }

    return Array.from(groups.entries()).map(([skill, files]) => ({
      skill,
      files,
    }));
  }
}

// ─────────────────────────────────────────────────────────────
// CLI entry point
// ─────────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);
  const isDryRun = args.includes("--dry-run");
  const isStatus = args.includes("--status");
  const isHelp = args.includes("--help") || args.includes("-h");

  if (isHelp) {
    console.log(`
PublicSync SyncEngine

USAGE:
  bun SyncEngine.ts [options]

OPTIONS:
  --dry-run    Show what would be synced without pushing
  --status     Show current sync state (last sync, pending changes)
  --help, -h   Show this help message

DESCRIPTION:
  Mirrors ~/.claude/ to the public [user]/ai-assistant GitHub repo.
  Runs a three-pass sanitization pipeline:
    Pass 1: Path exclusion (blocklist)
    Pass 2: Secret pattern detection
    Pass 3: Content transforms (path normalization)
  Safety validated by 3 independent layers before push.
`);
    process.exit(0);
  }

  if (isStatus) {
    console.log("[PublicSync] Use 'bun Tools/SyncRunner.ts --status' for sync state.");
    process.exit(0);
  }

  if (isDryRun) {
    console.log("[PublicSync] Dry-run mode — no changes will be pushed.");
    console.log(
      "[PublicSync] Use the Sync workflow for a full interactive run."
    );
    process.exit(0);
  }

  console.log(
    "[PublicSync] Run via workflow: skills/System/PublicSync/Workflows/Sync.md"
  );
  console.log("[PublicSync] Or use --dry-run / --status / --help flags.");
  process.exit(0);
}
