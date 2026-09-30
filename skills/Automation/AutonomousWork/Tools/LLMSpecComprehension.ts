/**
 * LLMSpecComprehension.ts — Phase 4a of the AutonomousWork lean-LLM refactor.
 *
 * Reads a spec's markdown and returns structured ISC data in ONE LLM call.
 * This module is the heart of the refactor: it replaces the regex-based
 * SpecParser (deleted in a later phase) with a single, well-prompted inference
 * call that understands the spec as a whole rather than pattern-matching fragments.
 *
 * KEY CORRECTNESS PROPERTIES (enforced via system prompt and validation):
 *   1. Verbatim extraction — verifyCommand is copied EXACTLY from the spec, never
 *      paraphrased, "fixed", or invented.
 *   2. No hallucination — if there is no shell command in the verify cell, the
 *      field is null. The LLM is explicitly forbidden from fabricating commands.
 *   3. Row fidelity — one spec ISC entry = one ComprehendedRow, in spec order.
 *      No splitting, merging, or inventing rows.
 *
 * WIRING: Not wired into prepare() yet — that is Phase 4c.
 */

import type { InferenceFn } from "./SkepticalVerifier.ts";
import type { ComprehendedSpec, ComprehendedRow, ComprehendedPhase } from "./Types.ts";
import { appendComprehensionFidelity } from "./ComprehensionFidelityLog.ts";

export type { ComprehendedSpec, ComprehendedRow, ComprehendedPhase };

// Maximum spec content length we pass to the LLM.
// Sonnet's context easily handles ~15K tokens; 60K chars ≈ 15K tokens leaves ample room.
// Full ISC section is always preserved; only preamble prose is truncated when over cap.
const SPEC_CONTENT_MAX_CHARS = 60_000;

// ============================================================================
// System Prompt
// ============================================================================

const SYSTEM_PROMPT = `You are a PRECISE SPEC PARSER. Your only job is to extract structured data from a software spec. You return ONLY a valid JSON object — no code fences, no markdown, no prose before or after. Any deviation from JSON makes the output unparseable and causes a system failure.

## OUTPUT SCHEMA

Return exactly this JSON shape:
{
  "rows": [
    {
      "id": <integer starting at 1>,
      "description": "<criterion text>",
      "verifyCommand": "<shell command>" | null,
      "humanRequired": <boolean>,
      "native": <boolean>,
      "invertExit": <boolean>,
      "category": "implementation" | "documentation" | "deployment" | "general",
      "testLevel": "unit" | "integration" | "e2e" | "manual"
    }
  ],
  "complexityHint": "trivial" | "standard" | "thorough",
  "phases": [
    { "number": <integer>, "name": "<phase name>", "rowIds": [<row id>, ...] }
  ]
}

## HARD RULES — VIOLATIONS CAUSE PRODUCTION FAILURES

### Rule 1: Row extraction fidelity (MOST CRITICAL)
Extract rows ONLY from the spec's Ideal State Criteria / ISC / Success Criteria / Acceptance Criteria section(s).
- Do NOT invent rows.
- Do NOT infer rows from prose outside ISC sections.
- Do NOT split one ISC entry into multiple rows.
- Do NOT merge multiple ISC entries into one row.
- Preserve the spec's own row order exactly.
- Assign sequential integer ids starting at 1.

### Rule 2: verifyCommand must be VERBATIM or null (MOST CRITICAL)
Copy the verification command EXACTLY as written in the spec — including exact file paths, flags, quotes, environment variables, and pipe characters.
- Do NOT paraphrase, normalize, shorten, rewrite, or "fix" the command.
- Do NOT expand shell aliases or substitute equivalent flags.
- If the verify cell contains prose description but no runnable shell command, set verifyCommand to null.
- NEVER fabricate a command that does not appear in the spec. A fabricated command is worse than null — it will execute wrong code on the production system.

### Rule 3: humanRequired
Set humanRequired to true ONLY for rows that INHERENTLY require a human:
- Secret/credential entry (passwords, API keys, tokens typed by hand)
- Account consent or OAuth login flow
- Physical action on a real device (tap, swipe, hardware button)
- Irreversible destructive operation that must be reviewed before execution
Set humanRequired to false for everything else, including automated tests, CLI commands, file checks, and web scraping.

### Rule 4: native
Set native to true if the criterion concerns a native mobile or desktop UI artifact that requires a real device or simulator to exercise (e.g. iOS/Android app, Electron app, macOS menu bar). Set native to false for web apps, CLI tools, server-side code, and browser automation.

### Rule 5: complexityHint
Choose the single most appropriate value:
- "trivial": tiny change, one-liner fix, cosmetic tweak
- "standard": normal feature, typical implementation
- "thorough": architectural change, multi-domain, large-scale refactor

### Rule 6: phases
If the spec has explicit phase headings (e.g. "Phase 1: ...", "Phase 2: ..."), list each phase with its name and the row ids whose ISC entries fall under that phase. If there are no explicit phase headings, return an empty array [].

### Rule 7: invertExit
Set invertExit to true ONLY when the criterion is satisfied by the verifyCommand exiting NON-ZERO — i.e. the row asserts the ABSENCE of something. Examples: "grep returns 0 matches", "the old symbol is removed / no longer present", "X does not exist", "the directory is empty". In those cases a normal command (like grep) exits non-zero on success, so the pass/fail must be inverted. Set invertExit to false (the default) for every ordinary criterion where exit 0 means success. When in doubt, choose false.

### Rule 8: category and testLevel
Classify each row with the most appropriate category and test level.

category — choose ONE:
- "implementation": the criterion is about code behavior, API contracts, data integrity, or system function (default for most rows)
- "documentation": the criterion concerns a README, changelog, JSDoc/TSDoc comment, wiki page, or other written artifact
- "deployment": the criterion concerns releasing, publishing, shipping, or migrating to a live environment
- "general": none of the above fit clearly

testLevel — choose ONE:
- "unit": the criterion can be verified by a single function/module test with no external services
- "integration": the criterion requires multiple components or an external service (DB, API, queue) to be running
- "e2e": the criterion requires a full browser, real device, or end-to-end workflow (UI flow, Playwright, real user journey)
- "manual": the criterion can only be verified by a human (account login, physical device, visual review, irreversible op)

Use the verifyCommand (if present) as the primary signal for testLevel: "bun test *.integration.test.*" → integration; "bun test *.test.*" → unit; "playwright" / browser → e2e. When no command is present, infer from the description.

### Rule 9: the ISC may be incomplete — do NOT fill gaps
The ISC section is the author's best expression of intent at the time of writing; it may not be exhaustive. If a requirement seems logically implied by adjacent rows but is NOT written explicitly in the ISC, do NOT create a row for it. Extract only what is explicitly stated. If you notice an apparent gap (e.g. "row 3 implies X but X has no row"), leave the gap as-is — do not invent a row to fill it. The cost of a fabricated row (running wrong verification, building unasked-for behavior) is always higher than the cost of an omission that a human can add later.

## REMEMBER
- Output ONLY the JSON object. No prose. No code fences (\`\`\`json). No commentary.
- verifyCommand: copy VERBATIM or set null. NEVER fabricate.
- One spec row = one output row. No splitting, no merging, no invention.
- invertExit: true only for ABSENCE checks (non-zero exit = success); otherwise false.
- category + testLevel: every row must have both fields.`;

// ============================================================================
// Validation helpers
// ============================================================================

function isValidRow(r: unknown): r is ComprehendedRow {
  if (!r || typeof r !== "object") return false;
  const row = r as Record<string, unknown>;
  return (
    typeof row["id"] === "number" &&
    typeof row["description"] === "string" &&
    (row["verifyCommand"] === null || typeof row["verifyCommand"] === "string") &&
    typeof row["humanRequired"] === "boolean" &&
    typeof row["native"] === "boolean"
  );
}

function isValidPhase(p: unknown): p is ComprehendedPhase {
  if (!p || typeof p !== "object") return false;
  const phase = p as Record<string, unknown>;
  return (
    typeof phase["number"] === "number" &&
    typeof phase["name"] === "string" &&
    Array.isArray(phase["rowIds"]) &&
    (phase["rowIds"] as unknown[]).every((id) => typeof id === "number")
  );
}

function coerceComplexityHint(
  raw: unknown
): "trivial" | "standard" | "thorough" {
  if (raw === "trivial" || raw === "standard" || raw === "thorough") return raw;
  return "standard";
}

/**
 * Validate and coerce the raw parsed object from the LLM into ComprehendedSpec.
 * Returns null if the structure is fundamentally invalid (missing rows array).
 * Coerces recoverable issues (missing phases, bad complexityHint).
 */
function coerceToComprehendedSpec(parsed: unknown): ComprehendedSpec | null {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;

  // rows is mandatory — without it we cannot produce a valid result
  if (!Array.isArray(obj["rows"])) return null;

  const rawRows = obj["rows"] as unknown[];
  const validRows = rawRows.filter(isValidRow);

  // If all rows are invalid, treat as fundamentally malformed
  if (rawRows.length > 0 && validRows.length === 0) return null;

  const rawPhases = Array.isArray(obj["phases"]) ? obj["phases"] : [];
  const validPhases = rawPhases.filter(isValidPhase);

  return {
    rows: validRows,
    complexityHint: coerceComplexityHint(obj["complexityHint"]),
    phases: validPhases,
  };
}

// ============================================================================
// Main export
// ============================================================================

export interface ComprehendSpecOpts {
  /** Injectable inference function — allows deterministic testing without hitting a real LLM. */
  inferenceFn?: InferenceFn;
  /** Inference level (default: "standard" — Sonnet). Use "smart" for large/complex specs. */
  level?: "fast" | "standard" | "smart";
  /**
   * Spec/item identifier. When set AND no inferenceFn is injected (i.e. a real
   * LLM call), the extraction summary is appended to comprehension-parity.jsonl
   * for the pipeline-evals Slice-4 ISC-extraction-fidelity monitor. Omitted in
   * tests (which inject inferenceFn), so unit runs never write the live source.
   */
  specId?: string;
}

/**
 * Comprehend a spec's markdown and return structured ISC data in one LLM call.
 *
 * @param specContent - Full markdown content of the spec file.
 * @param opts - Optional overrides for inference function and level.
 * @returns A ComprehendedSpec with verbatim-extracted rows, complexity hint, and phase map.
 * @throws Error if the LLM returns persistently invalid JSON after one retry.
 */
export async function comprehendSpec(
  specContent: string,
  opts: ComprehendSpecOpts = {}
): Promise<ComprehendedSpec> {
  const level = opts.level ?? "standard";

  // Lazy-load real inference only when no mock is injected.
  const inferenceFn: InferenceFn =
    opts.inferenceFn ??
    (await import("../../../../lib/core/Inference.ts")).inference;

  // Live-source emission gate: only a real LLM call (no injected mock) with a
  // known specId logs to the fidelity monitor. NON-FATAL — never breaks comprehension.
  const isLiveInference = opts.inferenceFn === undefined;
  const emitFidelity = (out: ComprehendedSpec): void => {
    if (!opts.specId || !isLiveInference) return;
    appendComprehensionFidelity({
      specId: opts.specId,
      rowCount: out.rows.length,
      rowDescriptions: out.rows.map((r) => r.description),
      complexityHint: out.complexityHint,
      truncated: out.truncated,
    });
  };

  // Guard length — truncate only leading prose; preserve ISC sections.
  // Truncation must NEVER be silent: callers receive `truncated: true` on the result,
  // and a loud console.warn fires so log-watchers can investigate.
  let contentForLLM = specContent;
  let wasContentTruncated = false;
  if (contentForLLM.length > SPEC_CONTENT_MAX_CHARS) {
    wasContentTruncated = true;
    console.warn(
      `[comprehendSpec] WARN: Spec content (${contentForLLM.length} chars) exceeds cap ` +
      `(${SPEC_CONTENT_MAX_CHARS} chars). Truncating — ISC rows may be incomplete if the ` +
      `criteria section extends beyond the cap. Investigate oversized specs.`
    );
    // Find the first ISC/Success Criteria heading and truncate before it
    const iscMarker = contentForLLM.search(
      /^#+\s*(ideal state criteria|isc|success criteria|acceptance criteria)/im
    );
    if (iscMarker > 0 && iscMarker < contentForLLM.length - 1000) {
      // Keep everything from the ISC heading onward, plus a short preamble
      const preamble = contentForLLM.slice(0, 200);
      const iscOnward = contentForLLM.slice(iscMarker);
      contentForLLM = preamble + "\n\n[...preamble truncated for length...]\n\n" + iscOnward;
    } else {
      contentForLLM = contentForLLM.slice(0, SPEC_CONTENT_MAX_CHARS) +
        "\n\n[...content truncated at " + SPEC_CONTENT_MAX_CHARS + " chars...]";
    }
  }

  const userPrompt = `Extract the ISC rows and metadata from this spec:\n\n${contentForLLM}`;

  // First attempt
  const result1 = await inferenceFn({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    level,
    expectJson: true,
    timeout: 180_000,
  });

  if (result1.success) {
    const coerced = coerceToComprehendedSpec(result1.parsed);
    // Treat 0-row result the same as invalid — retry.
    // A real software spec always has acceptance criteria; 0 rows means the LLM
    // failed to find them. Silent acceptance of an empty result is a false PASS.
    if (coerced !== null && coerced.rows.length > 0) {
      const out: ComprehendedSpec = { ...coerced };
      if (wasContentTruncated) out.truncated = true;
      emitFidelity(out);
      return out;
    }
  }

  // One retry on failure, invalid structure, or 0-row result
  const result2 = await inferenceFn({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    level,
    expectJson: true,
    timeout: 180_000,
  });

  if (result2.success) {
    const coerced = coerceToComprehendedSpec(result2.parsed);
    if (coerced !== null && coerced.rows.length > 0) {
      const out: ComprehendedSpec = { ...coerced };
      if (wasContentTruncated) out.truncated = true;
      emitFidelity(out);
      return out;
    }
  }

  // Both attempts failed, returned invalid structure, or returned 0 rows.
  // Distinguish persistent-empty (LLM found no criteria) from persistent-invalid (bad JSON).
  const attempt1Coerced = result1.success ? coerceToComprehendedSpec(result1.parsed) : null;
  const attempt2Coerced = result2.success ? coerceToComprehendedSpec(result2.parsed) : null;
  const persistentlyEmpty =
    (attempt1Coerced !== null && attempt1Coerced.rows.length === 0) &&
    (attempt2Coerced !== null && attempt2Coerced.rows.length === 0);

  if (persistentlyEmpty) {
    throw new Error(
      `comprehendSpec: LLM returned 0 ISC rows on both attempts. ` +
      `A real software spec always has acceptance criteria — 0 rows means the LLM ` +
      `failed to extract them. This would produce a false PASS with zero verification. ` +
      `prepare() must fail loud (EXECUTION_FAILED) — fix the spec or comprehension prompt; never silently complete.`
    );
  }

  const errDetail = result2.error ?? result1.error ?? "no error detail";
  throw new Error(
    `comprehendSpec: LLM returned persistently invalid JSON after retry. ` +
    `Last error: ${errDetail}. ` +
    `prepare() must fail loud (EXECUTION_FAILED) — fix the spec or comprehension prompt; never silently complete.`
  );
}
