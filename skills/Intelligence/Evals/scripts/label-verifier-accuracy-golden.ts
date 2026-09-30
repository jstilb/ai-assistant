#!/usr/bin/env bun
/**
 * label-verifier-accuracy-golden.ts
 *
 * Builds the verifier-accuracy golden set via REAL ensemble labeling.
 *
 * WHAT WE ARE LABELING (meta-judgment framing):
 * This is NOT a re-run of the SkepticalVerifier. We are judging:
 *   "Given this verifier's own stated evidence (verdict + concerns + ISC coverage
 *    + transcript), was the verdict JUSTIFIED?"
 *
 * Rubric:
 *   - justified   → the recorded evidence supports the verdict
 *   - unjustified → the recorded evidence contradicts the verdict (e.g. PASS with
 *                   serious unaddressed mandatory requirements and no debunking)
 *
 * Output: skills/Intelligence/Evals/Data/golden/verifier-accuracy-golden.jsonl
 *
 * Usage:
 *   bun .../label-verifier-accuracy-golden.ts                 # PRESERVE curated labels (default)
 *   bun .../label-verifier-accuracy-golden.ts --dry-run       # no LLM; emit DRY_RUN placeholders
 *   bun .../label-verifier-accuracy-golden.ts --live          # Phase-L cases only
 *   bun .../label-verifier-accuracy-golden.ts --drift-check   # ensemble vs curated, report drift, keep curated
 *   bun .../label-verifier-accuracy-golden.ts --force-relabel # regenerate every label from the ensemble
 *
 * REPRODUCIBILITY: the 3-model ensemble is non-deterministic on the fuzziest
 * meta-judgment cases and once silently regressed 6 hand-reconciled labels
 * (2026-06-19). By default the committed golden is AUTHORITATIVE — existing labels
 * are preserved (no inference spent on pinned cases) and only NEW cases are
 * ensemble-labeled. Use --drift-check to detect ensemble drift without overwriting,
 * or --force-relabel to deliberately regenerate from scratch.
 */

import { inference } from "../../../../lib/core/Inference.ts";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { join, dirname } from "path";

// ── Config ───────────────────────────────────────────────────────────────────

const CRITERIA_VERSION = 1;
const KAYA_HOME = getKayaHome();
const OUTPUT_PATH = join(import.meta.dir, "../Data/golden/verifier-accuracy-golden.jsonl");

const isDryRun = process.argv.includes("--dry-run");
const isLiveOnly = process.argv.includes("--live");
// Reproducibility flags: by default the committed golden is AUTHORITATIVE — existing
// labels are preserved (the 3-model ensemble is non-deterministic on fuzzy cases and
// once silently regressed 6 hand-reconciled labels). --force-relabel regenerates every
// label from the ensemble; --drift-check runs the ensemble and reports disagreements
// with the curated labels WITHOUT overwriting them.
const forceRelabel = process.argv.includes("--force-relabel");
const driftCheck = process.argv.includes("--drift-check");

// ── Justification rubric (ensemble system prompt) ─────────────────────────────

const VERIFIER_ACCURACY_SYSTEM_PROMPT = `You are a meta-evaluator auditing an AI verifier's verdict quality.

Given evidence about a completed work item's verification, judge whether the verifier's
verdict (PASS / FAIL / PASS_MANUAL) was JUSTIFIED by its own stated evidence.

Return ONLY valid JSON: {"justified": "justified"} or {"justified": "unjustified"}

RUBRIC:
Justified PASS:
  - Concerns are minor (infra failures like Tier-2 timeouts, false-positive warnings
    that are self-debunked within the same concern list, pattern-matching false alarms)
  - ISC coverage is high (≥80%) OR the low coverage is explained (pre-AW era, manual verify)
  - No unresolved mandatory spec requirements (unaddressed requirements that are NOT debunked
    as false positives = red flag)
  - PASS_MANUAL: human manually debunked all concerns = justified when concerns are explained

Unjustified PASS:
  - "Unaddressed: [requirement]" concerns with NO subsequent explanation/debunking = red flag
  - iscRowsVerified == 0 and iscRowsTotal > 0 AND concerns are not false-positives
  - Serious implementation gaps clearly stated and left unresolved in the concerns list

Justified FAIL:
  - Concerns list concrete failing evidence (failed tests, missing mandatory files,
    ISC rows 0/N with no debunking, spec section explicitly unimplemented)
  - iscRowsVerified < iscRowsTotal and reason is not explained

Unjustified FAIL:
  - All concerns are debunked false positives but verdict is still FAIL
  - Evidence strongly suggests work was done but verdict ignores it

IMPORTANT: Be conservative — label "justified" when in doubt. Only label "unjustified"
when the evidence clearly contradicts the verdict.`;

const CANDIDATE_FIELD = "justified";
const VALID_JUSTIFICATIONS = new Set(["justified", "unjustified"]);

// ── Verifier cases corpus ─────────────────────────────────────────────────────
// 20 verifier cases (from work-queue.json) + 5 Phase-L cases from live-verification/
// Evidence format: compact serialization of verdict+concerns+ISC+transcript snippet

const VERIFIER_CASES: VerifierCase[] = [
  // ── Category A: FAIL — the only clear FAIL in the queue ──────────────────
  {
    id: "mn8s-e70349f88b23",
    item_title: "Art Audit Remediation — Orphaned Images, Midjourney Deprecation",
    verdict: "FAIL",
    isc_verified: 0,
    isc_total: 3,
    concerns: [
      "Low spec alignment: 4/4 requirements unaddressed",
      "Unaddressed: BackgroundRemoval.md, CreatePack.md, ValidatePack.md",
      "No terminology overlap between ISC descriptions and changed files — possible spec drift",
      "Low code density: 164 insertions across 35 files (4.7 lines/file avg) — possible skeleton/stub",
      "Test file covers only deletion scenario, not ISC-2 changes — confirms ISC-2 was skipped entirely",
      "Work item calls for Midjourney subsystem deprecation but zero related file changes in git diff",
      "Work item calls for SKILL.md Customization section but no SKILL.md changes in git diff",
      "Agent only registered 3 ISC rows while ISC-2 and additional spec items have no corresponding ISC rows",
    ],
    transcript_snippet: null,
    expected_reasoning:
      "FAIL is justified: 0/3 ISC rows verified, 4/4 spec requirements flagged as unaddressed with concrete file-level evidence. Core deliverables (Midjourney deprecation, SKILL.md update, stale cross-skill reference fixes) are absent from the git diff.",
  },

  // ── Category B: PASS_MANUAL — human debunked verifier concerns ───────────
  {
    id: "mlzhsdw8-g0p8il",
    item_title: "ML/MLOps Repos: Strategic Consolidation + Key Improvements",
    verdict: "PASS_MANUAL",
    isc_verified: null,
    isc_total: null,
    concerns: [
      "Multi-repo item: SkepticalVerifier cannot diff across 3 separate git repos (timeseries-forecasting, mlops-serving, deep-learning-cv). Work manually verified — all commits pushed to GitHub.",
    ],
    transcript_snippet: null,
    expected_reasoning:
      "PASS_MANUAL is justified: the verifier's limitation (cannot diff across 3 repos) is a known infrastructure constraint, not an implementation gap. Manual verification was the only viable approach. Concern is structural, not a work deficiency.",
  },
  {
    id: "mlzhrg3i-pvwqds",
    item_title: "compound-ai-system: Tests, Real Providers, Benchmarks, A/B Harness",
    verdict: "PASS_MANUAL",
    isc_verified: null,
    isc_total: null,
    concerns: [
      "SkepticalVerifier gave NEEDS_REVIEW — all concerns manually debunked as false positives:",
      "- docs/architecture.md exists in initial commit (not in diff because pre-existing)",
      "- ADR files are 35 and 29 lines respectively (git diff stat mismatch due to pre-existing files)",
      "- README comparison table is programmatic (benchmark/strategy_comparison.py writes it)",
      "- Test files confirmed in diff: 312+278+258 lines across 3 test files",
      "- CachedHTTPClient false positive: standalone Python project using SDK clients",
    ],
    transcript_snippet: null,
    expected_reasoning:
      "PASS_MANUAL is justified: every NEEDS_REVIEW concern is explicitly debunked with concrete explanations (pre-existing files, Python project pattern, confirmed test file line counts). The debunking is specific, not hand-wavy.",
  },

  // ── Category C: PASS with no concerns, no ISC data (early items) ─────────
  {
    id: "mli8hx7q-vi36mm",
    item_title: "Voice System Migration: ElevenLabs → Local Open-Source TTS",
    verdict: "PASS",
    isc_verified: null,
    isc_total: null,
    concerns: [],
    transcript_snippet: null,
    expected_reasoning:
      "PASS with zero concerns and no ISC tracking data is a weak but not unjustified verdict. This is an early-era item that pre-dates ISC tracking. The absence of negative evidence is weak positive evidence in a pre-verification era.",
  },
  {
    id: "mlvvhk00-inbtri",
    item_title: "LucidTasks Inbox Triage — Autonomous Batch Processing",
    verdict: "PASS",
    isc_verified: null,
    isc_total: null,
    concerns: [],
    transcript_snippet: null,
    expected_reasoning:
      "PASS with zero concerns and no ISC data is weakly justified. Pre-AW-era item with no evidence of failure. Justified by absence of contradicting evidence, though thin.",
  },

  // ── Category D: PASS with full ISC + no concerns (clean verdicts) ─────────
  {
    id: "mlo1lrsy-hmvavd",
    item_title: "Kaya Mobile Gateway Phase 3: Always-On Server (Mac Mini)",
    verdict: "PASS",
    isc_verified: 1,
    isc_total: 1,
    concerns: [],
    transcript_snippet: null,
    expected_reasoning:
      "PASS is clearly justified: 1/1 ISC rows verified, zero concerns. Clean execution record.",
  },
  {
    id: "mlo1t7q7-cbbeyk",
    item_title: "Kaya Canvas Phase 3: Container Ecosystem",
    verdict: "PASS",
    isc_verified: 5,
    isc_total: 5,
    concerns: [],
    transcript_snippet: null,
    expected_reasoning:
      "PASS is justified: 5/5 ISC rows verified, no concerns. Full coverage with no negative signals.",
  },
  {
    id: "mlo22pcn-ic392p",
    item_title: "Real-Time Voice Phase 4: Integration & Polish",
    verdict: "PASS",
    isc_verified: 8,
    isc_total: 8,
    concerns: [],
    transcript_snippet: null,
    expected_reasoning:
      "PASS is clearly justified: 8/8 ISC rows verified, no concerns. Strong positive signal.",
  },

  // ── Category E: PASS with Tier-2/3 infra errors but full ISC (justified) ──
  {
    id: "mly4emgu-zsbd7a",
    item_title: "LinkedIn Data Integration — Tier 1",
    verdict: "PASS",
    isc_verified: 54,
    isc_total: 54,
    concerns: [
      "No terminology overlap between ISC descriptions and changed files — possible spec drift",
      "ISC describes state/persistence work but no StateManager usage detected in git diff",
      "Tier 2 inference returned unparseable result (error: Claude Code cannot be launched inside another Claude Code session)",
      "Tier 3 deep review returned unparseable result (same error)",
    ],
    transcript_snippet: null,
    expected_reasoning:
      "PASS is justified despite Tier-2/3 failures: 54/54 ISC rows verified at Tier-1. The infra errors (nested-session crash) are a system constraint, not evidence of implementation failure. StateManager concern is a false-positive pattern heuristic. Full ISC coverage is strong evidence.",
  },
  {
    id: "mlyik3jo-psw4wv",
    item_title: "Canvas Tier 1: Fix What's Broken",
    verdict: "PASS",
    isc_verified: 12,
    isc_total: 12,
    concerns: [
      "ISC describes state/persistence work but no StateManager usage detected in git diff — may use raw JSON.parse",
      "Tier 2 inference returned unparseable result (error: Timeout after 15000ms)",
      "Tier 1 StateManager concern is a false positive — Canvas spec does not require StateManager usage",
      "Tier 2 inference timed out — no inference-layer validation available",
      "Adversarial agent: REGISTRY_COMPONENTS expanded to 13 types, ISC #5 requires 14; concern marked RESOLVED",
      "ISC #10 and #11 (browser rendering) marked 'runtime' — difficult to verify without live browser",
      "Execution log shows no entries ('no logs') — reduces traceability",
    ],
    transcript_snippet: null,
    expected_reasoning:
      "PASS is marginally justified: 12/12 ISC rows verified, StateManager concern is explicitly debunked, Tier-2 is an infra failure. Residual concern: ISC #10/11 runtime items and absent execution logs. Evidence balance tips toward justified given full ISC coverage and self-debunking.",
  },
  {
    id: "mlzhs5up-ypvqtq",
    item_title: "mcp-toolkit-server: Sampling, Elicitation, Real Providers, Publish",
    verdict: "PASS",
    isc_verified: 12,
    isc_total: 12,
    concerns: [
      "Budget $0.00 suggests paper completion but git diff shows 8217 insertions across 14 files",
      "ISC describes HTTP/API work but no CachedHTTPClient detected in git diff",
      "ISC describes state/persistence work but no StateManager detected in git diff",
      "Tier 2 inference returned unparseable result (error: Timeout after 60000ms)",
      "npm publish (ISC #4592) cannot be verified from git diff alone",
      "CachedHTTPClient concern is NOT applicable — this is an MCP server project",
      "StateManager concern is NOT applicable — MCP server spec does not require it",
      "Budget $0.00 with 8217 insertions is a bookkeeping gap from parallel/prior session",
      "Tier 2 timed out — no inference-layer validation of implementation semantics available",
    ],
    transcript_snippet: null,
    expected_reasoning:
      "PASS is justified: 12/12 ISC verified, false-positive concerns (CachedHTTPClient, StateManager) explicitly debunked, budget gap explained. Residual concern: npm publish unverifiable. Overall evidence supports PASS.",
  },

  // ── Category F: PASS with 'unaddressed' concerns that are self-debunked ────
  {
    id: "mlyhveq9-u8jf45",
    item_title: "Kaya: Research COBRA filing requirements and steps",
    verdict: "PASS",
    isc_verified: 11,
    isc_total: 11,
    concerns: [
      "Partial spec alignment: 8/16 requirements unaddressed",
      "No file changes detected in git diff — Phase 2 will evaluate contextually",
      "No git diff changes — file created at ~/Desktop/cobra-guide.md (outside git tracking), expected per spec",
      "Phase 1 flags '8/16 requirements unaddressed' — FALSE POSITIVE: checker confused spec verification grep commands with separate unaddressed requirements",
      "Phase 1 flags 'no test files in git diff' — FALSE POSITIVE for a documentation task",
      "Execution log entries lack explicit commandRan=true markers — trust level MEDIUM",
      "Cal-COBRA determination and CA Insurance Code reference cannot be confirmed without reading the file",
    ],
    transcript_snippet: null,
    expected_reasoning:
      "PASS is marginally justified: 11/11 ISC verified, the 8/16 unaddressed concern is explicitly labeled a false positive (grep commands misidentified as requirements). Output file is outside git tracking as expected. Residual trust concern due to absent commandRan markers. Justified on balance.",
  },
  {
    id: "mn3q0a01-path-a",
    item_title: "Path A: Fix ContextManager Configuration",
    verdict: "PASS",
    isc_verified: 1,
    isc_total: 1,
    concerns: [
      "Low spec alignment: 3/3 requirements unaddressed",
      "Unaddressed: Stage B inference timeout → general fallback",
      "Unaddressed: general profile budget mismatch",
      "Unaddressed: Empty filesLoaded for general sessions",
      "Template override despite explicit spec: 1/1 ISC rows are INFERRED",
      "Phase 1 'unaddressed requirements' are false positives — checker matched against description text rather than actual ISC spec criteria",
      "ISC-5 (development.tokenBudget==1800) may fail verify command since profile lacks tokenBudget field",
      "ISC-7/8/9 (runtime behavioral checks) were not executed",
    ],
    transcript_snippet: null,
    expected_reasoning:
      "PASS verdict is questionable: the 3/3 'unaddressed requirements' concern is self-debunked as a false positive, but ISC-7/8/9 runtime checks were not executed, ISC row is INFERRED not spec-derived, and only 1 ISC row for 3 spec requirements is thin. Evidence is marginal; justified only by the self-debunking of the primary concern.",
  },
  {
    id: "mn3q0a02-path-b",
    item_title: "Path B: Live Graph Query Tool",
    verdict: "PASS",
    isc_verified: 1,
    isc_total: 1,
    concerns: [
      "Low spec alignment: 5/5 requirements unaddressed",
      "Unaddressed: never block the user's prompt from being answered",
      "Unaddressed: exist before implementation",
      "Unaddressed: complete in under 5s",
      "Requirement coverage too low: 1 ISC rows for 5 spec requirements (20%)",
      "Template override despite explicit spec: 1/1 ISC rows are INFERRED",
      "Phase 1 'unaddressed requirements' flags are FALSE POSITIVES from text-matching heuristics; code clearly implements all spec requirements",
      "ISC-4 performance claim (180ms) from execution log (low trust)",
      "Test file has 56 tests but test content not directly verified against all 11 ISC criteria",
    ],
    transcript_snippet: null,
    expected_reasoning:
      "PASS verdict is questionable: 1 INFERRED ISC row for 11 explicit spec criteria is thin tracking. The 5/5 'unaddressed' concern is debunked, but ISC coverage (1/1 template row) doesn't map well to actual spec depth. Justified only because all 'unaddressed' items are explicitly debunked.",
  },

  // ── Category G: PASS with some unjustified-leaning signals ───────────────
  {
    id: "mm78fws5-6gghfb",
    item_title: "Skill Categorization: Consolidate 54 Skills into 11 Categories",
    verdict: "PASS",
    isc_verified: 10,
    isc_total: 10,
    concerns: [
      "Low spec alignment: 1/1 requirements unaddressed",
      "Unaddressed: \"**Intelligence**\"",
      "Low code density: 698 insertions across 3326 files (0.2 lines/file avg) — possible skeleton/stub implementation",
      "Automation/SKILL.md sub-skills table references 'Automation/ContextManager/SKILL.md' but ContextManager was kept at flat path — documentation inconsistency",
      "ISC-5/ISC-6/ISC-7 hook import integrity not directly verified via commandRan=true verification commands",
    ],
    transcript_snippet: null,
    expected_reasoning:
      "PASS verdict is marginally justified: 10/10 ISC rows verified. The '1/1 unaddressed requirement' (Intelligence category) is concerning but ISC coverage is full. 3326-file change is consistent with a skill reorganization. No debunking for the 'Intelligence' gap means a real concern remains, but ISC coverage overrides.",
  },
  {
    id: "mn8s-81c4b6c7f1f7",
    item_title: "SkillAudit Simulation Integration",
    verdict: "PASS",
    isc_verified: 8,
    isc_total: 8,
    concerns: [
      "Low spec alignment: 3/4 requirements unaddressed",
      "Unaddressed: produce identical markdown output to the pre-integration baseline",
      "Unaddressed: not change any existing exported values — append-only",
      "Unaddressed: equal or exceed its pre-integration score",
      "Test files exist in diff but Verifier did not execute them — testExecutionResults missing",
      "Phase 1 flagged 3 unaddressed requirements — these appear to be from P2 spec sections not captured in ISC",
      "Test execution results self-reported (62 pass) — no commandRan=true verification",
      "ComprehensiveAudit.md shows only 11 lines changed — sufficient for replacing one aspirational step with a concrete command",
    ],
    transcript_snippet: null,
    expected_reasoning:
      "PASS is marginally justified: 8/8 ISC verified. The 3/4 'unaddressed' items are partially debunked (P2 out-of-scope), but test execution is self-reported only (no commandRan). Residual concern: 3 regression requirements not directly verified. Thin but justified by ISC coverage + debunking of P2 scope.",
  },
  {
    id: "mlzqq69c-tvsdmp",
    item_title: "JobEngine v2.0.0 — Unified Job Engine (Scan + Auto-Apply)",
    verdict: "PASS",
    isc_verified: 0,
    isc_total: 28,
    concerns: [
      "Pre-dates AutonomousWork verification fixes; verified manually",
    ],
    transcript_snippet: null,
    expected_reasoning:
      "PASS with 0/28 ISC verified is technically very low coverage. However, the single concern explicitly states this pre-dates AW verification fixes and was manually verified. Without evidence contradicting that, the manual-verify explanation makes the verdict justified for its era.",
  },

  // ── Category H: PASS with concerns about infra + self-reported evidence ────
  {
    id: "mly0xk7b-28ksr2",
    item_title: "Agent Infrastructure Optimization",
    verdict: "PASS",
    isc_verified: null,
    isc_total: null,
    concerns: [
      "SkepticalVerifier spec alignment overcounted: found 44 requirements but actual ISC count is 16",
      "All 16 ISC verification commands pass independently",
      "Adversarial Explore agent confirmed 10/16 ISC pass, 2 critical gaps (hook registration) were fixed by orchestrator",
      "Tier 2/3 inference returned unparseable results (inference infrastructure issue)",
      "Forced completion after independent verification confirmed work",
    ],
    transcript_snippet: null,
    expected_reasoning:
      "PASS is justified: 16 ISC commands passed independently, adversarial agent confirmed 10/16 + orchestrator fixed the 2 gaps. Tier-2/3 infra failure doesn't override positive Tier-1 + adversarial confirmation. 'Forced completion' language is notable but the preceding evidence is solid.",
  },
  {
    id: "mlzhr0i4-q5p2ir",
    item_title: "llm-eval-framework: Real Evaluations, Real LLM Judge, Proper Types",
    verdict: "PASS",
    isc_verified: 10,
    isc_total: 10,
    concerns: [
      "2 testing row(s) marked complete but no test files in git diff",
      "ISC describes HTTP/API work but CachedHTTPClient not found — may use raw fetch()",
      "Row #5148 (mypy --strict): No execution logs to confirm mypy --strict exits 0",
      "Row #7600 (>85% coverage): No pytest --cov execution log — 5 large test files added but actual coverage not confirmed",
      "Phase 1 concern 'no test files in git diff' is a FALSE POSITIVE — git diff clearly shows 5 test files added",
      "Phase 1 CachedHTTPClient concern is a FALSE POSITIVE — Python project using httpx directly",
      "Row #7320 (real API calls): implementation looks correct but no integration test run",
      "data/adversarial/adversarial_prompts.jsonl has 30 lines — implies 20+ entries",
    ],
    transcript_snippet: null,
    expected_reasoning:
      "PASS is justified: 10/10 ISC verified, false positives debunked (test files, CachedHTTPClient). Residual gaps: mypy --strict and pytest --cov not confirmed via execution log. Evidence leans positive given full ISC + debunking; residual concerns are execution-log gaps, not implementation gaps.",
  },
  {
    id: "mncfawp3-kchibj",
    item_title: "Skill: Automation/AutonomousWork — architecture refactor",
    verdict: "PASS",
    isc_verified: 19,
    isc_total: 20,
    concerns: [],
    transcript_snippet: null,
    expected_reasoning:
      "PASS is clearly justified: 19/20 ISC rows verified with no concerns. One unverified ISC row in 20 is acceptable variance with no negative signals.",
  },
  {
    id: "mncfacj3-tgczuc",
    item_title: "Skill: Productivity/CalendarAssistant — architecture review + security fix",
    verdict: "PASS",
    isc_verified: 9,
    isc_total: 9,
    concerns: [
      "Partial spec alignment: 4/7 requirements unaddressed",
      "Unaddressed: be comprehensive-by-default, not allowlist-by-default",
      "Unaddressed: consciously decide if they're safe enough to add to SAFE_KEYS",
      "Phase 1 flagged items are FALSE POSITIVES — execution log shows SAFE_KEYS opt-out semantics satisfy the stated problem",
      "ISC rows #606 and #607 are design discussion questions not actionable bugs; marked VERIFIED which is slightly odd",
      "Spec section was truncated so full PII masking requirements cannot be confirmed",
    ],
    transcript_snippet: null,
    expected_reasoning:
      "PASS is marginally justified: 9/9 ISC verified, false-positive debunking for 'unaddressed' items is present. Spec truncation and ISC-row type mismatch are minor. Evidence balance tips justified given ISC coverage + debunking.",
  },

  // ── Category I: SYNTHETIC adversarial — clear UNJUSTIFIED PASS ────────────
  // Hand-authored (source: synthetic-adversarial), NOT from work-queue. The real
  // queue is heavily PASS-skewed and its concerns are mostly debunked false-positives,
  // so the golden lacked a clean "verifier over-passed" exemplar to exercise the
  // unjustified-detection direction the eval exists to catch. This is that exemplar:
  // mandatory gaps with NO debunking + near-zero ISC + no tests.
  {
    id: "synthetic-unjustified-pass-01",
    item_title: "Synthetic adversarial: PASS with undebunked mandatory gaps",
    verdict: "PASS",
    isc_verified: 1,
    isc_total: 9,
    concerns: [
      "Low spec alignment: 5/5 mandatory requirements unaddressed",
      "Unaddressed: OAuth login flow not implemented (no auth code in git diff)",
      "Unaddressed: database schema migration missing",
      "Unaddressed: rate-limiting middleware absent",
      "Only 1/9 ISC rows verified — 8 rows have no verification evidence or explanation",
      "No test files in git diff for any of the 5 core features",
    ],
    transcript_snippet: null,
    expected_reasoning:
      "PASS is UNJUSTIFIED: 5/5 mandatory requirements are flagged unaddressed with NO debunking, only 1/9 ISC rows verified with no explanation for the 8-row gap, and zero tests for the core features. Unlike the justified-PASS cases, none of these concerns are debunked as false positives — the evidence directly contradicts a PASS verdict. This is the canonical 'verifier over-passed' case the eval exists to catch.",
  },
];

// ── Phase-L cases (from live-verification/ snapshots) ────────────────────────
// 7 Phase-L cases covering the unique items in live-verification/
// (mnt5gb50-th7itl has 7 runs; we pick a FAIL + the final PASS)

interface PhaseL_Case {
  id: string;
  snapshot_file: string;
  item_id: string;
  verdict: "PASS" | "FAIL" | null;
  scenario_summary: string;
  fail_scenarios: string[];
  pass_scenarios_count: number;
  total_scenarios_count: number;
  expected_reasoning: string;
}

const PHASE_L_CASES: PhaseL_Case[] = [
  {
    id: "phase-l-mnt5gb50-early-fail",
    snapshot_file:
      "MEMORY/AutonomousWork/live-verification/mnt5gb50-th7itl/run-1781205150817.json",
    item_id: "mnt5gb50-th7itl",
    verdict: "FAIL",
    scenario_summary:
      "12 scenarios: ISC 1-7 (budget gate, notifications, heartbeat, stall detection, backup rotation/recovery, wall-clock caps) all passed. 3 FAILs: ISC-8 live-CLI stdio workaround removed, ISC-3 heartbeat breaks 2 CompletionPipeline snapshot tests, ISC-16 zero-cast invariant violated (Record<string,unknown> cast at WorkOrchestrator.ts:1252).",
    fail_scenarios: [
      "s10: FAIL — Bun stdio: 'pipe' workaround removed in last commit, spawnSync without explicit stdio doesn't capture stderr",
      "s11: FAIL — 51 pass 2 fail — pipeline.run() stamps lastEventAt into metadata, breaking snapshot equality checks",
      "s12: FAIL — ISC-16: WorkItemMetadata has ≥15 typed named fields violated — cast at WorkOrchestrator.ts:1252 confirmed in git diff",
    ],
    pass_scenarios_count: 9,
    total_scenarios_count: 12,
    expected_reasoning:
      "FAIL is justified: 3 concrete test failures with specific file-line evidence (stdio workaround removed, snapshot equality broken, zero-cast invariant violated at specific line). ISC-8, ISC-3, ISC-16 are confirmed failures, not false positives.",
  },
  {
    id: "phase-l-mnt5gb50-final-pass",
    snapshot_file:
      "MEMORY/AutonomousWork/live-verification/mnt5gb50-th7itl/run-1781210954973.json",
    item_id: "mnt5gb50-th7itl",
    verdict: "PASS",
    scenario_summary:
      "12 scenarios all PASS: ISC 1-4 (budget gate, wall-clock cap, heartbeat, stall detection) and ISC 5-7 (backup rotation, corrupt-primary recovery, unrecoverable error) verified. All 28 testwriter tests pass and all 12 manual scenarios pass.",
    fail_scenarios: [],
    pass_scenarios_count: 12,
    total_scenarios_count: 12,
    expected_reasoning:
      "PASS is clearly justified: all 12 scenarios pass including the previously-failing ISC-8 (stdio fix confirmed), ISC-3 (heartbeat snapshot tests fixed), and ISC-16 (zero-cast invariant restored). Represents successful resolution of prior FAIL.",
  },
  {
    id: "phase-l-mq4rx6k1-fail",
    snapshot_file:
      "MEMORY/AutonomousWork/live-verification/mq4rx6k1-pz84n8/run-1781195605537.json",
    item_id: "mq4rx6k1-pz84n8",
    verdict: "FAIL",
    scenario_summary:
      "6 scenarios. 5 PASS: test suite (38 pass), report file exists, internal references resolve, key official URLs return 200, CDN-blocked URLs return 403 (expected). 1 FAIL: EU immigration portal URL (immigration-portal.ec.europa.eu/eu-blue-card/spain_en) returns ECONNREFUSED — CloudFront distribution defunct.",
    fail_scenarios: [
      "ss6: FAIL — EU immigration portal URL returns ECONNREFUSED; CNAME resolves to defunct CloudFront distribution (no A record)",
    ],
    pass_scenarios_count: 5,
    total_scenarios_count: 6,
    expected_reasoning:
      "FAIL is justified: the EU immigration portal URL is a broken external link — a concrete, verified failure with DNS/HTTP evidence. However, this is a borderline case: the failure is a defunct third-party URL (beyond the agent's control) not an implementation gap. The FAIL is technically accurate but arguably overly strict for a research task.",
  },
  {
    id: "phase-l-mq4rx6k1-pass",
    snapshot_file:
      "MEMORY/AutonomousWork/live-verification/mq4rx6k1-pz84n8/run-1781197156095.json",
    item_id: "mq4rx6k1-pz84n8",
    verdict: "PASS",
    scenario_summary:
      "Subsequent run after URL link issue was addressed. All scenarios pass.",
    fail_scenarios: [],
    pass_scenarios_count: 6,
    total_scenarios_count: 6,
    expected_reasoning:
      "PASS is justified: subsequent run with all scenarios passing. The previous FAIL (defunct EU portal URL) was resolved.",
  },
  {
    id: "phase-l-mq4kdqs0-pass",
    snapshot_file:
      "MEMORY/AutonomousWork/live-verification/mq4kdqs0-q0h0ew/run-1781200428660.json",
    item_id: "mq4kdqs0-q0h0ew",
    verdict: "PASS",
    scenario_summary:
      "All scenarios pass. Work item verification with full scenario coverage.",
    fail_scenarios: [],
    pass_scenarios_count: -1, // unknown, all pass
    total_scenarios_count: -1,
    expected_reasoning:
      "PASS is justified: all scenarios pass with no failure evidence.",
  },
  {
    id: "phase-l-mq4rx6gg-pass",
    snapshot_file:
      "MEMORY/AutonomousWork/live-verification/mq4rx6gg-9rwqvj/run-1781195869080.json",
    item_id: "mq4rx6gg-9rwqvj",
    verdict: "PASS",
    scenario_summary: "All scenarios pass.",
    fail_scenarios: [],
    pass_scenarios_count: -1,
    total_scenarios_count: -1,
    expected_reasoning:
      "PASS is justified: all scenarios pass with no failure evidence.",
  },
  {
    id: "phase-l-live-smoke-fail",
    snapshot_file:
      "MEMORY/AutonomousWork/live-verification/live-smoke/selfverify-1781579700555.json",
    item_id: "live-smoke",
    verdict: "FAIL",
    scenario_summary:
      "2 scenarios: ssv1 PASS (bun run ok.ts succeeds), ssv2 FAIL (bun run bad.ts — artifact crashed). This is a smoke test where one scenario is DESIGNED to fail.",
    fail_scenarios: [
      "ssv2: FAIL — bun run bad.ts: artifact crashed (intentional negative test case)",
    ],
    pass_scenarios_count: 1,
    total_scenarios_count: 2,
    expected_reasoning:
      "FAIL is technically accurate (one scenario failed) but this is a smoke test with an intentional failure scenario (bad.ts). The FAIL verdict is justified by the scenario evidence, but the context (smoke test design) makes the overall assessment nuanced — the system is working correctly.",
  },
];

// ── Types ─────────────────────────────────────────────────────────────────────

interface VerifierCase {
  id: string;
  item_title: string;
  verdict: "PASS" | "FAIL" | "PASS_MANUAL";
  isc_verified: number | null;
  isc_total: number | null;
  concerns: string[];
  transcript_snippet: string | null;
  expected_reasoning: string;
}

interface GoldenEntry {
  id: string;
  type: "verifier" | "phase-l";
  item_id?: string;
  snapshot_file?: string;
  item_title?: string;
  verdict: string;
  isc_verified?: number | null;
  isc_total?: number | null;
  concerns?: string[];
  scenario_verdict_summary?: string;
  justified: string | null;
  divergent?: boolean;
  votes?: Record<string, number>;
  source: string;
  expected_reasoning: string;
  labeled_at: string;
  criteria_version: number;
}

// ── Evidence serializer ───────────────────────────────────────────────────────

function serializeVerifierEvidence(c: VerifierCase): string {
  const lines = [
    `WORK ITEM: ${c.item_title}`,
    `VERDICT: ${c.verdict}`,
    `ISC COVERAGE: ${c.isc_verified ?? "N/A"}/${c.isc_total ?? "N/A"}`,
    "",
    "CONCERNS:",
    ...(c.concerns.length > 0
      ? c.concerns.map((cx) => `  - ${cx}`)
      : ["  (none)"]),
    "",
    c.transcript_snippet
      ? `TRANSCRIPT SNIPPET: ${c.transcript_snippet}`
      : "TRANSCRIPT: not available",
    "",
    `QUESTION: Given this evidence, was the verdict ${c.verdict} JUSTIFIED?`,
    `Return exactly: {"justified": "justified"} or {"justified": "unjustified"}`,
  ];
  return lines.join("\n");
}

function serializePhaseLEvidence(c: PhaseL_Case): string {
  const lines = [
    `PHASE-L LIVE VERIFICATION`,
    `ITEM ID: ${c.item_id}`,
    `VERDICT: ${c.verdict}`,
    `SCENARIOS: ${c.pass_scenarios_count >= 0 ? c.pass_scenarios_count : "all"} passed, ${c.fail_scenarios.length} failed, total ${c.total_scenarios_count >= 0 ? c.total_scenarios_count : "unknown"}`,
    "",
    "SCENARIO SUMMARY:",
    c.scenario_summary,
    "",
    ...(c.fail_scenarios.length > 0
      ? ["FAILING SCENARIOS:", ...c.fail_scenarios.map((s) => `  ${s}`), ""]
      : ["(no failing scenarios)", ""]),
    `QUESTION: Given this live-verification evidence, was the verdict ${c.verdict} JUSTIFIED?`,
    `Return exactly: {"justified": "justified"} or {"justified": "unjustified"}`,
  ];
  return lines.join("\n");
}

// ── Ensemble labeling ─────────────────────────────────────────────────────────

async function ensembleLabel(
  input: string,
  itemId: string,
): Promise<{ label: string | null; divergent: boolean; votes: Record<string, number> }> {
  const levels = ["fast", "standard", "smart"] as const;

  const results = await Promise.all(
    levels.map((level) =>
      inference({
        systemPrompt: VERIFIER_ACCURACY_SYSTEM_PROMPT,
        userPrompt: input,
        level,
        expectJson: true,
        retries: 2,
      }),
    ),
  );

  const votes: Record<string, number> = {};
  let abstentions = 0;

  for (const r of results) {
    if (!r.success || !r.parsed) {
      abstentions++;
      continue;
    }
    const label = (r.parsed as Record<string, unknown>)[CANDIDATE_FIELD];
    if (typeof label === "string" && VALID_JUSTIFICATIONS.has(label)) {
      votes[label] = (votes[label] ?? 0) + 1;
    } else {
      abstentions++;
    }
  }

  const voterCount = levels.length - abstentions;
  if (voterCount === 0) {
    return { label: null, divergent: true, votes };
  }

  const topLabel = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
  const hasConsensus = topLabel[1] * 2 > voterCount;

  if (!hasConsensus) {
    console.log(`  ⚠ DIVERGENT: ${JSON.stringify(votes)}`);
    return { label: null, divergent: true, votes };
  }

  return { label: topLabel[0], divergent: false, votes };
}

// ── Curated-label preservation (reproducibility) ──────────────────────────────

interface CuratedLabel {
  justified: string | null;
  divergent: boolean;
  votes?: Record<string, number>;
  source: string;
}

/** Load the already-committed golden as id → curated label, if it exists. */
function loadExistingGolden(): Map<string, CuratedLabel> {
  const map = new Map<string, CuratedLabel>();
  if (!existsSync(OUTPUT_PATH)) return map;
  try {
    const lines = readFileSync(OUTPUT_PATH, "utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const e = JSON.parse(line) as GoldenEntry;
        if (e.id) {
          map.set(e.id, {
            justified: e.justified,
            divergent: e.divergent ?? false,
            votes: e.votes,
            source: e.source ?? "ensemble",
          });
        }
      } catch {
        // skip malformed line
      }
    }
  } catch {
    // unreadable — treat as no existing golden
  }
  return map;
}

/**
 * Resolve a case's label. Default: PRESERVE the curated label if one exists
 * (the committed golden is authoritative — prevents silent ensemble regression).
 * --force-relabel always re-derives from the ensemble; --drift-check re-derives
 * to report disagreements but keeps the curated label.
 */
async function resolveLabel(
  id: string,
  evidence: string,
  existing: Map<string, CuratedLabel>,
): Promise<{ label: string | null; divergent: boolean; votes: Record<string, number>; source: string }> {
  const pinned = existing.get(id);

  // Fast path: preserve curated label, no inference spent.
  if (pinned && !forceRelabel && !driftCheck) {
    return { label: pinned.justified, divergent: pinned.divergent, votes: pinned.votes ?? {}, source: pinned.source };
  }

  const { label, divergent, votes } = await ensembleLabel(evidence, id);

  // Drift-check: surface ensemble disagreement but keep the curated label.
  if (pinned && driftCheck) {
    const ensembleResult = divergent ? "DIVERGENT" : label;
    if (pinned.justified !== label || (pinned.divergent !== divergent)) {
      console.warn(`  ⚠ DRIFT: ${id} ensemble=${ensembleResult} but curated=${pinned.justified}${pinned.divergent ? " (divergent)" : ""} — keeping curated`);
    }
    return { label: pinned.justified, divergent: pinned.divergent, votes, source: pinned.source };
  }

  // Fresh case or --force-relabel: use the ensemble result.
  return { label, divergent, votes, source: "ensemble" };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Verifier Accuracy Golden Labeler ===");
  console.log(`Mode: ${isDryRun ? "DRY RUN" : isLiveOnly ? "PHASE-L ONLY" : "FULL RUN"}`);
  const existing = loadExistingGolden();
  const labelMode = forceRelabel
    ? "FORCE-RELABEL (overwrite all from ensemble)"
    : driftCheck
      ? "DRIFT-CHECK (ensemble vs curated, keep curated)"
      : `PRESERVE curated labels (${existing.size} found; pass --force-relabel to regenerate)`;
  console.log(`Label policy: ${labelMode}`);
  console.log(
    `Cases: ${isLiveOnly ? 0 : VERIFIER_CASES.length} verifier + ${PHASE_L_CASES.length} Phase-L`,
  );
  console.log();

  const entries: GoldenEntry[] = [];
  const now = new Date().toISOString();

  // ── Verifier cases ────────────────────────────────────────────────────────
  if (!isLiveOnly) {
    console.log(`Processing ${VERIFIER_CASES.length} verifier cases...`);
    for (const c of VERIFIER_CASES) {
      const evidence = serializeVerifierEvidence(c);
      console.log(`  [${c.id}] ${c.item_title.slice(0, 50)}...`);

      if (isDryRun) {
        console.log("    (dry-run, skipping LLM)");
        entries.push({
          id: c.id,
          type: "verifier",
          item_title: c.item_title,
          verdict: c.verdict,
          isc_verified: c.isc_verified,
          isc_total: c.isc_total,
          concerns: c.concerns,
          justified: "DRY_RUN",
          source: "dry-run",
          expected_reasoning: c.expected_reasoning,
          labeled_at: now,
          criteria_version: CRITERIA_VERSION,
        });
        continue;
      }

      const { label, divergent, votes, source } = await resolveLabel(c.id, evidence, existing);
      console.log(
        `    → ${divergent ? "DIVERGENT" : label} [${source}] (votes: ${JSON.stringify(votes)})`,
      );

      const entry: GoldenEntry = {
        id: c.id,
        type: "verifier",
        item_title: c.item_title,
        verdict: c.verdict,
        isc_verified: c.isc_verified,
        isc_total: c.isc_total,
        concerns: c.concerns,
        justified: label,
        source,
        expected_reasoning: c.expected_reasoning,
        labeled_at: now,
        criteria_version: CRITERIA_VERSION,
      };

      if (divergent) {
        entry.divergent = true;
        entry.votes = votes;
      }

      entries.push(entry);
    }
  }

  // ── Phase-L cases ─────────────────────────────────────────────────────────
  console.log(`\nProcessing ${PHASE_L_CASES.length} Phase-L cases...`);
  for (const c of PHASE_L_CASES) {
    const evidence = serializePhaseLEvidence(c);
    console.log(`  [${c.id}]`);

    if (isDryRun) {
      entries.push({
        id: c.id,
        type: "phase-l",
        item_id: c.item_id,
        snapshot_file: c.snapshot_file,
        verdict: c.verdict ?? "null",
        scenario_verdict_summary: c.scenario_summary,
        justified: "DRY_RUN",
        source: "dry-run",
        expected_reasoning: c.expected_reasoning,
        labeled_at: now,
        criteria_version: CRITERIA_VERSION,
      });
      continue;
    }

    const { label, divergent, votes, source } = await resolveLabel(c.id, evidence, existing);
    console.log(`    → ${divergent ? "DIVERGENT" : label} [${source}] (votes: ${JSON.stringify(votes)})`);

    const entry: GoldenEntry = {
      id: c.id,
      type: "phase-l",
      item_id: c.item_id,
      snapshot_file: c.snapshot_file,
      verdict: c.verdict ?? "null",
      scenario_verdict_summary: c.scenario_summary,
      justified: label,
      source,
      expected_reasoning: c.expected_reasoning,
      labeled_at: now,
      criteria_version: CRITERIA_VERSION,
    };

    if (divergent) {
      entry.divergent = true;
      entry.votes = votes;
    }

    entries.push(entry);
  }

  // ── Write output ──────────────────────────────────────────────────────────
  if (!isDryRun) {
    mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
    const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    writeFileSync(OUTPUT_PATH, lines, "utf-8");
    console.log(`\nWrote ${entries.length} entries to ${OUTPUT_PATH}`);
  } else {
    console.log("\n(dry-run: output not written)");
  }

  // ── Distribution report ───────────────────────────────────────────────────
  const verifierEntries = entries.filter((e) => e.type === "verifier");
  const phaseLEntries = entries.filter((e) => e.type === "phase-l");

  const countJustified = (arr: GoldenEntry[]) =>
    arr.filter((e) => e.justified === "justified").length;
  const countUnjustified = (arr: GoldenEntry[]) =>
    arr.filter((e) => e.justified === "unjustified").length;
  const countDivergent = (arr: GoldenEntry[]) => arr.filter((e) => e.divergent).length;

  const verdictDist = entries.reduce(
    (acc, e) => {
      acc[e.verdict] = (acc[e.verdict] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  console.log("\n=== Distribution Report ===");
  console.log(`Total entries: ${entries.length}`);
  console.log(`  Verifier cases: ${verifierEntries.length}`);
  console.log(`    justified:   ${countJustified(verifierEntries)}`);
  console.log(`    unjustified: ${countUnjustified(verifierEntries)}`);
  console.log(`    divergent:   ${countDivergent(verifierEntries)}`);
  console.log(`  Phase-L cases: ${phaseLEntries.length}`);
  console.log(`    justified:   ${countJustified(phaseLEntries)}`);
  console.log(`    unjustified: ${countUnjustified(phaseLEntries)}`);
  console.log(`    divergent:   ${countDivergent(phaseLEntries)}`);
  console.log(`  Verdict mix: ${JSON.stringify(verdictDist)}`);
  console.log(
    `  Overall justified: ${countJustified(entries)} | unjustified: ${countUnjustified(entries)} | divergent: ${countDivergent(entries)}`,
  );
}

main().catch(console.error);
