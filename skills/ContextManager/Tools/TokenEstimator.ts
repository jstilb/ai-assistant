#!/usr/bin/env bun
/**
 * TokenEstimator.ts - Fast token count heuristic
 *
 * Uses chars/3.5 approximation (standard for English text with code).
 * No external dependencies.
 *
 * CLI: bun TokenEstimator.ts <file-or-text>
 * API: import { estimateTokens, estimateFileTokens } from "./TokenEstimator"
 */

import { existsSync, readFileSync, statSync } from 'fs';

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

export function estimateFileTokens(filePath: string): { tokens: number; chars: number; lines: number } | null {
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, 'utf-8');
  return {
    tokens: estimateTokens(content),
    chars: content.length,
    lines: content.split('\n').length,
  };
}

// CLI
if (import.meta.main) {
  const arg = process.argv[2];
  if (!arg) {
    console.log('Usage: bun TokenEstimator.ts <file-path-or-text>');
    process.exit(1);
  }

  if (existsSync(arg)) {
    const result = estimateFileTokens(arg);
    if (result) {
      console.log(JSON.stringify({ file: arg, ...result }, null, 2));
    }
  } else {
    // Treat as raw text
    console.log(JSON.stringify({ tokens: estimateTokens(arg), chars: arg.length }, null, 2));
  }
}
