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
 * Load injection patterns from KAYASECURITYSYSTEM/.
 */
export function loadPatterns(): InjectionPatternsConfig {
  if (cachedPatterns) return cachedPatterns;

  const kayaDir = getKayaDir();
  const patternsPath = join(kayaDir, "KAYASECURITYSYSTEM", "injection-patterns.yaml");

  if (existsSync(patternsPath)) {
    try {
      const content = readFileSync(patternsPath, "utf-8");
      cachedPatterns = parseYaml(content) as InjectionPatternsConfig;
    } catch {
      // Fall through to defaults
    }
  }

  if (!cachedPatterns) {
    cachedPatterns = {
      version: "1.0",
      last_updated: new Date().toISOString().split("T")[0],
      categories: {},
    };
  }

  return cachedPatterns;
}

/**
 * Load defender configuration from KAYASECURITYSYSTEM/.
 */
export function loadConfig(): InjectionDefenderConfig {
  if (cachedConfig) return cachedConfig;

  const kayaDir = getKayaDir();
  const configPath = join(kayaDir, "KAYASECURITYSYSTEM", "injection-config.yaml");

  if (existsSync(configPath)) {
    try {
      const content = readFileSync(configPath, "utf-8");
      cachedConfig = parseYaml(content) as InjectionDefenderConfig;
    } catch {
      // Fall through to defaults
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
