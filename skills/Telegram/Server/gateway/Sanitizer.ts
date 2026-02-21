/**
 * Sanitizer.ts - Input/output sanitization for the Telegram gateway
 *
 * Input sanitization: strips dangerous characters, truncates, normalizes
 * Output sanitization: scrubs API keys, tokens, credentials from responses
 *
 * Applied at both entry (handlers) and exit (TelegramBot.ts reply) points.
 */

// Max input length (characters)
const MAX_INPUT_LENGTH = 10_000;

/**
 * Sanitize user input before processing.
 * - Strips null bytes and control characters (except newline, tab)
 * - Truncates to MAX_INPUT_LENGTH
 * - Trims whitespace
 */
export function sanitizeInput(input: string): string {
  if (!input) return "";

  let sanitized = input;

  // Strip null bytes
  sanitized = sanitized.replace(/\0/g, "");

  // Strip control characters except \n (0x0A) and \t (0x09)
  // eslint-disable-next-line no-control-regex
  sanitized = sanitized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");

  // Truncate
  if (sanitized.length > MAX_INPUT_LENGTH) {
    sanitized = sanitized.substring(0, MAX_INPUT_LENGTH);
  }

  return sanitized.trim();
}

/**
 * Scrub API keys, tokens, and credentials from output text.
 * Prevents accidental credential exposure in Telegram messages.
 *
 * Pattern source: Designer/Tools/OutputFormatter.ts scrubCredentials()
 */
export function sanitizeOutput(text: string): string {
  if (!text) return text;

  let scrubbed = text;

  // API keys (long alphanumeric strings with key-like prefixes)
  scrubbed = scrubbed.replace(
    /(?:api[_-]?key|apikey|api_secret|secret[_-]?key|access[_-]?token|auth[_-]?token|bearer)\s*[:=]\s*["']?[A-Za-z0-9_\-./]{20,}["']?/gi,
    "[CREDENTIAL_REDACTED]"
  );

  // Bearer tokens in headers
  scrubbed = scrubbed.replace(
    /Bearer\s+[A-Za-z0-9_\-./]{20,}/g,
    "Bearer [TOKEN_REDACTED]"
  );

  // AWS-style keys
  scrubbed = scrubbed.replace(
    /(?:AKIA|ASIA)[A-Z0-9]{16}/g,
    "[AWS_KEY_REDACTED]"
  );

  // Anthropic API keys (sk-ant-xxx)
  scrubbed = scrubbed.replace(
    /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
    "[ANTHROPIC_KEY_REDACTED]"
  );

  // Generic long secrets (sk-xxx, sk_xxx patterns)
  scrubbed = scrubbed.replace(
    /\bsk[-_][A-Za-z0-9_-]{20,}/g,
    "[SECRET_KEY_REDACTED]"
  );

  // Telegram bot tokens (numeric:alphanumeric pattern)
  scrubbed = scrubbed.replace(
    /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g,
    "[TELEGRAM_TOKEN_REDACTED]"
  );

  // Gemini API keys (AIza pattern)
  scrubbed = scrubbed.replace(
    /\bAIza[A-Za-z0-9_-]{30,}/g,
    "[GEMINI_KEY_REDACTED]"
  );

  // ElevenLabs API keys (hex patterns of 32+ chars)
  scrubbed = scrubbed.replace(
    /\b[a-f0-9]{32,}\b/g,
    (match) => {
      // Only redact if it looks like a hex key (all lowercase hex, 32+ chars)
      if (match.length >= 32 && /^[a-f0-9]+$/.test(match)) {
        return "[HEX_KEY_REDACTED]";
      }
      return match;
    }
  );

  return scrubbed;
}
