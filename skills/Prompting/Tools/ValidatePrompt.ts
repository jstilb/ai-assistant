#!/usr/bin/env bun

/**
 * ValidatePrompt.ts - Prompt Quality Linter
 *
 * Validates prompts against Claude 4.x best practices from Standards.md
 * Detects anti-patterns and provides actionable suggestions
 *
 * Usage:
 *   bun run ValidatePrompt.ts --file path/to/prompt.md
 *   bun run ValidatePrompt.ts --text "Your prompt text here"
 *   cat prompt.md | bun run ValidatePrompt.ts
 *   bun run ValidatePrompt.ts --file path/to/prompt.md --fix
 *   bun run ValidatePrompt.ts --file path/to/prompt.md --strict
 *   bun run ValidatePrompt.ts --file path/to/prompt.md --json
 */

import { parseArgs } from "util";
import * as fs from "fs";

// Anti-pattern detection rules based on Standards.md
interface Rule {
  id: string;
  name: string;
  severity: "ERROR" | "WARNING" | "INFO";
  pattern: RegExp | ((text: string) => boolean);
  message: (match: string) => string;
  fix: (match: string) => string;
  global?: boolean;
}

const rules: Rule[] = [
  // 🔴 ERROR - Critical anti-patterns
  {
    id: "xml-tags",
    name: "XML tags in prompt",
    severity: "ERROR",
    pattern: /<([a-z_]+)>.*?<\/\1>/is,
    message: (match) => `XML tags detected: "${match.substring(0, 50)}..."`,
    fix: () => "Use markdown headers instead (## Header Name)",
  },
  {
    id: "aggressive-tool-language",
    name: "Aggressive tool language",
    severity: "ERROR",
    pattern: /\b(CRITICAL|MANDATORY|YOU MUST)\s*:?\s*(use|call|invoke)/i,
    message: (match) => `Aggressive language detected: "${match}"`,
    fix: (match) => {
      const tool = match.match(/(?:use|call|invoke)\s+(\w+)/i)?.[1] || "this tool";
      return `Use ${tool} when...`;
    },
  },
  {
    id: "think-with-extended-thinking",
    name: "Using 'think' with extended thinking disabled",
    severity: "ERROR",
    pattern: /\b(think about|think through|thinking|think)\b/i,
    message: (match) => `Avoid "${match}" when extended thinking is disabled`,
    fix: () => "Use 'consider', 'evaluate', 'reflect', or 'assess' instead",
  },

  // 🟡 WARNING - Suboptimal patterns
  {
    id: "negative-only-constraint",
    name: "Negative-only constraint",
    severity: "WARNING",
    pattern: /^(?:.*\b(?:NEVER|DON'T|DO NOT|AVOID)\b.*)[.!]$/m,
    message: (match) => `Negative-only constraint: "${match}"`,
    fix: () => "Add positive alternative: what TO do instead",
  },
  {
    id: "vague-language",
    name: "Vague instruction language",
    severity: "WARNING",
    pattern: /\b(might want to|could consider|should probably|you may want to)\b/i,
    message: (match) => `Vague language detected: "${match}"`,
    fix: () => "Be direct and specific (use imperative: 'Do X')",
  },
  {
    id: "example-overload",
    name: "Too many examples",
    severity: "WARNING",
    pattern: (text: string) => {
      const exampleCount = (text.match(/\*\*Example \d+:/g) || []).length;
      return exampleCount > 3;
    },
    message: () => "More than 3 examples detected",
    fix: () => "1-3 examples optimal (diminishing returns after 3)",
  },
  {
    id: "verbose-explanations",
    name: "Excessive verbosity",
    severity: "WARNING",
    pattern: (text: string) => {
      // Detect overly long explanatory passages (>200 chars without structure)
      const lines = text.split('\n');
      return lines.some(line =>
        !line.startsWith('#') &&
        !line.startsWith('-') &&
        !line.startsWith('*') &&
        line.length > 200
      );
    },
    message: () => "Overly verbose explanations detected",
    fix: () => "Prefer clear, direct language over lengthy explanations",
  },
  {
    id: "missing-output-format",
    name: "Missing output format specification",
    severity: "WARNING",
    pattern: (text: string) => {
      return !text.match(/##\s*Output\s*Format/i);
    },
    message: () => "No '## Output Format' section found",
    fix: () => "Add explicit output format specification",
  },

  // 🔵 INFO - Suggestions for improvement
  {
    id: "bold-italic-overuse",
    name: "Excessive bold/italic formatting",
    severity: "INFO",
    pattern: /(\*\*[^*]+\*\*|\*[^*]+\*){5,}/,
    message: () => "Heavy use of bold/italic formatting",
    fix: () => "Use formatting sparingly for emphasis",
  },
];

interface ValidationResult {
  line?: number;
  severity: "ERROR" | "WARNING" | "INFO";
  ruleId: string;
  ruleName: string;
  message: string;
  fix: string;
  match?: string;
}

interface Summary {
  errors: number;
  warnings: number;
  info: number;
}

function validateText(text: string): ValidationResult[] {
  const results: ValidationResult[] = [];
  const lines = text.split('\n');

  for (const rule of rules) {
    if (typeof rule.pattern === 'function') {
      // Function-based pattern (checks entire text)
      if (rule.pattern(text)) {
        results.push({
          severity: rule.severity,
          ruleId: rule.id,
          ruleName: rule.name,
          message: rule.message(''),
          fix: rule.fix(''),
        });
      }
    } else {
      // RegExp-based pattern
      if (rule.global) {
        // Check all matches
        let match;
        const globalPattern = new RegExp(rule.pattern.source, rule.pattern.flags + 'g');
        while ((match = globalPattern.exec(text)) !== null) {
          const lineNum = text.substring(0, match.index).split('\n').length;
          results.push({
            line: lineNum,
            severity: rule.severity,
            ruleId: rule.id,
            ruleName: rule.name,
            message: rule.message(match[0]),
            fix: rule.fix(match[0]),
            match: match[0],
          });
        }
      } else {
        // Check each line
        lines.forEach((line, idx) => {
          const match = line.match(rule.pattern as RegExp);
          if (match) {
            results.push({
              line: idx + 1,
              severity: rule.severity,
              ruleId: rule.id,
              ruleName: rule.name,
              message: rule.message(match[0]),
              fix: rule.fix(match[0]),
              match: match[0],
            });
          }
        });
      }
    }
  }

  return results;
}

function summarize(results: ValidationResult[]): Summary {
  return {
    errors: results.filter(r => r.severity === 'ERROR').length,
    warnings: results.filter(r => r.severity === 'WARNING').length,
    info: results.filter(r => r.severity === 'INFO').length,
  };
}

function formatOutput(
  source: string,
  results: ValidationResult[],
  options: { json?: boolean; fix?: boolean }
): string {
  if (options.json) {
    return JSON.stringify({ source, results, summary: summarize(results) }, null, 2);
  }

  const summary = summarize(results);
  let output = `Validating: ${source}\n\n`;

  if (results.length === 0) {
    output += '✅ No issues found\n';
    return output;
  }

  // Group by severity
  const errors = results.filter(r => r.severity === 'ERROR');
  const warnings = results.filter(r => r.severity === 'WARNING');
  const info = results.filter(r => r.severity === 'INFO');

  if (errors.length > 0) {
    output += '🔴 ERRORS\n';
    errors.forEach(result => {
      output += formatResult(result, options.fix);
    });
    output += '\n';
  }

  if (warnings.length > 0) {
    output += '🟡 WARNINGS\n';
    warnings.forEach(result => {
      output += formatResult(result, options.fix);
    });
    output += '\n';
  }

  if (info.length > 0) {
    output += '🔵 INFO\n';
    info.forEach(result => {
      output += formatResult(result, options.fix);
    });
    output += '\n';
  }

  output += `Summary: ${summary.errors} error${summary.errors !== 1 ? 's' : ''}, `;
  output += `${summary.warnings} warning${summary.warnings !== 1 ? 's' : ''}, `;
  output += `${summary.info} info\n`;

  return output;
}

function formatResult(result: ValidationResult, showFix: boolean = false): string {
  let output = '';

  const icon = result.severity === 'ERROR' ? '🔴' : result.severity === 'WARNING' ? '🟡' : '🔵';
  const lineInfo = result.line ? `[line ${result.line}]` : '';

  output += `${icon} ${result.severity} ${lineInfo}: ${result.ruleName}\n`;
  if (result.match) {
    output += `   Found: "${result.match.substring(0, 60)}${result.match.length > 60 ? '...' : ''}"\n`;
  }
  output += `   ${result.message}\n`;

  if (showFix) {
    output += `   Fix: ${result.fix}\n`;
  }

  output += '\n';
  return output;
}

async function main() {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      file: { type: 'string', short: 'f' },
      text: { type: 'string', short: 't' },
      fix: { type: 'boolean', default: false },
      strict: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(`
ValidatePrompt.ts - Prompt Quality Linter

Usage:
  bun run ValidatePrompt.ts --file path/to/prompt.md
  bun run ValidatePrompt.ts --text "Your prompt text here"
  cat prompt.md | bun run ValidatePrompt.ts

Options:
  -f, --file <path>    Validate a file
  -t, --text <string>  Validate inline text
  --fix                Show fix suggestions inline
  --strict             Fail on any warning (exit code 2)
  --json               Output results as JSON
  -h, --help           Show this help message

Exit Codes:
  0: No errors
  1: Errors found
  2: Warnings found (with --strict)
`);
    process.exit(0);
  }

  let text: string;
  let source: string;

  // Determine input source
  if (values.file) {
    try {
      text = await Bun.file(values.file).text();
      source = values.file;
    } catch (error) {
      console.error(`Error reading file: ${values.file}`);
      process.exit(1);
    }
  } else if (values.text) {
    text = values.text;
    source = '<inline>';
  } else if (positionals.length > 0) {
    // Try to read from positional argument as file
    try {
      text = await Bun.file(positionals[0]).text();
      source = positionals[0];
    } catch (error) {
      console.error(`Error reading file: ${positionals[0]}`);
      process.exit(1);
    }
  } else {
    // Read from stdin
    const decoder = new TextDecoder();
    const stdin = await Bun.stdin.text();

    if (!stdin || stdin.trim().length === 0) {
      console.error('Error: No input provided. Use --file, --text, or pipe input.');
      console.error('Run with --help for usage information.');
      process.exit(1);
    }

    text = stdin;
    source = '<stdin>';
  }

  // Validate the text
  const results = validateText(text);
  const summary = summarize(results);

  // Output results
  const output = formatOutput(source, results, {
    json: values.json,
    fix: values.fix,
  });

  console.log(output);

  // Exit with appropriate code
  if (summary.errors > 0) {
    process.exit(1);
  } else if (values.strict && summary.warnings > 0) {
    process.exit(2);
  } else {
    process.exit(0);
  }
}

main();
