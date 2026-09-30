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
// Layer 4: ML Escalation (warn/ask band only)
// =============================================

/**
 * Structured judgment returned by the ML escalation call (Inference.ts
 * "fast" tier), given the content plus the finding(s) layers 1-3 already
 * produced. Only ever consulted when the preliminary verdict is "warn" --
 * a "block" verdict from layers 1-3 never reaches this code path, so this
 * type has no way to represent (and therefore cannot express) overriding a
 * block.
 */
export interface MlJudgment {
  /** true = LLM agrees this is a real injection attempt; false = false positive. */
  isTruePositive: boolean;
  /** Optional severity adjustment, folded back into decide() on confirm/escalate. */
  adjustedSeverity?: ThreatSeverity;
  /** Optional confidence adjustment (0.0-1.0), folded back into decide(). */
  adjustedConfidence?: number;
  /** Human-readable rationale, surfaced in the security event log. */
  reasoning: string;
}

/**
 * Outcome of one scanAsync() call. `ok: false` covers EVERY failure mode
 * (thrown error, Inference.ts success:false incl. timeout/rate-limit,
 * unparseable JSON, or the layer being disabled) -- callers must treat all
 * of these identically: fall back to the tripwire's own preliminary verdict,
 * unchanged, and log loudly. There is no shape here that lets a caller
 * mistake "failed" for "safe."
 */
export interface MlScanOutcome {
  ok: boolean;
  judgment?: MlJudgment;
  /** Present iff !ok -- for loud logging, never for silent branching. */
  failureReason?: string;
}

// =============================================
// Scanner Interfaces
// =============================================

/** Interface all scanning layers must implement */
export interface Scanner {
  name: string;
  scan(content: string, toolName: string, config: InjectionDefenderConfig): ScanFinding[];
}
