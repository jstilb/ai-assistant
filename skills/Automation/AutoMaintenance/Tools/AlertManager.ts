#!/usr/bin/env bun
/**
 * AlertManager - Severity classification and escalation
 *
 * PURPOSE:
 * Classify findings by severity using HealthTracker persistence data.
 * Escalate CRITICAL findings via AlertGate (tier: 'page') immediately;
 * WARNING findings digest (tier: 'digest') — see ADR-004.
 * Maintain alerts.jsonl log with open/dismissed status.
 *
 * ESCALATION POLICY:
 * - Verified secrets: CRITICAL + immediate notification
 * - Unverified secrets (< 100): INFO
 * - Unverified secrets (>= 100): WARNING
 * - Privacy violations: WARNING (first occurrence)
 * - Scan errors (secret-scan itself failed to complete — result UNKNOWN, not
 *   clean, see SecurityAuditor.ts's E1 handleScanError): CRITICAL + immediate
 *   notification, same as a confirmed leak — must page on FIRST occurrence,
 *   not wait for the x3/x7 occurrence-based escalation below.
 * - Same finding x3: WARNING + notification
 * - Same finding x7: CRITICAL + daily re-alert
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { createHash, randomUUID } from 'crypto';
import { AlertGate, getAlertGate, type AlertTier } from '../../../../lib/core/AlertGate.ts';
import { HealthTracker, generateIssueKey } from './HealthTracker';
import { createAppendLog } from '../../../../lib/core/AppendLog';
import { defaultKayaHome, assertNotLiveDefaultUnderTest } from '../../../../lib/core/KayaHome.ts';

// homedir-only original (ignored KAYA_HOME env); defaultKayaHome() preserves real-home
const KAYA_HOME = defaultKayaHome();
const ALERTS_LOG = join(KAYA_HOME, 'MEMORY', 'AutoMaintenance', 'alerts.jsonl');

export interface Alert {
  id: string;
  /**
   * The issue-class key this row was written under (A3 — N1 alert-closure
   * program). Threaded through from evaluate()'s `generateIssueKey(...)`
   * call at write time — NEVER recomputed against a historical row read
   * back off disk. Recomputation is a locked design non-goal: 8 pre-
   * normalization legacy rows have issue keys that generateIssueKey() would
   * compute differently today, so re-deriving from stored (workflow, step,
   * finding) would silently produce the WRONG key for those rows. Rows
   * written before this field existed (or via writeAlert() with no key
   * threaded) simply have `issueKey: undefined` — readers must treat that
   * as "unknown", not attempt to backfill it.
   */
  issueKey?: string;
  timestamp: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  workflow: string;
  step: string;
  finding: string;
  firstSeen?: string;
  occurrences?: number;
  status: 'open' | 'dismissed' | 'auto-resolved';
  dismissedBy?: 'human' | 'system';
  dismissedAt?: string;
  verified?: boolean;
  count?: number;
}

export interface FindingInput {
  workflow: string;
  step: string;
  type: string;
  finding: string;
  verified?: boolean;
  count?: number;
}

export interface EvaluationResult {
  alerts: Alert[];
  notificationsFired: number;
  /** Issue keys auto-resolved this scan (see HealthTracker.resolveAbsent). */
  resolvedKeys: string[];
}

export interface AlertManagerOptions {
  /**
   * Override for the alerts.jsonl write/read path (tests only). When
   * omitted, resolves to the module-level ALERTS_LOG — a frozen real-home
   * path that deliberately ignores KAYA_HOME (see the module-level comment
   * above; this is the inline-KAYA_HOME burn-down exemption for this file,
   * NOT a bug) — with a hermetic-guard tripwire on every write. Mirrors
   * AlertGate's statePath/spoolPath override pattern (lib/core/AlertGate.ts).
   */
  alertsLogPath?: string;
  /**
   * Injectable AlertGate — tests pass a scratch-rooted instance with a
   * recording `send` fn (mirrors HealthManager.checkForGaps's `gate` DI, see
   * lib/core/AlertGate.ts). Default: getAlertGate(), the real singleton.
   * Replaces this file's previous direct notifySync() calls — per ADR-004
   * (docs/decisions/004-notification-traffic-through-alertgate.md), all
   * alert traffic routes through the gate so cooldown/dedup policy applies
   * uniformly instead of every sender inventing its own (or none).
   */
  gate?: AlertGate;
}

/**
 * Pure per-id reduction over alerts.jsonl's raw append-only rows (A3 — N1
 * alert-closure program).
 *
 * alerts.jsonl never mutates a row in place: dismissAlert() APPENDS a new
 * row sharing the original id rather than editing the original "open" row,
 * so the raw file can hold multiple rows for the same id. This function is
 * the single reduction: single pass, `Map<id, Alert>`, last-write-wins —
 * for any id that appears more than once, the LATEST row (by file order,
 * which is chronological — alerts.jsonl is append-only) replaces earlier
 * ones for that id.
 *
 * Output order: first-seen order of ids, not chronological order of each
 * id's WINNING (latest) row. This falls out of `Map`'s own semantics for
 * free and is documented here because it's easy to assume otherwise: per
 * the spec, re-`.set()`-ing an EXISTING Map key updates its value but does
 * NOT move its position in iteration order — only a key's FIRST insertion
 * fixes its slot. So `Array.from(byId.values())` naturally yields ids in
 * the order they first appeared in the input, each with its most recent
 * value. Chosen over "chronological by latest occurrence" because it's the
 * simpler, more stable ordering for a status view a human dismisses
 * against — a dismissed id doesn't jump to the end of the list — and it's
 * exactly what the single-pass Map gives you without extra bookkeeping.
 *
 * Pure: no I/O, no `this`, safe to unit-test directly and to reuse anywhere
 * an unreduced Alert[] needs collapsing (not just readAlerts()).
 */
export function reduceAlertsById(alerts: Alert[]): Alert[] {
  const byId = new Map<string, Alert>();
  for (const alert of alerts) {
    byId.set(alert.id, alert);
  }
  return Array.from(byId.values());
}

export class AlertManager {
  private healthTracker: HealthTracker;
  private readonly alertsLogPathOverride?: string;
  private readonly gate: AlertGate;

  constructor(healthTracker: HealthTracker, options: AlertManagerOptions = {}) {
    this.healthTracker = healthTracker;
    this.alertsLogPathOverride = options.alertsLogPath;
    this.gate = options.gate ?? getAlertGate();
  }

  /**
   * Lazily resolved on every access (never cached) so a caller-supplied
   * override always wins and the non-overridden path always reflects
   * whichever KAYA_HOME-independent ALERTS_LOG this module was built with.
   */
  private get alertsLogPath(): string {
    return this.alertsLogPathOverride ?? ALERTS_LOG;
  }

  /**
   * Single write choke point for alerts.jsonl — used by writeAlert() and
   * dismissAlert(). Only guards the REAL default-derived path: an injected
   * alertsLogPath (the norm across this file's hermetic tests) already
   * targets a caller-controlled sandbox regardless of KAYA_HOME/NODE_ENV, so
   * guarding it too would only produce false-positive throws in otherwise-
   * correct hermetic tests (mirrors AlertGate.spool()/saveState(), see
   * AlertGate.ts:372,427).
   *
   * Uses assertNotLiveDefaultUnderTest(), NOT assertNotLiveHomeUnderTest() —
   * this module's ALERTS_LOG is a frozen defaultKayaHome() path that ignores
   * KAYA_HOME/KAYA_DIR by design (see the module-level comment above), so the
   * sibling guard's `getKayaHome() === defaultKayaHome()` condition is wrong
   * here: pinning KAYA_HOME to a scratch dir would make that comparison
   * false and disable the guard while the write still landed on the live
   * default home (the exact 2026-07-20 incident — Gap B).
   */
  private appendAlertEntry(entry: Alert): void {
    if (!this.alertsLogPathOverride) assertNotLiveDefaultUnderTest('AlertManager.writeAlert');
    const dir = dirname(this.alertsLogPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    try {
      createAppendLog(this.alertsLogPath).append(entry);
    } catch (error) {
      console.error('Failed to write alert:', error);
    }
  }

  /**
   * Evaluate findings and classify severity.
   *
   * `workflow` (optional) is the tier this scan belongs to — callers always
   * know it (Workflows.ts passes "daily" / "weekly-security"). It exists
   * SPECIFICALLY so resolveAbsent() still runs on a CLEAN scan: when
   * `findings` is empty (the common, healthy-day case — Workflows.ts's
   * alertFindings is [] whenever integrity+remediation both come back
   * clean), the for-loop below never touches currentKeysByWorkflow, so
   * without this seed the map would stay empty and resolveAbsent() would
   * never be called for this workflow at all — any issue left "monitoring"
   * from a prior run would stay "monitoring" forever, no matter how many
   * clean scans ran after it. Seeding `workflow` with an empty Set BEFORE
   * the loop guarantees resolveAbsent(workflow, ...) always runs once per
   * evaluate() call for the in-scope tier, while the loop below still
   * builds (and resolves) entries for any OTHER workflow present in
   * `findings` exactly as before — multi-workflow findings are unaffected.
   */
  async evaluate(findings: FindingInput[], healthTracker: HealthTracker, workflow?: string): Promise<EvaluationResult> {
    const alerts: Alert[] = [];
    let notificationsFired = 0;
    // Every issue key this scan (re-)recorded, grouped by workflow — feeds
    // resolveAbsent() below so a key that existed in prior state but wasn't
    // reproduced by THIS scan's findings gets auto-resolved. Grouped by
    // workflow (not flattened) because a single evaluate() call is scoped to
    // one scan/tier in production (Workflows.ts calls it once per tier with
    // that tier's full finding set), and resolution must never cross tiers.
    const currentKeysByWorkflow = new Map<string, Set<string>>();
    if (workflow !== undefined) currentKeysByWorkflow.set(workflow, new Set());

    for (const finding of findings) {
      let severity: 'INFO' | 'WARNING' | 'CRITICAL' = 'INFO';
      const now = new Date().toISOString();

      // Generate issue key for persistence tracking
      const issueKey = generateIssueKey(finding.workflow, finding.step, finding.finding);
      const workflowKeys = currentKeysByWorkflow.get(finding.workflow) ?? new Set<string>();
      workflowKeys.add(issueKey);
      currentKeysByWorkflow.set(finding.workflow, workflowKeys);

      // Check if this is a recurring issue
      const existingRecord = healthTracker.get(issueKey);
      let occurrences = 1;

      if (existingRecord) {
        occurrences = existingRecord.occurrences + 1;
      }

      // Record in HealthTracker
      healthTracker.record(issueKey, {
        lastSeen: now,
        type: finding.type,
        finding: finding.finding,
        status: 'monitoring',
      });

      // Classify severity based on type and occurrence
      if (finding.type === 'verified_secret' && finding.verified === true) {
        severity = 'CRITICAL';
      } else if (finding.type === 'scan_error') {
        // The secret scan itself failed to complete (E1 — secret-scan-honest):
        // the result is UNKNOWN, not clean. Page immediately on first
        // occurrence — do not fall through to occurrence-based escalation,
        // which would silently under-alert on a scanner that just started
        // failing (i.e. exactly the class of bug this branch exists to fix).
        severity = 'CRITICAL';
      } else if (finding.type === 'potential_secret' && finding.verified === false) {
        if (finding.count && finding.count >= 100) {
          severity = 'WARNING';
        } else {
          severity = 'INFO';
        }
      } else if (finding.type === 'privacy_violation') {
        // Privacy violations are WARNING on first detection per spec (ISC A-07)
        const persistenceSeverity = healthTracker.getSeverity(issueKey);
        severity = persistenceSeverity === 'CRITICAL' ? 'CRITICAL' : 'WARNING';
      } else {
        // Use occurrence-based escalation for other types
        severity = healthTracker.getSeverity(issueKey);
      }

      // Write to alerts.jsonl — thread the SAME issueKey already computed
      // above (never recompute; see Alert.issueKey's docblock) so the row
      // records the exact key it was classified/persisted under.
      //
      // writeAlert() now returns the PERSISTED row (A4 — N1 alert-closure
      // program, id-threading fix). Before this, evaluate() built a SEPARATE
      // in-memory Alert object right here with its OWN randomUUID() call,
      // entirely independent from the randomUUID() writeAlert() generated
      // internally for the row it actually appended to disk — so an id in
      // EvaluationResult.alerts never matched any id readAlerts() could ever
      // return. Fixed by threading ONE id: take writeAlert()'s returned row
      // as the base and overlay firstSeen/occurrences (computed above from
      // HealthTracker state, which writeAlert() itself has no visibility
      // into) onto it, instead of constructing a second, independently-id'd
      // object.
      const persisted = this.writeAlert(finding, severity, issueKey);
      const alert: Alert = {
        ...persisted,
        firstSeen: existingRecord?.firstSeen || now,
        occurrences,
      };

      alerts.push(alert);

      // Route WARNING+ severity through AlertGate — CRITICAL pages
      // (immediate, cooldown+fingerprint gated), WARNING digests (spooled
      // for the next daily digest). Key is stable per finding CLASS (reuses
      // the same normalized issueKey record()/getSeverity() use above, so a
      // re-alert for the same underlying issue shares one cooldown window —
      // this is what makes CRITICAL's "re-fires daily until dismissed"
      // policy work without a human re-paging themselves on every scan).
      // Fingerprint is the raw (unnormalized) finding text so a materially
      // different message for the same issue class still breaks the
      // cooldown freeze (ADR-004 / S3a un-freeze-stale-fingerprints pattern).
      if (severity === 'WARNING' || severity === 'CRITICAL') {
        const tier: AlertTier = severity === 'CRITICAL' ? 'page' : 'digest';
        const key = `automaintenance-alert-${issueKey}`;
        const fingerprint = createHash('sha256').update(finding.finding).digest('hex').slice(0, 12);
        const result = await this.gate.send(`[${severity}] ${finding.finding}`, { key, tier, fingerprint });
        if (result !== 'suppressed') notificationsFired++;
      }
    }

    const resolvedKeys: string[] = [];
    for (const [workflow, keys] of currentKeysByWorkflow) {
      resolvedKeys.push(...healthTracker.resolveAbsent(workflow, keys));
    }

    // resolveAbsent bridge (A4 — N1 alert-closure program): resolveAbsent()
    // above closes an issue in health-state.json's issuePersistence map
    // (IssueRecord.status -> 'auto-resolved') but has zero knowledge of
    // alerts.jsonl — before this bridge, an issue that stopped reproducing
    // left its last alerts.jsonl row open FOREVER, split-brained against
    // health-state.json's own resolved status (the second half of N1,
    // alongside supersede-on-write above). Close that gap here: for every
    // key resolveAbsent() just resolved this scan, dismiss (by 'system';
    // semantically this is "auto-resolved — no longer reproduced", distinct
    // from supersede-on-write's "superseded by a newer scan") every OPEN
    // alert row whose STORED issueKey matches. Matches on the stored field
    // ONLY — the locked design rule at the top of this file — so a legacy
    // row with issueKey undefined can never match a resolved key string and
    // is structurally unreachable here, the same guarantee supersede-on-
    // write relies on.
    if (resolvedKeys.length > 0) {
      const resolvedSet = new Set(resolvedKeys);
      const openForResolvedKeys = this.readAlerts().filter(
        (a) => a.status === 'open' && a.issueKey !== undefined && resolvedSet.has(a.issueKey),
      );
      for (const row of openForResolvedKeys) {
        this.dismissAlertEntry(row.id, 'system');
      }
    }

    return { alerts, notificationsFired, resolvedKeys };
  }

  /**
   * Write alert to alerts.jsonl. Returns the persisted row (A4 — N1
   * alert-closure program; see evaluate()'s id-threading comment for why:
   * this is the ONE place an Alert's id is minted for a fresh open row, so
   * callers that need the on-disk id — evaluate() included — use this
   * return value instead of separately minting their own).
   *
   * `issueKey` (optional, A3) is threaded IN by the caller — evaluate()
   * passes its own already-computed generateIssueKey(...) result. This
   * method never computes a key itself; a caller that omits it (legacy
   * call shape, still used directly by a few tests) simply writes a row
   * with `issueKey: undefined`, which JSON.stringify drops from the line
   * entirely — indistinguishable from a pre-A3 legacy row on disk.
   *
   * Supersede-on-write (A4): when `issueKey` IS provided, every currently
   * OPEN row sharing that STORED issueKey is dismissed (by 'system';
   * semantically "superseded by a newer scan") BEFORE the new row is
   * appended — the invariant going forward is at most one open row per
   * issueKey. Ordering matters: the dismissal append(s) happen strictly
   * before the new open row's append, so the raw file always replays
   * deterministically (open -> dismissed -> open, never out of order).
   * Matches on the STORED issueKey field only (locked design rule, see the
   * top of this file) — never recomputed against a historical row, and
   * skipped entirely when `issueKey` is undefined, so a legacy call shape
   * (no key threaded) can never trigger or be caught by this mechanism,
   * even when its content is byte-identical to another legacy row.
   */
  writeAlert(finding: FindingInput, severity: 'INFO' | 'WARNING' | 'CRITICAL', issueKey?: string): Alert {
    if (issueKey !== undefined) {
      const openSameIssue = this.readAlerts().filter(
        (a) => a.status === 'open' && a.issueKey === issueKey,
      );
      for (const stale of openSameIssue) {
        this.dismissAlertEntry(stale.id, 'system');
      }
    }

    const alert: Alert = {
      id: randomUUID(),
      issueKey,
      timestamp: new Date().toISOString(),
      severity,
      workflow: finding.workflow,
      step: finding.step,
      finding: finding.finding,
      status: 'open',
      verified: finding.verified,
      count: finding.count,
    };

    this.appendAlertEntry(alert);
    return alert;
  }

  /**
   * Synchronous core of dismissAlert() — appends a dismissed row for
   * `alertId` (mutating a found row's copy, or synthesizing one if not
   * found — see dismissAlert()'s docblock for that append-only contract).
   * Extracted (A4) so writeAlert()'s supersede-on-write step and
   * evaluate()'s resolveAbsent bridge can dismiss rows directly without an
   * async/await indirection: dismissAlert() has never actually contained an
   * `await` (it's pure synchronous fs work wrapped in an `async` method
   * signature), so this extraction is behavior-preserving, not a new code
   * path.
   */
  private dismissAlertEntry(alertId: string, dismissedBy: 'human' | 'system'): void {
    const alerts = this.readAlerts();
    let dismissedAlert = alerts.find(a => a.id === alertId);

    if (dismissedAlert) {
      dismissedAlert.status = 'dismissed';
      dismissedAlert.dismissedBy = dismissedBy;
      dismissedAlert.dismissedAt = new Date().toISOString();
    } else {
      // Create a dismissed entry even if alert didn't previously exist
      dismissedAlert = {
        id: alertId,
        timestamp: new Date().toISOString(),
        severity: 'INFO' as const,
        workflow: 'manual',
        step: 'dismiss',
        finding: 'Dismissed by command',
        status: 'dismissed' as const,
        dismissedBy,
        dismissedAt: new Date().toISOString(),
      };
    }

    // Append dismissed alert to log
    this.appendAlertEntry(dismissedAlert);
  }

  /**
   * Dismiss an alert by ID
   */
  async dismissAlert(alertId: string, dismissedBy: 'human' | 'system'): Promise<void> {
    this.dismissAlertEntry(alertId, dismissedBy);
  }

  /**
   * Read all alerts from alerts.jsonl, reduced to one row per id
   * (last-write-wins — see reduceAlertsById()'s docblock). This is the
   * single choke point (A3 — N1) that makes dismissAlert(), Workflows.ts's
   * refireCriticalAlerts()/runStatusCommand() dismiss-honoring with ZERO
   * call-site changes: a dismissed id's original "open" row is superseded
   * by its later "dismissed" row in every caller's view of this method's
   * return value, even though the underlying file is still append-only and
   * unchanged on disk.
   */
  readAlerts(): Alert[] {
    if (!existsSync(this.alertsLogPath)) {
      return [];
    }

    try {
      const content = readFileSync(this.alertsLogPath, 'utf-8');
      const lines = content.trim().split('\n').filter(l => l.length > 0);
      const raw: Alert[] = lines.map(line => JSON.parse(line));
      return reduceAlertsById(raw);
    } catch (error) {
      console.error('Failed to read alerts:', error);
      return [];
    }
  }

  /**
   * Re-fire open CRITICAL alerts (for daily re-alerting)
   */
  async refireOpenCriticalAlerts(openAlerts: Alert[]): Promise<{ refiredCount: number; notificationsFired: number }> {
    let refiredCount = 0;
    let notificationsFired = 0;

    for (const alert of openAlerts) {
      if (alert.severity === 'CRITICAL' && alert.status === 'open') {
        // A4 — N1 alert-closure program: prefer the row's STORED issueKey
        // (threaded at write time — see Alert.issueKey's docblock) over
        // recomputing it here. Recomputing was itself a landmine: legacy
        // rows written before normalizeFindingText() existed (or before
        // some other since-changed normalization rule) have a STORED key
        // that generateIssueKey() would compute DIFFERENTLY today, so
        // recomputing silently mints a DIFFERENT AlertGate cooldown key
        // than the one evaluate()/writeAlert() classified/persisted this
        // exact row under — splitting one issue across two cooldown
        // windows. Fall back to recompute ONLY for rows that genuinely have
        // no stored issueKey at all (legacy-only fallback — remove once
        // DATA-2 closes those rows, per the locked design rule at the top
        // of this file).
        const issueKey = alert.issueKey ?? generateIssueKey(alert.workflow, alert.step, alert.finding);
        const key = `automaintenance-alert-${issueKey}`;
        const fingerprint = createHash('sha256').update(alert.finding).digest('hex').slice(0, 12);
        // TIER (2026-07-31): 'digest', not 'page'. This is the DAILY RE-FIRE of
        // an ALREADY-OPEN critical — the first occurrence still pages loudly via
        // evaluate()'s own gate.send() (line ~307), which is untouched. Re-paging
        // an alert Jm has already seen and triaged is the classic alarm-fatigue
        // pattern: in the 14 days to 07-31 this fired 6 [CRITICAL RE-ALERT]
        // pages, every one of them the same known-open secrets finding
        // (secrets.json.bak-* + creds in pushed git history) that is gitignored,
        // has no egress, and is blocked on a manual Jm step. An alert that
        // re-pages daily while its owner is knowingly sitting on it trains the
        // alarm to be ignored — the exact failure mode the keychain watcher hit
        // (12 identical pages in 5 days). It stays visible in the daily digest
        // until genuinely closed.
        const result = await this.gate.send(`[CRITICAL RE-ALERT] ${alert.finding}`, { key, tier: 'digest', fingerprint });
        if (result !== 'suppressed') {
          notificationsFired++;
          refiredCount++;
        }
      }
    }

    return { refiredCount, notificationsFired };
  }
}
