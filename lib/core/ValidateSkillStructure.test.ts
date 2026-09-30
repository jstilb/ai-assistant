#!/usr/bin/env bun
/**
 * ValidateSkillStructure.test.ts
 *
 * Unit + integration tests for all 5 validation rules and the top-level
 * validateSkillStructure() function.
 */

import { describe, it, expect, afterAll } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  parseRoutingTableEntries,
  checkBrokenRoutingRefs,
  checkMissingFromTable,
  checkOrphanedRootDirs,
  checkExcessiveDepth,
  checkNameMismatch,
  validateSkillStructure,
} from './ValidateSkillStructure';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Create a directory (including parents) under the given base. */
function mkdir(base: string, ...parts: string[]): string {
  const full = join(base, ...parts);
  mkdirSync(full, { recursive: true });
  return full;
}

/** Write text content to a file (creating parent dirs as needed). */
function write(base: string, relPath: string, content: string): void {
  const full = join(base, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf-8');
}

/** Canonical category SKILL.md listing one sub-skill in its routing table. */
function categorySkillMd(catName: string, subEntries: Array<{ name: string; path: string }>): string {
  const rows = subEntries
    .map((e) => `| **${e.name}** | ${e.name.toLowerCase()} trigger | \`${e.path}\` |`)
    .join('\n');

  return `---
name: ${catName}
description: Test category. USE WHEN test.
---

# ${catName}

Test description.

## Sub-Skills

| Sub-Skill | Triggers | Load |
|-----------|----------|------|
${rows}

## Workflow Routing

When a sub-skill is identified from the table above:
1. Read the sub-skill's SKILL.md for its full routing and workflow list
2. Execute the appropriate workflow from that sub-skill's directory

## Voice Notification

Use \`notifySync()\` from \`lib/core/NotificationService.ts\`
`;
}

/** Minimal sub-skill SKILL.md with given name field. */
function subSkillMd(name: string): string {
  return `---
name: ${name}
description: Sub skill ${name}. USE WHEN ${name.toLowerCase()}.
---

# ${name}
`;
}

// ---------------------------------------------------------------------------
// 1. parseRoutingTableEntries
// ---------------------------------------------------------------------------

describe('parseRoutingTableEntries', () => {
  it('parses a known routing table markdown string and returns correct name/path pairs', () => {
    const content = `
## Sub-Skills

| Sub-Skill | Triggers | Load |
|-----------|----------|------|
| **SubA** | sub a, test a | \`MockCategory/SubA/SKILL.md\` |
| **SubB** | sub b | \`MockCategory/SubB/SKILL.md\` |
`;
    const entries = parseRoutingTableEntries(content);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ name: 'SubA', path: 'MockCategory/SubA/SKILL.md' });
    expect(entries[1]).toEqual({ name: 'SubB', path: 'MockCategory/SubB/SKILL.md' });
  });

  it('returns an empty array when content has no routing table rows', () => {
    const content = `# No Table Here\n\nJust some text without any table rows.\n`;
    const entries = parseRoutingTableEntries(content);
    expect(entries).toHaveLength(0);
  });

  it('returns an empty array for empty string', () => {
    expect(parseRoutingTableEntries('')).toHaveLength(0);
  });

  it('ignores header rows (no bold name)', () => {
    const content = `| Sub-Skill | Triggers | Load |\n|-----------|----------|------|\n`;
    const entries = parseRoutingTableEntries(content);
    expect(entries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. checkBrokenRoutingRefs
// ---------------------------------------------------------------------------

describe('checkBrokenRoutingRefs', () => {
  const dir = join(tmpdir(), `validate-broken-refs-${Date.now()}`);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('finds 1 BROKEN_ROUTING_REF for Ghost, 0 for Real', () => {
    const catDir = mkdir(dir, 'MockCategory');
    // Real sub-skill exists on disk
    mkdir(dir, 'MockCategory', 'Real');
    write(dir, 'MockCategory/Real/SKILL.md', subSkillMd('Real'));

    // Category routing table references both Real (exists) and Ghost (does not exist)
    write(
      dir,
      'MockCategory/SKILL.md',
      categorySkillMd('MockCategory', [
        { name: 'Real', path: 'MockCategory/Real/SKILL.md' },
        { name: 'Ghost', path: 'MockCategory/Ghost/SKILL.md' },
      ]),
    );

    const issues = checkBrokenRoutingRefs(dir);
    const broken = issues.filter((i) => i.rule === 'BROKEN_ROUTING_REF');
    expect(broken).toHaveLength(1);
    expect(broken[0].path).toBe('MockCategory/Ghost/SKILL.md');
    expect(broken[0].severity).toBe('ERROR');
    expect(broken[0].category).toBe('MockCategory');

    // Real should produce no broken-ref issue
    const realBroken = broken.filter((i) => i.path?.includes('Real'));
    expect(realBroken).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. checkMissingFromTable
// ---------------------------------------------------------------------------

describe('checkMissingFromTable', () => {
  const dir = join(tmpdir(), `validate-missing-table-${Date.now()}`);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('finds 1 MISSING_FROM_TABLE for SubB when routing table only lists SubA', () => {
    // Category SKILL.md routing table only references SubA
    write(
      dir,
      'MockCategory/SKILL.md',
      categorySkillMd('MockCategory', [{ name: 'SubA', path: 'MockCategory/SubA/SKILL.md' }]),
    );
    mkdir(dir, 'MockCategory', 'SubA');
    write(dir, 'MockCategory/SubA/SKILL.md', subSkillMd('SubA'));
    mkdir(dir, 'MockCategory', 'SubB');
    write(dir, 'MockCategory/SubB/SKILL.md', subSkillMd('SubB'));

    const issues = checkMissingFromTable(dir);
    const missing = issues.filter((i) => i.rule === 'MISSING_FROM_TABLE');
    expect(missing).toHaveLength(1);
    expect(missing[0].subSkill).toBe('SubB');
    expect(missing[0].severity).toBe('ERROR');
    expect(missing[0].category).toBe('MockCategory');
  });
});

// ---------------------------------------------------------------------------
// 4. checkOrphanedRootDirs
// ---------------------------------------------------------------------------

describe('checkOrphanedRootDirs', () => {
  const dir = join(tmpdir(), `validate-orphaned-${Date.now()}`);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('finds 1 ORPHANED_ROOT_DIR warning for root dir with no SKILL.md that shadows a sub-skill', () => {
    // RealCategory is a proper category with a sub-skill named "Orphan"
    write(
      dir,
      'RealCategory/SKILL.md',
      categorySkillMd('RealCategory', [{ name: 'Orphan', path: 'RealCategory/Orphan/SKILL.md' }]),
    );
    mkdir(dir, 'RealCategory', 'Orphan');
    write(dir, 'RealCategory/Orphan/SKILL.md', subSkillMd('Orphan'));

    // Root-level "Orphan" directory exists but has no SKILL.md — only a State/ subdir
    mkdir(dir, 'Orphan', 'State');

    const issues = checkOrphanedRootDirs(dir);
    const orphaned = issues.filter((i) => i.rule === 'ORPHANED_ROOT_DIR');
    expect(orphaned).toHaveLength(1);
    expect(orphaned[0].severity).toBe('WARN');
    expect(orphaned[0].message).toContain('Orphan');
  });

  it('does not flag a root dir that has its own SKILL.md', () => {
    // RealCategory itself has SKILL.md — the orphan check should NOT flag it as orphaned
    // (it would only appear as the "shadowedCat" in an existing orphan message, not as a root orphan)
    const flaggedAsOrphan = checkOrphanedRootDirs(dir).filter(
      (i) => i.rule === 'ORPHANED_ROOT_DIR' && i.path?.endsWith('RealCategory'),
    );
    expect(flaggedAsOrphan).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. checkExcessiveDepth
// ---------------------------------------------------------------------------

describe('checkExcessiveDepth', () => {
  const dir = join(tmpdir(), `validate-depth-${Date.now()}`);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('finds 1 EXCESSIVE_DEPTH error for depth-3 SKILL.md but none for depth-1 or depth-2', () => {
    // Depth 1: Cat/SKILL.md (category root — OK)
    write(
      dir,
      'Cat/SKILL.md',
      categorySkillMd('Cat', [{ name: 'Sub', path: 'Cat/Sub/SKILL.md' }]),
    );
    // Depth 2: Cat/Sub/SKILL.md — OK
    mkdir(dir, 'Cat', 'Sub');
    write(dir, 'Cat/Sub/SKILL.md', subSkillMd('Sub'));
    // Depth 3: Cat/Sub/Deep/SKILL.md — VIOLATION
    mkdir(dir, 'Cat', 'Sub', 'Deep');
    write(dir, 'Cat/Sub/Deep/SKILL.md', subSkillMd('Deep'));

    const issues = checkExcessiveDepth(dir);
    const deep = issues.filter((i) => i.rule === 'EXCESSIVE_DEPTH');
    expect(deep).toHaveLength(1);
    expect(deep[0].severity).toBe('ERROR');
    expect(deep[0].path).toContain('Cat/Sub/Deep/SKILL.md');
  });
});

// ---------------------------------------------------------------------------
// 6. checkNameMismatch
// ---------------------------------------------------------------------------

describe('checkNameMismatch', () => {
  const dir = join(tmpdir(), `validate-name-mismatch-${Date.now()}`);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('finds 1 NAME_MISMATCH warning when SKILL.md name field differs from directory name', () => {
    // Category whose name matches its dir
    write(
      dir,
      'Cat/SKILL.md',
      categorySkillMd('Cat', [{ name: 'RightName', path: 'Cat/RightName/SKILL.md' }]),
    );
    // Sub-skill dir is "RightName" but SKILL.md says "WrongName"
    mkdir(dir, 'Cat', 'RightName');
    write(dir, 'Cat/RightName/SKILL.md', subSkillMd('WrongName'));

    const issues = checkNameMismatch(dir);
    const mismatches = issues.filter((i) => i.rule === 'NAME_MISMATCH');
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].severity).toBe('WARN');
    expect(mismatches[0].message).toContain('WrongName');
    expect(mismatches[0].message).toContain('RightName');
  });

  it('does not flag when name field matches directory name', () => {
    // Sub-skill where name: matches dirname
    const dir2 = join(tmpdir(), `validate-name-ok-${Date.now()}`);
    mkdirSync(dir2, { recursive: true });

    write(
      dir2,
      'Cat/SKILL.md',
      categorySkillMd('Cat', [{ name: 'CorrectName', path: 'Cat/CorrectName/SKILL.md' }]),
    );
    mkdir(dir2, 'Cat', 'CorrectName');
    write(dir2, 'Cat/CorrectName/SKILL.md', subSkillMd('CorrectName'));

    const issues = checkNameMismatch(dir2);
    const mismatches = issues.filter((i) => i.rule === 'NAME_MISMATCH');
    expect(mismatches).toHaveLength(0);

    rmSync(dir2, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// 7. Integration: validateSkillStructure with multiple violations
// ---------------------------------------------------------------------------

describe('validateSkillStructure (integration)', () => {
  const dir = join(tmpdir(), `validate-integration-${Date.now()}`);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('returns valid=false with correct error/warning counts when multiple rules are violated', () => {
    // === CategoryA: has a broken routing ref (GhostSub missing) + a real sub-skill ===
    write(
      dir,
      'CategoryA/SKILL.md',
      categorySkillMd('CategoryA', [
        { name: 'RealSub', path: 'CategoryA/RealSub/SKILL.md' },
        { name: 'GhostSub', path: 'CategoryA/GhostSub/SKILL.md' }, // broken
      ]),
    );
    mkdir(dir, 'CategoryA', 'RealSub');
    write(dir, 'CategoryA/RealSub/SKILL.md', subSkillMd('RealSub'));

    // === CategoryB: has a sub-skill missing from table + one name mismatch ===
    write(
      dir,
      'CategoryB/SKILL.md',
      categorySkillMd('CategoryB', [{ name: 'SubListed', path: 'CategoryB/SubListed/SKILL.md' }]),
    );
    mkdir(dir, 'CategoryB', 'SubListed');
    write(dir, 'CategoryB/SubListed/SKILL.md', subSkillMd('SubListed'));
    // SubUnlisted exists on disk but is absent from the routing table → MISSING_FROM_TABLE
    mkdir(dir, 'CategoryB', 'SubUnlisted');
    write(dir, 'CategoryB/SubUnlisted/SKILL.md', subSkillMd('SubUnlisted'));
    // SubWrong has a name mismatch → NAME_MISMATCH (WARN)
    mkdir(dir, 'CategoryB', 'SubWrong');
    write(dir, 'CategoryB/SubWrong/SKILL.md', subSkillMd('ActuallyDifferent'));
    // Add SubWrong to the routing table so it doesn't trigger MISSING_FROM_TABLE too
    write(
      dir,
      'CategoryB/SKILL.md',
      categorySkillMd('CategoryB', [
        { name: 'SubListed', path: 'CategoryB/SubListed/SKILL.md' },
        { name: 'SubWrong', path: 'CategoryB/SubWrong/SKILL.md' },
      ]),
    );

    // === Orphan root dir shadowing CategoryA/RealSub ===
    mkdir(dir, 'RealSub', 'SomeSubDir');

    const result = validateSkillStructure(dir);

    // Should be invalid because there are ERRORs
    expect(result.valid).toBe(false);

    // Verify structure shape
    expect(result.issues).toBeInstanceOf(Array);
    expect(typeof result.summary.errors).toBe('number');
    expect(typeof result.summary.warnings).toBe('number');
    expect(result.summary.categoriesChecked).toBeGreaterThanOrEqual(2);
    expect(result.summary.subSkillsChecked).toBeGreaterThanOrEqual(2);

    // BROKEN_ROUTING_REF: GhostSub → 1 error
    const brokenRefs = result.issues.filter((i) => i.rule === 'BROKEN_ROUTING_REF');
    expect(brokenRefs.length).toBeGreaterThanOrEqual(1);
    expect(brokenRefs.some((i) => i.path?.includes('GhostSub'))).toBe(true);

    // MISSING_FROM_TABLE: SubUnlisted → 1 error
    const missingTable = result.issues.filter((i) => i.rule === 'MISSING_FROM_TABLE');
    expect(missingTable.length).toBeGreaterThanOrEqual(1);
    expect(missingTable.some((i) => i.subSkill === 'SubUnlisted')).toBe(true);

    // NAME_MISMATCH: SubWrong → 1 warning
    const nameMismatches = result.issues.filter((i) => i.rule === 'NAME_MISMATCH');
    expect(nameMismatches.length).toBeGreaterThanOrEqual(1);
    expect(nameMismatches.some((i) => i.message.includes('ActuallyDifferent'))).toBe(true);

    // ORPHANED_ROOT_DIR: RealSub root dir → 1 warning
    const orphaned = result.issues.filter((i) => i.rule === 'ORPHANED_ROOT_DIR');
    expect(orphaned.length).toBeGreaterThanOrEqual(1);

    // summary counts must be consistent with issues array
    const errorCount = result.issues.filter((i) => i.severity === 'ERROR').length;
    const warnCount = result.issues.filter((i) => i.severity === 'WARN').length;
    expect(result.summary.errors).toBe(errorCount);
    expect(result.summary.warnings).toBe(warnCount);
  });
});

// ---------------------------------------------------------------------------
// 8. Smoke: real filesystem
// ---------------------------------------------------------------------------

describe('Smoke: real filesystem', () => {
  it('validates real skills dir without crashing', () => {
    const result = validateSkillStructure();
    expect(result.issues).toBeInstanceOf(Array);
    expect(result.summary.categoriesChecked).toBeGreaterThanOrEqual(10);
    expect(result.summary.subSkillsChecked).toBeGreaterThan(40);
    // Known issues exist pre-cleanup, so we just verify structure
    expect(typeof result.valid).toBe('boolean');
  });
});
