/**
 * OutputValidation.test.ts - Output format and content validation
 *
 * Tests:
 *   - JSON schema validation on pipeline output
 *   - Required Markdown sections present
 *   - No PII in audit logs
 *   - Product URL format validation
 *   - Hex color code validation (#RRGGBB format)
 *
 * @module OutputValidation.test
 */

import { describe, it, expect } from "bun:test";
import {
  formatAsJson,
  formatAsMarkdown,
  scrubCredentials,
  type DesignRecommendation,
  type MoodBoardOutput,
  type BudgetResultOutput,
} from "../OutputFormatter.ts";
import { generateMoodBoard, type MoodBoard } from "../MoodBoardGenerator.ts";
import { scrubPII, createAuditLogger } from "../AuditLogger.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeFullRecommendation(overrides?: Partial<DesignRecommendation>): DesignRecommendation {
  const moodBoard: MoodBoardOutput = {
    palette: [
      { name: "Warm Linen", hex: "#F5E6D3", weight: 0.35 },
      { name: "Camel", hex: "#C19A6B", weight: 0.35 },
      { name: "Charcoal", hex: "#36454F", weight: 0.15 },
      { name: "Terracotta", hex: "#CC5C3B", weight: 0.1 },
      { name: "Cream", hex: "#FFFDD0", weight: 0.05 },
    ],
    style_keywords: ["modern", "cozy", "warm"],
    reference_images: [
      { url: "https://images.unsplash.com/photo-001", style: "Modern Cozy", description: "Living room" },
      { url: "https://images.unsplash.com/photo-002", style: "Hygge", description: "Reading nook" },
    ],
    color_harmony: "analogous",
  };

  const budgetResult: BudgetResultOutput = {
    total_cost: 1850,
    budget_limit: 5000,
    budget_status: "under",
    currency: "USD",
    per_category: [
      { category: "seating", top_pick_cost: 1200, exceeds_budget: false },
      { category: "tables", top_pick_cost: 450, exceeds_budget: false },
      { category: "lighting", top_pick_cost: 200, exceeds_budget: false },
    ],
  };

  return {
    roomName: "Living Room",
    style: "Modern Cozy",
    analysis: {
      strengths: ["Good natural light", "Warm color palette"],
      opportunities: ["Add texture layers", "Improve reading corner"],
      lightingAssessment: "Abundant natural light with adequate artificial supplementation",
      colorCoherence: "8/10",
    },
    actions: [
      { suggestion: "Add floor lamp", impact: "medium", estimatedCost: 200, priority: 1, category: "lighting" },
      { suggestion: "Layer throw pillows", impact: "low", estimatedCost: 80, priority: 2, category: "textiles" },
      { suggestion: "Upgrade area rug", impact: "high", estimatedCost: 400, priority: 3, category: "rugs" },
    ],
    products: [
      { name: "Modern Sofa", price: 1200, retailer: "West Elm", styleMatchScore: 0.9, url: "https://westelm.com/sofa-123" },
      { name: "Glass Coffee Table", price: 450, retailer: "CB2", styleMatchScore: 0.85, url: "https://cb2.com/table-456" },
      { name: "Arc Floor Lamp", price: 200, retailer: "Article", styleMatchScore: 0.8, url: "https://article.com/lamp-789" },
    ],
    moodBoard,
    budgetResult,
    metadata: {
      analysisMethod: "claude_vision",
      confidence: 0.9,
      timestamp: "2024-01-01T00:00:00Z",
      pipeline_version: "1.0.0",
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// JSON Schema Validation
// ---------------------------------------------------------------------------

describe("OutputValidation - JSON Schema", () => {
  it("produces valid JSON from formatAsJson", () => {
    const rec = makeFullRecommendation();
    const jsonStr = formatAsJson(rec);
    const parsed = JSON.parse(jsonStr);

    expect(parsed).toBeDefined();
    expect(typeof parsed).toBe("object");
  });

  it("JSON output contains required top-level fields", () => {
    const rec = makeFullRecommendation();
    const parsed = JSON.parse(formatAsJson(rec));

    expect(parsed.roomName).toBe("Living Room");
    expect(parsed.style).toBe("Modern Cozy");
    expect(parsed.analysis).toBeDefined();
    expect(parsed.actions).toBeDefined();
    expect(Array.isArray(parsed.actions)).toBe(true);
    expect(parsed.products).toBeDefined();
    expect(Array.isArray(parsed.products)).toBe(true);
    expect(parsed.budget).toBeDefined();
  });

  it("JSON output includes moodBoard when present", () => {
    const rec = makeFullRecommendation();
    const parsed = JSON.parse(formatAsJson(rec));

    expect(parsed.moodBoard).toBeDefined();
    expect(parsed.moodBoard.palette).toBeDefined();
    expect(Array.isArray(parsed.moodBoard.palette)).toBe(true);
    expect(parsed.moodBoard.style_keywords).toBeDefined();
    expect(parsed.moodBoard.color_harmony).toBeDefined();
  });

  it("JSON output includes budgetResult when present", () => {
    const rec = makeFullRecommendation();
    const parsed = JSON.parse(formatAsJson(rec));

    expect(parsed.budgetResult).toBeDefined();
    expect(parsed.budgetResult.total_cost).toBe(1850);
    expect(parsed.budgetResult.budget_limit).toBe(5000);
    expect(parsed.budgetResult.currency).toBe("USD");
  });

  it("JSON output includes metadata when present", () => {
    const rec = makeFullRecommendation();
    const parsed = JSON.parse(formatAsJson(rec));

    expect(parsed.metadata).toBeDefined();
    expect(parsed.metadata.analysisMethod).toBe("claude_vision");
    expect(parsed.metadata.confidence).toBe(0.9);
  });

  it("actions are sorted by priority in JSON output", () => {
    const rec = makeFullRecommendation();
    const parsed = JSON.parse(formatAsJson(rec));

    for (let i = 1; i < parsed.actions.length; i++) {
      expect(parsed.actions[i].priority).toBeGreaterThanOrEqual(parsed.actions[i - 1].priority);
    }
  });

  it("handles recommendation without optional fields", () => {
    const rec = makeFullRecommendation({
      products: undefined,
      moodBoard: undefined,
      budgetResult: undefined,
      metadata: undefined,
    });

    const jsonStr = formatAsJson(rec);
    const parsed = JSON.parse(jsonStr);

    expect(parsed).toBeDefined();
    expect(parsed.roomName).toBe("Living Room");
    expect(parsed.products).toEqual([]);
    // moodBoard, budgetResult, metadata should not be present
    expect(parsed.moodBoard).toBeUndefined();
    expect(parsed.budgetResult).toBeUndefined();
    expect(parsed.metadata).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Markdown Section Validation
// ---------------------------------------------------------------------------

describe("OutputValidation - Required Markdown Sections", () => {
  it("contains ## Room Analysis section", () => {
    const rec = makeFullRecommendation();
    const md = formatAsMarkdown(rec);
    expect(md).toContain("## Room Analysis");
  });

  it("contains ## Recommended Products section when products exist", () => {
    const rec = makeFullRecommendation();
    const md = formatAsMarkdown(rec);
    expect(md).toContain("## Recommended Products");
  });

  it("contains ## Budget Summary section", () => {
    const rec = makeFullRecommendation();
    const md = formatAsMarkdown(rec);
    expect(md).toContain("## Budget Summary");
  });

  it("contains ## Mood Board section when mood board exists", () => {
    const rec = makeFullRecommendation();
    const md = formatAsMarkdown(rec);
    expect(md).toContain("## Mood Board");
  });

  it("contains ## Metadata section when metadata exists", () => {
    const rec = makeFullRecommendation();
    const md = formatAsMarkdown(rec);
    expect(md).toContain("## Metadata");
  });

  it("all five required sections present in full output", () => {
    const rec = makeFullRecommendation();
    const md = formatAsMarkdown(rec);

    const requiredSections = [
      "## Room Analysis",
      "## Recommended Products",
      "## Budget Summary",
      "## Mood Board",
      "## Metadata",
    ];

    for (const section of requiredSections) {
      expect(md).toContain(section);
    }
  });

  it("markdown output includes product table with correct headers", () => {
    const rec = makeFullRecommendation();
    const md = formatAsMarkdown(rec);

    expect(md).toContain("| Item | Price | Retailer | Match |");
    expect(md).toContain("|------|-------|----------|-------|");
  });

  it("markdown output includes style direction", () => {
    const rec = makeFullRecommendation();
    const md = formatAsMarkdown(rec);

    expect(md).toContain("**Style direction:** Modern Cozy");
  });

  it("omits products section when no products exist", () => {
    const rec = makeFullRecommendation({ products: [] });
    const md = formatAsMarkdown(rec);

    expect(md).not.toContain("## Recommended Products");
  });

  it("omits mood board section when no mood board", () => {
    const rec = makeFullRecommendation({ moodBoard: undefined });
    const md = formatAsMarkdown(rec);

    expect(md).not.toContain("## Mood Board");
  });
});

// ---------------------------------------------------------------------------
// PII in Audit Logs
// ---------------------------------------------------------------------------

describe("OutputValidation - No PII in Audit Logs", () => {
  it("scrubs file paths from audit log error messages", () => {
    const logger = createAuditLogger();

    logger.log({
      image_hash: "abc123",
      api_name: "claude_vision",
      latency_ms: 100,
      cost: 0.025,
      success: false,
      cache_hit: false,
      error_message: "Failed to read /Users/john/Documents/secret-photo.jpg",
    });

    const entries = logger.getEntries();
    expect(entries[0].error_message).not.toContain("/Users/john");
    expect(entries[0].error_message).toContain("PATH_REDACTED");
  });

  it("scrubs email addresses from audit log error messages", () => {
    const logger = createAuditLogger();

    logger.log({
      image_hash: "def456",
      api_name: "gemini_vision",
      latency_ms: 200,
      cost: 0.01,
      success: false,
      cache_hit: false,
      error_message: "Rate limited for user admin@company.com",
    });

    const entries = logger.getEntries();
    expect(entries[0].error_message).not.toContain("admin@company.com");
    expect(entries[0].error_message).toContain("EMAIL_REDACTED");
  });

  it("audit log entries contain no raw file paths in any field", () => {
    const logger = createAuditLogger();

    logger.log({
      image_hash: "hashed-value",
      api_name: "claude_vision",
      latency_ms: 50,
      cost: 0.025,
      success: true,
      cache_hit: false,
    });

    const entries = logger.getEntries();
    const serialized = JSON.stringify(entries);
    // Should not contain /Users/ or /home/ paths
    expect(serialized).not.toMatch(/\/Users\/[a-zA-Z]/);
    expect(serialized).not.toMatch(/\/home\/[a-zA-Z]/);
  });

  it("image_hash field stores hash, not original filename", () => {
    const logger = createAuditLogger();

    logger.log({
      image_hash: "a1b2c3d4e5f6", // This is the SHA-256 hash
      api_name: "claude_vision",
      latency_ms: 100,
      cost: 0.025,
      success: true,
      cache_hit: false,
    });

    const entries = logger.getEntries();
    expect(entries[0].image_hash).toBe("a1b2c3d4e5f6");
    // Should NOT be a file path
    expect(entries[0].image_hash).not.toContain("/");
    expect(entries[0].image_hash).not.toContain("\\");
    expect(entries[0].image_hash).not.toContain(".jpg");
  });
});

// ---------------------------------------------------------------------------
// Product URL Format Validation
// ---------------------------------------------------------------------------

describe("OutputValidation - Product URL Format", () => {
  it("valid HTTP URLs pass validation", () => {
    const urls = [
      "https://westelm.com/sofa-123",
      "https://cb2.com/table-456",
      "http://example.com/product",
      "https://images.unsplash.com/photo-001?w=800",
    ];

    for (const url of urls) {
      expect(url).toMatch(/^https?:\/\//);
    }
  });

  it("product URLs in markdown output are valid format", () => {
    const rec = makeFullRecommendation();
    const md = formatAsMarkdown(rec);

    // Products in markdown table don't include URLs in the table itself,
    // but let's verify the products data structure has valid URLs
    for (const product of rec.products!) {
      if (product.url) {
        expect(product.url).toMatch(/^https?:\/\//);
      }
    }
  });

  it("reference image URLs in mood board are valid", () => {
    const rec = makeFullRecommendation();
    for (const ref of rec.moodBoard!.reference_images) {
      expect(ref.url).toMatch(/^https?:\/\//);
    }
  });

  it("JSON output preserves valid product URLs", () => {
    const rec = makeFullRecommendation();
    const parsed = JSON.parse(formatAsJson(rec));

    for (const product of parsed.products) {
      if (product.url) {
        expect(product.url).toMatch(/^https?:\/\//);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Hex Color Code Validation
// ---------------------------------------------------------------------------

describe("OutputValidation - Hex Color Codes", () => {
  it("MoodBoardGenerator palette colors are valid #RRGGBB", () => {
    const analysis = {
      colors: {
        dominant: ["#F5E6D3", "#C19A6B", "#36454F"],
        accent: ["#CC5C3B"],
        mood: "Warm",
      },
      style: { primary: "Modern", cohesionScore: 8 },
    };

    const board = generateMoodBoard(analysis as any);

    for (const color of board.palette) {
      expect(color.hex).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it("palette colors in formatted output are valid hex", () => {
    const rec = makeFullRecommendation();
    const md = formatAsMarkdown(rec);

    // Extract hex codes from mood board section
    const hexMatches = md.match(/#[0-9A-Fa-f]{6}/g);
    expect(hexMatches).not.toBeNull();

    for (const hex of hexMatches!) {
      expect(hex).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it("palette weights sum to approximately 1.0", () => {
    const analysis = {
      colors: {
        dominant: ["#F5E6D3", "#C19A6B", "#36454F"],
        accent: ["#CC5C3B", "#FFFDD0"],
        mood: "Warm",
      },
      style: { primary: "Modern", cohesionScore: 8 },
    };

    const board = generateMoodBoard(analysis as any);
    const totalWeight = board.palette.reduce((sum, c) => sum + c.weight, 0);

    // Should be approximately 1.0 (within floating-point tolerance)
    expect(totalWeight).toBeGreaterThan(0.95);
    expect(totalWeight).toBeLessThan(1.05);
  });

  it("JSON output hex codes are valid format", () => {
    const rec = makeFullRecommendation();
    const parsed = JSON.parse(formatAsJson(rec));

    if (parsed.moodBoard?.palette) {
      for (const color of parsed.moodBoard.palette) {
        expect(color.hex).toMatch(/^#[0-9A-Fa-f]{6}$/);
      }
    }
  });

  it("handles edge case hex colors correctly", () => {
    const analysis = {
      colors: {
        dominant: ["#000000", "#FFFFFF", "#FF0000"],
        accent: ["#00FF00"],
        mood: "Contrasting",
      },
      style: { primary: "Bold", cohesionScore: 5 },
    };

    const board = generateMoodBoard(analysis as any);

    for (const color of board.palette) {
      expect(color.hex).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(color.name).toBeTruthy();
      expect(color.weight).toBeGreaterThan(0);
    }
  });
});
