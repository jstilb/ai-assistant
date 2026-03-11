/**
 * RegexScanner - Layer 1: Pattern Matching Engine
 * =================================================
 *
 * Pre-compiles all patterns at first invocation for <5ms scan time.
 * Uses early termination on critical findings and category priority ordering.
 *
 * FALSE POSITIVE MANAGEMENT:
 * - Context-aware scanning: checks if content is documentation/code about security
 * - Skip patterns per tool (configured in injection-config.yaml)
 * - Confidence scoring based on match context
 */

import type {
  ScanFinding,
  PatternRule,
  InjectionDefenderConfig,
  ThreatSeverity,
} from "./types";
import { getEnabledPatterns, loadPatterns } from "./patterns/index";

/** Pre-compiled pattern with metadata */
interface CompiledPattern {
  regex: RegExp;
  rule: PatternRule;
}

// Cache compiled patterns per tool
const compiledCache = new Map<string, CompiledPattern[]>();

// Severity ordering for scan priority (critical categories scanned first)
const SEVERITY_ORDER: Record<ThreatSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

// Categories that indicate the content is ABOUT security (meta-content)
// These reduce confidence when matched
const SECURITY_DOC_INDICATORS = [
  /(?:security|injection|attack|defense|defender|scanner|pattern|threat|vulnerability)/i,
  /(?:KAYASECURITYSYSTEM|prompt.injection|SecurityValidator)/i,
  /(?:false.positive|detection|scanning|payload)/i,
  /(?:specification|implementation|architecture|design\s+doc)/i,
  /(?:test\s+case|test\s+suite|unit\s+test|spec\.(?:ts|md))/i,
];

// File paths that are known-safe (Kaya internal files)
const SAFE_PATH_PATTERNS = [
  /KAYASECURITYSYSTEM\//,
  /hooks\/.*pid\//,
  /hooks\/.*prompt-injection/,
  /hooks\/.*security/i,
  /tests?\/.*pid/i,
  /tests?\/.*security/i,
  /tests?\/.*injection/i,
  /WORK\/.*spec\.md$/,
  /WORK\/.*security/i,
  /skills\/.*PromptInjection/,
  /skills\/.*RedTeam/,
  /skills\/.*Security/,
  /\.example\.yaml$/,
  /patterns\.yaml$/,
];

/**
 * Compile patterns for a given tool, cached after first call.
 */
function getCompiledPatterns(toolName: string): CompiledPattern[] {
  if (compiledCache.has(toolName)) {
    return compiledCache.get(toolName)!;
  }

  const patterns = getEnabledPatterns(toolName);

  // Sort by severity (critical first for early termination)
  patterns.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  const compiled: CompiledPattern[] = [];
  for (const rule of patterns) {
    try {
      // Strip inline flags that JS doesn't support, then compile
      let patternStr = rule.pattern;
      // Extract inline flags like (?i) or (?m) and apply them
      let flags = "m"; // multiline by default
      const inlineFlagMatch = patternStr.match(/^\(\?([imsu]+)\)/);
      if (inlineFlagMatch) {
        flags = inlineFlagMatch[1] + (inlineFlagMatch[1].includes("m") ? "" : "m");
        patternStr = patternStr.slice(inlineFlagMatch[0].length);
      } else {
        // Default: case-insensitive + multiline
        flags = "im";
      }

      const regex = new RegExp(patternStr, flags);
      compiled.push({ regex, rule });
    } catch {
      // Invalid regex -- skip silently (logged during pattern validation)
    }
  }

  compiledCache.set(toolName, compiled);
  return compiled;
}

/**
 * Check if the content appears to be documentation/code ABOUT security.
 * This is the key false-positive reducer.
 */
function isSecurityMetaContent(content: string, filePath?: string): boolean {
  // Check file path first (fastest)
  if (filePath) {
    for (const pattern of SAFE_PATH_PATTERNS) {
      if (pattern.test(filePath)) return true;
    }
  }

  // Count security documentation indicators in the content
  let indicatorCount = 0;
  for (const indicator of SECURITY_DOC_INDICATORS) {
    if (indicator.test(content)) indicatorCount++;
  }

  // If 3+ indicators match, this is likely documentation about security
  return indicatorCount >= 3;
}

/**
 * Calculate confidence for a regex match based on context.
 * Lower confidence = more likely a false positive.
 */
function calculateConfidence(
  match: RegExpExecArray,
  content: string,
  isMetaContent: boolean,
  rule: PatternRule
): number {
  let confidence = 0.85; // Base confidence for regex match

  // Reduce confidence for meta-content (docs about security)
  // This is the primary false-positive suppression mechanism.
  // Security docs, test files, and spec files that DESCRIBE attacks
  // should never trigger actionable findings.
  if (isMetaContent) {
    confidence -= 0.65;
  }

  // Reduce confidence if the match is inside a code block
  const matchPos = match.index;
  const precedingContent = content.slice(Math.max(0, matchPos - 200), matchPos);
  if (isInsideCodeBlock(precedingContent)) {
    confidence -= 0.25;
  }

  // Reduce confidence if the match is inside quotes (likely an example)
  if (isInsideQuotes(content, matchPos)) {
    confidence -= 0.20;
  }

  // Reduce confidence for patterns with known FP notes
  if (rule.false_positive_notes) {
    confidence -= 0.10;
  }

  // Increase confidence for critical severity patterns
  if (rule.severity === "critical") {
    confidence += 0.05;
  }

  // Clamp to 0.0-1.0
  return Math.max(0.05, Math.min(1.0, confidence));
}

/**
 * Check if position appears to be inside a markdown code block.
 */
function isInsideCodeBlock(precedingContent: string): boolean {
  // Count triple backticks -- odd count means we're inside a code block
  const backtickCount = (precedingContent.match(/```/g) || []).length;
  return backtickCount % 2 === 1;
}

/**
 * Check if position appears to be inside quotes.
 */
function isInsideQuotes(content: string, position: number): boolean {
  // Check surrounding context for quote indicators
  const start = Math.max(0, position - 5);
  const end = Math.min(content.length, position + 5);
  const surrounding = content.slice(start, end);

  return /["'`]/.test(surrounding.charAt(0)) || /["'`]/.test(surrounding.charAt(surrounding.length - 1));
}

/**
 * Get surrounding context for a match (for logging).
 */
function getSurrounding(content: string, position: number, matchLength: number): string {
  const contextRadius = 50;
  const start = Math.max(0, position - contextRadius);
  const end = Math.min(content.length, position + matchLength + contextRadius);
  let surrounding = content.slice(start, end);
  if (start > 0) surrounding = "..." + surrounding;
  if (end < content.length) surrounding = surrounding + "...";
  return surrounding.replace(/\n/g, " ").slice(0, 150);
}

/**
 * Scan content using pre-compiled regex patterns.
 * Target: <5ms for typical content.
 */
export function scan(
  content: string,
  toolName: string,
  config: InjectionDefenderConfig,
  filePath?: string
): ScanFinding[] {
  const findings: ScanFinding[] = [];

  // Fast path: very short content
  if (content.length < (config.global.min_content_length || 20)) {
    return findings;
  }

  const compiled = getCompiledPatterns(toolName);
  if (compiled.length === 0) return findings;

  // Determine if this is meta-content (docs about security)
  const isMetaContent = isSecurityMetaContent(content, filePath);

  // Truncate content if needed
  const scanContent = content.length > config.global.content_size_limit
    ? content.slice(0, config.global.content_size_limit)
    : content;

  for (const { regex, rule } of compiled) {
    // Reset lastIndex for global-like behavior
    regex.lastIndex = 0;

    const match = regex.exec(scanContent);
    if (!match) continue;

    const confidence = calculateConfidence(match, scanContent, isMetaContent, rule);

    // Skip low-confidence matches entirely (false positive suppression)
    if (confidence < 0.30) continue;

    const matchedText = match[0].slice(0, 100); // Truncate matched text

    findings.push({
      layer: "regex",
      category: rule.category,
      severity: rule.severity,
      confidence,
      matched_text: matchedText,
      pattern_id: rule.id,
      description: rule.description,
      context: {
        tool: toolName,
        position: match.index,
        surrounding: getSurrounding(scanContent, match.index, match[0].length),
      },
    });

    // Early termination: stop scanning if we find a critical finding with high confidence
    if (rule.severity === "critical" && confidence >= 0.8) {
      break;
    }
  }

  return findings;
}

/**
 * Reset compiled pattern cache (for testing/hot-reload).
 */
export function resetCache(): void {
  compiledCache.clear();
}

/** Export for testing */
export const _testing = {
  isSecurityMetaContent,
  calculateConfidence,
  isInsideCodeBlock,
  isInsideQuotes,
  getCompiledPatterns,
};
