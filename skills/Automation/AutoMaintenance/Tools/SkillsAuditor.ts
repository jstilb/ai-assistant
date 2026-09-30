/**
 * SkillsAuditor.ts — Monthly skills audit for AutoMaintenance.
 * Checks all skills for SKILL.md presence and structural integrity.
 * Uses Node fs APIs — no execSync shell commands.
 */

import { existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";

const KAYA_HOME = getKayaHome();

export interface SkillFinding {
  skill: string;
  hasSKILLmd?: boolean;
  issue?: string;
  severity?: string;
}

export interface SkillsAuditResult {
  skills: string[];
  findings: SkillFinding[];
}

function findSkills(dir: string, results: string[] = []): string[] {
  let items: string[];
  try { items = readdirSync(dir); } catch { return results; }
  for (const item of items) {
    const fullPath = join(dir, item);
    try {
      if (statSync(fullPath).isDirectory()) {
        if (existsSync(join(fullPath, "SKILL.md"))) results.push(fullPath);
        findSkills(fullPath, results);
      }
    } catch { /* skip inaccessible */ }
  }
  return results;
}

export async function runSkillsAudit(): Promise<SkillsAuditResult> {
  const skillsDir = join(KAYA_HOME, "skills");
  const findings: SkillFinding[] = [];
  const skills = findSkills(skillsDir);
  console.log(`✓ Found ${skills.length} skills`);

  for (const skillPath of skills) {
    if (!existsSync(join(skillPath, "SKILL.md"))) {
      findings.push({ skill: skillPath.replace(KAYA_HOME + "/", ""), hasSKILLmd: false });
    }
  }

  try {
    const { validateSkillStructure } = await import("../../../../lib/core/ValidateSkillStructure");
    const result = validateSkillStructure(skillsDir);
    if (!result.valid) {
      for (const issue of result.issues) {
        findings.push({ skill: issue.category || issue.subSkill || "system", issue: `[${issue.rule}] ${issue.message}`, severity: issue.severity });
      }
      console.log(`⚠ ${result.summary.errors} structural errors, ${result.summary.warnings} warnings`);
    } else {
      console.log(`✓ Structural validation passed (${result.summary.categoriesChecked} categories, ${result.summary.subSkillsChecked} sub-skills)`);
    }
  } catch (err) {
    console.error(`⚠ Structural validation failed to run: ${err instanceof Error ? err.message : err}`);
  }

  return { skills, findings };
}
