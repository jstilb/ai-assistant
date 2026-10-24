/**
 * PointsCli — the `points` subcommands of RewardEngine.ts (score, sync, check,
 * routines, goal, history, weights, preview). Rendering only; scoring lives in
 * Points.ts.
 */

import {
  appendRoutineCheck,
  currentStreaks,
  gatherCompletions,
  goalProgress,
  loadGoal,
  loadRoutineCatalogue,
  localDayOf,
  periodScore,
  readPointsLedger,
  resolveRoutine,
  saveGoal,
  scoreHistory,
  syncLedger,
  weekStart,
  type GoalPeriod,
  type PointsConfig,
  type PointsLedgerEntry,
} from "./Points.ts";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function positional(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      if (!["--dry-run"].includes(args[i])) i++;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

const KIND_ICON: Record<PointsLedgerEntry["kind"], string> = {
  task: "✅",
  base: "•",
  continuation: "🔥",
  milestone: "🏅",
  recovery: "🩹",
  weekly_target: "🎯",
};

function fmtEntry(e: PointsLedgerEntry): string {
  const pts = `+${e.points}`.padStart(4);
  const label = e.label.length > 48 ? `${e.label.slice(0, 47)}…` : e.label;
  return `  ${e.day}  ${pts}  ${KIND_ICON[e.kind]} ${label}  (${e.detail}${e.topUp ? ", top-up" : ""})`;
}

function bar(pct: number, width = 20): string {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

/** Lines summarizing score + goal (shared by `points` and `stats`). */
export function scoreLines(ledger: PointsLedgerEntry[], today: string): string[] {
  const goal = loadGoal();
  const lines = [
    `  today:         ${periodScore(ledger, "day", today)} pts`,
    `  this week:     ${periodScore(ledger, "week", today)} pts   (week of ${weekStart(today)})`,
    `  this month:    ${periodScore(ledger, "month", today)} pts`,
    `  lifetime:      ${ledger.reduce((s, e) => s + e.points, 0)} pts`,
  ];
  if (goal) {
    const score = periodScore(ledger, goal.period, today);
    const p = goalProgress(goal, score, today);
    lines.push(
      `  goal:          ${score}/${goal.target} per ${goal.period}  ${bar(p.pct)} ${p.pct}%`,
      `                 ${p.remaining ? `${p.remaining} to go` : "goal met 🎉"} · ${p.onPace ? "on pace" : "behind pace"} (expected ${p.expectedByNow} by day ${p.dayOfPeriod}/${p.periodDays})`,
    );
  } else {
    lines.push(`  goal:          none set — bun RewardEngine.ts points goal <n> [--period week]`);
  }
  return lines;
}

async function cmdScore(cfg: PointsConfig, args: string[]): Promise<void> {
  const now = new Date();
  const today = localDayOf(now);
  const { appended, ledger, completions, routineCadence, warnings } = await syncLedger(cfg, now, undefined, args.includes("--dry-run"));
  console.log(`\n  🏆 RewardEngine — points`);
  console.log(`  ──────────────────────────`);
  for (const l of scoreLines(ledger, today)) console.log(l);

  const streaks = currentStreaks(cfg, completions, today, routineCadence);
  const alive = streaks.filter((s) => s.current > 0).slice(0, 8);
  const recoverable = streaks.filter((s) => s.recoverable !== null);
  if (alive.length) {
    console.log(`\n  🔥 streaks`);
    for (const s of alive) console.log(`     ${String(s.current).padStart(3)}${s.cadence === "daily" ? "d" : "w"}  ${s.label}`);
  }
  if (recoverable.length) {
    console.log(`\n  🩹 broken — restart for +${cfg.streaks.recovery.bonus} recovery bonus`);
    for (const s of recoverable) console.log(`     ${s.label} (was ${s.recoverable}${s.cadence === "daily" ? "d" : "w"}, last ${s.lastDone})`);
  }
  if (appended.length) {
    console.log(`\n  ➕ new since last sync (${appended.reduce((s, e) => s + e.points, 0)} pts)`);
    for (const e of appended.slice(-12)) console.log(fmtEntry(e));
    if (appended.length > 12) console.log(`     … ${appended.length - 12} more (points history)`);
  }
  for (const w of warnings) console.log(`  ⚠️  ${w}`);
  console.log("");
}

async function cmdSync(cfg: PointsConfig, args: string[]): Promise<void> {
  const dry = args.includes("--dry-run");
  const { appended, warnings } = await syncLedger(cfg, new Date(), undefined, dry);
  const total = appended.reduce((s, e) => s + e.points, 0);
  console.log(`\n  ${dry ? "[dry-run] would append" : "appended"} ${appended.length} entr${appended.length === 1 ? "y" : "ies"} (+${total} pts)`);
  for (const e of appended.slice(-20)) console.log(fmtEntry(e));
  for (const w of warnings) console.log(`  ⚠️  ${w}`);
  console.log("");
}

async function cmdCheck(cfg: PointsConfig, args: string[]): Promise<void> {
  const query = positional(args).join(" ").trim();
  if (!query) {
    console.log(`\n  Usage: points check "<routine item>" [--date YYYY-MM-DD]   (list: points routines)\n`);
    return;
  }
  const catalogue = loadRoutineCatalogue(cfg);
  const hit = resolveRoutine(catalogue, cfg, query);
  if ("error" in hit) {
    console.log(`\n  ⛔ ${hit.error}\n`);
    return;
  }
  const now = new Date();
  const day = flag(args, "--date") ?? localDayOf(now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day > localDayOf(now)) {
    console.log(`\n  ⛔ --date must be YYYY-MM-DD and not in the future\n`);
    return;
  }
  appendRoutineCheck({ at: now.toISOString(), day, item: hit.item, label: hit.label, cadence: hit.cadence });
  const { appended } = await syncLedger(cfg, now);
  const earned = appended.filter((e) => e.item === hit.item);
  const total = earned.reduce((s, e) => s + e.points, 0);
  console.log(`\n  ✔ ${hit.label} — ${day}${total ? `  +${total} pts` : "  (already counted for this period)"}`);
  for (const e of earned) console.log(fmtEntry(e));
  const others = appended.length - earned.length;
  if (others > 0) console.log(`     (+${others} other new entr${others === 1 ? "y" : "ies"} synced from tasks/habits)`);
  console.log("");
}

function cmdRoutines(cfg: PointsConfig): void {
  const catalogue = loadRoutineCatalogue(cfg);
  console.log(`\n  📋 Checkable routine items (Daily/Weekly Behaviors + config)`);
  for (const cadence of ["daily", "weekly"] as const) {
    console.log(`\n  ${cadence.toUpperCase()}`);
    for (const e of [...catalogue.values()].filter((x) => x.cadence === cadence)) {
      const def = cfg.items[e.item];
      const pts = def ? (def.unitPoints !== undefined ? `${def.unitPoints}/unit` : `${def.points}`) : `${cfg.routineDefault.points}`;
      console.log(`    ${pts.padStart(6)} pts  ${e.label}`);
    }
  }
  console.log(`\n  Check one: bun RewardEngine.ts points check "<name>"\n`);
}

function cmdGoal(args: string[]): void {
  const pos = positional(args);
  if (pos[0] === "clear") {
    saveGoal(null);
    console.log(`\n  Goal cleared.\n`);
    return;
  }
  if (pos[0] !== undefined) {
    const target = Number(pos[0]);
    const period = (flag(args, "--period") ?? "week") as GoalPeriod;
    if (!Number.isFinite(target) || target <= 0 || !["day", "week", "month"].includes(period)) {
      console.log(`\n  Usage: points goal <positive number> [--period day|week|month] | points goal clear\n`);
      return;
    }
    saveGoal({ target: Math.round(target), period, setAt: new Date().toISOString() });
    console.log(`\n  🎯 Goal set: ${Math.round(target)} pts per ${period}.\n`);
    return;
  }
  const goal = loadGoal();
  console.log(goal ? `\n  🎯 ${goal.target} pts per ${goal.period} (set ${goal.setAt.slice(0, 10)})\n` : `\n  No goal set. points goal <n> [--period week]\n`);
}

function cmdHistory(args: string[]): void {
  const limit = Number(flag(args, "--limit") ?? 20);
  const entries = readPointsLedger().slice(-limit);
  if (!entries.length) {
    console.log(`\n  Ledger empty — run: bun RewardEngine.ts points sync\n`);
    return;
  }
  console.log(`\n  🏆 last ${entries.length} ledger entr${entries.length === 1 ? "y" : "ies"}`);
  for (const e of entries) console.log(fmtEntry(e));
  console.log("");
}

function cmdWeights(cfg: PointsConfig): void {
  const t = cfg.tasks;
  const s = cfg.streaks;
  console.log(`\n  ⚖️  Point weights (edit config/rewards.json → points)`);
  console.log(`  paying since:  ${cfg.startDate}`);
  console.log(`  tasks:         P1 ${t.byPriority["1"]} · P2 ${t.byPriority["2"]} · P3 ${t.byPriority["3"]}  +${t.estimate.points}/${t.estimate.everyMinutes}min estimate (max +${t.estimate.max})  +${t.goalLinkedBonus} goal-linked`);
  console.log(`                 excluded dispositions: ${t.excludeDispositions.join(", ")}`);
  console.log(`  continuation:  from ${s.continuation.startAt} in a row, +${s.continuation.perPeriod}/period (max +${s.continuation.max}); milestones ${Object.entries(s.continuation.milestones).map(([k, v]) => `${k}→+${v}`).join(" ")}`);
  console.log(`  recovery:      +${s.recovery.bonus} for restarting after a ≥${s.recovery.minPriorStreak} streak broke (within ${s.recovery.maxMissedPeriods.daily} missed days / ${s.recovery.maxMissedPeriods.weekly} missed weeks)`);
  console.log(`  routines:      ${cfg.routineDefault.points} pts default for unlisted Behaviors rows\n`);
  for (const [id, d] of Object.entries(cfg.items)) {
    const pts = d.unitPoints !== undefined ? `${d.unitPoints}/unit (max ${d.maxUnits ?? "∞"})` : `${d.points}`;
    const extras = [
      d.cadence === "weekly" ? "weekly" : "",
      d.doneAt && d.doneAt > 1 ? `streak needs ${d.doneAt}` : "",
      d.weeklyTarget ? `🎯 ${d.weeklyTarget.count}/wk +${d.weeklyTarget.bonus}` : "",
      d.bonuses.includes("continuation") ? "🔥" : "",
      d.bonuses.includes("recovery") ? "🩹" : "",
    ].filter(Boolean).join(" ");
    console.log(`    ${pts.padStart(16)}  ${d.label.padEnd(34)} ${extras}  [${id}]`);
  }
  console.log("");
}

/** Score history from --since without writing — calibrates a goal. */
async function cmdPreview(cfg: PointsConfig, args: string[]): Promise<void> {
  const today = localDayOf(new Date());
  const since = flag(args, "--since") ?? (() => {
    const d = new Date();
    d.setDate(d.getDate() - 56);
    return localDayOf(d);
  })();
  const { completions, routineCadence } = await gatherCompletions(cfg);
  const awards = scoreHistory({ ...cfg, startDate: since }, completions, routineCadence).filter((a) => a.day <= today);
  const weeks = new Map<string, { total: number; byKind: Record<string, number> }>();
  for (const a of awards) {
    const wk = weekStart(a.day);
    const w = weeks.get(wk) ?? { total: 0, byKind: {} };
    w.total += a.points;
    const k = a.kind === "task" ? "tasks" : a.kind === "base" ? "habits/routines" : "bonuses";
    w.byKind[k] = (w.byKind[k] ?? 0) + a.points;
    weeks.set(wk, w);
  }
  console.log(`\n  🔍 Preview (no writes) — weekly points since ${since} with current weights`);
  const totals: number[] = [];
  for (const [wk, w] of [...weeks.entries()].sort()) {
    const partial = wk === weekStart(today) ? "  (in progress)" : "";
    if (!partial) totals.push(w.total);
    console.log(`    ${wk}  ${String(w.total).padStart(5)}  tasks ${w.byKind["tasks"] ?? 0} · habits/routines ${w.byKind["habits/routines"] ?? 0} · bonuses ${w.byKind["bonuses"] ?? 0}${partial}`);
  }
  if (totals.length) {
    const sorted = [...totals].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const avg = Math.round(totals.reduce((s, x) => s + x, 0) / totals.length);
    console.log(`\n    full weeks: ${totals.length} · avg ${avg} · median ${median} · best ${sorted[sorted.length - 1]}`);
  }
  console.log("");
}

export async function cmdPoints(cfg: PointsConfig | undefined, args: string[]): Promise<void> {
  if (!cfg) {
    console.log(`\n  No "points" section in config/rewards.json — points are disabled.\n`);
    return;
  }
  const [sub, ...rest] = args[0]?.startsWith("--") ? ["score", ...args] : args;
  switch (sub) {
    case undefined:
    case "score": return cmdScore(cfg, rest);
    case "sync": return cmdSync(cfg, rest);
    case "check": return cmdCheck(cfg, rest);
    case "routines": return cmdRoutines(cfg);
    case "goal": return cmdGoal(rest);
    case "history": return cmdHistory(rest);
    case "weights": return cmdWeights(cfg);
    case "preview": return cmdPreview(cfg, rest);
    default:
      console.log(`points — deterministic points for tasks, habits and routines

  points [score] [--dry-run]                 Sync the ledger, show score, goal, streaks
  points sync [--dry-run]                    Pull new completions into the ledger
  points check "<routine>" [--date D]        Check off a Daily/Weekly Behaviors item
  points routines                            List checkable routine items + points
  points goal <n> [--period day|week|month]  Set a score goal (default per week)
  points goal clear                          Remove the goal
  points history [--limit N]                 Recent ledger entries
  points weights                             Show the point weights
  points preview [--since YYYY-MM-DD]        Score past weeks (no writes) to calibrate a goal`);
  }
}
