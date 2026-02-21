#!/usr/bin/env bun
/**
 * PromptInjectionDefender - PostToolUse Hook
 * =============================================
 *
 * Multi-layer scanning pipeline for detecting prompt injection in tool outputs.
 * Replaces the legacy prompt-injection-defender/post-tool-defender.ts.
 *
 * Layers:
 *   1. RegexScanner    (<5ms)  - Pattern matching with pre-compiled RegExp
 *   2. EncodingDetector (<10ms) - Base64, zero-width, homoglyphs, hex, URL
 *   3. StructuralAnalyzer (<30ms) - Imperative density, role-play, boundaries
 *   4. MLClassifier    (disabled) - Stub for Phase 2
 *
 * Exit codes:
 *   0 = Allow (with optional warning via JSON stdout)
 *   2 = Block (critical threat detected)
 *
 * Performance targets:
 *   Clean content: <3ms
 *   Full scan (no ML): <50ms
 */

import { existsSync, mkdirSync, appendFileSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { getKayaDir, getMemoryDir } from "./lib/paths";
import { extractContent, getSourceDescription } from "./lib/pid/ContentExtractor";
import * as RegexScanner from "./lib/pid/RegexScanner";
import * as EncodingDetector from "./lib/pid/EncodingDetector";
import * as StructuralAnalyzer from "./lib/pid/StructuralAnalyzer";
import * as MLClassifier from "./lib/pid/MLClassifier";
import { decide, formatWarning, formatBlockMessage } from "./lib/pid/DecisionEngine";
import { loadConfig, getToolConfig } from "./lib/pid/patterns/index";
import type { ScanFinding, InjectionSecurityEvent } from "./lib/pid/types";

/**
 * Main entry point.
 */
async function main(): Promise<void> {
  const startTime = performance.now();

  // Read stdin (Claude Code hook protocol)
  let inputText = "";
  for await (const chunk of Bun.stdin.stream()) {
    inputText += new TextDecoder().decode(chunk);
  }

  let input: {
    tool_name: string;
    tool_input: Record<string, unknown>;
    tool_output?: string;
    tool_response?: string;
    tool_result?: string;
    session_id?: string;
  };

  try {
    input = JSON.parse(inputText);
  } catch {
    // Invalid JSON, fail open
    process.exit(0);
  }

  const toolName = input.tool_name;
  const toolInput = input.tool_input || {};
  // Claude Code may use tool_output, tool_response, or tool_result
  const toolOutput = input.tool_output || input.tool_response || input.tool_result || "";
  const sessionId = input.session_id || "unknown";

  // Load configuration
  const config = loadConfig();

  // Fast path: defender disabled
  if (!config.enabled) {
    process.exit(0);
  }

  // Fast path: get tool-specific config
  const toolConfig = getToolConfig(toolName, config);
  if (!toolConfig.enabled) {
    process.exit(0);
  }

  // Fast path: empty or very short output
  if (!toolOutput || toolOutput.length < (config.global.min_content_length || 20)) {
    process.exit(0);
  }

  // Extract content
  const content = extractContent(toolName, toolInput, String(toolOutput));
  if (!content) {
    process.exit(0);
  }

  // Truncate if needed
  const scanText = content.text.length > toolConfig.max_content_length
    ? content.text.slice(0, toolConfig.max_content_length)
    : content.text;

  // Get file path for context-aware scanning
  const filePath = content.metadata.file_path || content.metadata.url || undefined;

  // Run scanning layers based on tool config
  const findings: ScanFinding[] = [];
  const layersExecuted: string[] = [];
  const layers = toolConfig.layers || ["regex"];

  // Layer 1: Regex
  if (layers.includes("regex")) {
    const layerStart = performance.now();
    const regexFindings = RegexScanner.scan(scanText, toolName, config, filePath);
    findings.push(...regexFindings);
    layersExecuted.push("regex");

    // Early termination: if regex found a critical + high confidence finding
    const hasCriticalBlock = regexFindings.some(
      f => f.severity === "critical" && f.confidence >= 0.8
    );
    if (hasCriticalBlock) {
      // Skip remaining layers -- we already know this is bad
      const scanTime = performance.now() - startTime;
      const result = decide(findings, scanTime, layersExecuted, config);
      await handleResult(result, content, toolName, sessionId, scanTime);
      return;
    }
  }

  // Layer 2: Encoding
  if (layers.includes("encoding")) {
    const encodingFindings = EncodingDetector.scan(scanText, toolName, config, filePath);
    findings.push(...encodingFindings);
    layersExecuted.push("encoding");
  }

  // Layer 3: Structural
  if (layers.includes("structural")) {
    const structuralFindings = StructuralAnalyzer.scan(scanText, toolName, config, filePath);
    findings.push(...structuralFindings);
    layersExecuted.push("structural");
  }

  // Layer 4: ML (disabled by default)
  if (layers.includes("ml") && config.global.enable_ml_layer) {
    const mlFindings = MLClassifier.scan(scanText, toolName, config, filePath);
    findings.push(...mlFindings);
    layersExecuted.push("ml");
  }

  const scanTime = performance.now() - startTime;

  // Decision
  const result = decide(findings, scanTime, layersExecuted, config);

  await handleResult(result, content, toolName, sessionId, scanTime);
}

/**
 * Handle the scan result: log, warn, or block.
 */
async function handleResult(
  result: ReturnType<typeof decide>,
  content: ReturnType<typeof extractContent>,
  toolName: string,
  sessionId: string,
  scanTime: number
): Promise<void> {
  const sourceDesc = content ? getSourceDescription(content) : "unknown";

  // Log security event
  if (!result.clean || loadConfig().global.log_clean_scans) {
    logSecurityEvent({
      timestamp: new Date().toISOString(),
      session_id: sessionId,
      event_type: result.clean ? "scan_clean" :
        result.recommended_action === "block" ? "injection_blocked" :
        result.recommended_action === "warn" ? "injection_warned" :
        "injection_detected",
      tool: toolName,
      source_type: content?.source_type || "unknown",
      findings: result.findings,
      action_taken: result.recommended_action,
      scan_time_ms: Math.round(scanTime * 100) / 100,
      content_hash: hashContent(content?.text || ""),
      content_preview: (content?.text || "").slice(0, 200).replace(/\n/g, " "),
    });
  }

  // Take action
  switch (result.recommended_action) {
    case "block": {
      const message = formatBlockMessage(result, sourceDesc, toolName);
      console.error(message);
      process.exit(2);
      break;
    }

    case "warn": {
      const warning = formatWarning(result, sourceDesc, toolName);
      const output = JSON.stringify({ decision: "block", reason: warning });
      console.log(output);
      process.exit(0);
      break;
    }

    case "log":
    default:
      // Silent pass-through
      process.exit(0);
  }
}

/**
 * Log a security event to MEMORY/SECURITY/YYYY/MM/.
 */
function logSecurityEvent(event: InjectionSecurityEvent): void {
  try {
    const now = new Date();
    const year = now.getFullYear().toString();
    const month = (now.getMonth() + 1).toString().padStart(2, "0");
    const day = now.getDate().toString().padStart(2, "0");

    const securityDir = join(getMemoryDir(), "SECURITY", year, month);
    if (!existsSync(securityDir)) {
      mkdirSync(securityDir, { recursive: true });
    }

    const logFile = join(securityDir, `pid-${day}.jsonl`);
    appendFileSync(logFile, JSON.stringify(event) + "\n");
  } catch {
    // Logging failure must never block execution
  }
}

/**
 * SHA-256 hash of content for deduplication.
 */
function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

// Run
main().catch(() => process.exit(0));
