/**
 * Pattern Loader - SYSTEM/USER Cascade
 * ======================================
 *
 * Loads injection patterns and configuration from KAYASECURITYSYSTEM/.
 *
 * Paths:
 *   - KAYASECURITYSYSTEM/injection-patterns.yaml
 *   - KAYASECURITYSYSTEM/injection-config.yaml
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { getKayaDir } from "../../paths.ts";
import type { InjectionPatternsConfig, InjectionDefenderConfig, PatternRule } from "../types.ts";

/**
 * Directories searched for KAYASECURITYSYSTEM/<file>: the Kaya home first, then the
 * repo root this hook ships in. On the Mac both are the same directory. In a clone
 * or a CI checkout, KAYA_HOME may point elsewhere; without the repo fallback the
 * scanner would load ZERO patterns and detect nothing (silent fail-open).
 */
function securityFileCandidates(file: string): string[] {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
  const paths = [join(getKayaDir(), "KAYASECURITYSYSTEM", file), join(repoRoot, "KAYASECURITYSYSTEM", file)];
  return [...new Set(paths)];
}

// Cached loaded patterns and config
let cachedPatterns: InjectionPatternsConfig | null = null;
let cachedConfig: InjectionDefenderConfig | null = null;

/**
 * Load injection patterns from KAYASECURITYSYSTEM/.
 */
export function loadPatterns(): InjectionPatternsConfig {
  if (cachedPatterns) return cachedPatterns;

  const patternsPath = securityFileCandidates("injection-patterns.yaml").find((p) => existsSync(p));

  let loaded: InjectionPatternsConfig | null = null;
  if (patternsPath) {
    try {
      const content = readFileSync(patternsPath, "utf-8");
      loaded = parseYaml(content) as InjectionPatternsConfig;
    } catch (err) {
      // Fall through to defaults
      console.error(
        `[patterns] failed to parse injection-patterns.yaml, falling back to defaults: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (!loaded) {
    // Fail visibly: an empty pattern set means the scanner detects nothing.
    console.error(
      `[patterns] injection-patterns.yaml not found or unreadable (searched: ${securityFileCandidates("injection-patterns.yaml").join(", ")}); prompt-injection regex layer has NO patterns`,
    );
    loaded = {
      version: "1.0",
      last_updated: new Date().toISOString().slice(0, 10),
      categories: {},
    };
  }

  cachedPatterns = loaded;
  return loaded;
}

/**
 * Load defender configuration from KAYASECURITYSYSTEM/.
 */
export function loadConfig(): InjectionDefenderConfig {
  if (cachedConfig) return cachedConfig;

  const configPath = securityFileCandidates("injection-config.yaml").find((p) => existsSync(p));

  if (configPath) {
    try {
      const content = readFileSync(configPath, "utf-8");
      cachedConfig = parseYaml(content) as InjectionDefenderConfig;
    } catch (err) {
      // Fall through to defaults
      console.error(
        `[patterns] failed to parse injection-config.yaml, falling back to defaults: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (!cachedConfig) {
    cachedConfig = getDefaultConfig();
  }

  return cachedConfig;
}

/**
 * Get all enabled patterns, respecting skip_patterns for a given tool.
 */
export function getEnabledPatterns(toolName: string): PatternRule[] {
  const patterns = loadPatterns();
  const config = loadConfig();

  // Get tool-specific config
  const toolConfig = getToolConfig(toolName, config);
  const skipPatterns = new Set(toolConfig.skip_patterns || []);

  // Check category policies
  const categoryPolicies = config.category_policies || {};

  const result: PatternRule[] = [];

  for (const [categoryName, category] of Object.entries(patterns.categories)) {
    // Check if category is disabled by policy
    const policy = categoryPolicies[categoryName];
    if (policy && !policy.enabled) continue;

    for (const pattern of category.patterns) {
      // Skip disabled patterns
      if (!pattern.enabled) continue;
      // Skip tool-specific exclusions
      if (skipPatterns.has(pattern.id)) continue;

      // Apply severity override from policy
      const effectivePattern = { ...pattern };
      if (policy?.severity_override) {
        effectivePattern.severity = policy.severity_override;
      }

      result.push(effectivePattern);
    }
  }

  return result;
}

/**
 * Get the scanning config for a specific tool.
 */
export function getToolConfig(toolName: string, config: InjectionDefenderConfig): ToolScanConfig {
  // Direct tool match
  const direct = config.tools[toolName];
  if (direct) return direct;

  // MCP tools match the "mcp" config
  if (toolName.startsWith("mcp__") || toolName.startsWith("mcp_")) {
    const mcp = config.tools.mcp;
    if (mcp) return mcp;
  }

  const fallback = config.tools.default;
  if (!fallback) throw new Error("injection-config: tools.default is missing; cannot pick a scan config");
  return fallback;
}

// Local import for type
import type { ToolScanConfig } from "../types.ts";

/**
 * Reset caches (for testing).
 */
export function resetCaches(): void {
  cachedPatterns = null;
  cachedConfig = null;
}

/**
 * Safe default configuration when no YAML files are found.
 */
function getDefaultConfig(): InjectionDefenderConfig {
  return {
    version: "1.0",
    enabled: true,
    global: {
      default_action: "warn",
      max_scan_time_ms: 200,
      enable_ml_layer: false,
      log_clean_scans: false,
      content_size_limit: 102400,
      min_content_length: 20,
    },
    tools: {
      Read: {
        enabled: true,
        max_content_length: 102400,
        layers: ["regex", "encoding", "structural"],
        skip_patterns: ["PI-043"],
      },
      WebFetch: {
        enabled: true,
        max_content_length: 51200,
        layers: ["regex", "encoding", "structural"],
      },
      Bash: {
        enabled: true,
        max_content_length: 51200,
        layers: ["regex", "encoding"],
        skip_patterns: ["PI-060", "PI-061"],
      },
      WebSearch: {
        enabled: true,
        max_content_length: 20480,
        layers: ["regex"],
      },
      mcp: {
        enabled: true,
        max_content_length: 102400,
        layers: ["regex", "encoding", "structural"],
      },
      default: {
        enabled: false,
        max_content_length: 51200,
        layers: ["regex"],
      },
    },
  };
}
