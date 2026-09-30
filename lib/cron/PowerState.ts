/**
 * PowerState — parses `pmset -g batt` output into on-AC vs on-battery power
 * state, for B1/A2 run-ledger enrichment (see RunLedger.ts's loose `[extra]`
 * row fields).
 *
 * Deliberately injectable: `getPowerState` takes an `execFn` so tests never
 * spawn a real `pmset` process. Mirrors WakeLock.ts's injectable-spawn shape.
 *
 * `pmset -g batt` output looks like:
 *   Now drawing from 'AC Power'
 *    -InternalBattery-0 (id=35192931)	100%; charged; 0:00 remaining present: true
 * or:
 *   Now drawing from 'Battery Power'
 *    -InternalBattery-0 (id=35192931)	87%; discharging; 9:12 remaining present: true
 *
 * Desktop Macs with no battery, or a `pmset` binary that's missing/erroring,
 * must never throw — this is best-effort forensic enrichment, never allowed
 * to fail the job it's attached to (same philosophy as WakeLock/RunLedger's
 * try/catch-swallow style).
 */

export type PowerSource = 'AC Power' | 'Battery Power' | 'unknown';

export interface PowerState {
  /** true = on AC, false = on battery, null = undetermined (no battery / pmset failed). */
  onAC: boolean | null;
  source: PowerSource;
  /** Battery percentage 0-100, or null if not present/parseable. */
  percentage: number | null;
}

export type ExecPmset = () => string;

const UNKNOWN_STATE: PowerState = { onAC: null, source: 'unknown', percentage: null };

const defaultExec: ExecPmset = () => {
  return Bun.spawnSync(['pmset', '-g', 'batt']).stdout.toString();
};

/**
 * Parse `pmset -g batt`-shaped output (via injectable execFn) into a
 * PowerState. Never throws: any exec failure or unparseable output falls
 * back to UNKNOWN_STATE.
 */
export function getPowerState(execFn: ExecPmset = defaultExec): PowerState {
  let raw: string;
  try {
    raw = execFn();
  } catch {
    return { ...UNKNOWN_STATE };
  }

  const sourceMatch = raw.match(/Now drawing from '([^']+)'/);
  if (!sourceMatch) return { ...UNKNOWN_STATE };

  const rawSource = sourceMatch[1];
  const source: PowerSource = rawSource === 'AC Power' || rawSource === 'Battery Power' ? rawSource : 'unknown';
  if (source === 'unknown') return { ...UNKNOWN_STATE };

  const onAC = source === 'AC Power';

  const pctMatch = raw.match(/(\d+)%/);
  const percentage = pctMatch ? parseInt(pctMatch[1]!, 10) : null;

  return { onAC, source, percentage };
}
