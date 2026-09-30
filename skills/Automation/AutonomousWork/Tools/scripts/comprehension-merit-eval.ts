#!/usr/bin/env bun
/**
 * comprehension-merit-eval.ts — merit-based eval for LLM spec comprehension.
 *
 * Replaces the old parity harness (comprehension-parity.ts), which measured
 * fidelity to the regex SpecParser we are DELETING — the wrong oracle.
 *
 * This harness judges comprehension OUTPUT ON THE SPEC'S OWN TERMS:
 *   - completeness: did it capture the spec's real acceptance criteria?
 *   - command fidelity: are verifyCommands verbatim-from-spec or correctly null?
 *                       (a FABRICATED command that could yield a false PASS is the
 *                        only command issue we treat as inexcusable)
 *   - usability: would these rows correctly drive autonomous verification?
 *
 * A comprehension that THROWS (loud backstop) is recorded as LOUD_FAIL — a SAFE
 * outcome (no silent false PASS), counted separately from silent quality misses.
 *
 * Run:
 *   cd ~/.claude/skills/Automation/AutonomousWork/Tools
 *   bun scripts/comprehension-merit-eval.ts            # default ~10 diverse specs
 *   bun scripts/comprehension-merit-eval.ts --all      # all 25 fixture spec paths
 */

import { readFileSync, readdirSync } from "fs";
import { join, basename } from "path";
import type { ComprehendedRow } from "../Types.ts";
import type { GoldenFixture } from "./build-golden-fixtures.ts";

const FIXTURES_DIR = join(import.meta.dir, "..", "__tests__", "fixtures", "golden-isc");

// Default diverse subset — spans the failure modes seen in the parity run plus controls.
const DEFAULT_SUBSET = new Set([
  "argumentmapper-001-spec",      // was 24->0 (truncation: 19K spec > old 16K cap)
  "browser-audit-remediation-2026-03-26", // was 9 "fabrications" — prose verify cells?
  "path-a-contextmanager-fix-spec",       // was 11->4 undercount
  "kaya-evals-001-spec",          // was 30->39 overcount
  "art-audit-remediation-2026-03-26",     // was 13->10 + 5 cmd
  "mlzhsdw8-g0p8il-spec",         // was 7 cmd mismatches
  "mlalgpd5-y2h5a8-spec",         // was 14->8 undercount
  "Agora-spec",                   // control: was MATCH
  "mqgplvxy-owk3o4-spec",         // control: was MATCH
  "kaya-dnd-001-spec",            // control
]);

interface JudgeVerdict {
  completeness: number;      // 0..1 — fraction of the spec's real criteria captured
  missedCriteria: string[];  // notable criteria the spec has but comprehension dropped
  fabricatedCommands: string[]; // commands present in output but NOT in the spec
  usable: boolean;           // would these rows correctly drive autonomous verification?
  verdict: "USABLE" | "DEGRADED" | "UNUSABLE";
  inexcusable: string[];     // issues that would cause a false PASS / unverifiable completion
  notes: string;
}

const JUDGE_SYSTEM = `You are a STRICT, FAIR evaluator of an automated spec-comprehension system. You are given (A) a software spec's markdown and (B) the structured ISC rows a comprehension model extracted from it. Judge the extraction ON THE SPEC'S OWN TERMS. Do NOT compare against any other parser.

Return ONLY a JSON object, no prose, no code fences:
{
  "completeness": <number 0..1>,        // fraction of the spec's real acceptance/verification criteria that are represented by a row
  "missedCriteria": ["<short desc>", ...],   // real criteria in the spec with NO corresponding row (empty if none)
  "fabricatedCommands": ["<cmd>", ...], // verifyCommand values that do NOT appear anywhere in the spec text (empty if none)
  "usable": <boolean>,                  // could these rows correctly drive autonomous verification of THIS spec?
  "verdict": "USABLE" | "DEGRADED" | "UNUSABLE",
  "inexcusable": ["<issue>", ...],      // issues that would cause a FALSE PASS or unverifiable completion (e.g. a fabricated command that would pass spuriously; an entire criteria section dropped). Empty if none.
  "notes": "<one or two sentences>"
}

Rules:
- A verifyCommand of null is CORRECT when the spec's verification is prose with no runnable command. Do NOT penalize null.
- A command is "fabricated" ONLY if its core text does not appear in the spec. Minor reformatting (e.g. unescaping a markdown-table pipe \\| to |) is NOT fabrication.
- "completeness" is about real criteria coverage, not row-count matching. Splitting/merging is fine if coverage is faithful.
- verdict USABLE: faithfully drives verification. DEGRADED: minor gaps, still mostly works. UNUSABLE: would mislead verification.
- Be concrete in "inexcusable": only list things that would actually produce a wrong completion verdict.`;

async function judge(
  inferenceFn: any,
  specContent: string,
  rows: ComprehendedRow[],
  truncated: boolean
): Promise<JudgeVerdict | null> {
  const rowsJson = JSON.stringify(
    rows.map((r) => ({ id: r.id, description: r.description, verifyCommand: r.verifyCommand, humanRequired: r.humanRequired, native: r.native })),
    null,
    1
  );
  const userPrompt =
    `SPEC MARKDOWN:\n\n${specContent.slice(0, 50_000)}\n\n` +
    `========\n\nEXTRACTED ISC ROWS (${rows.length})${truncated ? " [NOTE: spec content was truncated before comprehension]" : ""}:\n\n${rowsJson}\n\n` +
    `Evaluate the extraction on the spec's own terms and return the JSON verdict.`;

  const res = await inferenceFn({ systemPrompt: JUDGE_SYSTEM, userPrompt, level: "smart", expectJson: true, timeout: 180_000 });
  if (!res.success || !res.parsed || typeof res.parsed !== "object") return null;
  // Defensive normalization — the judge LLM occasionally omits a field; never crash the run.
  const raw = res.parsed as Record<string, unknown>;
  const verdict = raw.verdict === "USABLE" || raw.verdict === "DEGRADED" || raw.verdict === "UNUSABLE" ? raw.verdict : "DEGRADED";
  return {
    completeness: typeof raw.completeness === "number" ? raw.completeness : 0,
    missedCriteria: Array.isArray(raw.missedCriteria) ? (raw.missedCriteria as string[]) : [],
    fabricatedCommands: Array.isArray(raw.fabricatedCommands) ? (raw.fabricatedCommands as string[]) : [],
    usable: raw.usable === true,
    verdict: verdict as JudgeVerdict["verdict"],
    inexcusable: Array.isArray(raw.inexcusable) ? (raw.inexcusable as string[]) : [],
    notes: typeof raw.notes === "string" ? raw.notes : "",
  };
}

async function main() {
  const all = process.argv.includes("--all");
  const { comprehendSpec } = await import("../LLMSpecComprehension.ts");
  const { inference } = await import("../../../../../lib/core/Inference.ts");

  const fixtureFiles = readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".json"))
    .filter((f) => all || DEFAULT_SUBSET.has(basename(f, ".json")))
    .sort();

  console.log(`\nComprehension MERIT Eval — ${new Date().toISOString()}`);
  console.log(`Specs to evaluate: ${fixtureFiles.length} (${all ? "ALL" : "default subset"})\n`);
  console.log("=".repeat(80));

  const results: Array<{ slug: string; status: string; v?: JudgeVerdict }> = [];

  for (const file of fixtureFiles) {
    const fixture: GoldenFixture = JSON.parse(readFileSync(join(FIXTURES_DIR, file), "utf-8"));
    const slug = basename(file, ".json");
    let specContent: string;
    try {
      specContent = readFileSync(fixture.specPath, "utf-8");
    } catch {
      console.log(`\n[${slug}] SKIP — spec file unreadable: ${fixture.specPath}`);
      results.push({ slug, status: "FILE_ERROR" });
      continue;
    }

    process.stdout.write(`\n[${slug}] ${fixture.layoutNote} (${specContent.length} chars)\n`);

    // Comprehension — a throw is the LOUD BACKSTOP = a SAFE outcome, not a silent miss.
    let comp;
    try {
      comp = await comprehendSpec(specContent, { level: "standard" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  LOUD_FAIL (safe — no silent false PASS): ${msg.slice(0, 120)}`);
      results.push({ slug, status: "LOUD_FAIL" });
      continue;
    }

    const v = await judge(inference, specContent, comp.rows, comp.truncated === true);
    if (!v) {
      console.log(`  JUDGE_ERROR — could not get verdict`);
      results.push({ slug, status: "JUDGE_ERROR" });
      continue;
    }

    results.push({ slug, status: v.verdict, v });
    console.log(
      `  rows=${comp.rows.length} truncated=${comp.truncated === true} | verdict=${v.verdict} ` +
      `completeness=${v.completeness.toFixed(2)} fabricated=${v.fabricatedCommands.length} inexcusable=${v.inexcusable.length}`
    );
    if (v.fabricatedCommands.length) console.log(`    FABRICATED: ${v.fabricatedCommands.slice(0, 3).join(" | ")}`);
    if (v.inexcusable.length) console.log(`    INEXCUSABLE: ${v.inexcusable.slice(0, 3).join(" | ")}`);
    if (v.missedCriteria.length) console.log(`    MISSED: ${v.missedCriteria.slice(0, 3).join(" | ")}`);
  }

  // Aggregate
  const count = (s: string) => results.filter((r) => r.status === s).length;
  const usable = count("USABLE");
  const degraded = count("DEGRADED");
  const unusable = count("UNUSABLE");
  const loud = count("LOUD_FAIL");
  const judged = results.filter((r) => r.v).length;
  const totalFab = results.reduce((n, r) => n + (r.v?.fabricatedCommands.length ?? 0), 0);
  const totalInexcusable = results.reduce((n, r) => n + (r.v?.inexcusable.length ?? 0), 0);
  const avgCompleteness = judged > 0 ? results.reduce((n, r) => n + (r.v?.completeness ?? 0), 0) / judged : 0;

  console.log("\n" + "=".repeat(80));
  console.log(`USABLE: ${usable}  DEGRADED: ${degraded}  UNUSABLE: ${unusable}  LOUD_FAIL(safe): ${loud}`);
  console.log(`Avg completeness (judged): ${avgCompleteness.toFixed(2)}`);
  console.log(`Total fabricated commands: ${totalFab}`);
  console.log(`Total INEXCUSABLE issues: ${totalInexcusable}`);
  console.log("");

  // Acceptance: NO unusable silent outputs, ZERO inexcusable issues. Loud fails are OK (safe).
  const pass = unusable === 0 && totalInexcusable === 0;
  if (pass) {
    console.log("STATUS: PASS — every output is usable or fails loud; zero inexcusable issues.");
  } else {
    console.log(`STATUS: NEEDS WORK — ${unusable} unusable + ${totalInexcusable} inexcusable issue(s).`);
    const bad = results.filter((r) => r.status === "UNUSABLE" || (r.v?.inexcusable.length ?? 0) > 0).map((r) => r.slug);
    console.log(`Problem specs: ${bad.join(", ")}`);
  }
  process.exit(pass ? 0 : 1);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("FATAL:", err);
    process.exit(1);
  });
}
