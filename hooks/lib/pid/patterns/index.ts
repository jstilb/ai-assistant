/**
 * Pattern Loader - SYSTEM/USER Cascade
 * ======================================
 *
 * Loads injection patterns and configuration following Kaya's two-tier
 * SYSTEM/USER architecture. USER overrides take precedence.
 *
 * Search order for patterns:
 *   1. USER/KAYASECURITYSYSTEM/injection-patterns.yaml
 *   2. KAYASECURITYSYSTEM/injection-patterns.yaml (SYSTEM default)
 *
 * Search order for config:
 *   1. USER/KAYASECURITYSYSTEM/injection-config.yaml
 *   2. KAYASECURITYSYSTEM/injection-config.yaml (SYSTEM default)
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { parse as parseYaml } from "yaml";
import { getKayaDir } from "../../paths";
import type {
  InjectionPatternsConfig,
  InjectionDefenderConfig,
  PatternRule,
} from "../types";

// Cached loaded patterns and config
let cachedPatterns: InjectionPatternsConfig | null = null;
let cachedConfig: InjectionDefenderConfig | null = null;

/**
 * Load injection patterns with SYSTEM/USER cascade.
 * USER patterns override SYSTEM patterns on a per-category basis.
 */
export function loadPatterns(): InjectionPatternsConfig {
  if (cachedPatterns) return cachedPatterns;

  const kayaDir = getKayaDir();

  // SYSTEM default path
  const systemPath = join(kayaDir, "KAYASECURITYSYSTEM", "injection-patterns.yaml");
  // USER override path
  const userPath = join(kayaDir, "USER", "KAYASECURITYSYSTEM", "injection-patterns.yaml");

  let systemPatterns: InjectionPatternsConfig | null = null;
  let userPatterns: InjectionPatternsConfig | null = null;

  // Load SYSTEM patterns (required)
  if (existsSync(systemPath)) {
    try {
      const content = readFileSync(systemPath, "utf-8");
      systemPatterns = parseYaml(content) as InjectionPatternsConfig;
    } catch {
      // Fall through to defaults
    }
  }

  // Load USER patterns (optional override)
  if (existsSync(userPath)) {
    try {
      const content = readFileSync(userPath, "utf-8");
      userPatterns = parseYaml(content) as InjectionPatternsConfig;
    } catch {
      // Fall through, use SYSTEM
    }
  }

  // Merge: USER categories override SYSTEM categories
  if (systemPatterns && userPatterns) {
    cachedPatterns = {
      ...systemPatterns,
      categories: {
        ...systemPatterns.categories,
        ...userPatterns.categories,
      },
    };
  } else if (userPatterns) {
    cachedPatterns = userPatterns;
  } else if (systemPatterns) {
    cachedPatterns = systemPatterns;
  } else {
    // Fallback: empty config (no patterns loaded)
    cachedPatterns = {
      version: "1.0",
      last_updated: new Date().toISOString().split("T")[0],
      categories: {},
    };
  }

  return cachedPatterns;
}

/**
 * Load defender configuration with SYSTEM/USER cascade.
 */
export function loadConfig(): InjectionDefenderConfig {
  if (cachedConfig) return cachedConfig;

  const kayaDir = getKayaDir();

  const systemPath = join(kayaDir, "KAYASECURITYSYSTEM", "injection-config.yaml");
  const userPath = join(kayaDir, "USER", "KAYASECURITYSYSTEM", "injection-config.yaml");

  let config: InjectionDefenderConfig | null = null;

  // Try USER first (higher priority)
  if (existsSync(userPath)) {
    try {
      const content = readFileSync(userPath, "utf-8");
      config = parseYaml(content) as InjectionDefenderConfig;
    } catch {
      // Fall through
    }
  }

  // Fall back to SYSTEM
  if (!config && existsSync(systemPath)) {
    try {
      const content = readFileSync(systemPath, "utf-8");
      config = parseYaml(content) as InjectionDefenderConfig;
    } catch {
      // Fall through
    }
  }

  // Fallback: safe defaults
  if (!config) {
    config = getDefaultConfig();
  }

  cachedConfig = config;
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
export function getToolConfig(
  toolName: string,
  config: InjectionDefenderConfig
): ToolScanConfig {
  // Direct tool match
  if (toolName in config.tools) {
    return config.tools[toolName];
  }

  // MCP tools match the "mcp" config
  if (toolName.startsWith("mcp__") || toolName.startsWith("mcp_")) {
    return config.tools.mcp || config.tools.default;
  }

  return config.tools.default;
}

// Local import for type
import type { ToolScanConfig } from "../types";

/**
 * Get MCP trust level for a given tool name.
 */
export function getMcpTrustLevel(
  toolName: string,
  config: InjectionDefenderConfig
): "trusted" | "standard" | "untrusted" {
  if (!config.mcp_trust) return "untrusted";

  // Extract server name from tool name (e.g., "mcp__gemini__query" -> "gemini")
  const parts = toolName.replace(/^mcp_+/, "").split("__");
  const serverPrefix = parts[0] || "";

  return config.mcp_trust[serverPrefix] || "untrusted";
}

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
