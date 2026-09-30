#!/usr/bin/env bun
/**
 * GenerateGoalsMd.ts — render USER/TELOS/GOALS.md from USER/TELOS/goals.yaml.
 *
 * Option (b) of the markdown-regex remediation (Jm's call, 2026-08-02):
 * goals.yaml is the source of truth Jm edits; GOALS.md is a generated
 * artifact. Regenerate after every goals.yaml edit:
 *
 *   bun ~/.claude/skills/Life/Telos/Tools/GenerateGoalsMd.ts           # write
 *   bun ~/.claude/skills/Life/Telos/Tools/GenerateGoalsMd.ts --check   # verify only
 *
 * --check exits 1 if GOALS.md on disk differs from what goals.yaml renders
 * (i.e. someone edited the generated file directly, or forgot to regenerate).
 *
 * The banner below is the only content not derived from goals.yaml. All
 * validation lives in lib/core/TelosGoals.ts and fails loud.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import {
  parseGoalsModel,
  renderGoalsMd,
  telosGoalsYamlPath,
  telosGoalsMdPath,
} from "../../../../lib/core/TelosGoals.ts";

const BANNER = `<!-- GENERATED FILE — do not edit directly.
     Source of truth: USER/TELOS/goals.yaml (edit that, structured fields + verbatim body blocks).
     Regenerate:      bun ~/.claude/skills/Life/Telos/Tools/GenerateGoalsMd.ts -->
`;

export function generateGoalsMdText(): string {
  const yamlPath = telosGoalsYamlPath();
  const model = parseGoalsModel(readFileSync(yamlPath, "utf-8"));
  return BANNER + renderGoalsMd(model);
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  const mdPath = telosGoalsMdPath();
  const next = generateGoalsMdText();

  if (check) {
    const current = existsSync(mdPath) ? readFileSync(mdPath, "utf-8") : "";
    if (current === next) {
      console.log(`OK: ${mdPath} matches goals.yaml`);
      process.exit(0);
    }
    console.error(
      `STALE: ${mdPath} does not match what goals.yaml renders.\n` +
        `Either goals.yaml was edited without regenerating (run this tool without --check), ` +
        `or GOALS.md was edited directly (port the edit into goals.yaml — direct edits get clobbered).`,
    );
    process.exit(1);
  }

  writeFileSync(mdPath, next);
  console.log(`Wrote ${mdPath} from ${telosGoalsYamlPath()}`);
}
