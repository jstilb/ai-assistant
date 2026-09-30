#!/usr/bin/env bun
/**
 * run-all.ts — Architecture lint entry point.
 *
 * Runs all architecture lint rules and exits non-zero if any errors are found.
 * Warnings are printed but do not cause a non-zero exit.
 *
 * Usage:
 *   bun lib/lint/run-all.ts
 *   bun lint:architecture
 *
 * Rules:
 *   1. no-raw-append    — ban appendFileSync outside AppendLog.ts
 *   2. no-inline-kaya-home — ban inline Kaya home path construction
 *   3. no-raw-stdin     — ban manual stdin reading outside hook-utils.ts (warning)
 *   4. no-unguarded-hook-main — require import.meta.main guard on hooks/*.hook.ts
 *   5. lifeos-label-table-drift — SKILL.md's classification-rules table must
 *      cover every Router.ts Label union member (audit finding F5)
 */

import { checkNoRawAppend } from './no-raw-append.ts';
import { checkNoInlineKayaHome } from './no-inline-kaya-home.ts';
import { checkNoRawStdin } from './no-raw-stdin.ts';
import { checkNoUnguardedHookMain } from './no-unguarded-hook-main.ts';
import { checkNoCrossSkillImport } from './no-cross-skill-import.ts';
import { checkLifeOSLabelTableDrift } from './lifeos-label-table-drift.ts';

const rootDir = process.cwd();

console.log('[lint:architecture] Running architecture checks...');
console.log(`[lint:architecture] Root: ${rootDir}`);
console.log('');

const results = await Promise.all([
  checkNoRawAppend(rootDir),
  checkNoInlineKayaHome(rootDir),
  checkNoRawStdin(rootDir),
  checkNoUnguardedHookMain(rootDir),
  checkNoCrossSkillImport(rootDir),
  checkLifeOSLabelTableDrift(rootDir),
]);

const [rawAppend, inlineKayaHome, rawStdin, unguardedHookMain, crossSkillImport, lifeosLabelTableDrift] = results;

const allErrors = [
  ...rawAppend.errors.map(e => `[no-raw-append] ${e}`),
  ...inlineKayaHome.errors.map(e => `[no-inline-kaya-home] ${e}`),
  ...rawStdin.errors.map(e => `[no-raw-stdin] ${e}`),
  ...unguardedHookMain.errors.map(e => `[no-unguarded-hook-main] ${e}`),
  ...crossSkillImport.errors.map(e => `[no-cross-skill-import] ${e}`),
  ...lifeosLabelTableDrift.errors.map(e => `[lifeos-label-table-drift] ${e}`),
];

const allWarnings = [
  ...rawAppend.warnings.map(w => `[no-raw-append] ${w}`),
  ...inlineKayaHome.warnings.map(w => `[no-inline-kaya-home] ${w}`),
  ...rawStdin.warnings.map(w => `[no-raw-stdin] ${w}`),
  ...unguardedHookMain.warnings.map(w => `[no-unguarded-hook-main] ${w}`),
  ...crossSkillImport.warnings.map(w => `[no-cross-skill-import] ${w}`),
  ...lifeosLabelTableDrift.warnings.map(w => `[lifeos-label-table-drift] ${w}`),
];

if (allWarnings.length > 0) {
  console.warn(`[lint:architecture] ${allWarnings.length} architecture warning(s):`);
  for (const w of allWarnings) {
    console.warn(`  WARN: ${w}`);
  }
  console.log('');
}

if (allErrors.length > 0) {
  console.error(`[lint:architecture] ${allErrors.length} architecture error(s):`);
  for (const e of allErrors) {
    console.error(`  ERROR: ${e}`);
  }
  console.log('');
  console.error('[lint:architecture] FAILED — fix the errors above before committing.');
  process.exit(1);
}

console.log('[lint:architecture] All checks passed ✓');
process.exit(0);
