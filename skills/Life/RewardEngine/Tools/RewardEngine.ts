#!/usr/bin/env bun
/**
 * ============================================================================
 * RewardEngine — randomized (variable-ratio) rewards for incentivizing good work
 * ============================================================================
 *
 * WHY THIS DESIGN:
 * The single most powerful behavioral schedule for sustaining effort is the
 * VARIABLE-RATIO reinforcement schedule (the slot-machine schedule): a reward
 * delivered after an unpredictable amount of effort, with unpredictable
 * magnitude. It produces high, steady response rates that are extremely
 * resistant to extinction — far more than a fixed "do X, always get Y" reward.
 *
 * This skill harnesses that same dopamine loop that drives Jm's C0 challenge
 * (uncontrolled low-value media grazing) and points it at his actual goals.
 * You finish a real piece of work → you "roll" → most rolls give a small
 * reward or an encouraging near-miss, occasionally a medium reward, rarely a
 * jackpot. The unpredictability is the active ingredient.
 *
 * INTEGRITY (this only works if it stays honest):
 *   - The RNG and the schedule math are DETERMINISTIC and auditable (seedable).
 *     Fairness must be inspectable — that part does not get to be a black box.
 *   - Rolls are capped per day and gated by a cooldown, so a roll stays special.
 *   - A "pity" rule guarantees a reward after N consecutive near-misses, so the
 *     schedule motivates rather than discourages (standard, honest game design).
 *   - Every roll is appended to an immutable ledger you can review.
 *   - An OPTIONAL LLM gate can judge whether the described work actually
 *     qualifies, so you can't reward yourself for nothing. The qualification
 *     judgement and the reveal flavor-text are the only LLM parts — the odds
 *     are math.
 *
 * USAGE:
 *   bun RewardEngine.ts roll --work "shipped the X fix, all tests green"
 *   bun RewardEngine.ts roll --no-llm        # skip the qualification gate
 *   bun RewardEngine.ts roll --seed 42       # deterministic (for testing/demos)
 *   bun RewardEngine.ts stats                # streak, totals, today's rolls
 *   bun RewardEngine.ts history [--limit 20] # recent ledger entries
 *   bun RewardEngine.ts menu                 # show the reward menu
 *   bun RewardEngine.ts odds                 # show current effective odds
 *
 * STATE:
 *   Config:  skills/Life/RewardEngine/config/rewards.json (edit your menu here)
 *   State:   $KAYA_HOME/runtime/reward-engine/state.json
 *   Ledger:  $KAYA_HOME/runtime/reward-engine/ledger.jsonl
 * ============================================================================
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";
import { createAppendLog } from "../../../../lib/core/AppendLog.ts";

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export type Tier = "small" | "medium" | "jackpot";
export type Outcome = "reward" | "near_miss";

export interface ScheduleConfig {
  pReward: number;
  tierWeights: Record<Tier, number>;
  pityAfter: number;
  dailyRollCap: number;
  cooldownMinutes: number;
  streak: { jackpotBonusPerDay: number; maxBonus: number };
}

export interface RewardConfig {
  schedule: ScheduleConfig;
  rewards: Record<Tier, string[]>;
  nearMiss: string[];
}

export interface EngineState {
  streakDays: number;
  lastQualifyingDay: string | null; // YYYY-MM-DD (local) of last day with >=1 qualifying roll
  rollsToday: number;
  lastRollDate: string | null; // YYYY-MM-DD (local) — for daily-cap reset
  lastRollAt: string | null; // ISO instant — for cooldown
  consecutiveNearMisses: number;
  totals: { rolls: number; rewards: number; jackpots: number };
}

export interface RollResolution {
  outcome: Outcome;
  tier: Tier | null;
  reward: string;
  effectiveJackpotWeight: number;
  pityTriggered: boolean;
}

// ----------------------------------------------------------------------------
// Paths
// ----------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));

export function configPath(): string {
  return join(__dirname, "..", "config", "rewards.json");
}

export function rewardEnginePaths(): { dir: string; state: string; ledger: string } {
  const dir = join(getKayaHome(), "runtime", "reward-engine");
  return { dir, state: join(dir, "state.json"), ledger: join(dir, "ledger.jsonl") };
}

// AppendLog seam for the ledger.jsonl growing log — getKayaHome() is cached process-wide
// after first call, so this module-level path is stable for the life of the process
// (same resolved path rewardEnginePaths().ledger would return at any later call).
const rewardLedgerLog = createAppendLog(rewardEnginePaths().ledger);

// ----------------------------------------------------------------------------
// Seedable RNG (mulberry32) — deterministic, auditable
// ----------------------------------------------------------------------------

/** Returns a function producing deterministic floats in [0,1) from a seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pick an index from weighted entries using rng. */
function weightedPick(rng: () => number, weights: number[]): number {
  const total = weights.reduce((s, w) => s + Math.max(0, w), 0);
  if (total <= 0) return 0;
  let r = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= Math.max(0, weights[i]);
    if (r < 0) return i;
  }
  return weights.length - 1;
}

// ----------------------------------------------------------------------------
// Pure schedule logic
// ----------------------------------------------------------------------------

/** Effective jackpot weight given the current consecutive-day streak. */
export function effectiveJackpotWeight(cfg: ScheduleConfig, streakDays: number): number {
  const bonus = Math.min(cfg.streak.maxBonus, Math.max(0, streakDays) * cfg.streak.jackpotBonusPerDay);
  return cfg.tierWeights.jackpot + bonus;
}

/**
 * Resolve a single qualifying roll. PURE — given the rng and current streak /
 * near-miss state, it returns the outcome. This is the auditable core.
 */
export function resolveRoll(
  config: RewardConfig,
  rng: () => number,
  streakDays: number,
  consecutiveNearMisses: number
): RollResolution {
  const cfg = config.schedule;
  const jackpotWeight = effectiveJackpotWeight(cfg, streakDays);

  // Pity: after enough consecutive near-misses, guarantee a reward this roll.
  const pityTriggered = consecutiveNearMisses >= cfg.pityAfter;
  const gotReward = pityTriggered || rng() < cfg.pReward;

  if (!gotReward) {
    const list = config.nearMiss.length ? config.nearMiss : ["No reward this roll."];
    return {
      outcome: "near_miss",
      tier: null,
      reward: list[Math.floor(rng() * list.length)] ?? list[0],
      effectiveJackpotWeight: jackpotWeight,
      pityTriggered,
    };
  }

  // Variable MAGNITUDE: draw a tier by weight, then a specific reward within it.
  const tiers: Tier[] = ["small", "medium", "jackpot"];
  const weights = [cfg.tierWeights.small, cfg.tierWeights.medium, jackpotWeight];
  let tier = tiers[weightedPick(rng, weights)];

  // Fall back to a populated tier if the chosen one is empty.
  if (!config.rewards[tier]?.length) {
    tier = tiers.find((t) => config.rewards[t]?.length) ?? "small";
  }
  const pool = config.rewards[tier] ?? [];
  const reward = pool.length ? pool[Math.floor(rng() * pool.length)] : "(reward menu is empty — edit config/rewards.json)";

  return { outcome: "reward", tier, reward, effectiveJackpotWeight: jackpotWeight, pityTriggered };
}

// ----------------------------------------------------------------------------
// Date helpers (injectable `now` for testability)
// ----------------------------------------------------------------------------

/** Local YYYY-MM-DD (en-CA renders ISO-style). */
export function localDay(now: Date): string {
  return now.toLocaleDateString("en-CA");
}

function previousDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}

// ----------------------------------------------------------------------------
// State
// ----------------------------------------------------------------------------

export function defaultState(): EngineState {
  return {
    streakDays: 0,
    lastQualifyingDay: null,
    rollsToday: 0,
    lastRollDate: null,
    lastRollAt: null,
    consecutiveNearMisses: 0,
    totals: { rolls: 0, rewards: 0, jackpots: 0 },
  };
}

export function loadConfig(): RewardConfig {
  return JSON.parse(readFileSync(configPath(), "utf8")) as RewardConfig;
}

export function loadState(): EngineState {
  const { state } = rewardEnginePaths();
  if (!existsSync(state)) return defaultState();
  try {
    return { ...defaultState(), ...(JSON.parse(readFileSync(state, "utf8")) as Partial<EngineState>) };
  } catch {
    return defaultState();
  }
}

export function saveState(s: EngineState): void {
  const { dir, state } = rewardEnginePaths();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(state, JSON.stringify(s, null, 2));
}

export interface LedgerEntry {
  at: string;
  day: string;
  work: string | null;
  qualified: boolean;
  outcome: Outcome | "blocked";
  tier: Tier | null;
  reward: string;
  streakDays: number;
  seed: number;
}

export function appendLedger(entry: LedgerEntry): void {
  rewardLedgerLog.append(entry);
}

export function readLedger(limit?: number): LedgerEntry[] {
  const { ledger } = rewardEnginePaths();
  if (!existsSync(ledger)) return [];
  const lines = readFileSync(ledger, "utf8").trim().split("\n").filter(Boolean);
  const parsed = lines
    .map((l) => {
      try {
        return JSON.parse(l) as LedgerEntry;
      } catch {
        return null;
      }
    })
    .filter((x): x is LedgerEntry => x !== null);
  return limit ? parsed.slice(-limit) : parsed;
}

// ----------------------------------------------------------------------------
// Gate checks (daily cap + cooldown) — pure
// ----------------------------------------------------------------------------

export interface GateResult {
  allowed: boolean;
  reason?: string;
  rollsTodayAfterReset: number;
}

/**
 * Returns whether a roll is allowed given state + now, accounting for daily
 * rollover (resets rollsToday when the local day changes) and the cooldown.
 */
export function checkGate(cfg: ScheduleConfig, state: EngineState, now: Date): GateResult {
  const today = localDay(now);
  const rollsToday = state.lastRollDate === today ? state.rollsToday : 0;

  if (rollsToday >= cfg.dailyRollCap) {
    return {
      allowed: false,
      reason: `Daily roll cap reached (${cfg.dailyRollCap}/day). Keeps each roll special — come back tomorrow.`,
      rollsTodayAfterReset: rollsToday,
    };
  }

  if (state.lastRollAt) {
    const elapsedMin = (now.getTime() - new Date(state.lastRollAt).getTime()) / 60000;
    if (elapsedMin < cfg.cooldownMinutes) {
      const remaining = Math.ceil(cfg.cooldownMinutes - elapsedMin);
      return {
        allowed: false,
        reason: `Cooldown active — ${remaining} min until your next roll. Go do more good work.`,
        rollsTodayAfterReset: rollsToday,
      };
    }
  }

  return { allowed: true, rollsTodayAfterReset: rollsToday };
}

/**
 * Apply a resolved roll to state, advancing streak / near-miss / totals / caps.
 * PURE — returns the next state; does not write. `rollsTodayAfterReset` is the
 * gate's post-rollover count (so the daily counter is correct across midnight).
 */
export function applyRoll(
  state: EngineState,
  resolution: RollResolution,
  now: Date,
  rollsTodayAfterReset: number
): EngineState {
  const today = localDay(now);
  const next: EngineState = JSON.parse(JSON.stringify(state));

  // Streak counts consecutive days with >=1 qualifying roll.
  if (next.lastQualifyingDay !== today) {
    next.streakDays = next.lastQualifyingDay === previousDay(today) ? next.streakDays + 1 : 1;
    next.lastQualifyingDay = today;
  }

  if (resolution.outcome === "reward") {
    next.consecutiveNearMisses = 0;
    next.totals.rewards += 1;
    if (resolution.tier === "jackpot") next.totals.jackpots += 1;
  } else {
    next.consecutiveNearMisses += 1;
  }

  next.rollsToday = rollsTodayAfterReset + 1;
  next.lastRollDate = today;
  next.lastRollAt = now.toISOString();
  next.totals.rolls += 1;
  return next;
}

// ----------------------------------------------------------------------------
// Optional LLM layer (qualification gate + reveal flavor) — fail-open
// ----------------------------------------------------------------------------

async function judgeWorkQualifies(work: string): Promise<{ qualifies: boolean; reason: string }> {
  try {
    const { inference } = await import("../../../../lib/core/Inference.ts");
    const res = await inference({
      level: "fast",
      expectJson: true,
      timeout: 30000,
      systemPrompt:
        "You gate a SELF-reward system Jm uses to motivate himself. He reports his own work in good faith — " +
        "you are NOT an auditor and must NOT demand proof, links, or evidence. Default to QUALIFIES whenever the " +
        "description plausibly names real, completed, non-trivial effort toward a goal/habit/project (shipping code, " +
        "a writing or piano session, a workout, a community contribution, a deep focus block, errands done, etc.). " +
        "Only return qualifies=false when it's clearly nothing/automatic ('breathed', 'existed'), purely trivial, " +
        "empty, or an obvious attempt to game the system. When in doubt, qualify it. " +
        'Respond ONLY with JSON: {"qualifies": boolean, "reason": "<one short sentence>"}.',
      userPrompt: `Work described: "${work}"`,
    });
    if (res.success && res.parsed && typeof (res.parsed as any).qualifies === "boolean") {
      const p = res.parsed as { qualifies: boolean; reason?: string };
      return { qualifies: p.qualifies, reason: p.reason ?? "" };
    }
  } catch {
    // fall through
  }
  // Fail-open: if the LLM is unavailable, trust the user (don't block a reward).
  return { qualifies: true, reason: "(qualification gate unavailable — accepted)" };
}

async function flavorReveal(resolution: RollResolution, work: string | null, streakDays: number): Promise<string | null> {
  try {
    const { inference } = await import("../../../../lib/core/Inference.ts");
    const res = await inference({
      level: "fast",
      timeout: 30000,
      systemPrompt:
        "You are Kaya delivering a randomized reward to Jm for good work, slot-machine style. " +
        "Write ONE short, punchy, genuine line (<=20 words) revealing the outcome below. Match the energy: " +
        "near-miss = encouraging not deflating; jackpot = big celebration. No emojis-only; be specific. Output just the line.",
      userPrompt: JSON.stringify({
        outcome: resolution.outcome,
        tier: resolution.tier,
        reward: resolution.reward,
        work,
        streakDays,
        pity: resolution.pityTriggered,
      }),
    });
    if (res.success && res.output.trim()) return res.output.trim().split("\n")[0];
  } catch {
    // fall through
  }
  return null;
}

// ----------------------------------------------------------------------------
// CLI
// ----------------------------------------------------------------------------

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

async function cmdRoll(): Promise<void> {
  const config = loadConfig();
  const cfg = config.schedule;
  const state = loadState();
  const now = new Date();
  const work = arg("--work") ?? null;
  const useLlm = !hasFlag("--no-llm");
  const seed = arg("--seed") !== undefined ? Number(arg("--seed")) : (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;

  // 1. Gate: daily cap + cooldown.
  const gate = checkGate(cfg, state, now);
  if (!gate.allowed) {
    console.log(`\n  ⛔ ${gate.reason}\n`);
    return;
  }

  // 2. Optional qualification gate (does NOT consume a roll if it fails).
  if (work && useLlm) {
    const judged = await judgeWorkQualifies(work);
    if (!judged.qualifies) {
      console.log(`\n  🤔 Not a roll yet — ${judged.reason}\n     (Do the work first, then come back. Or use --no-llm to override.)\n`);
      appendLedger({
        at: now.toISOString(), day: localDay(now), work, qualified: false,
        outcome: "blocked", tier: null, reward: judged.reason, streakDays: state.streakDays, seed,
      });
      return;
    }
  }

  // 3. Resolve (pure, seeded, auditable).
  const rng = mulberry32(seed);
  const resolution = resolveRoll(config, rng, state.streakDays, state.consecutiveNearMisses);

  // 4. Advance + persist state.
  const next = applyRoll(state, resolution, now, gate.rollsTodayAfterReset);
  saveState(next);
  appendLedger({
    at: now.toISOString(), day: localDay(now), work, qualified: true,
    outcome: resolution.outcome, tier: resolution.tier, reward: resolution.reward,
    streakDays: next.streakDays, seed,
  });

  // 5. Reveal (LLM flavor if available, else templated).
  const flavor = useLlm ? await flavorReveal(resolution, work, next.streakDays) : null;
  console.log("");
  if (resolution.outcome === "near_miss") {
    console.log(`  🎲 ${flavor ?? resolution.reward}`);
  } else if (resolution.tier === "jackpot") {
    console.log(`  🎰💥 JACKPOT 💥🎰`);
    console.log(`  🏆 ${resolution.reward}`);
    if (flavor) console.log(`     ${flavor}`);
  } else {
    const icon = resolution.tier === "medium" ? "✨" : "🎉";
    console.log(`  ${icon} ${resolution.tier?.toUpperCase()} REWARD`);
    console.log(`  🎁 ${resolution.reward}`);
    if (flavor) console.log(`     ${flavor}`);
  }
  if (resolution.pityTriggered) console.log(`     (guaranteed after ${state.consecutiveNearMisses} near-misses — pity timer)`);
  console.log(`     streak: ${next.streakDays}d · rolls today: ${next.rollsToday}/${cfg.dailyRollCap} · jackpot odds boosted to weight ${resolution.effectiveJackpotWeight}\n`);
}

function cmdStats(): void {
  const config = loadConfig();
  const s = loadState();
  const today = localDay(new Date());
  const rollsToday = s.lastRollDate === today ? s.rollsToday : 0;
  const rewardRate = s.totals.rolls ? ((s.totals.rewards / s.totals.rolls) * 100).toFixed(0) : "0";
  console.log(`\n  🎰 RewardEngine — stats`);
  console.log(`  ──────────────────────────`);
  console.log(`  streak:        ${s.streakDays} day(s)`);
  console.log(`  rolls today:   ${rollsToday}/${config.schedule.dailyRollCap}`);
  console.log(`  near-misses:   ${s.consecutiveNearMisses} in a row (pity at ${config.schedule.pityAfter})`);
  console.log(`  lifetime:      ${s.totals.rolls} rolls · ${s.totals.rewards} rewards (${rewardRate}%) · ${s.totals.jackpots} jackpots`);
  console.log(`  jackpot odds:  weight ${effectiveJackpotWeight(config.schedule, s.streakDays)} (base ${config.schedule.tierWeights.jackpot})\n`);
}

function cmdHistory(): void {
  const limit = arg("--limit") ? Number(arg("--limit")) : 15;
  const entries = readLedger(limit);
  if (!entries.length) {
    console.log("\n  No rolls yet. Do good work, then: bun RewardEngine.ts roll --work \"...\"\n");
    return;
  }
  console.log(`\n  🎰 RewardEngine — last ${entries.length} roll(s)`);
  console.log(`  ──────────────────────────`);
  for (const e of entries) {
    const tag = e.outcome === "blocked" ? "⛔ blocked" : e.outcome === "near_miss" ? "🎲 miss" : e.tier === "jackpot" ? "🎰 JACKPOT" : `🎁 ${e.tier}`;
    console.log(`  ${e.at.slice(0, 16).replace("T", " ")}  ${tag.padEnd(12)} ${e.reward}`);
  }
  console.log("");
}

function cmdMenu(): void {
  const config = loadConfig();
  console.log(`\n  🎁 Reward menu (edit: ${configPath()})\n`);
  for (const tier of ["small", "medium", "jackpot"] as Tier[]) {
    console.log(`  ${tier.toUpperCase()} (weight ${config.schedule.tierWeights[tier]}):`);
    for (const r of config.rewards[tier] ?? []) console.log(`    • ${r}`);
    console.log("");
  }
}

function cmdOdds(): void {
  const config = loadConfig();
  const s = loadState();
  const cfg = config.schedule;
  const jw = effectiveJackpotWeight(cfg, s.streakDays);
  const totalW = cfg.tierWeights.small + cfg.tierWeights.medium + jw;
  const pct = (w: number) => ((cfg.pReward * w) / totalW * 100).toFixed(1);
  console.log(`\n  🎲 Current effective odds (streak ${s.streakDays}d)`);
  console.log(`  ──────────────────────────`);
  console.log(`  any reward:  ${(cfg.pReward * 100).toFixed(0)}%   near-miss: ${((1 - cfg.pReward) * 100).toFixed(0)}%`);
  console.log(`  ├ small:     ${pct(cfg.tierWeights.small)}%`);
  console.log(`  ├ medium:    ${pct(cfg.tierWeights.medium)}%`);
  console.log(`  └ jackpot:   ${pct(jw)}%   (weight ${jw}, +${jw - cfg.tierWeights.jackpot} from streak)`);
  console.log(`  pity: guaranteed reward after ${cfg.pityAfter} consecutive near-misses\n`);
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  switch (cmd) {
    case "roll": await cmdRoll(); break;
    case "stats": cmdStats(); break;
    case "history": cmdHistory(); break;
    case "menu": cmdMenu(); break;
    case "odds": cmdOdds(); break;
    default:
      console.log(`RewardEngine — randomized (variable-ratio) rewards for good work

  roll --work "<what you did>"   Roll for a reward (LLM gates qualification)
  roll --no-llm                  Skip the qualification gate
  roll --seed <n>                Deterministic roll (testing/demos)
  stats                          Streak, totals, today's rolls
  history [--limit N]            Recent ledger entries
  menu                           Show the reward menu
  odds                           Show current effective odds`);
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("RewardEngine error:", e);
    process.exit(1);
  });
}
