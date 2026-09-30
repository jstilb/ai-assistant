#!/usr/bin/env bun
/**
 * SpecLint.ts — Structural gate for ReverseSpec specs.
 *
 * PURPOSE:
 * A spec is only useful if it is complete and honest about its provenance.
 * This lint checks the parts of that a script can check: frontmatter
 * provenance (subject exists, hash recorded, spec lives at the canonical
 * path), the twelve required sections in order, the Findings subsections,
 * a minimum-size Acceptance Criteria table (mirrors the spec-pipeline's ISC
 * quality gate), at least two mermaid diagrams, no leftover template
 * comments, and that every backticked repo path resolves.
 *
 * Content quality (does the Summary actually explain the module?) is LLM
 * judgment and lives in the workflow, not here.
 *
 * USAGE:
 *   bun SpecLint.ts <spec.md> [<spec.md> ...]     # lint given files
 *   bun SpecLint.ts --all                         # lint every spec under docs/specs
 *   --root <dir>   Kaya home override
 *   --json         machine-readable output
 *   --strict       treat warnings as errors
 * Exit 0 = no errors, 1 = errors, 2 = usage error.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";
import { parseArgs } from "util";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";
import {
  SUBJECT_KINDS,
  hashSubject,
  inferKind,
  parseFrontmatter,
  specPathFor,
  type SpecFrontmatter,
  type SubjectKind,
} from "./Inventory.ts";

// ============================================================================
// Contract
// ============================================================================

export const REQUIRED_FRONTMATTER = [
  "subject",
  "kind",
  "spec_version",
  "source_hash",
  "source_files",
  "generated",
  "generated_by",
  "status",
  "confidence",
] as const;

export const REQUIRED_SECTIONS = [
  "Summary",
  "Purpose",
  "Context",
  "Ontology",
  "Interface",
  "Features",
  "Acceptance Criteria",
  "Tests And Edge Cases",
  "Evals And Metrics",
  "Diagrams",
  "Rebuild Notes",
  "Findings",
] as const;

export const FINDINGS_SUBSECTIONS = [
  "Improvements",
  "Redundancies",
  "Synergies",
  "Contradictions",
  "Open Questions",
] as const;

export const MIN_ACCEPTANCE_ROWS = 4;
const VALID_STATUS = new Set(["draft", "reviewed"]);
const VALID_CONFIDENCE = new Set(["high", "medium", "low"]);
const VALID_AC_STATUS = new Set(["observed", "inferred", "unverified"]);

export interface LintIssue {
  level: "error" | "warning";
  message: string;
}

export interface LintResult {
  file: string;
  issues: LintIssue[];
  errors: number;
  warnings: number;
}

// ============================================================================
// Parsing helpers
// ============================================================================

interface Section {
  title: string;
  level: number;
  body: string;
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

/** Split markdown into H2/H3 sections (frontmatter and H1 excluded). Fenced code is opaque. */
export function splitSections(content: string): Section[] {
  const body = content.startsWith("---") ? content.slice(content.indexOf("\n---", 3) + 4) : content;
  const lines = body.split("\n");
  const sections: Section[] = [];
  let current: Section | null = null;
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const m = !inFence ? line.match(/^(##|###)\s+(.+?)\s*$/) : null;
    if (m) {
      current = { title: m[2], level: m[1].length, body: "" };
      sections.push(current);
    } else if (current) {
      current.body += line + "\n";
    }
  }
  return sections;
}

/** Body of an H2 section including its H3 children, up to the next H2. */
function h2Body(sections: Section[], title: string): string | null {
  const i = sections.findIndex((s) => s.level === 2 && s.title === title);
  if (i === -1) return null;
  let out = sections[i].body;
  for (let j = i + 1; j < sections.length && sections[j].level !== 2; j++) {
    out += `### ${sections[j].title}\n` + sections[j].body;
  }
  return out;
}

function stripComments(s: string): string {
  return s.replace(/<!--[\s\S]*?-->/g, "");
}

function countMermaid(s: string): number {
  return (s.match(/^\s*```mermaid\b/gm) ?? []).length;
}

/** Data rows of the first pipe table in a section (skips header + separator). */
export function tableRows(body: string): string[][] {
  const lines = body.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("|"));
  if (lines.length < 2) return [];
  const rows: string[][] = [];
  for (const line of lines.slice(1)) {
    if (/^\|\s*:?-+/.test(line)) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    rows.push(cells);
  }
  return rows;
}

const REPO_PATH_RE = /`((?:skills|hooks|lib|bin|agents|docs|Commands|USER|MEMORY|plans|tests|servers|jobs)\/[^`\s]+?)(?::\d+(?:-\d+)?)?`/g;

// ============================================================================
// Lint
// ============================================================================

export function lintSpecContent(root: string, specRel: string, content: string): LintResult {
  const issues: LintIssue[] = [];
  const err = (message: string) => issues.push({ level: "error", message });
  const warn = (message: string) => issues.push({ level: "warning", message });

  // --- frontmatter -----------------------------------------------------------
  const fm: SpecFrontmatter | null = parseFrontmatter(content);
  if (!fm) {
    err("missing frontmatter block (--- ... ---)");
  } else {
    for (const key of REQUIRED_FRONTMATTER) {
      if (!fm[key]) err(`frontmatter: missing \`${key}\``);
    }
    if (fm.kind && !SUBJECT_KINDS.includes(fm.kind as SubjectKind)) {
      err(`frontmatter: kind \`${fm.kind}\` not one of ${SUBJECT_KINDS.join("|")}`);
    }
    if (fm.status && !VALID_STATUS.has(fm.status)) err(`frontmatter: status \`${fm.status}\` must be draft|reviewed`);
    if (fm.confidence && !VALID_CONFIDENCE.has(fm.confidence)) {
      err(`frontmatter: confidence \`${fm.confidence}\` must be high|medium|low`);
    }
    if (fm.generated && !/^\d{4}-\d{2}-\d{2}$/.test(fm.generated)) warn(`frontmatter: generated \`${fm.generated}\` is not YYYY-MM-DD`);
    if (fm.subject) {
      const subject = toPosix(fm.subject).replace(/\/+$/, "");
      const inferred = inferKind(subject);
      if (inferred === null) err(`frontmatter: subject \`${subject}\` is not a recognised subject path`);
      else if (fm.kind && inferred !== fm.kind) err(`frontmatter: kind \`${fm.kind}\` but path implies \`${inferred}\``);
      if (!existsSync(join(root, subject))) {
        err(`frontmatter: subject \`${subject}\` does not exist on disk`);
      } else {
        const expected = specPathFor(subject);
        if (expected !== specRel) err(`spec is at \`${specRel}\` but the canonical path for this subject is \`${expected}\``);
        const { hash, files } = hashSubject(root, subject);
        if (fm.source_hash && fm.source_hash !== hash) {
          warn(`stale: source_hash ${fm.source_hash} ≠ current ${hash} — subject changed since the spec was written`);
        }
        if (fm.source_files && String(files.length) !== fm.source_files) {
          warn(`source_files ${fm.source_files} ≠ current ${files.length}`);
        }
      }
    }
  }

  // --- sections --------------------------------------------------------------
  const sections = splitSections(content);
  const h2s = sections.filter((s) => s.level === 2).map((s) => s.title);
  let lastIdx = -1;
  for (const title of REQUIRED_SECTIONS) {
    const occurrences = h2s.filter((t) => t === title).length;
    if (occurrences === 0) {
      err(`missing section \`## ${title}\``);
      continue;
    }
    if (occurrences > 1) err(`section \`## ${title}\` appears ${occurrences} times`);
    const idx = h2s.indexOf(title);
    if (idx < lastIdx) err(`section \`## ${title}\` is out of order (template order is fixed)`);
    lastIdx = Math.max(lastIdx, idx);
    const body = stripComments(h2Body(sections, title) ?? "").trim();
    if (body.length === 0) err(`section \`## ${title}\` is empty`);
  }
  for (const extra of h2s.filter((t) => !(REQUIRED_SECTIONS as readonly string[]).includes(t))) {
    warn(`unexpected extra section \`## ${extra}\` — keep the template shape so cross-spec tooling can read it`);
  }

  // --- Findings subsections --------------------------------------------------
  const findingsIdx = sections.findIndex((s) => s.level === 2 && s.title === "Findings");
  if (findingsIdx !== -1) {
    const subs = sections.slice(findingsIdx + 1).filter((s) => s.level === 3).map((s) => s.title);
    for (const sub of FINDINGS_SUBSECTIONS) {
      if (!subs.includes(sub)) err(`Findings: missing \`### ${sub}\``);
      else {
        const s = sections.find((x) => x.level === 3 && x.title === sub);
        if (s && stripComments(s.body).trim().length === 0) err(`Findings: \`### ${sub}\` is empty (write "none found")`);
      }
    }
  }

  // --- Acceptance Criteria table ---------------------------------------------
  const ac = h2Body(sections, "Acceptance Criteria");
  if (ac !== null) {
    const rows = tableRows(stripComments(ac));
    if (rows.length < MIN_ACCEPTANCE_ROWS) {
      err(`Acceptance Criteria: ${rows.length} table rows, minimum is ${MIN_ACCEPTANCE_ROWS}`);
    }
    for (const row of rows) {
      if (row.length < 4) {
        warn(`Acceptance Criteria: row \`${row[0] ?? "?"}\` has ${row.length} cells, expected ID|Criterion|Verification|Status`);
        continue;
      }
      const status = row[3].toLowerCase();
      if (!VALID_AC_STATUS.has(status)) warn(`Acceptance Criteria: row \`${row[0]}\` status \`${row[3]}\` not observed|inferred|unverified`);
      if (/check (that )?it works/i.test(row[2])) warn(`Acceptance Criteria: row \`${row[0]}\` verification is not concrete`);
    }
  }

  // --- Diagrams --------------------------------------------------------------
  const diagrams = h2Body(sections, "Diagrams");
  if (diagrams !== null) {
    const n = countMermaid(diagrams);
    if (n === 0) err("Diagrams: no ```mermaid block");
    else if (n === 1) warn("Diagrams: only one mermaid block — template asks for structural + behavioral");
  }

  // --- Summary hygiene -------------------------------------------------------
  const summary = h2Body(sections, "Summary");
  if (summary !== null && /`/.test(stripComments(summary))) {
    warn("Summary: contains backticks — the summary is plain language, no paths or code");
  }

  // --- Tests honesty ---------------------------------------------------------
  const tests = h2Body(sections, "Tests And Edge Cases");
  if (tests !== null) {
    const t = stripComments(tests);
    if (/0 fail/i.test(t) && !/Ran \d+/i.test(t) && !/\d+ pass/i.test(t)) {
      warn('Tests And Edge Cases: claims "0 fail" without a "Ran N" / "N pass" count');
    }
  }

  // --- leftover template comments -------------------------------------------
  const leftovers = (content.match(/<!--[\s\S]*?-->/g) ?? []).filter((c) => /^<!--\s*(\d\.|-|Every item|Two parts|Where the subject|Everything a caller|Numbered list|ISC-style|At least two|The "from scratch"|The problem this|3–6 sentences|changes that would|overlap with|things that would|docs vs code|things only Jm)/.test(c));
  if (leftovers.length > 0) warn(`${leftovers.length} template guidance comment(s) left in the spec — delete them`);

  // --- referenced repo paths resolve ----------------------------------------
  const seen = new Set<string>();
  for (const m of stripComments(content).matchAll(REPO_PATH_RE)) {
    const p = m[1].replace(/[),.;:]+$/, "");
    if (seen.has(p) || p.includes("*") || p.includes("<") || p.includes("{") || p.includes("[")) continue;
    seen.add(p);
    if (!existsSync(join(root, p))) warn(`referenced path does not exist: \`${p}\``);
  }

  const errors = issues.filter((i) => i.level === "error").length;
  return { file: specRel, issues, errors, warnings: issues.length - errors };
}

export function lintSpecFile(root: string, specAbs: string): LintResult {
  const specRel = toPosix(relative(root, specAbs));
  if (!existsSync(specAbs)) {
    return { file: specRel, issues: [{ level: "error", message: "file does not exist" }], errors: 1, warnings: 0 };
  }
  return lintSpecContent(root, specRel, readFileSync(specAbs, "utf-8"));
}

/** Every *.md under docs/specs except INDEX.md and CROSS-SPEC.md. */
export function findAllSpecs(root: string): string[] {
  const base = join(root, "docs", "specs");
  if (!existsSync(base)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".md") && e.name !== "INDEX.md" && e.name !== "CROSS-SPEC.md" && e.name !== "README.md") out.push(p);
    }
  };
  walk(base);
  return out.sort();
}

// ============================================================================
// CLI
// ============================================================================

function main(): void {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      root: { type: "string" },
      all: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      strict: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const root = values.root ?? getKayaHome();
  const targets = values.all ? findAllSpecs(root) : positionals.map((p) => (p.startsWith("/") ? p : join(process.cwd(), p)));
  if (targets.length === 0) {
    console.error("[SpecLint] no spec files given (pass paths or --all)");
    process.exit(2);
  }
  for (const t of targets) {
    if (existsSync(t) && statSync(t).isDirectory()) {
      console.error(`[SpecLint] ${t} is a directory — pass spec files or --all`);
      process.exit(2);
    }
  }

  const results = targets.map((t) => lintSpecFile(root, t));
  const totalErrors = results.reduce((n, r) => n + r.errors, 0);
  const totalWarnings = results.reduce((n, r) => n + r.warnings, 0);

  if (values.json) {
    console.log(JSON.stringify({ results, totalErrors, totalWarnings }, null, 2));
  } else {
    for (const r of results) {
      const tag = r.errors > 0 ? "FAIL" : r.warnings > 0 ? "WARN" : "OK  ";
      console.log(`${tag} ${r.file}${r.issues.length ? ` (${r.errors} errors, ${r.warnings} warnings)` : ""}`);
      for (const i of r.issues) console.log(`     ${i.level === "error" ? "✗" : "△"} ${i.message}`);
    }
    console.log(`\n${results.length} spec(s): ${totalErrors} errors, ${totalWarnings} warnings`);
  }
  const fail = totalErrors > 0 || (values.strict && totalWarnings > 0);
  process.exit(fail ? 1 : 0);
}

if (import.meta.main) {
  main();
}
