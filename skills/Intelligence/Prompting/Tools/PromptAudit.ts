#!/usr/bin/env bun
/**
 * PromptAudit.ts - Validate prompts against Standards.md best practices
 *
 * Audits all registered prompts in PromptRegistry.yaml against the
 * Prompting skill's Standards.md to ensure consistency and quality.
 *
 * Usage:
 *   bun PromptAudit.ts [options]
 *
 * Examples:
 *   bun PromptAudit.ts --registry PromptRegistry.yaml
 *   bun PromptAudit.ts --fast
 *   bun PromptAudit.ts --strict --json
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { parseArgs } from 'util';
import { parse as parseYaml } from 'yaml';
import { resolveOutputPath, ensureOutputDir } from '../../../../lib/core/OutputPathResolver';

// =============================================================================
// Types
// =============================================================================

interface PromptEntry {
  template: string;
  version: string;
  description: string;
  used_by: string[];
  model_hint: string | null;
  required_data?: string[];
  output_format: string;
}

interface PromptRegistry {
  version: string;
  prompts: Record<string, PromptEntry>;
}

interface AuditIssue {
  type: 'error' | 'warning' | 'info';
  rule: string;
  message: string;
  line?: number;
}

interface AuditResult {
  promptId: string;
  templatePath: string;
  version: string;
  issues: AuditIssue[];
  recommendations: string[];
  score: number; // 0-100 compliance
  passed: boolean;
}

interface AuditSummary {
  timestamp: string;
  registryVersion: string;
  totalPrompts: number;
  passedPrompts: number;
  failedPrompts: number;
  totalIssues: number;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  averageScore: number;
  results: AuditResult[];
}

// =============================================================================
// Constants
// =============================================================================

const PROMPTING_DIR = dirname(dirname(import.meta.path));
const TEMPLATES_DIR = join(PROMPTING_DIR, 'Templates');
const REGISTRY_PATH = join(TEMPLATES_DIR, 'PromptRegistry.yaml');
const STANDARDS_PATH = join(PROMPTING_DIR, 'Standards.md');

// =============================================================================
// Audit Rules
// =============================================================================

interface AuditRule {
  id: string;
  name: string;
  description: string;
  severity: 'error' | 'warning' | 'info';
  check: (content: string, meta: PromptEntry) => AuditIssue[];
}

const AUDIT_RULES: AuditRule[] = [
  // Rule 1: No XML tags
  {
    id: 'NO_XML_TAGS',
    name: 'No XML Tags',
    description: 'Prompts should use markdown headers, not XML tags',
    severity: 'error',
    check: (content) => {
      const issues: AuditIssue[] = [];
      const xmlPattern = /<\/?[a-z_]+>/gi;
      const lines = content.split('\n');

      lines.forEach((line, idx) => {
        const matches = line.match(xmlPattern);
        if (matches) {
          // Allow Handlebars syntax {{#...}} and HTML in examples
          const filtered = matches.filter(m =>
            !m.startsWith('{{') &&
            !line.includes('```') &&
            !line.includes('EXAMPLES:')
          );
          if (filtered.length > 0) {
            issues.push({
              type: 'error',
              rule: 'NO_XML_TAGS',
              message: `XML tag found: ${filtered.join(', ')}. Use markdown headers instead.`,
              line: idx + 1,
            });
          }
        }
      });

      return issues;
    },
  },

  // Rule 2: Has clear instructions
  {
    id: 'CLEAR_INSTRUCTIONS',
    name: 'Clear Instructions',
    description: 'Prompts should have explicit, clear instructions',
    severity: 'warning',
    check: (content) => {
      const issues: AuditIssue[] = [];
      const hasInstructions =
        content.includes('## Instructions') ||
        content.includes('## Rules') ||
        content.includes('RULES:') ||
        content.includes('INSTRUCTIONS:') ||
        content.match(/^\d+\./m); // Numbered list

      if (!hasInstructions && content.length > 200) {
        issues.push({
          type: 'warning',
          rule: 'CLEAR_INSTRUCTIONS',
          message: 'Prompt lacks explicit instructions section. Consider adding ## Instructions or numbered rules.',
        });
      }

      return issues;
    },
  },

  // Rule 3: Has output format
  {
    id: 'OUTPUT_FORMAT',
    name: 'Output Format Specified',
    description: 'Prompts should specify expected output format',
    severity: 'warning',
    check: (content, meta) => {
      const issues: AuditIssue[] = [];
      const hasFormat =
        content.includes('## Output') ||
        content.includes('OUTPUT FORMAT') ||
        content.includes('Output:') ||
        content.includes('```json') ||
        content.includes('GOOD') ||
        content.includes('Example');

      if (!hasFormat && meta.model_hint !== null) {
        issues.push({
          type: 'warning',
          rule: 'OUTPUT_FORMAT',
          message: 'Prompt does not specify output format. Consider adding examples or format specification.',
        });
      }

      return issues;
    },
  },

  // Rule 4: Positive framing
  {
    id: 'POSITIVE_FRAMING',
    name: 'Positive Framing',
    description: 'Instructions should tell what to do, not just what not to do',
    severity: 'info',
    check: (content) => {
      const issues: AuditIssue[] = [];
      const negativePatterns = [
        /NEVER\s+use/gi,
        /DO\s+NOT/gi,
        /Don't\s+\w+/gi,
        /AVOID\s+\w+/gi,
      ];

      let negativeCount = 0;
      const lines = content.split('\n');

      lines.forEach((line, idx) => {
        for (const pattern of negativePatterns) {
          if (pattern.test(line)) {
            negativeCount++;
            if (negativeCount > 3) {
              issues.push({
                type: 'info',
                rule: 'POSITIVE_FRAMING',
                message: `Heavy negative framing detected on line ${idx + 1}. Consider reframing positively.`,
                line: idx + 1,
              });
            }
          }
        }
      });

      return issues;
    },
  },

  // Rule 5: Has context/motivation
  {
    id: 'HAS_CONTEXT',
    name: 'Has Context',
    description: 'Prompts should explain why behavior matters',
    severity: 'info',
    check: (content) => {
      const issues: AuditIssue[] = [];
      const contextIndicators = [
        /because\s+/i,
        /so\s+that\s+/i,
        /this\s+helps\s+/i,
        /this\s+ensures\s+/i,
        /why\s+/i,
        /CONTEXT:/i,
        /PURPOSE:/i,
      ];

      const hasContext = contextIndicators.some(p => p.test(content));

      if (!hasContext && content.length > 300) {
        issues.push({
          type: 'info',
          rule: 'HAS_CONTEXT',
          message: 'Consider adding context explaining why certain behavior matters.',
        });
      }

      return issues;
    },
  },

  // Rule 6: No "think" language when inappropriate
  {
    id: 'THINK_LANGUAGE',
    name: 'Think Language Check',
    description: 'Avoid "think" language which can trigger extended thinking issues',
    severity: 'info',
    check: (content) => {
      const issues: AuditIssue[] = [];
      const thinkPatterns = [
        /\bthink\s+about\b/gi,
        /\bthink\s+through\b/gi,
      ];

      const lines = content.split('\n');
      lines.forEach((line, idx) => {
        for (const pattern of thinkPatterns) {
          if (pattern.test(line)) {
            issues.push({
              type: 'info',
              rule: 'THINK_LANGUAGE',
              message: `"Think" language detected. Consider using "consider", "evaluate", or "assess" instead.`,
              line: idx + 1,
            });
          }
        }
      });

      return issues;
    },
  },

  // Rule 7: Handlebars template validity
  {
    id: 'HANDLEBARS_SYNTAX',
    name: 'Handlebars Syntax',
    description: 'Handlebars template syntax should be valid',
    severity: 'error',
    check: (content) => {
      const issues: AuditIssue[] = [];

      // Check for unclosed blocks
      const blockOpens = (content.match(/\{\{#\w+/g) || []).length;
      const blockCloses = (content.match(/\{\{\/\w+/g) || []).length;

      if (blockOpens !== blockCloses) {
        issues.push({
          type: 'error',
          rule: 'HANDLEBARS_SYNTAX',
          message: `Unclosed Handlebars block: ${blockOpens} opens, ${blockCloses} closes`,
        });
      }

      // Check for malformed expressions
      const malformed = content.match(/\{\{[^}]*$/gm);
      if (malformed) {
        issues.push({
          type: 'error',
          rule: 'HANDLEBARS_SYNTAX',
          message: 'Malformed Handlebars expression detected (unclosed {{)',
        });
      }

      return issues;
    },
  },

  // Rule 8: Has examples
  {
    id: 'HAS_EXAMPLES',
    name: 'Has Examples',
    description: 'Prompts benefit from concrete examples',
    severity: 'info',
    check: (content, meta) => {
      const issues: AuditIssue[] = [];
      const hasExamples =
        content.includes('EXAMPLE') ||
        content.includes('Example') ||
        content.includes('GOOD') ||
        content.includes('BAD') ||
        content.includes('✅') ||
        content.includes('❌');

      if (!hasExamples && meta.model_hint !== null && content.length > 200) {
        issues.push({
          type: 'info',
          rule: 'HAS_EXAMPLES',
          message: 'Consider adding examples to clarify expected behavior.',
        });
      }

      return issues;
    },
  },
];

// =============================================================================
// Audit Logic
// =============================================================================

function loadRegistry(): PromptRegistry {
  if (!existsSync(REGISTRY_PATH)) {
    throw new Error(`Registry not found: ${REGISTRY_PATH}`);
  }
  const content = readFileSync(REGISTRY_PATH, 'utf-8');
  return parseYaml(content) as PromptRegistry;
}

function loadTemplate(templatePath: string): string {
  const fullPath = join(TEMPLATES_DIR, templatePath);
  if (!existsSync(fullPath)) {
    throw new Error(`Template not found: ${fullPath}`);
  }
  return readFileSync(fullPath, 'utf-8');
}

function auditPrompt(
  promptId: string,
  entry: PromptEntry,
  rules: AuditRule[],
  fast: boolean
): AuditResult {
  const content = loadTemplate(entry.template);
  const issues: AuditIssue[] = [];
  const recommendations: string[] = [];

  // Run rules
  for (const rule of rules) {
    if (fast && rule.severity === 'info') continue;

    const ruleIssues = rule.check(content, entry);
    issues.push(...ruleIssues);

    if (ruleIssues.length > 0 && rule.severity !== 'info') {
      recommendations.push(`${rule.name}: ${rule.description}`);
    }
  }

  // Calculate score
  const errorCount = issues.filter(i => i.type === 'error').length;
  const warningCount = issues.filter(i => i.type === 'warning').length;
  const infoCount = issues.filter(i => i.type === 'info').length;

  // Score: start at 100, deduct for issues
  let score = 100;
  score -= errorCount * 20;   // -20 per error
  score -= warningCount * 10; // -10 per warning
  score -= infoCount * 2;     // -2 per info
  score = Math.max(0, score);

  return {
    promptId,
    templatePath: entry.template,
    version: entry.version,
    issues,
    recommendations: [...new Set(recommendations)], // dedupe
    score,
    passed: errorCount === 0,
  };
}

function runAudit(fast: boolean, strict: boolean): AuditSummary {
  const registry = loadRegistry();
  const results: AuditResult[] = [];

  for (const [promptId, entry] of Object.entries(registry.prompts)) {
    try {
      const result = auditPrompt(promptId, entry, AUDIT_RULES, fast);
      results.push(result);
    } catch (error) {
      results.push({
        promptId,
        templatePath: entry.template,
        version: entry.version,
        issues: [{
          type: 'error',
          rule: 'TEMPLATE_LOAD',
          message: `Failed to load template: ${(error as Error).message}`,
        }],
        recommendations: ['Ensure template file exists at specified path'],
        score: 0,
        passed: false,
      });
    }
  }

  // Calculate summary
  const totalIssues = results.reduce((sum, r) => sum + r.issues.length, 0);
  const errorCount = results.reduce((sum, r) =>
    sum + r.issues.filter(i => i.type === 'error').length, 0);
  const warningCount = results.reduce((sum, r) =>
    sum + r.issues.filter(i => i.type === 'warning').length, 0);
  const infoCount = results.reduce((sum, r) =>
    sum + r.issues.filter(i => i.type === 'info').length, 0);
  const passedPrompts = results.filter(r => r.passed).length;
  const averageScore = results.reduce((sum, r) => sum + r.score, 0) / results.length;

  // In strict mode, warnings also cause failure
  if (strict) {
    results.forEach(r => {
      if (r.issues.some(i => i.type === 'warning')) {
        r.passed = false;
      }
    });
  }

  return {
    timestamp: new Date().toISOString(),
    registryVersion: registry.version,
    totalPrompts: results.length,
    passedPrompts,
    failedPrompts: results.length - passedPrompts,
    totalIssues,
    errorCount,
    warningCount,
    infoCount,
    averageScore: Math.round(averageScore * 10) / 10,
    results,
  };
}

// =============================================================================
// Output Formatting
// =============================================================================

function formatTextReport(summary: AuditSummary, verbose: boolean): string {
  const lines: string[] = [];

  lines.push('='.repeat(60));
  lines.push('PROMPT AUDIT REPORT');
  lines.push('='.repeat(60));
  lines.push('');
  lines.push(`Timestamp: ${summary.timestamp}`);
  lines.push(`Registry Version: ${summary.registryVersion}`);
  lines.push('');
  lines.push('SUMMARY');
  lines.push('-'.repeat(40));
  lines.push(`Total Prompts: ${summary.totalPrompts}`);
  lines.push(`Passed: ${summary.passedPrompts}`);
  lines.push(`Failed: ${summary.failedPrompts}`);
  lines.push(`Average Score: ${summary.averageScore}/100`);
  lines.push('');
  lines.push(`Issues: ${summary.totalIssues} total`);
  lines.push(`  Errors: ${summary.errorCount}`);
  lines.push(`  Warnings: ${summary.warningCount}`);
  lines.push(`  Info: ${summary.infoCount}`);
  lines.push('');

  // Results by prompt
  lines.push('RESULTS BY PROMPT');
  lines.push('-'.repeat(40));

  for (const result of summary.results) {
    const status = result.passed ? '✓' : '✗';
    lines.push(`${status} ${result.promptId} (${result.score}/100)`);
    lines.push(`  Template: ${result.templatePath}`);

    if (verbose || !result.passed) {
      for (const issue of result.issues) {
        const icon = issue.type === 'error' ? '❌' : issue.type === 'warning' ? '⚠️' : 'ℹ️';
        const lineRef = issue.line ? ` [line ${issue.line}]` : '';
        lines.push(`  ${icon} ${issue.rule}${lineRef}: ${issue.message}`);
      }

      if (result.recommendations.length > 0) {
        lines.push('  Recommendations:');
        for (const rec of result.recommendations) {
          lines.push(`    → ${rec}`);
        }
      }
    }

    lines.push('');
  }

  return lines.join('\n');
}

// =============================================================================
// CLI
// =============================================================================

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      fast: { type: 'boolean', short: 'f', default: false },
      strict: { type: 'boolean', short: 's', default: false },
      json: { type: 'boolean', short: 'j', default: false },
      verbose: { type: 'boolean', short: 'v', default: false },
      output: { type: 'string', short: 'o' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`
PromptAudit - Validate prompts against Standards.md best practices

USAGE:
  bun PromptAudit.ts [options]

OPTIONS:
  -f, --fast      Quick scan, skip info-level checks
  -s, --strict    Fail on warnings (not just errors)
  -j, --json      Output as JSON
  -v, --verbose   Show all issues, even for passing prompts
  -o, --output    Save report to file
  -h, --help      Show this help

EXAMPLES:
  # Run full audit
  bun PromptAudit.ts

  # Quick check
  bun PromptAudit.ts --fast

  # Strict mode with JSON output
  bun PromptAudit.ts --strict --json

  # Save report to file
  bun PromptAudit.ts --verbose --output ./audit-report.md

AUDIT RULES:
  NO_XML_TAGS       - Prompts should use markdown, not XML tags
  CLEAR_INSTRUCTIONS - Prompts should have explicit instructions
  OUTPUT_FORMAT     - Prompts should specify output format
  POSITIVE_FRAMING  - Instructions should tell what to do
  HAS_CONTEXT       - Prompts should explain why behavior matters
  THINK_LANGUAGE    - Avoid "think" language that triggers issues
  HANDLEBARS_SYNTAX - Handlebars template should be valid
  HAS_EXAMPLES      - Prompts benefit from examples

SCORING:
  -20 points per error
  -10 points per warning
  -2 points per info
`);
    process.exit(0);
  }

  try {
    const summary = runAudit(values.fast || false, values.strict || false);

    if (values.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      const report = formatTextReport(summary, values.verbose || false);
      console.log(report);
    }

    // Save to file if requested
    if (values.output) {
      const outputPath = values.output.startsWith('/')
        ? values.output
        : join(process.cwd(), values.output);

      const content = values.json
        ? JSON.stringify(summary, null, 2)
        : formatTextReport(summary, true);

      await Bun.write(outputPath, content);
      console.log(`\nReport saved to: ${outputPath}`);
    }

    // Exit with error if any prompts failed
    if (summary.failedPrompts > 0) {
      process.exit(1);
    }
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
}

// Run CLI if executed directly
if (import.meta.main) {
  main();
}

// Export for programmatic use
export { runAudit, AUDIT_RULES };
export type { AuditResult, AuditSummary, AuditIssue };
