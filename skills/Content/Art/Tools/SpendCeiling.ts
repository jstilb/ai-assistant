/**
 * SpendCeiling.ts — daily call-count ceiling for paid image generation (T3-14, money boundary).
 *
 * One chokepoint: Generate.ts calls reserveCalls() before it dispatches any generation. Every
 * caller (DnD MonsterArt/MapPrompt, SystemFlowchart ArtBridge, the /art command) goes through
 * Generate.ts, so one check covers all paths.
 *
 * Policy (plans/audits/remediation/theme3-art-spend-ceiling.md, option A, count part only):
 *   - The ceiling is a number of image calls per local calendar day.
 *   - Default: 30 calls/day. THIS NUMBER IS A PLACEHOLDER from the plan. Jm must confirm it.
 *   - Override: env ART_DAILY_CALL_LIMIT (positive integer).
 *   - State: <KAYA_HOME>/MEMORY/State/art-spend-ceiling.json (override: ART_SPEND_STATE_PATH).
 *   - A call is counted when it is reserved (before dispatch), so a retry loop cannot spend
 *     without being counted.
 *   - A trip throws a CLIError and sends a page-tier alert. It never skips silently.
 *   - The counter resets at the date rollover.
 *
 * Not built here: the dollar estimate. The plan has no verified price per image.
 */

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { createStateManager } from "../../../../lib/core/StateManager.ts";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";
import { CLIError } from "../Lib/cli-utils.ts";

/** Placeholder from the plan (theme3-art-spend-ceiling.md section 5). Jm must confirm. */
export const DEFAULT_DAILY_CALL_LIMIT = 30;

const StateSchema = z.object({
  date: z.string(),
  callCount: z.number().int().nonnegative(),
});
type CeilingState = z.infer<typeof StateSchema>;

interface ReserveOptions {
  /** Number of images this invocation will attempt. */
  count: number;
  /** Model name, for the trip message. */
  model?: string;
  /** Daily limit. Default: ART_DAILY_CALL_LIMIT env, else DEFAULT_DAILY_CALL_LIMIT. */
  limit?: number;
  /** State file path. Default: ART_SPEND_STATE_PATH env, else <KAYA_HOME>/MEMORY/State/art-spend-ceiling.json. */
  statePath?: string;
  /** Clock, for tests. */
  now?: () => Date;
  /** Alert hook, for tests. Default: page-tier sendAlert. */
  alert?: (message: string) => Promise<void>;
}

interface ReserveResult {
  date: string;
  callCount: number;
  limit: number;
}

/** Local calendar date as YYYY-MM-DD. */
function localDate(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Resolve the daily limit. Throws CLIError for a bad ART_DAILY_CALL_LIMIT. */
export function resolveDailyLimit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ART_DAILY_CALL_LIMIT;
  if (raw === undefined || raw === "") return DEFAULT_DAILY_CALL_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new CLIError(`Invalid ART_DAILY_CALL_LIMIT: "${raw}". Must be a positive integer.`);
  }
  return n;
}

async function defaultAlert(message: string): Promise<void> {
  const { sendAlert } = await import("../../../../lib/core/AlertGate.ts");
  await sendAlert(message, { key: "art-spend-ceiling-tripped", tier: "page" });
}

/**
 * Reserve `count` image calls against today's ceiling.
 * Throws CLIError (and pages) if the reservation would exceed the limit. State is unchanged on a trip.
 */
export async function reserveCalls(options: ReserveOptions): Promise<ReserveResult> {
  const { count } = options;
  if (!Number.isInteger(count) || count < 1) {
    throw new CLIError(`SpendCeiling: invalid call count ${count}`);
  }
  const limit = options.limit ?? resolveDailyLimit();
  const today = localDate((options.now ?? (() => new Date()))());
  const statePath =
    options.statePath ??
    process.env.ART_SPEND_STATE_PATH ??
    join(getKayaHome(), "MEMORY", "State", "art-spend-ceiling.json");

  mkdirSync(dirname(statePath), { recursive: true }); // the lock file needs the directory
  const manager = createStateManager<CeilingState>({
    path: statePath,
    schema: StateSchema,
    defaults: () => ({ date: today, callCount: 0 }),
  });

  const trip: { usedBefore: number | null } = { usedBefore: null };
  const next = await manager.update((current) => {
    const used = current.date === today ? current.callCount : 0;
    if (used + count > limit) {
      trip.usedBefore = used;
      return current; // unchanged: a refused call does not consume budget
    }
    return { date: today, callCount: used + count };
  });

  if (trip.usedBefore !== null) {
    const message =
      `Art spend ceiling reached${options.model ? ` (${options.model})` : ""}: ` +
      `${trip.usedBefore}/${limit} calls used today, ${count} more requested. ` +
      `Raise ART_DAILY_CALL_LIMIT or wait for tomorrow.`;
    try {
      await (options.alert ?? defaultAlert)(message);
    } catch (err) {
      // The refusal below is the main signal. Report the failed page, do not hide the trip.
      console.error(`[SpendCeiling] page alert failed: ${(err as Error).message}`);
    }
    throw new CLIError(message);
  }

  return { date: next.date, callCount: next.callCount, limit };
}
