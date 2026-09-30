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
import { statSync, existsSync, readFileSync, readdirSync } from "fs";
import { basename, join, relative } from "path";
import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { createAppendLog } from "../../../../lib/core/AppendLog.ts";
import { memPath } from "../../../../lib/core/MemoryPaths.ts";

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface BlocklistConfig {
  /**
   * Fail-closed top-level allowlist. When non-empty, a path is allowed ONLY
   * if its first segment (top-level dir or root file) is in this list; every
   * other top-level entry is excluded, README preservation included. New
   * top-level dirs therefore stay private by default instead of syncing on
   * the next nightly (the fail-open gap found 2026-07-09 and 2026-09-01).
   * The exclusion rules below still apply inside allowed entries.
   */
  allowedTopLevel?: string[];
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
  /**
   * Directory names excluded at any depth INSIDE a skill (below the skill
   * root — `skills/<Category>/` itself is never matched). Defaults to
   * ["State"] when excludedStateDirs is true; blocklist.yaml widens it to
   * Data/, logs/, config/ etc. so per-skill runtime data never syncs.
   */
  excludedSkillSubdirs?: string[];
  /** Additional path prefixes from plugins/blocklist.json */
  additionalExcludedPaths?: string[];
  /**
   * Exact private identifier strings (e.g. Google Sheet / Drive IDs) that
   * must never appear in any synced file. Scanned as literals by the
   * SecretScanner; a hit aborts the sync exactly like a credential would.
   * Path exclusions are the first line of defence — this is the backstop
   * for the next file that embeds one of these after the fact.
   */
  blockedIdentifiers?: string[];
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
  /**
   * Exact literals replaced before username stripping (e.g. the owner's
   * e-mail address, which would otherwise be mangled into `[user]7@…`).
   */
  stripLiterals?: Array<{ literal: string; replacement: string }>;
}

// HashRegistry: maps relative path → SHA-256 hex string
export const HashRegistrySchema = z.record(
  z.string().min(1),
  z.string().regex(/^[0-9a-f]{64}$/, "must be SHA-256 hex")
);
export type HashRegistry = z.infer<typeof HashRegistrySchema>;

/**
 * Load and validate a HashRegistry from a JSON file.
 * Throws with a clear message if the file is corrupted.
 * Returns an empty registry if the file does not exist.
 */
export function loadHashRegistry(statePath: string): HashRegistry {
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf-8"));
    return HashRegistrySchema.parse(raw);
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw new Error(
        `sync-state.json schema validation failed: ${err.message}\nDelete ${statePath} to reset.`
      );
    }
    // File doesn't exist or is not JSON — start fresh
    return {};
  }
}

/**
 * Prune stale entries from a HashRegistry.
 * Removes entries for files no longer present in currentFiles.
 */
export function pruneRegistry(
  registry: HashRegistry,
  currentFiles: Set<string>
): { pruned: HashRegistry; removedCount: number } {
  const pruned: HashRegistry = {};
  let removedCount = 0;
  for (const [path, hash] of Object.entries(registry)) {
    if (currentFiles.has(path)) {
      pruned[path] = hash;
    } else {
      removedCount++;
    }
  }
  if (removedCount > 0) {
    console.log(`[PublicSync] Pruned ${removedCount} stale registry entries`);
  }
  return { pruned, removedCount };
}

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

    // ── Fail-closed top-level allowlist ───────────────────
    // Runs before every other rule so nothing below (README preservation
    // included) can re-admit a top-level entry that was never allowed.
    const allowedTopLevel = this.config.allowedTopLevel ?? [];
    if (allowedTopLevel.length > 0 && !allowedTopLevel.includes(parts[0])) {
      return false;
    }

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
      // SQLite journal files (T7-08.1): live WAL/SHM files grow organically
      // between checkpoints and tripped the 500KB size-anomaly layer on every
      // nightly run from 2026-07-02 onward. Never sync candidates.
      ".db-wal", ".db-shm", ".sqlite-wal", ".sqlite-shm",
      // Editor/rotation backups of config files
      ".bak",
    ]);
    const filename = parts[parts.length - 1];
    // Rotation suffixes (foo.log.1, foo.db.2) must not dodge the extension
    // check — strip trailing numeric segments before extracting the extension.
    const baseName = filename.replace(/(\.\d+)+$/, "");
    const extIdx = baseName.lastIndexOf(".");
    if (extIdx > 0 && EXCLUDED_EXTENSIONS.has(baseName.slice(extIdx).toLowerCase())) {
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

      // ── Exclude State/ (and configured siblings) within any skill ──
      // Handles both skills/<Name>/State/ and skills/<Category>/<Name>/State/.
      // Only segments BELOW `skills/<first>` are matched, so a category dir
      // that happens to share a name (skills/Data/<Skill>/…) stays allowed.
      const skillSubdirs = this.config.excludedSkillSubdirs
        ?? (this.config.excludedStateDirs ? ["State"] : []);
      if (skillSubdirs.length > 0) {
        const insideSkill = parts.slice(2, -1); // directory segments after skills/<first>, excluding the filename
        if (insideSkill.some((segment) => skillSubdirs.includes(segment))) {
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

// Shapes that mark an ASSIGNED VALUE as a safe placeholder rather than a real
// credential. Tested against the value text only — never the whole line — so
// placeholder words in a comment can't exempt a real key sitting next to them
// (the P0 ordering fix), and conversely the docs idiom KEY=your_key_here isn't
// vetoed just because it parses as an assignment.
const PLACEHOLDER_VALUE_PATTERNS: RegExp[] = [
  /^<[^>]+>$/,             // <YOUR_API_KEY>
  /\bYOUR_[A-Z_]+\b/,      // YOUR_API_KEY
  /your[-_][a-z_-]+/i,     // your_key_here, your-token, your_actual_..._here
  /x{4,}/i,                // xxxx filler: apify_api_xxxxx
  /\.\.\./,                // truncated examples: sk-ant-api03-...
];

// Line shapes that are code manipulating variables, not literal credentials.
// Assigning FROM an identifier (process.env.KEY = savedKey) can't leak a
// secret; a quoted literal on the right-hand side deliberately does NOT match.
const CODE_CONTEXT_PATTERNS: RegExp[] = [
  /\.match\(|\.test\(|\.replace\(|RegExp\(/, // Regex/string operations in code
  /\/[^/]+_KEY[^/]*\//,    // Inside regex literals: /SOME_KEY=.../
  /process\.env\.\w+\s*=\s*[A-Za-z_$][\w$]*\s*(\?\?|\|\||;|$)/, // env restore from variable
  /os\.environ/,           // Python env access
];

/**
 * Assignment FROM a function call — `const GITHUB_TOKEN = loadGithubToken();`.
 * Anchored at the secret match (not the whole line) and only for assignment-
 * shaped matches, so a call elsewhere on the line — `Anthropic(api_key="sk-…")`,
 * `make(` next to a ghp_ token — can never exempt a literal credential.
 */
function assignsFromCall(line: string, match: RegExpExecArray): boolean {
  if (!/[=:]/.test(match[0])) return false; // bare token shapes are never calls
  return /^[^=:]*[=:]\s*[A-Za-z_$][\w$.]*\s*\(/.test(line.slice(match.index));
}

/**
 * Extract the value assigned at-or-after the secret pattern's match: the
 * first quoted string or bare token following an `=` or `:` from the match
 * position onward. Anchoring at the match (not the line start) keeps an
 * earlier unrelated `:` — e.g. `echo "Gemini: export KEY=your-key"` — from
 * hijacking extraction. Returns null when nothing assignment-like follows
 * (bare-token patterns like ghp_* / sk-ant-*).
 */
function extractAssignedValue(line: string, matchIndex: number): string | null {
  const tail = line.slice(matchIndex);
  const m = tail.match(/[=:]\s*(?:"([^"]*)"|'([^']*)'|([^\s"';]+))/);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}

export class SecretScanner {
  private identifierPatterns: Array<{ name: string; regex: RegExp }>;

  /**
   * @param blockedIdentifiers exact private identifier strings (Sheet/Drive
   *   IDs, …) from blocklist.yaml. Matched as literals with NO placeholder or
   *   code-context exemption — an ID inside a `.replace(` call is still the
   *   ID. Empty/short values are ignored so a stray "" can't match everything.
   */
  constructor(blockedIdentifiers: readonly string[] = []) {
    this.identifierPatterns = blockedIdentifiers
      .filter((id) => id.length >= 8)
      .map((id) => ({
        name: `blocked-identifier:${id.slice(0, 6)}…`,
        regex: new RegExp(escapeRegex(id)),
      }));
  }

  scan(content: string): ScanResult {
    const findings: SecretFinding[] = [];
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNumber = i + 1;

      // Blocked identifiers — literal match, no exemptions, checked first
      const identifierHit = this.identifierPatterns.find(({ regex }) => regex.test(line));
      if (identifierHit) {
        findings.push({
          line: lineNumber,
          pattern: identifierHit.name,
          snippet: line.slice(0, 80).replace(identifierHit.regex, "[REDACTED]"),
        });
        continue; // One finding per line
      }

      // Run secret patterns FIRST — never skip before checking
      for (const { name, regex } of SECRET_PATTERNS) {
        const match = regex.exec(line);
        if (!match) continue;

        // Secret pattern matched. Exempt only when the assigned value itself
        // is placeholder-shaped (falling back to the matched text for bare
        // tokens with no assignment), or the line is code moving variables.
        const value =
          extractAssignedValue(line, match.index) ?? match[0];
        const valueIsPlaceholder = PLACEHOLDER_VALUE_PATTERNS.some((p) =>
          p.test(value)
        );
        const isCodeContext =
          CODE_CONTEXT_PATTERNS.some((p) => p.test(line)) ||
          assignsFromCall(line, match);

        if (valueIsPlaceholder || isCodeContext) {
          // Placeholder/documentation or variable plumbing — safe to skip
          break;
        }

        // Real-looking credential or not clearly a placeholder — report it
        const snippet = line.slice(0, 80).replace(regex, "[REDACTED]");
        findings.push({
          line: lineNumber,
          pattern: name,
          snippet,
        });
        break; // One finding per line
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

    // Exact literals first (e-mail etc.) so the username pass below can't
    // half-mangle them into something like `[user]7@gmail.com`.
    for (const { literal, replacement } of this.config.stripLiterals ?? []) {
      if (!literal) continue;
      const literalRegex = new RegExp(escapeRegex(literal), "g");
      const literalMatches = result.match(literalRegex);
      if (literalMatches) {
        replacementCount += literalMatches.length;
        result = result.replace(literalRegex, replacement);
      }
    }

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
    this.scanner = new SecretScanner(blocklist.blockedIdentifiers ?? []);
    this.filter = new BlocklistFilter(blocklist);
  }

  /**
   * Layer 1: Pattern scan on staged git diff output. Only added (`+`) lines
   * are what gets published; removed/context lines are blanked (keeping diff
   * line numbers) so pruning an identifier-bearing orphan isn't a failure.
   */
  async validateDiff(diff: string): Promise<ValidationLayerResult> {
    const added = diff
      .split("\n")
      .map((line) => (line.startsWith("+") ? line : ""))
      .join("\n");
    const scanResult = this.scanner.scan(added);
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
  stripLiterals: [
    { literal: "[user-email]", replacement: "[user-email]" },
    { literal: "[user]", replacement: "[user]" },
  ],
};

// ─────────────────────────────────────────────────────────────
// blocklist.yaml loader (fail-closed) + allowed-file walker
// Shared by SyncRunner (live sync) and FreshExport (clean export/diff) so
// both see byte-identical filtering.
// ─────────────────────────────────────────────────────────────

const BlocklistYamlSchema = z.object({
  allowedTopLevel: z.array(z.string()).optional(),
  excludedDirs: z.array(z.string()).optional(),
  excludedFiles: z.array(z.string()).optional(),
  excludedSkills: z.array(z.string()).optional(),
  preserveReadmes: z.boolean().optional(),
  excludedStateDirs: z.boolean().optional(),
  excludedSkillSubdirs: z.array(z.string()).optional(),
  additionalExcludedPaths: z.array(z.string()).optional(),
  blockedIdentifiers: z.array(z.string()).optional(),
});

/**
 * Parse blocklist.yaml into a full BlocklistConfig, layered over
 * DEFAULT_BLOCKLIST_CONFIG. FAIL-CLOSED: a missing, unreadable, or
 * schema-invalid file THROWS instead of silently falling back to the much
 * weaker built-in default (the fallback would have dropped every Sheet-ID
 * and personal-skill exclusion on the next nightly — T4-02 follow-on).
 */
export function loadBlocklistConfigFrom(yamlPath: string): BlocklistConfig {
  if (!existsSync(yamlPath)) {
    throw new Error(
      `[PublicSync] blocklist.yaml not found at ${yamlPath} — refusing to sync with the built-in default (fail-closed).`
    );
  }
  let rawParsed: unknown;
  try {
    rawParsed = parseYaml(readFileSync(yamlPath, "utf8"));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`[PublicSync] blocklist.yaml is not valid YAML (${message}) — refusing to sync (fail-closed).`);
  }
  const result = BlocklistYamlSchema.safeParse(rawParsed);
  if (!result.success) {
    throw new Error(
      `[PublicSync] blocklist.yaml failed schema validation — refusing to sync (fail-closed):\n${result.error.message}`
    );
  }
  const parsed = result.data;
  const config: BlocklistConfig = { ...DEFAULT_BLOCKLIST_CONFIG };
  if (parsed.allowedTopLevel) config.allowedTopLevel = parsed.allowedTopLevel;
  if (parsed.excludedDirs) config.excludedDirs = parsed.excludedDirs;
  if (parsed.excludedFiles) config.excludedFiles = parsed.excludedFiles;
  if (parsed.excludedSkills) config.excludedSkills = parsed.excludedSkills;
  if (parsed.preserveReadmes !== undefined) config.preserveReadmes = parsed.preserveReadmes;
  if (parsed.excludedStateDirs !== undefined) config.excludedStateDirs = parsed.excludedStateDirs;
  if (parsed.excludedSkillSubdirs) config.excludedSkillSubdirs = parsed.excludedSkillSubdirs;
  if (parsed.additionalExcludedPaths) config.additionalExcludedPaths = parsed.additionalExcludedPaths;
  if (parsed.blockedIdentifiers) config.blockedIdentifiers = parsed.blockedIdentifiers;
  return config;
}

/**
 * Recursively list every file under `sourceDir` the filter allows, as
 * `/`-joined paths relative to `sourceDir`. Directories the filter rejects
 * are not descended into (so an excluded top-level dir with 900k files is
 * never walked). Symlinks are not followed.
 */
export function walkAllowedFiles(sourceDir: string, filter: BlocklistFilter): string[] {
  const results: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — nothing to sync from it
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relativePath = relative(sourceDir, fullPath).split("\\").join("/");
      if (!filter.isAllowed(relativePath)) continue;
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        // No spread/concat: subtrees can exceed the JSC argument limit.
        results.push(relativePath);
      }
    }
  };
  walk(sourceDir);
  return results;
}

// ─────────────────────────────────────────────────────────────
// SyncEngine — orchestrates the full pipeline
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// Structured JSONL Audit Log
// ─────────────────────────────────────────────────────────────

export interface SyncOutcome {
  ts: number;
  action: "sync" | "dry-run" | "status";
  success: boolean;
  filesScanned: number;
  filesSynced: number;
  filesSkipped: number;
  filesBlocked: number;
  blockedDetails: Array<{ path: string; reason: string; patternName?: string }>;
  registryEntriesPruned: number;
  pushResult?: "success" | "skipped" | "failed" | "dry-run";
  pushError?: string;
  durationMs: number;
}

// ISC AppendLog seam: the log path resolves once at module load, so a single
// module-level instance is created and reused rather than re-resolved on
// each call.
const PUBLIC_SYNC_LOG_PATH = memPath("MONITORING", "audit", "public-sync.jsonl");
const publicSyncLog = createAppendLog(PUBLIC_SYNC_LOG_PATH);

export function logSyncOutcome(outcome: SyncOutcome): void {
  publicSyncLog.append(outcome);
}

// ─────────────────────────────────────────────────────────────
// SyncEngine config and result types
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
    this.scanner = new SecretScanner(blocklistCfg.blockedIdentifiers ?? []);
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

      if (parts[0] === "skills" && parts.length >= 4) {
        skill = parts[2]; // skills/<Category>/<SkillName>/...
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
