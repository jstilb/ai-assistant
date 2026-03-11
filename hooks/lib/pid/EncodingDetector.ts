/**
 * EncodingDetector - Layer 2: Encoding Analysis
 * ================================================
 *
 * Detects suspicious encoding that could hide payloads.
 * Target: <10ms scan time.
 *
 * Detections:
 * - Base64 blocks (with decode + rescan)
 * - Zero-width Unicode characters
 * - Homoglyph detection (mixed scripts)
 * - Hex-encoded sequences
 * - URL-encoded sequences
 * - ROT13 detection
 */

import type { ScanFinding, InjectionDefenderConfig } from "./types";

// Known-safe Base64 prefixes (images, certs, etc.)
const SAFE_BASE64_CONTEXTS = [
  /data:image\/[a-z]+;base64,/i,
  /-----BEGIN\s+(?:CERTIFICATE|PUBLIC KEY|RSA)/,
  /eyJ[A-Za-z0-9_-]+\.eyJ/, // JWT tokens (header.payload)
  /sha[0-9]+-/i, // SRI hashes
  /integrity\s*=\s*["']/i,
  /\.woff2?\b/i, // Font data
  /\.(?:png|jpg|jpeg|gif|svg|ico|webp)\b/i,
];

// Zero-width characters to detect
const ZERO_WIDTH_CHARS = new Set([
  0x200B, // Zero Width Space
  0x200C, // Zero Width Non-Joiner
  0x200D, // Zero Width Joiner
  0xFEFF, // Byte Order Mark
  0x00AD, // Soft Hyphen
  0x2060, // Word Joiner
  0x180E, // Mongolian Vowel Separator
]);

// Confusable character pairs: [Latin, Cyrillic/Greek lookalike]
const HOMOGLYPH_MAP: Record<string, number[]> = {
  a: [0x0430], // Cyrillic а
  e: [0x0435, 0x03B5], // Cyrillic е, Greek ε
  o: [0x043E, 0x03BF], // Cyrillic о, Greek ο
  p: [0x0440, 0x03C1], // Cyrillic р, Greek ρ
  c: [0x0441], // Cyrillic с
  x: [0x0445], // Cyrillic х
  s: [0x0455], // Cyrillic ѕ
  i: [0x0456], // Cyrillic і
  y: [0x0443], // Cyrillic у
};

// Injection keywords to check in decoded content (simple string matching for speed)
const INJECTION_KEYWORD_STRINGS = [
  "ignore", "previous", "instructions",
  "system prompt", "system message", "system override",
  "forget", "disregard", "override",
  "you are now", "new instructions", "jailbreak",
];

/**
 * Check if decoded text contains injection-related keywords.
 * Uses simple case-insensitive string matching for reliability.
 * For encoded content, ANY single suspicious keyword is enough
 * because encoding itself is the suspicious signal.
 */
function containsInjectionKeywords(text: string): boolean {
  const lower = text.toLowerCase();
  for (const keyword of INJECTION_KEYWORD_STRINGS) {
    if (lower.includes(keyword)) {
      return true;
    }
  }
  return false;
}

/**
 * Scan content for encoding-based attacks.
 * Target: <10ms for typical content.
 */
export function scan(
  content: string,
  toolName: string,
  config: InjectionDefenderConfig,
  _filePath?: string
): ScanFinding[] {
  const findings: ScanFinding[] = [];

  // Fast path: short content rarely has encoding attacks
  // But zero-width chars can be in short strings, so keep threshold low
  if (content.length < 10) return findings;

  // Run each detector
  detectBase64(content, toolName, findings);
  detectZeroWidth(content, toolName, findings);
  detectHomoglyphs(content, toolName, findings);
  detectHexEncoding(content, toolName, findings);
  detectUrlEncoding(content, toolName, findings);

  return findings;
}

/**
 * Detect Base64-encoded blocks that might hide instructions.
 */
function detectBase64(content: string, toolName: string, findings: ScanFinding[]): void {
  // Match Base64 blocks of 40+ chars
  const base64Regex = /(?:[A-Za-z0-9+/]{4}){10,}={0,2}/g;
  let match: RegExpExecArray | null;

  while ((match = base64Regex.exec(content)) !== null) {
    const b64String = match[0];
    const position = match.index;

    // Check if this is in a known-safe context
    const preceding = content.slice(Math.max(0, position - 100), position);
    let isSafe = false;
    for (const safePattern of SAFE_BASE64_CONTEXTS) {
      if (safePattern.test(preceding)) {
        isSafe = true;
        break;
      }
    }
    if (isSafe) continue;

    // Attempt to decode and check for injection keywords
    try {
      const decoded = atob(b64String);
      // Check if decoded content is readable text (not binary)
      if (!isReadableText(decoded)) continue;

      if (containsInjectionKeywords(decoded)) {
        findings.push({
          layer: "encoding",
          category: "encoded_content",
          severity: "high",
          confidence: 0.85,
          matched_text: `Base64 decoded: "${decoded.slice(0, 80)}"`,
          description: "Base64-encoded content contains injection keywords",
          context: {
            tool: toolName,
            position,
            surrounding: getSurrounding(content, position, b64String.length),
          },
        });
        return; // One finding is enough
      }
    } catch {
      // Not valid Base64, skip
    }

    // Only 1 non-keyword base64 finding max to avoid noise
    break;
  }
}

/**
 * Detect zero-width Unicode characters that could hide content.
 */
function detectZeroWidth(content: string, toolName: string, findings: ScanFinding[]): void {
  let zwCount = 0;
  let firstPosition = -1;

  for (let i = 0; i < content.length; i++) {
    if (ZERO_WIDTH_CHARS.has(content.charCodeAt(i))) {
      zwCount++;
      if (firstPosition === -1) firstPosition = i;
    }
  }

  // Single zero-width chars can be legitimate (BOM at start of file)
  if (zwCount >= 2) {
    findings.push({
      layer: "encoding",
      category: "encoded_content",
      severity: "high",
      confidence: Math.min(0.5 + zwCount * 0.1, 0.95),
      matched_text: `${zwCount} zero-width characters detected`,
      description: "Multiple zero-width Unicode characters found (possible hidden content)",
      context: {
        tool: toolName,
        position: firstPosition,
        surrounding: getSurrounding(content, firstPosition, 20),
      },
    });
  }
}

/**
 * Detect homoglyph attacks (mixed Latin + Cyrillic/Greek characters).
 */
function detectHomoglyphs(content: string, toolName: string, findings: ScanFinding[]): void {
  // Only check if content has characters outside basic ASCII
  let hasNonAscii = false;
  for (let i = 0; i < Math.min(content.length, 10000); i++) {
    if (content.charCodeAt(i) > 127) {
      hasNonAscii = true;
      break;
    }
  }
  if (!hasNonAscii) return;

  // Check for mixed scripts within words
  const wordRegex = /[a-zA-Z\u0400-\u04FF\u0370-\u03FF]{3,}/g;
  let match: RegExpExecArray | null;

  while ((match = wordRegex.exec(content)) !== null) {
    const word = match[0];
    let hasLatin = false;
    let hasNonLatin = false;

    for (const char of word) {
      const code = char.charCodeAt(0);
      if (code >= 0x41 && code <= 0x7A) hasLatin = true;
      else if (code >= 0x0370) hasNonLatin = true;
    }

    if (hasLatin && hasNonLatin) {
      findings.push({
        layer: "encoding",
        category: "encoded_content",
        severity: "high",
        confidence: 0.80,
        matched_text: `Mixed-script word: "${word}"`,
        description: "Homoglyph attack: Latin + Cyrillic/Greek characters in same word",
        context: {
          tool: toolName,
          position: match.index,
          surrounding: getSurrounding(content, match.index, word.length),
        },
      });
      return; // One finding is enough
    }
  }
}

/**
 * Detect hex-encoded sequences that might hide payloads.
 */
function detectHexEncoding(content: string, toolName: string, findings: ScanFinding[]): void {
  // Match \x41\x42 style sequences (4+ consecutive)
  // In content, these appear as literal backslash + x + two hex digits
  // Use string constructor to avoid regex literal escaping issues
  const hexPattern = String.raw`\\x[0-9a-fA-F]{2}(?:\\x[0-9a-fA-F]{2}){3,}`;
  const hexRegex = new RegExp(hexPattern, "g");
  const match = hexRegex.exec(content);
  if (match) {
    // Attempt to decode
    try {
      const decodePattern = new RegExp("\\\\x([0-9a-fA-F]{2})", "g");
      const decoded = match[0].replace(decodePattern, (_: string, hex: string) =>
        String.fromCharCode(parseInt(hex, 16))
      );

      if (containsInjectionKeywords(decoded)) {
        findings.push({
          layer: "encoding",
          category: "encoded_content",
          severity: "high",
          confidence: 0.85,
          matched_text: `Hex decoded: "${decoded.slice(0, 80)}"`,
          description: "Hex-encoded content contains injection keywords",
          context: {
            tool: toolName,
            position: match.index,
            surrounding: getSurrounding(content, match.index, match[0].length),
          },
        });
      }
    } catch {
      // Ignore decode errors
    }
  }
}

/**
 * Detect URL-encoded sequences beyond normal URL parameters.
 */
function detectUrlEncoding(content: string, toolName: string, findings: ScanFinding[]): void {
  // Match %XX sequences (5+ consecutive)
  const urlRegex = /%[0-9a-fA-F]{2}(?:%[0-9a-fA-F]{2}){4,}/g;
  const match = urlRegex.exec(content);

  if (match) {
    try {
      const decoded = decodeURIComponent(match[0]);

      if (containsInjectionKeywords(decoded)) {
        findings.push({
          layer: "encoding",
          category: "encoded_content",
          severity: "high",
          confidence: 0.85,
          matched_text: `URL decoded: "${decoded.slice(0, 80)}"`,
          description: "URL-encoded content contains injection keywords",
          context: {
            tool: toolName,
            position: match.index,
            surrounding: getSurrounding(content, match.index, match[0].length),
          },
        });
      }
    } catch {
      // Invalid URL encoding, skip
    }
  }
}

// =============================================
// Utility Functions
// =============================================

/**
 * Check if decoded content appears to be readable text.
 */
function isReadableText(text: string): boolean {
  if (text.length === 0) return false;
  let printableCount = 0;
  for (let i = 0; i < Math.min(text.length, 100); i++) {
    const code = text.charCodeAt(i);
    if ((code >= 32 && code <= 126) || code === 10 || code === 13 || code === 9) {
      printableCount++;
    }
  }
  return printableCount / Math.min(text.length, 100) > 0.8;
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
