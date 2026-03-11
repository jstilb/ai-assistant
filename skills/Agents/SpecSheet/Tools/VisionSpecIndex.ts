#!/usr/bin/env bun
/**
 * VisionSpecIndex - Index spec files by domain and vision tier
 *
 * Scans ~/.claude/Plans/Specs/ for spec files matching a domain name,
 * categorizes them by vision tier (Solarpunk/Grounded/CurrentWork),
 * and returns ordered paths.
 *
 * Usage:
 *   bun VisionSpecIndex.ts --domain "pkm"
 *   bun VisionSpecIndex.ts --domain "canvas" --json
 */

import { readdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';

// ============================================================================
// Types
// ============================================================================

type VisionTier = 'Solarpunk' | 'Grounded' | 'CurrentWork' | 'Unclassified';

interface SpecEntry {
  path: string;
  filename: string;
  tier: VisionTier;
  modified: string;
}

interface VisionSpecResult {
  domain: string;
  specsDir: string;
  specs: SpecEntry[];
}

// ============================================================================
// Constants
// ============================================================================

const SPECS_DIR = join(homedir(), '.claude', 'Plans', 'Specs');

const TIER_ORDER: Record<VisionTier, number> = {
  Solarpunk: 0,
  Grounded: 1,
  CurrentWork: 2,
  Unclassified: 3,
};

// ============================================================================
// Tier Classification
// ============================================================================

function classifyTier(filename: string): VisionTier {
  const lower = filename.toLowerCase();

  if (/solarpunk|vision|ideal-end-state|utopi/.test(lower)) {
    return 'Solarpunk';
  }
  if (/grounded/.test(lower)) {
    return 'Grounded';
  }
  if (/current-work|current_work|phase\d|tier\d/.test(lower)) {
    return 'CurrentWork';
  }

  return 'Unclassified';
}

// ============================================================================
// Domain Matching
// ============================================================================

function toDomainSlug(domain: string): string {
  return domain.toLowerCase().replace(/[\s_]+/g, '-');
}

function matchesDomain(filename: string, domainSlug: string): boolean {
  const lower = filename.toLowerCase().replace(/[\s_]+/g, '-');
  return lower.includes(domainSlug);
}

// ============================================================================
// Core Logic
// ============================================================================

function indexSpecs(domain: string): VisionSpecResult {
  const domainSlug = toDomainSlug(domain);
  const result: VisionSpecResult = {
    domain,
    specsDir: SPECS_DIR,
    specs: [],
  };

  let files: string[];
  try {
    files = readdirSync(SPECS_DIR).filter(f => f.endsWith('.md'));
  } catch {
    return result;
  }

  for (const file of files) {
    if (!matchesDomain(file, domainSlug)) continue;

    const fullPath = join(SPECS_DIR, file);
    let modified: string;
    try {
      modified = statSync(fullPath).mtime.toISOString();
    } catch {
      modified = 'unknown';
    }

    result.specs.push({
      path: fullPath,
      filename: file,
      tier: classifyTier(file),
      modified,
    });
  }

  // Sort by tier hierarchy, then by filename within tier
  result.specs.sort((a, b) => {
    const tierDiff = TIER_ORDER[a.tier] - TIER_ORDER[b.tier];
    if (tierDiff !== 0) return tierDiff;
    return a.filename.localeCompare(b.filename);
  });

  return result;
}

// ============================================================================
// Report Printing
// ============================================================================

function printReport(result: VisionSpecResult): void {
  console.log(`# Vision Spec Index: ${result.domain}\n`);
  console.log(`**Specs Directory:** ${result.specsDir}`);
  console.log(`**Matching Specs:** ${result.specs.length}\n`);

  if (result.specs.length === 0) {
    console.log('No specs found matching this domain.');
    return;
  }

  console.log('| Tier | Filename | Modified |');
  console.log('|------|----------|----------|');
  for (const spec of result.specs) {
    console.log(`| ${spec.tier} | ${spec.filename} | ${spec.modified.split('T')[0]} |`);
  }
}

// ============================================================================
// CLI Entry Point
// ============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  const domainIdx = args.indexOf('--domain');
  if (domainIdx === -1 || !args[domainIdx + 1]) {
    console.log('Usage: bun VisionSpecIndex.ts --domain <name>');
    console.log('       bun VisionSpecIndex.ts --domain "pkm" --json');
    process.exit(1);
  }

  const domain = args[domainIdx + 1];
  const jsonOutput = args.includes('--json');

  const result = indexSpecs(domain);

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printReport(result);
  }
}
