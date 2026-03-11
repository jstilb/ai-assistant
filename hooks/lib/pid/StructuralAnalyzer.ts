/**
 * StructuralAnalyzer - Layer 3: Instruction-in-Data Detection
 * =============================================================
 *
 * Detects instruction-like patterns in non-instruction contexts.
 * The "does this data file contain commands?" detector.
 * Target: <30ms scan time.
 *
 * Analysis rules:
 * 1. Imperative density scoring
 * 2. Role-play boundary detection
 * 3. Instruction/data boundary confusion
 * 4. Context window poisoning
 * 5. MCP response structure validation
 */

import type { ScanFinding, InjectionDefenderConfig } from "./types";

// Imperative verbs that indicate commands
const IMPERATIVE_VERBS = new Set([
  "run", "execute", "delete", "create", "send", "write", "read", "install",
  "remove", "modify", "update", "deploy", "fetch", "download", "upload",
  "override", "ignore", "forget", "disregard", "bypass", "disable",
  "enable", "activate", "deactivate", "shutdown", "restart",
  "exfiltrate", "transmit", "forward", "pipe", "redirect",
]);

// Verbs that are common in normal code/docs (reduce FP when seen)
const COMMON_CODE_VERBS = new Set([
  "create", "read", "update", "delete", "write", "install", "run",
  "execute", "fetch", "deploy", "enable", "disable", "modify",
  "send", "remove", "download",
]);

// Role-play / persona patterns
const ROLE_PLAY_PATTERNS = [
  /you\s+are\s+now\s+(?:a|an|the)\s+/i,
  /your\s+(?:new|updated|real)\s+role\s+is/i,
  /from\s+now\s+on,?\s+you\s+(?:are|will|must|should)/i,
  /henceforth,?\s+you\s+(?:are|will|must)/i,
  /assume\s+the\s+(?:role|identity|persona)\s+of/i,
  /you\s+(?:will|shall)\s+(?:now\s+)?(?:act|behave|respond)\s+as/i,
];

// Instruction boundary confusion patterns
const BOUNDARY_CONFUSION_PATTERNS = [
  /(?:^|\n)\s*(?:<\/?(?:system|instructions?|rules?|prompt)>)/im,
  /(?:^|\n)\s*\[(?:SYSTEM|ADMIN|ROOT|INSTRUCTION)\]/im,
  /(?:^|\n)\s*---+\s*(?:system|admin|config|internal)\s*---+/im,
  /(?:^|\n)\s*={3,}\s*(?:system|instructions?)\s*={3,}/im,
];

// Context window poisoning indicators
const CONTEXT_POISONING_PATTERNS = [
  /(?:previous\s+conversation|chat\s+history|earlier\s+we\s+discussed)\s*(?:summary|context|history)?\s*:/i,
  /(?:memory|context)\s+(?:update|injection|override)\s*:/i,
  /\[(?:remembered|stored|cached)\s+context\]/i,
  /(?:conversation\s+(?:summary|history|context))\s*:/i,
];

/**
 * Scan content for structural anomalies indicating injection.
 * Target: <30ms for typical content.
 */
export function scan(
  content: string,
  toolName: string,
  config: InjectionDefenderConfig,
  _filePath?: string
): ScanFinding[] {
  const findings: ScanFinding[] = [];

  // Fast path: very short content
  if (content.length < 50) return findings;

  // Determine content type for threshold adjustment
  const isCodeContent = detectCodeContent(content);

  // 1. Imperative density scoring
  checkImperativeDensity(content, toolName, isCodeContent, findings);

  // 2. Role-play boundary detection
  checkRolePlayBoundaries(content, toolName, findings);

  // 3. Instruction/data boundary confusion
  checkBoundaryConfusion(content, toolName, findings);

  // 4. Context window poisoning
  checkContextPoisoning(content, toolName, findings);

  // 5. MCP response structure validation (only for MCP tools)
  if (toolName.startsWith("mcp__") || toolName.startsWith("mcp_")) {
    checkMcpResponse(content, toolName, findings);
  }

  return findings;
}

/**
 * Detect if content appears to be code (higher imperative threshold).
 */
function detectCodeContent(content: string): boolean {
  const codeIndicators = [
    /(?:function|const|let|var|import|export|class|interface|type)\s/,
    /(?:if|else|for|while|switch|return|throw|try|catch)\s*[({]/,
    /(?:def|async|await)\s/,
    /^\s*(?:\/\/|#|\/\*|\*)/m,
    /[{};]\s*$/m,
    /=>\s*{/,
  ];

  let matches = 0;
  for (const indicator of codeIndicators) {
    if (indicator.test(content)) matches++;
  }
  return matches >= 2;
}

/**
 * Check imperative verb density in content.
 * Data files with high imperative density are suspicious.
 */
function checkImperativeDensity(
  content: string,
  toolName: string,
  isCodeContent: boolean,
  findings: ScanFinding[]
): void {
  // Extract words (first 5000 chars for performance)
  const sampleContent = content.slice(0, 5000);
  const words = sampleContent.toLowerCase().split(/[\s,.:;!?()[\]{}"'`]+/).filter(Boolean);

  if (words.length < 10) return;

  let imperativeCount = 0;
  let codeVerbCount = 0;
  const imperativePositions: number[] = [];

  for (let i = 0; i < words.length; i++) {
    if (IMPERATIVE_VERBS.has(words[i])) {
      imperativeCount++;
      if (COMMON_CODE_VERBS.has(words[i])) {
        codeVerbCount++;
      }
      // Approximate position in original content
      imperativePositions.push(Math.floor((i / words.length) * sampleContent.length));
    }
  }

  const density = imperativeCount / words.length;

  // Thresholds differ by content type
  // Code: higher threshold (imperatives are normal in code)
  // Data/text: lower threshold (imperatives are suspicious)
  const threshold = isCodeContent ? 0.08 : 0.04;

  // If most imperative verbs are common code verbs, reduce concern
  const codeVerbRatio = imperativeCount > 0 ? codeVerbCount / imperativeCount : 0;

  if (density > threshold && codeVerbRatio < 0.8) {
    const confidence = Math.min(0.4 + (density - threshold) * 5, 0.85);
    findings.push({
      layer: "structural",
      category: "context_manipulation",
      severity: "medium",
      confidence,
      matched_text: `Imperative density: ${(density * 100).toFixed(1)}% (${imperativeCount}/${words.length} words)`,
      description: `High density of command-like verbs in ${isCodeContent ? "code" : "data"} content`,
      context: {
        tool: toolName,
        position: imperativePositions[0] || 0,
        surrounding: `${imperativeCount} imperative verbs in ${words.length} words`,
      },
    });
  }
}

/**
 * Check for role-play / persona boundary patterns.
 */
function checkRolePlayBoundaries(
  content: string,
  toolName: string,
  findings: ScanFinding[]
): void {
  for (const pattern of ROLE_PLAY_PATTERNS) {
    const match = pattern.exec(content);
    if (match) {
      findings.push({
        layer: "structural",
        category: "instruction_override",
        severity: "high",
        confidence: 0.75,
        matched_text: match[0].slice(0, 100),
        description: "Role-play/persona boundary detected in tool output",
        context: {
          tool: toolName,
          position: match.index,
          surrounding: getSurrounding(content, match.index, match[0].length),
        },
      });
      return; // One finding is enough
    }
  }
}

/**
 * Check for instruction/data boundary confusion.
 */
function checkBoundaryConfusion(
  content: string,
  toolName: string,
  findings: ScanFinding[]
): void {
  for (const pattern of BOUNDARY_CONFUSION_PATTERNS) {
    const match = pattern.exec(content);
    if (match) {
      // Check if this is inside a code block (reduces confidence)
      const precedingContent = content.slice(Math.max(0, match.index - 300), match.index);
      const backtickCount = (precedingContent.match(/```/g) || []).length;
      const inCodeBlock = backtickCount % 2 === 1;

      if (inCodeBlock) continue; // Skip code block matches

      findings.push({
        layer: "structural",
        category: "context_manipulation",
        severity: "high",
        confidence: 0.70,
        matched_text: match[0].trim().slice(0, 100),
        description: "Instruction/data boundary confusion (fake system markers)",
        context: {
          tool: toolName,
          position: match.index,
          surrounding: getSurrounding(content, match.index, match[0].length),
        },
      });
      return; // One finding per type
    }
  }
}

/**
 * Check for context window poisoning attempts.
 */
function checkContextPoisoning(
  content: string,
  toolName: string,
  findings: ScanFinding[]
): void {
  for (const pattern of CONTEXT_POISONING_PATTERNS) {
    const match = pattern.exec(content);
    if (match) {
      findings.push({
        layer: "structural",
        category: "context_manipulation",
        severity: "medium",
        confidence: 0.60,
        matched_text: match[0].slice(0, 100),
        description: "Context window poisoning attempt (fake history/memory)",
        context: {
          tool: toolName,
          position: match.index,
          surrounding: getSurrounding(content, match.index, match[0].length),
        },
      });
      return;
    }
  }

  // Check for large blocks of repeated text (context stuffing)
  checkContextStuffing(content, toolName, findings);
}

/**
 * Detect large blocks of repeated text (context stuffing).
 */
function checkContextStuffing(
  content: string,
  toolName: string,
  findings: ScanFinding[]
): void {
  if (content.length < 1000) return;

  // Sample: take 50-char chunks at intervals and check for repetition
  const chunkSize = 50;
  const chunks: string[] = [];
  // Use tighter sampling interval to catch shorter repeat cycles
  const interval = Math.max(chunkSize, Math.floor(content.length / 40));
  for (let i = 0; i < content.length && chunks.length < 40; i += interval) {
    chunks.push(content.slice(i, i + chunkSize));
  }

  // Count duplicates
  const seen = new Map<string, number>();
  for (const chunk of chunks) {
    seen.set(chunk, (seen.get(chunk) || 0) + 1);
  }

  let maxRepetition = 0;
  for (const count of seen.values()) {
    if (count > maxRepetition) maxRepetition = count;
  }

  if (maxRepetition >= 3) {
    findings.push({
      layer: "structural",
      category: "context_manipulation",
      severity: "medium",
      confidence: 0.55,
      matched_text: `${maxRepetition}x repeated content blocks detected`,
      description: "Context stuffing: large blocks of repeated text",
      context: {
        tool: toolName,
        position: 0,
        surrounding: `Content has ${maxRepetition} repeating 100-char blocks`,
      },
    });
  }
}

/**
 * Validate MCP response structure for injection.
 */
function checkMcpResponse(
  content: string,
  toolName: string,
  findings: ScanFinding[]
): void {
  // Check for nested tool-call structures in MCP responses
  const nestedToolPatterns = [
    /["']?(?:tool_call|function_call|tool_use)["']?\s*[:=]\s*[{[]/i,
    /(?:the\s+tool|server|api)\s+(?:says|requires|demands)\s+(?:you|that)/i,
  ];

  for (const pattern of nestedToolPatterns) {
    const match = pattern.exec(content);
    if (match) {
      findings.push({
        layer: "structural",
        category: "mcp_attacks",
        severity: "high",
        confidence: 0.70,
        matched_text: match[0].slice(0, 100),
        description: "MCP response contains tool-call or instruction structures",
        context: {
          tool: toolName,
          position: match.index,
          surrounding: getSurrounding(content, match.index, match[0].length),
        },
      });
      return;
    }
  }
}

/**
 * Get surrounding context for logging.
 */
function getSurrounding(content: string, position: number, matchLength: number): string {
  const radius = 50;
  const start = Math.max(0, position - radius);
  const end = Math.min(content.length, position + matchLength + radius);
  let result = content.slice(start, end);
  if (start > 0) result = "..." + result;
  if (end < content.length) result = result + "...";
  return result.replace(/\n/g, " ").slice(0, 150);
}
