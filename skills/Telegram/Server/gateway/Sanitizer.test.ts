import { describe, test, expect } from "bun:test";
import { sanitizeInput, sanitizeOutput } from "./Sanitizer";

describe("sanitizeInput", () => {
  test("strips null bytes", () => {
    const input = "hello\0world\0";
    // Null bytes are removed (not replaced with space)
    expect(sanitizeInput(input)).toBe("helloworld");
  });

  test("strips control characters except newline and tab", () => {
    const input = "hello\x01\x02\x03world\n\ttabs ok";
    expect(sanitizeInput(input)).toBe("helloworld\n\ttabs ok");
  });

  test("preserves newlines and tabs", () => {
    const input = "line1\nline2\ttab";
    expect(sanitizeInput(input)).toBe("line1\nline2\ttab");
  });

  test("truncates at 10000 characters", () => {
    const input = "a".repeat(15000);
    expect(sanitizeInput(input)).toHaveLength(10000);
  });

  test("returns empty string for empty input", () => {
    expect(sanitizeInput("")).toBe("");
  });

  test("returns empty string for null-like input", () => {
    expect(sanitizeInput(undefined as unknown as string)).toBe("");
  });

  test("trims whitespace", () => {
    expect(sanitizeInput("  hello  ")).toBe("hello");
  });
});

describe("sanitizeOutput", () => {
  test("redacts API key patterns", () => {
    const output = 'api_key: "sk_test_abcdefghijklmnopqrstuvwxyz1234"';
    const result = sanitizeOutput(output);
    expect(result).toContain("[CREDENTIAL_REDACTED]");
    expect(result).not.toContain("sk_test_abcdefghijklmnopqrstuvwxyz1234");
  });

  test("redacts Bearer tokens", () => {
    const output = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abcdefghijk";
    const result = sanitizeOutput(output);
    expect(result).toContain("Bearer [TOKEN_REDACTED]");
    expect(result).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abcdefghijk");
  });

  test("redacts Telegram bot tokens", () => {
    // Telegram tokens: 8-10 digit number, colon, exactly 35 alphanumeric/dash/underscore chars
    const output = "Bot token: 1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
    const result = sanitizeOutput(output);
    expect(result).toContain("[TELEGRAM_TOKEN_REDACTED]");
    expect(result).not.toContain("1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi");
  });

  test("redacts Anthropic API keys", () => {
    const output = "key: sk-ant-abcdefghijklmnopqrstuvwxyz123456";
    const result = sanitizeOutput(output);
    expect(result).toContain("[ANTHROPIC_KEY_REDACTED]");
  });

  test("redacts AWS-style keys", () => {
    const output = "AKIAIOSFODNN7EXAMPLE1";
    const result = sanitizeOutput(output);
    expect(result).toContain("[AWS_KEY_REDACTED]");
  });

  test("redacts Gemini API keys", () => {
    const output = "key: AIzaSyD1234567890abcdefghijklmnopqrstuv";
    const result = sanitizeOutput(output);
    expect(result).toContain("[GEMINI_KEY_REDACTED]");
  });

  test("passes through normal text unchanged", () => {
    const output = "Hello, this is a normal response with no secrets.";
    expect(sanitizeOutput(output)).toBe(output);
  });

  test("returns empty/falsy input unchanged", () => {
    expect(sanitizeOutput("")).toBe("");
  });
});
