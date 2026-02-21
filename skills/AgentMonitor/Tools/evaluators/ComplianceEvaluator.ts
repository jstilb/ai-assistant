#!/usr/bin/env bun
/**
 * ComplianceEvaluator - Kaya standards compliance checking
 *
 * Checks for raw fetch() usage, raw JSON.parse(readFileSync()),
 * missing SKILL.md sections, and output format violations.
 * Works on both trace data and file-level scanning when context is available.
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { AgentTrace } from '../TraceCollector.ts';
import type { EvaluationResult, Finding, Evaluator } from './ResourceEfficiencyEvaluator.ts';

// ============================================================================
// Types
// ============================================================================

export interface ComplianceConfig {
  noRawFetch: boolean;
  noRawJsonParse: boolean;
  skillMdSections: boolean;
  outputFormatCompliance: boolean;
  requiredSkillMdSections: string[];
}

// ============================================================================
// Default Config
// ============================================================================

const DEFAULT_CONFIG: ComplianceConfig = {
  noRawFetch: true,
  noRawJsonParse: true,
  skillMdSections: true,
  outputFormatCompliance: true,
  requiredSkillMdSections: [
    'Customization',
    'Voice Notification',
    'Workflow Routing',
    'Examples',
    'Integration',
  ],
};

const KAYA_HOME: string = join(homedir(), '.claude');

// ============================================================================
// File Scanning Helpers
// ============================================================================

function scanFileForPatterns(filePath: string): { rawFetch: boolean; rawJsonParse: boolean } {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    let rawFetch = false;
    let rawJsonParse = false;

    for (const line of lines) {
      const trimmed = line.trim();
      // Skip comments
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

      // Check for raw fetch() usage (not from CachedHTTPClient)
      if (/\bfetch\s*\(/.test(trimmed) && !trimmed.includes('CachedHTTPClient') && !trimmed.includes('httpClient')) {
        rawFetch = true;
      }

      // Check for raw JSON.parse(readFileSync()) pattern
      if (/JSON\.parse\s*\(\s*readFileSync/.test(trimmed) && !trimmed.includes('StateManager')) {
        rawJsonParse = true;
      }
    }

    return { rawFetch, rawJsonParse };
  } catch {
    return { rawFetch: false, rawJsonParse: false };
  }
}

function checkSkillMdSections(skillMdPath: string, requiredSections: string[]): string[] {
  try {
    const content = readFileSync(skillMdPath, 'utf-8');
    const missingSections: string[] = [];

    for (const section of requiredSections) {
      // Check for section as heading or bold section name
      const patterns = [
        new RegExp(`^#+\\s+.*${section}`, 'mi'),
        new RegExp(`\\*\\*${section}\\*\\*`, 'i'),
        new RegExp(`^## ${section}`, 'mi'),
      ];
      const found = patterns.some(p => p.test(content));
      if (!found) {
        missingSections.push(section);
      }
    }

    return missingSections;
  } catch {
    return requiredSections;
  }
}

function checkOutputFormat(traces: AgentTrace[]): { hasVoiceLine: boolean; hasSummary: boolean; hasStory: boolean } {
  // Check if trace context contains output format indicators
  let hasVoiceLine = false;
  let hasSummary = false;
  let hasStory = false;

  for (const t of traces) {
    const ctx = JSON.stringify(t.context);
    if (ctx.includes('COMPLETED') || ctx.includes('voice')) hasVoiceLine = true;
    if (ctx.includes('SUMMARY')) hasSummary = true;
    if (ctx.includes('STORY')) hasStory = true;
  }

  return { hasVoiceLine, hasSummary, hasStory };
}

// ============================================================================
// Evaluator
// ============================================================================

export function createComplianceEvaluator(config?: Partial<ComplianceConfig>): Evaluator {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  return {
    name: 'Compliance',

    async evaluate(traces: AgentTrace[]): Promise<EvaluationResult> {
      const findings: Finding[] = [];
      const recommendations: string[] = [];
      let deductions = 0;

      // 1. Check for raw fetch() / JSON.parse violations in files referenced by traces
      if (cfg.noRawFetch || cfg.noRawJsonParse) {
        const scannedFiles = new Set<string>();

        for (const t of traces) {
          // Check if context mentions files that were edited/created
          if (t.context.filePath && typeof t.context.filePath === 'string') {
            scannedFiles.add(t.context.filePath);
          }
          if (t.context.files && Array.isArray(t.context.files)) {
            for (const f of t.context.files) {
              if (typeof f === 'string') scannedFiles.add(f);
            }
          }
        }

        // Also check the skill directory if referenced in traces
        const skillDirs = new Set<string>();
        for (const t of traces) {
          if (t.context.skillDir && typeof t.context.skillDir === 'string') {
            skillDirs.add(t.context.skillDir);
          }
        }

        for (const dir of skillDirs) {
          const fullDir = dir.startsWith('/') ? dir : join(KAYA_HOME, dir);
          if (existsSync(fullDir)) {
            try {
              const files = readdirSync(fullDir, { recursive: true }) as string[];
              for (const f of files) {
                if (typeof f === 'string' && f.endsWith('.ts')) {
                  scannedFiles.add(join(fullDir, f));
                }
              }
            } catch {
              // Skip inaccessible directories
            }
          }
        }

        let rawFetchCount = 0;
        let rawJsonParseCount = 0;

        for (const file of scannedFiles) {
          if (existsSync(file)) {
            const result = scanFileForPatterns(file);
            if (result.rawFetch && cfg.noRawFetch) {
              rawFetchCount++;
              findings.push({
                severity: 'warning',
                category: 'raw_fetch',
                message: `Raw fetch() usage detected in ${file}. Use CachedHTTPClient instead.`,
                evidence: { file },
              });
            }
            if (result.rawJsonParse && cfg.noRawJsonParse) {
              rawJsonParseCount++;
              findings.push({
                severity: 'warning',
                category: 'raw_json_parse',
                message: `Raw JSON.parse(readFileSync()) detected in ${file}. Consider StateManager for state files.`,
                evidence: { file },
              });
            }
          }
        }

        if (rawFetchCount > 0) {
          deductions += rawFetchCount * 5;
          recommendations.push('Replace raw fetch() calls with CachedHTTPClient from skills/CORE/Tools/');
        }
        if (rawJsonParseCount > 0) {
          deductions += rawJsonParseCount * 3;
          recommendations.push('Consider using StateManager for state file persistence');
        }
      }

      // 2. Check SKILL.md sections for skills referenced in traces
      if (cfg.skillMdSections) {
        const skillNames = new Set<string>();
        for (const t of traces) {
          if (t.context.skillName && typeof t.context.skillName === 'string') {
            skillNames.add(t.context.skillName);
          }
        }

        for (const skillName of skillNames) {
          const skillMdPath = join(KAYA_HOME, 'skills', skillName, 'SKILL.md');
          if (existsSync(skillMdPath)) {
            const missing = checkSkillMdSections(skillMdPath, cfg.requiredSkillMdSections);
            if (missing.length > 0) {
              findings.push({
                severity: 'warning',
                category: 'skill_md_sections',
                message: `SKILL.md for "${skillName}" missing sections: ${missing.join(', ')}`,
                evidence: { skillName, missingSections: missing },
              });
              deductions += missing.length * 3;
              recommendations.push(`Add missing sections to ${skillName}/SKILL.md: ${missing.join(', ')}`);
            }
          }
        }
      }

      // 3. Output format compliance (from trace context)
      if (cfg.outputFormatCompliance) {
        const completionTraces = traces.filter(t => t.eventType === 'completion');
        if (completionTraces.length > 0) {
          const formatCheck = checkOutputFormat(traces);
          if (!formatCheck.hasVoiceLine) {
            findings.push({
              severity: 'info',
              category: 'output_format',
              message: 'No voice line (COMPLETED) detected in workflow output',
              evidence: formatCheck,
            });
            deductions += 5;
          }
        }
      }

      // 4. Compliance summary
      const totalChecks = (cfg.noRawFetch ? 1 : 0) + (cfg.noRawJsonParse ? 1 : 0) +
        (cfg.skillMdSections ? 1 : 0) + (cfg.outputFormatCompliance ? 1 : 0);
      const warningCount = findings.filter(f => f.severity === 'warning').length;

      findings.push({
        severity: 'info',
        category: 'compliance_summary',
        message: `Compliance check: ${totalChecks} categories checked, ${warningCount} warnings found`,
        evidence: { totalChecks, warningCount, deductions },
      });

      const score = Math.max(0, Math.min(100, 100 - deductions));

      return {
        score,
        passed: score >= 50,
        findings,
        recommendations: [...new Set(recommendations)],
      };
    },
  };
}
