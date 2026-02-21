#!/usr/bin/env bun
/**
 * OutputFormatter.ts - JSON + Markdown output with budget calculation
 *
 * Formats design recommendations into structured JSON or human-readable
 * markdown. Includes budget breakdowns by category and impact tier.
 * Enhanced with MoodBoard, BudgetResult, credential scrubbing, and Metadata.
 *
 * Usage:
 *   import { formatAsJson, formatAsMarkdown, calculateBudget, scrubCredentials } from './OutputFormatter';
 *
 * @module OutputFormatter
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DesignAction {
  suggestion: string;
  impact: "low" | "medium" | "high";
  estimatedCost: number;
  priority: number;
  category: string;
}

export interface ProductResult {
  name: string;
  price: number;
  retailer: string;
  styleMatchScore: number;
  url?: string;
  dimensions?: { width?: number; depth?: number; height?: number };
  material?: string;
  color?: string;
}

export interface DesignAnalysis {
  strengths: string[];
  opportunities: string[];
  lightingAssessment: string;
  colorCoherence: string;
}

export interface MoodBoardOutput {
  palette: Array<{ name: string; hex: string; weight: number }>;
  style_keywords: string[];
  reference_images: Array<{ url: string; style: string; description: string }>;
  color_harmony: string;
}

export interface BudgetResultOutput {
  total_cost: number;
  budget_limit: number | null;
  budget_status: string;
  currency: string;
  per_category: Array<{
    category: string;
    top_pick_cost: number;
    exceeds_budget: boolean;
    explanation?: string;
  }>;
}

export interface DesignRecommendation {
  roomName: string;
  style: string;
  analysis: DesignAnalysis;
  actions: DesignAction[];
  products?: ProductResult[];
  moodBoard?: MoodBoardOutput;
  budgetResult?: BudgetResultOutput;
  metadata?: Record<string, unknown>;
}

export interface BudgetSummary {
  total: number;
  byCategory: Record<string, number>;
  byImpact: Record<string, number>;
  itemCount: number;
}

// ---------------------------------------------------------------------------
// Credential scrubbing
// ---------------------------------------------------------------------------

/**
 * Strip API keys, tokens, and credentials from output strings.
 * Catches common patterns: Bearer tokens, API keys, secret keys.
 */
export function scrubCredentials(text: string): string {
  if (!text) return text;

  let scrubbed = text;

  // API keys (long alphanumeric strings with key-like prefixes)
  scrubbed = scrubbed.replace(/(?:api[_-]?key|apikey|api_secret|secret[_-]?key|access[_-]?token|auth[_-]?token|bearer)\s*[:=]\s*["']?[A-Za-z0-9_\-./]{20,}["']?/gi, "[CREDENTIAL_REDACTED]");

  // Bearer tokens in headers
  scrubbed = scrubbed.replace(/Bearer\s+[A-Za-z0-9_\-./]{20,}/g, "Bearer [TOKEN_REDACTED]");

  // AWS-style keys
  scrubbed = scrubbed.replace(/(?:AKIA|ASIA)[A-Z0-9]{16}/g, "[AWS_KEY_REDACTED]");

  // Anthropic API keys (sk-ant-xxx) -- check before generic sk_ pattern
  scrubbed = scrubbed.replace(/\bsk-ant-[A-Za-z0-9_-]{20,}/g, "[ANTHROPIC_KEY_REDACTED]");

  // Generic long secrets (sk-xxx, sk_xxx patterns)
  scrubbed = scrubbed.replace(/\bsk[-_][A-Za-z0-9_-]{20,}/g, "[SECRET_KEY_REDACTED]");

  return scrubbed;
}

// ---------------------------------------------------------------------------
// Budget calculation
// ---------------------------------------------------------------------------

export function calculateBudget(actions: DesignAction[]): BudgetSummary {
  const byCategory: Record<string, number> = {};
  const byImpact: Record<string, number> = {};
  let total = 0;

  for (const action of actions) {
    total += action.estimatedCost;

    byCategory[action.category] = (byCategory[action.category] || 0) + action.estimatedCost;
    byImpact[action.impact] = (byImpact[action.impact] || 0) + action.estimatedCost;
  }

  return {
    total,
    byCategory,
    byImpact,
    itemCount: actions.length,
  };
}

// ---------------------------------------------------------------------------
// JSON formatter
// ---------------------------------------------------------------------------

export function formatAsJson(rec: DesignRecommendation): string {
  const budget = calculateBudget(rec.actions);

  const output: Record<string, unknown> = {
    roomName: rec.roomName,
    style: rec.style,
    analysis: rec.analysis,
    actions: rec.actions.sort((a, b) => a.priority - b.priority),
    products: rec.products || [],
    budget: {
      total: budget.total,
      byCategory: budget.byCategory,
      byImpact: budget.byImpact,
      itemCount: budget.itemCount,
    },
  };

  if (rec.moodBoard) {
    output.moodBoard = rec.moodBoard;
  }

  if (rec.budgetResult) {
    output.budgetResult = rec.budgetResult;
  }

  if (rec.metadata) {
    output.metadata = rec.metadata;
  }

  const json = JSON.stringify(output, null, 2);
  return scrubCredentials(json);
}

// ---------------------------------------------------------------------------
// Markdown formatter
// ---------------------------------------------------------------------------

export function formatAsMarkdown(rec: DesignRecommendation): string {
  const budget = calculateBudget(rec.actions);
  const lines: string[] = [];

  // Header
  lines.push(`## Room Analysis: ${rec.roomName}`);
  lines.push("");

  // Assessment
  lines.push("### Current Assessment");
  lines.push(`- **Style direction:** ${rec.style}`);
  lines.push(`- **Strengths:** ${rec.analysis.strengths.join(", ")}`);
  lines.push(`- **Opportunities:** ${rec.analysis.opportunities.join(", ")}`);
  lines.push(`- **Lighting:** ${rec.analysis.lightingAssessment}`);
  lines.push(`- **Color coherence:** ${rec.analysis.colorCoherence}`);
  lines.push("");

  // Priority Actions
  lines.push("### Priority Actions");
  const sorted = [...rec.actions].sort((a, b) => a.priority - b.priority);
  sorted.forEach((a) => {
    lines.push(`${a.priority}. ${a.suggestion} -- Est. $${a.estimatedCost} (${a.impact} impact)`);
  });
  lines.push("");

  // Products (## Recommended Products)
  if (rec.products && rec.products.length > 0) {
    lines.push("## Recommended Products");
    lines.push("");
    lines.push("| Item | Price | Retailer | Match |");
    lines.push("|------|-------|----------|-------|");
    rec.products.forEach((p) => {
      const match = `${(p.styleMatchScore * 100).toFixed(0)}%`;
      lines.push(`| ${p.name} | $${p.price} | ${p.retailer} | ${match} |`);
    });
    lines.push("");
  }

  // Budget Summary (## Budget Summary)
  lines.push("## Budget Summary");
  lines.push(`**Total estimated cost:** $${budget.total}`);
  lines.push("");

  if (Object.keys(budget.byCategory).length > 0) {
    lines.push("| Category | Cost |");
    lines.push("|----------|------|");
    for (const [cat, cost] of Object.entries(budget.byCategory)) {
      lines.push(`| ${cat} | $${cost} |`);
    }
    lines.push("");
  }

  if (rec.budgetResult) {
    lines.push(`**Budget status:** ${rec.budgetResult.budget_status}`);
    if (rec.budgetResult.budget_limit !== null) {
      lines.push(`**Budget limit:** $${rec.budgetResult.budget_limit}`);
    }
    lines.push("");
  }

  // Mood Board (## Mood Board)
  if (rec.moodBoard) {
    lines.push("## Mood Board");
    lines.push("");
    lines.push(`**Color harmony:** ${rec.moodBoard.color_harmony}`);
    lines.push(`**Style keywords:** ${rec.moodBoard.style_keywords.join(", ")}`);
    lines.push("");

    if (rec.moodBoard.palette.length > 0) {
      lines.push("**Palette:**");
      rec.moodBoard.palette.forEach((c) => {
        lines.push(`- ${c.hex} ${c.name} (${(c.weight * 100).toFixed(0)}%)`);
      });
      lines.push("");
    }

    if (rec.moodBoard.reference_images.length > 0) {
      lines.push("**Reference Images:**");
      rec.moodBoard.reference_images.forEach((r) => {
        lines.push(`- [${r.style}] ${r.description}`);
      });
      lines.push("");
    }
  }

  // Metadata (## Metadata)
  if (rec.metadata) {
    lines.push("## Metadata");
    lines.push("");
    for (const [key, value] of Object.entries(rec.metadata)) {
      lines.push(`- **${key}:** ${String(value)}`);
    }
    lines.push("");
  }

  const output = lines.join("\n");
  return scrubCredentials(output);
}
