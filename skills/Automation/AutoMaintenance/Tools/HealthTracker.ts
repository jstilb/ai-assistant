/**
 * HealthTracker — Issue persistence tracking and severity classification.
 *
 * Wraps the issuePersistence map from HealthManager with convenience methods
 * for recording, querying, and classifying issues by occurrence count.
 *
 * Severity thresholds:
 *   1 occurrence  → INFO
 *   3 occurrences → WARNING
 *   7 occurrences → CRITICAL
 */

import { createHash } from "crypto";
import {
  loadHealthState,
  saveHealthState,
  type IssueRecord,
  type IssueKey,
} from "./HealthManager";

export type { IssueRecord, IssueKey };

export interface RecordInput {
  lastSeen: string;
  type: string;
  finding: string;
  status: "monitoring" | "escalated" | "auto-resolved";
}

export interface ISCScoreEntry {
  date: string;
  pass: number;
  total: number;
}

/** True iff `token` is ENTIRELY a numeric shape — digits, optional
 *  thousands-commas, optional one decimal point — with no other characters
 *  at all (anchored both ends). Used by normalizeFindingText() to decide
 *  whether a whole alnum token is a "number" vs an identifier that merely
 *  contains digits.
 *
 *  Trailing `\.?` (D1 item 6): because the tokenizer below includes `.` in
 *  its character class, a number sitting at the end of a sentence — e.g.
 *  "...grew to 3,600." — gets tokenized as ONE run ("3,600.") including that
 *  trailing full stop. The interior `(?:\.\d+)?` group only matches a decimal
 *  point FOLLOWED BY digits, so a bare trailing period with nothing after it
 *  used to fail the whole-token test and leave the count un-normalized
 *  (defeating the occurrence-accumulation this function exists to enable).
 *  The added optional bare `\.?` accepts exactly that one trailing full stop
 *  — it does not open a second decimal group, so a genuinely different shape
 *  like "3.6.7" still fails to match in full (the anchored end can't line up
 *  after only one of its two dots is consumed). */
const PURE_NUMERIC_TOKEN = /^\d[\d,]*(?:\.\d+)?\.?$/;

/**
 * Strip variable numerics (counts, sizes, percentages, dates, timestamps)
 * from finding text before it's hashed into an issue key.
 *
 * WHY: generateIssueKey() previously hashed the RAW finding text, so e.g.
 * "3600 modified files" one day and "3550 modified files" the next minted
 * two DIFFERENT keys for what is obviously the same finding class (git_dirty
 * on the daily workflow) — occurrences never accumulated past 1, so the
 * 3x-WARNING/7x-CRITICAL escalation ladder (getSeverity() below) never fired
 * for anything whose finding text embeds a live number (disk %, file
 * counts, secret counts, byte sizes, dates).
 *
 * APPROACH: tokenize on maximal runs of `[A-Za-z0-9.,]` (a single character
 * class, greedy, no lookaround) so there is no backtracking — the token
 * boundary is always the same regardless of what's inside it. Each token is
 * then replaced with "<N>" only if the ENTIRE token matches
 * PURE_NUMERIC_TOKEN (digits/commas/one-decimal, anchored both ends);
 * anything else (including a token that MIXES letters and digits) is left
 * untouched verbatim.
 *
 * An earlier version used a single lookaround regex
 * (`/(?<![a-zA-Z])\d[\d,]*(?:\.\d+)?(?![a-zA-Z])/g`) intending the same
 * "don't touch identifiers" behavior, but greedy-with-backtracking digit
 * matching bounded by a lookahead is unsound: when the maximal digit run
 * fails the lookahead (next char is a letter), the engine backtracks to a
 * SHORTER digit run whose own immediate next character isn't a letter —
 * even though that shorter run is still the middle of one contiguous
 * alphanumeric identifier. E.g. "148792d2": the maximal run "148792" fails
 * (next char 'd' is a letter), so the engine backtracked to "14879" (next
 * char '2' — not a letter, lookahead passes) and replaced JUST that,
 * producing the corrupted "<N>2d2". The whole-token approach here can't
 * produce a partial match at all — a token is matched atomically, then
 * accepted/rejected as a whole — so this class of bug is structurally
 * impossible, not just less likely.
 *
 * Covers every numeric shape actually seen in this codebase's finding text:
 * plain counts ("3600" -> "<N>"), percentages ("87%" -> "<N>%" — '%' isn't
 * in the token class so it's a boundary, left as-is), comma-grouped counts
 * ("3,600" -> "<N>" — comma is inside the token class so it's part of the
 * SAME token as the digits), decimal sizes ("1.2 MB" -> "<N> MB" — "MB" is
 * its own token, all-letters, not pure-numeric, untouched), and ISO
 * dates/timestamps ("2026-07-20" -> "<N>-<N>-<N>", identically for any date
 * — '-' isn't in the token class so each digit group is its own token,
 * each independently collapsing to the same placeholder).
 *
 * Protects alphanumeric identifiers that happen to contain digits by
 * construction, not as a best-effort heuristic: "148792d2" (UUID fragment)
 * and "148792d2-1ecc-4bf0" (multiple hyphen-joined fragments) are each
 * single tokens that fail PURE_NUMERIC_TOKEN (they contain letters), so they
 * pass through completely unchanged. "512MB" (no space before the unit) is
 * ALSO one token (digits directly followed by letters, no boundary between
 * them) and is therefore also left unchanged — this is intentional: without
 * a space, "512MB" is indistinguishable from an identifier like "148792d2"
 * from this function's point of view, and leaving it untouched (rather than
 * guessing) is the correct, principled behavior, not a limitation.
 */
export function normalizeFindingText(finding: string): string {
  return finding.replace(/[A-Za-z0-9.,]+/g, (token) =>
    PURE_NUMERIC_TOKEN.test(token) ? "<N>" : token,
  );
}

export function generateIssueKey(workflow: string, step: string, finding: string): IssueKey {
  const hash = createHash("sha256").update(normalizeFindingText(finding)).digest("hex").substring(0, 8);
  return `${workflow}:${step}:${hash}`;
}

export class HealthTracker {
  private issues: Map<string, IssueRecord> = new Map();

  async load(): Promise<void> {
    const state = await loadHealthState();
    this.issues = new Map(Object.entries(state.issuePersistence ?? {}));
  }

  async save(): Promise<void> {
    const state = await loadHealthState();
    const issuePersistence: Record<string, IssueRecord> = {};
    for (const [key, record] of this.issues) {
      issuePersistence[key] = record;
    }
    await saveHealthState({ ...state, issuePersistence });
  }

  record(key: string, input: RecordInput): void {
    const existing = this.issues.get(key);
    if (existing) {
      this.issues.set(key, {
        ...existing,
        lastSeen: input.lastSeen,
        type: input.type,
        finding: input.finding,
        status: input.status,
        occurrences: existing.occurrences + 1,
      });
    } else {
      this.issues.set(key, {
        firstSeen: input.lastSeen,
        lastSeen: input.lastSeen,
        occurrences: 1,
        type: input.type,
        finding: input.finding,
        status: input.status,
      });
    }
  }

  get(key: string): IssueRecord | undefined {
    return this.issues.get(key);
  }

  getOccurrences(key: string): number {
    return this.issues.get(key)?.occurrences ?? 0;
  }

  getSeverity(key: string): "INFO" | "WARNING" | "CRITICAL" {
    const occurrences = this.getOccurrences(key);
    if (occurrences >= 7) return "CRITICAL";
    if (occurrences >= 3) return "WARNING";
    return "INFO";
  }

  markResolved(key: string): void {
    const record = this.issues.get(key);
    if (record) {
      this.issues.set(key, {
        ...record,
        status: "auto-resolved",
        resolvedAt: Date.now(),
      });
    }
  }

  /**
   * Auto-resolve issues from a completed scan — the alert lifecycle's third
   * leg (emit via record() -> accumulate via occurrences -> resolve here).
   * Before this, markResolved() had zero callers: a finding that stopped
   * recurring stayed "monitoring" forever instead of ever clearing.
   *
   * Scope: `workflow` matches the `${workflow}:` prefix generateIssueKey()
   * produces, so only issues belonging to THIS scan's tier are candidates —
   * a "weekly-security:..." issue is never touched by a "daily" scan.
   * `currentKeys` is every key this scan's findings (across all its steps)
   * mapped to via generateIssueKey(); a tracked key under this workflow that
   * is NOT in that set means the scan just ran and did not reproduce that
   * finding — i.e. it's fixed. Already `auto-resolved` keys are skipped
   * (idempotent — no repeated resolvedAt stamping on later clean scans).
   */
  resolveAbsent(workflow: string, currentKeys: ReadonlySet<string>): string[] {
    const resolved: string[] = [];
    const prefix = `${workflow}:`;
    for (const [key, record] of this.issues) {
      if (!key.startsWith(prefix)) continue;
      if (record.status === "auto-resolved") continue;
      if (currentKeys.has(key)) continue;
      this.markResolved(key);
      resolved.push(key);
    }
    return resolved;
  }

  calculateISCPassRate(scores: ISCScoreEntry[]): number {
    if (scores.length === 0) return 1;
    const totalPass = scores.reduce((sum, s) => sum + s.pass, 0);
    const totalTotal = scores.reduce((sum, s) => sum + s.total, 0);
    return totalTotal === 0 ? 1 : totalPass / totalTotal;
  }
}
