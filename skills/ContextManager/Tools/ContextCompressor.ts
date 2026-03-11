#!/usr/bin/env bun
/**
 * ContextCompressor.ts - Pre-compute compressed context summaries
 *
 * Uses Haiku inference to summarize context files while preserving
 * key facts, dates, numbers, statuses, and file paths.
 *
 * CLI: bun ContextCompressor.ts --all
 * CLI: bun ContextCompressor.ts --file <path>
 * API: import { compressFile } from "./ContextCompressor"
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname, basename, extname } from 'path';
import { z } from 'zod';
import { inference } from '../../../lib/core/Inference';
import { createStateManager } from '../../../lib/core/StateManager';
import { estimateTokens } from './TokenEstimator';

const KAYA_DIR = process.env.KAYA_DIR || join(process.env.HOME!, '.claude');
const COMPRESSION_RULES_PATH = join(KAYA_DIR, 'skills/ContextManager/config/compression-rules.json');

interface CompressionRule {
  pattern: string;
  targetLines: number;
  preserveKeys: string[];
}

interface CompressionConfig {
  rules: CompressionRule[];
  minLinesForCompression: number;
  outputSuffix: string;
}

const CompressionRuleSchema = z.object({
  pattern: z.string(),
  targetLines: z.number(),
  preserveKeys: z.array(z.string()),
});

const CompressionConfigSchema = z.object({
  rules: z.array(CompressionRuleSchema),
  minLinesForCompression: z.number().default(30),
  outputSuffix: z.string().default('.compressed.md'),
});

const compressionState = createStateManager({
  path: COMPRESSION_RULES_PATH,
  schema: CompressionConfigSchema,
  defaults: { rules: [], minLinesForCompression: 30, outputSuffix: '.compressed.md' },
});

async function loadCompressionRules(): Promise<CompressionConfig> {
  return compressionState.load();
}

/**
 * Find matching compression rule for a file path
 */
function findRule(filePath: string, config: CompressionConfig): CompressionRule | null {
  const relativePath = filePath.replace(KAYA_DIR + '/', '');
  for (const rule of config.rules) {
    // Simple glob matching
    if (rule.pattern.includes('*')) {
      const prefix = rule.pattern.split('*')[0];
      const suffix = rule.pattern.split('*').pop() || '';
      if (relativePath.startsWith(prefix) && relativePath.endsWith(suffix)) {
        return rule;
      }
    } else if (relativePath === rule.pattern) {
      return rule;
    }
  }
  return null;
}

/**
 * Get output path for compressed version
 */
function getCompressedOutputPath(filePath: string): string {
  const ext = extname(filePath);
  const base = basename(filePath, ext);
  const dir = dirname(filePath);
  return join(dir, `${base}.compressed${ext}`);
}

/**
 * Compress a file using Haiku inference
 */
export async function compressFile(
  filePath: string,
  options?: { targetLines?: number; preserveKeys?: string[] }
): Promise<{ success: boolean; outputPath: string; originalTokens: number; compressedTokens: number; error?: string }> {
  if (!existsSync(filePath)) {
    return { success: false, outputPath: '', originalTokens: 0, compressedTokens: 0, error: 'File not found' };
  }

  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').length;
  const config = await loadCompressionRules();

  // Skip files under minimum line threshold
  if (lines < config.minLinesForCompression) {
    return {
      success: false,
      outputPath: '',
      originalTokens: estimateTokens(content),
      compressedTokens: estimateTokens(content),
      error: `File has ${lines} lines, below minimum of ${config.minLinesForCompression}`,
    };
  }

  // Find matching rule or use provided options
  const rule = findRule(filePath, config);
  const targetLines = options?.targetLines || rule?.targetLines || 50;
  const preserveKeys = options?.preserveKeys || rule?.preserveKeys || ['key facts', 'dates', 'numbers', 'statuses'];

  const systemPrompt = `You are a context compression expert. Compress the provided document to approximately ${targetLines} lines while preserving critical information.

MUST PRESERVE:
${preserveKeys.map(k => `- ${k}`).join('\n')}

COMPRESSION RULES:
1. Keep all file paths, URLs, and command examples
2. Keep all dates, version numbers, and metric values
3. Keep table structures but reduce rows if needed
4. Remove verbose explanations, lengthy examples, and repetitive content
5. Use bullet points instead of paragraphs
6. Keep section headers for navigation
7. Never remove actionable information (commands, workflows, triggers)

OUTPUT: The compressed document only. No meta-commentary.`;

  try {
    // Scale timeout with content size: base 30s + 10s per 2000 tokens
    const contentTokens = estimateTokens(content);
    const dynamicTimeout = Math.max(30000, 30000 + Math.ceil(contentTokens / 2000) * 10000);

    const result = await inference({
      systemPrompt,
      userPrompt: content,
      level: 'fast',
      timeout: dynamicTimeout,
    });

    if (!result.success) {
      return {
        success: false,
        outputPath: '',
        originalTokens: estimateTokens(content),
        compressedTokens: 0,
        error: result.error || 'Inference failed',
      };
    }

    const compressed = result.output.trim();
    const outputPath = getCompressedOutputPath(filePath);
    const dir = dirname(outputPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    // Add frontmatter with compression metadata
    const header = `---
compressed_from: ${filePath.replace(KAYA_DIR + '/', '')}
compressed_at: ${new Date().toISOString()}
original_lines: ${lines}
compressed_lines: ${compressed.split('\n').length}
---

`;
    writeFileSync(outputPath, header + compressed);

    return {
      success: true,
      outputPath,
      originalTokens: estimateTokens(content),
      compressedTokens: estimateTokens(header + compressed),
    };
  } catch (err) {
    return {
      success: false,
      outputPath: '',
      originalTokens: estimateTokens(content),
      compressedTokens: 0,
      error: String(err),
    };
  }
}

/**
 * Compress all files defined in compression-rules.json
 */
export async function compressAll(): Promise<Array<{ file: string; success: boolean; ratio?: string; error?: string }>> {
  const config = await loadCompressionRules();
  const results: Array<{ file: string; success: boolean; ratio?: string; error?: string }> = [];

  for (const rule of config.rules) {
    // Resolve pattern to actual files
    if (rule.pattern.includes('*')) {
      const dir = join(KAYA_DIR, dirname(rule.pattern));
      const suffix = rule.pattern.split('*').pop() || '';
      if (!existsSync(dir)) continue;

      const { readdirSync } = require('fs');
      const files = (readdirSync(dir) as string[])
        .filter((f: string) => f.endsWith(suffix) && !f.includes('.compressed.'));

      for (const f of files) {
        const fullPath = join(dir, f);
        console.error(`Compressing: ${fullPath}`);
        const result = await compressFile(fullPath, {
          targetLines: rule.targetLines,
          preserveKeys: rule.preserveKeys,
        });
        results.push({
          file: fullPath.replace(KAYA_DIR + '/', ''),
          success: result.success,
          ratio: result.success ? `${result.originalTokens} → ${result.compressedTokens} tokens` : undefined,
          error: result.error,
        });
      }
    } else {
      const fullPath = join(KAYA_DIR, rule.pattern);
      if (!existsSync(fullPath)) {
        results.push({ file: rule.pattern, success: false, error: 'File not found' });
        continue;
      }

      console.error(`Compressing: ${rule.pattern}`);
      const result = await compressFile(fullPath, {
        targetLines: rule.targetLines,
        preserveKeys: rule.preserveKeys,
      });
      results.push({
        file: rule.pattern,
        success: result.success,
        ratio: result.success ? `${result.originalTokens} → ${result.compressedTokens} tokens` : undefined,
        error: result.error,
      });
    }
  }

  return results;
}

// CLI
if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes('--all')) {
    console.error('Compressing all configured files...\n');
    const results = await compressAll();
    console.log(JSON.stringify(results, null, 2));

    const success = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    console.error(`\nDone: ${success} compressed, ${failed} skipped/failed`);
  } else if (args.includes('--file')) {
    const fileIndex = args.indexOf('--file') + 1;
    const filePath = args[fileIndex];
    if (!filePath) {
      console.error('Usage: bun ContextCompressor.ts --file <path>');
      process.exit(1);
    }

    const absolutePath = filePath.startsWith('/') ? filePath : join(KAYA_DIR, filePath);
    const result = await compressFile(absolutePath);
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('Usage:');
    console.log('  bun ContextCompressor.ts --all           Compress all configured files');
    console.log('  bun ContextCompressor.ts --file <path>   Compress a specific file');
  }
}
