/**
 * Prompt Injection Defender - Type Definitions
 * =============================================
 *
 * Shared type definitions for the multi-layer PID scanning pipeline.
 * All interfaces follow the spec from security-pid-001.
 */

// =============================================
// Hook Input/Output (Claude Code Protocol)
// =============================================

export interface PostToolUseInput {
  session_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_output: string;          // The content to scan
}

export interface HookDecision {
  continue: true;
}

export interface HookBlock {
  decision: "block";
  message: string;
}

export interface HookWarn {
  decision: "warn";
  message: string;
}

export type HookOutput = HookDecision | HookBlock | HookWarn;

// =============================================
// Scanning Pipeline
// =============================================

/** Severity levels for detected threats */
export type ThreatSeverity = "critical" | "high" | "medium" | "low" | "info";

/** Response actions per severity */
export type ThreatAction = "block" | "warn" | "log";

/** A single detection finding */
export interface ScanFinding {
  layer: "regex" | "encoding" | "structural" | "ml";
  category: string;
  severity: ThreatSeverity;
  confidence: number;         // 0.0 to 1.0
  matched_text: string;       // The suspicious fragment (truncated)
  pattern_id?: string;        // Which pattern matched (regex layer)
  description: string;        // Human-readable explanation
  context: {
    tool: string;
    position: number;
    surrounding: string;      // +/- 50 chars for context
  };
}

/** Aggregated scan result */
export interface ScanResult {
  clean: boolean;
  findings: ScanFinding[];
  max_severity: ThreatSeverity;
  recommended_action: ThreatAction;
  scan_time_ms: number;
  layers_executed: string[];
}

// =============================================
// Content Extraction
// =============================================

/** Extracted content ready for scanning */
export interface ExtractedContent {
  tool: string;
  source_type: "file" | "web" | "command" | "mcp" | "search";
  text: string;
  metadata: {
    file_path?: string;
    url?: string;
    command?: string;
    mcp_server?: string;
    content_length: number;
  };
}

// =============================================
// Pattern Definitions
// =============================================

/** A regex pattern rule */
export interface PatternRule {
  id: string;
  pattern: string;
  category: string;
  severity: ThreatSeverity;
  description: string;
  enabled: boolean;
  false_positive_notes?: string;
}

/** Pattern file schema */
export interface InjectionPatternsConfig {
  version: string;
  last_updated: string;
  categories: {
    [category: string]: {
      description: string;
      default_severity: ThreatSeverity;
      default_action: ThreatAction;
      patterns: PatternRule[];
    };
  };
}

// =============================================
// Configuration
// =============================================

/** Per-category policy override */
export interface CategoryPolicy {
  action: ThreatAction;
  enabled: boolean;
  severity_override?: ThreatSeverity;
}

/** Tool-specific scanning config */
export interface ToolScanConfig {
  enabled: boolean;
  max_content_length: number;
  layers: ("regex" | "encoding" | "structural" | "ml")[];
  skip_patterns?: string[];
}

/** Main configuration schema */
export interface InjectionDefenderConfig {
  version: string;
  enabled: boolean;

  global: {
    default_action: ThreatAction;
    max_scan_time_ms: number;
    enable_ml_layer: boolean;
    ml_endpoint?: string;
    log_clean_scans: boolean;
    content_size_limit: number;
    min_content_length: number;
  };

  tools: {
    Read: ToolScanConfig;
    WebFetch: ToolScanConfig;
    Bash: ToolScanConfig;
    WebSearch: ToolScanConfig;
    mcp: ToolScanConfig;
    default: ToolScanConfig;
    [key: string]: ToolScanConfig;
  };

  category_policies?: {
    [category: string]: CategoryPolicy;
  };

  mcp_trust?: {
    [server_prefix: string]: "trusted" | "standard" | "untrusted";
  };
}

// =============================================
// Security Event (extends existing schema)
// =============================================

export interface InjectionSecurityEvent {
  timestamp: string;
  session_id: string;
  event_type: "injection_detected" | "injection_blocked" | "injection_warned" | "scan_clean";
  tool: string;
  source_type: string;
  findings: ScanFinding[];
  action_taken: ThreatAction;
  scan_time_ms: number;
  content_hash: string;
  content_preview: string;
}

// =============================================
// Scanner Interfaces
// =============================================

/** Interface all scanning layers must implement */
export interface Scanner {
  name: string;
  scan(content: string, toolName: string, config: InjectionDefenderConfig): ScanFinding[];
}
