/**
 * Points tests — deterministic scoring, streak bonuses, ledger idempotency,
 * goal progress, routine catalogue, and the read-only source readers.
 */
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Pin KAYA_HOME to a temp dir BEFORE importing the module (KayaHome caches it).
const TMP = mkdtempSync(join(tmpdir(), "reward-points-test-"));
process.env.KAYA_HOME = TMP;
delete process.env.KAYA_DIR;

const P = await import("../Tools/Points.ts");
type Completion = import("../Tools/Points.ts").Completion;
type PointsConfig = import("../Tools/Points.ts").PointsConfig;

const cfg: PointsConfig = {
  startDate: "2026-10-01",
  tasks: {
    byPriority: { "1": 15, "2": 10, "3": 5 },
    estimate: { everyMinutes: 30, points: 2, max: 8 },
    goalLinkedBonus: 5,
    excludeDispositions: ["autonomous", "drop"],
    streakItem: "tasks",
  },
  routineDefault: { points: 3, bonuses: ["continuation"] },
  routineIgnore: ["Daily lead completion"],
  streaks: {
    continuation: { startAt: 3, perPeriod: 1, max: 5, milestones: { "7": 10 } },
    recovery: { minPriorStreak: 3, maxMissedPeriods: { daily: 7, weekly: 2 }, bonus: 8 },
  },
  items: {
    tasks: { label: "Tasks", cadence: "daily", points: 0, bonuses: ["continuation", "recovery"] },
    workout: { label: "Workout", cadence: "daily", points: 10, bonuses: ["continuation", "recovery"], habits: ["workout"], routines: ["Workout"] },
    floss: { label: "Floss", cadence: "daily", points: 3, bonuses: ["continuation"], habits: ["floss"] },
    dance: { label: "Dance", cadence: "daily", points: 6, bonuses: [], habits: ["dance"] },
    phone_sep: { label: "Phone reps", cadence: "daily", points: 0, unitPoints: 2, maxUnits: 8, doneAt: 5, bonuses: ["continuation"], habits: ["phone_sep"] },
    build: { label: "Build", cadence: "daily", points: 12, weeklyTarget: { count: 5, bonus: 25 }, bonuses: [], habits: ["build"], routines: ["Fourth Spaces build block"] },
    community_event: { label: "Community", cadence: "weekly", points: 0, unitPoints: 15, maxUnits: 4, weeklyTarget: { count: 2, bonus: 20 }, bonuses: ["continuation", "recovery"], habits: ["community_event"] },
  },
};

const habit = (item: string, day: string, units = 1): Completion => ({ source: "habit", item, day, units, label: item });
const days = (from: string, n: number) => Array.from({ length: n }, (_, i) => P.addDays(from, i));
const byKind = <T extends { kind: string }>(awards: T[], kind: string): T[] => awards.filter((a) => a.kind === kind);

describe("date helpers", () => {
  test("weekStart is Monday", () => {
    expect(P.weekStart("2026-10-07")).toBe("2026-10-05"); // Wed
    expect(P.weekStart("2026-10-11")).toBe("2026-10-05"); // Sun
    expect(P.weekStart("2026-10-05")).toBe("2026-10-05"); // Mon
  });
  test("periodStart for day/week/month", () => {
    expect(P.periodStart("2026-10-07", "day")).toBe("2026-10-07");
    expect(P.periodStart("2026-10-07", "month")).toBe("2026-10-01");
  });
});

describe("taskPoints", () => {
  test("priority base + estimate size (capped) + goal bonus", () => {
    expect(P.taskPoints(cfg.tasks, { priority: 1, estimatedMinutes: null, goalLinked: false }).points).toBe(15);
    expect(P.taskPoints(cfg.tasks, { priority: 3, estimatedMinutes: 60, goalLinked: false }).points).toBe(5 + 4);
    expect(P.taskPoints(cfg.tasks, { priority: 2, estimatedMinutes: 600, goalLinked: true }).points).toBe(10 + 8 + 5);
  });
});

describe("itemBasePoints", () => {
  test("flat items pay points; counters pay per unit up to cap", () => {
    expect(P.itemBasePoints(cfg.items.workout, 1)).toBe(10);
    expect(P.itemBasePoints(cfg.items.phone_sep, 3)).toBe(6);
    expect(P.itemBasePoints(cfg.items.phone_sep, 20)).toBe(16);
    expect(P.itemBasePoints(cfg.items.workout, 0)).toBe(0);
  });
});

describe("scoreHistory", () => {
  test("a completed task and a habit each add points", () => {
    const awards = P.scoreHistory(cfg, [
      { source: "task", item: "t-1", day: "2026-10-02", units: 1, label: "Ship X", task: { priority: 1, estimatedMinutes: null, goalLinked: false } },
      habit("workout", "2026-10-02"),
    ]);
    expect(awards.find((a) => a.key === "task:t-1")?.points).toBe(15);
    expect(awards.find((a) => a.key === "item:workout:2026-10-02")?.points).toBe(10);
  });

  test("nothing before startDate pays, but it still builds the streak", () => {
    const awards = P.scoreHistory(cfg, days("2026-09-29", 4).map((d) => habit("workout", d)));
    // 09-29, 09-30 unpaid; 10-01 is day 3 of the streak → continuation +1
    expect(awards.filter((a) => a.kind === "base").map((a) => a.day)).toEqual(["2026-10-01", "2026-10-02"]);
    expect(awards.find((a) => a.key === "streak:workout:2026-10-01")?.points).toBe(1);
    expect(awards.find((a) => a.key === "streak:workout:2026-10-02")?.points).toBe(2);
  });

  test("continuation grows per day, caps at max, milestone fires once at 7", () => {
    const awards = P.scoreHistory(cfg, days("2026-10-01", 9).map((d) => habit("workout", d)));
    expect(byKind(awards, "continuation").map((a) => a.points)).toEqual([1, 2, 3, 4, 5, 5, 5]);
    const ms = byKind(awards, "milestone");
    expect(ms.length).toBe(1);
    expect(ms[0]).toMatchObject({ day: "2026-10-07", points: 10 });
  });

  test("recovery bonus after a broken streak (prior ≥ 3, missed ≤ 7)", () => {
    const hist = [...days("2026-10-01", 4), "2026-10-08"].map((d) => habit("workout", d));
    const rec = byKind(P.scoreHistory(cfg, hist), "recovery");
    expect(rec.length).toBe(1);
    expect(rec[0]).toMatchObject({ key: "recovery:workout:2026-10-08", points: 8 });
  });

  test("no recovery when the prior streak was short or the gap too long", () => {
    const short = [...days("2026-10-01", 2), "2026-10-05"].map((d) => habit("workout", d));
    expect(byKind(P.scoreHistory(cfg, short), "recovery").length).toBe(0);
    const longGap = [...days("2026-10-01", 4), "2026-10-20"].map((d) => habit("workout", d));
    expect(byKind(P.scoreHistory(cfg, longGap), "recovery").length).toBe(0);
  });

  test("bonuses are per item: floss continuation-only, dance none", () => {
    const hist = [
      ...[...days("2026-10-01", 4), "2026-10-08"].map((d) => habit("floss", d)),
      ...days("2026-10-01", 5).map((d) => habit("dance", d)),
    ];
    const awards = P.scoreHistory(cfg, hist);
    expect(awards.some((a) => a.item === "floss" && a.kind === "continuation")).toBe(true);
    expect(awards.some((a) => a.item === "floss" && a.kind === "recovery")).toBe(false);
    expect(awards.some((a) => a.item === "dance" && a.kind !== "base")).toBe(false);
  });

  test("counter streak only counts days at/above doneAt", () => {
    const hist = [habit("phone_sep", "2026-10-01", 5), habit("phone_sep", "2026-10-02", 6), habit("phone_sep", "2026-10-03", 2), habit("phone_sep", "2026-10-04", 5)];
    const awards = P.scoreHistory(cfg, hist);
    expect(awards.find((a) => a.key === "item:phone_sep:2026-10-03")?.points).toBe(4); // reps still pay
    expect(byKind(awards, "continuation").length).toBe(0); // streak never reached 3
  });

  test("weekly target on a daily item pays on the day the target is reached", () => {
    const hist = days("2026-10-05", 6).map((d) => habit("build", d));
    const wk = byKind(P.scoreHistory(cfg, hist), "weekly_target");
    expect(wk).toEqual([expect.objectContaining({ key: "weekly:build:2026-10-05", day: "2026-10-09", points: 25 })]);
  });

  test("weekly cadence item: target, weekly streak, recovery in weeks", () => {
    const hist: Completion[] = [];
    // 3 consecutive weeks with 2 events, skip one week, then come back.
    for (const mon of ["2026-10-05", "2026-10-12", "2026-10-19", "2026-11-02"]) {
      hist.push(habit("community_event", mon), habit("community_event", P.addDays(mon, 2)));
    }
    const awards = P.scoreHistory(cfg, hist);
    expect(byKind(awards, "weekly_target").length).toBe(4);
    expect(awards.find((a) => a.key === "item:community_event:2026-10-05")?.points).toBe(15);
    expect(awards.find((a) => a.key === "streak:community_event:2026-10-19")).toMatchObject({ points: 1, day: "2026-10-21" });
    expect(awards.find((a) => a.key === "recovery:community_event:2026-11-02")?.points).toBe(8);
  });

  test("tasks feed a ≥1-task-per-day streak", () => {
    const hist: Completion[] = days("2026-10-01", 3).map((d, i) => ({
      source: "task", item: `t${i}`, day: d, units: 1, label: "t", task: { priority: 2, estimatedMinutes: null, goalLinked: false },
    }));
    expect(P.scoreHistory(cfg, hist).find((a) => a.key === "streak:tasks:2026-10-03")?.points).toBe(1);
  });

  test("unconfigured routine items score routineDefault with its bonuses", () => {
    const hist: Completion[] = days("2026-10-01", 3).map((d) => ({ source: "routine", item: "routine:make_bed", day: d, units: 1, label: "Make bed" }));
    const awards = P.scoreHistory(cfg, hist);
    expect(byKind(awards, "base").map((a) => a.points)).toEqual([3, 3, 3]);
    expect(byKind(awards, "continuation").length).toBe(1);
  });

  test("is deterministic", () => {
    const hist = [...days("2026-10-01", 5).map((d) => habit("workout", d)), habit("phone_sep", "2026-10-02", 7)];
    expect(P.scoreHistory(cfg, hist)).toEqual(P.scoreHistory(cfg, [...hist].reverse()));
  });
});

describe("ledgerDelta", () => {
  const awards = P.scoreHistory(cfg, [habit("phone_sep", "2026-10-02", 3)]);
  test("first sync appends everything, second sync appends nothing", () => {
    const first = P.ledgerDelta(awards, [], "t1");
    expect(first.length).toBe(1);
    expect(P.ledgerDelta(awards, first, "t2")).toEqual([]);
  });
  test("more units later in the day append a top-up delta", () => {
    const first = P.ledgerDelta(awards, [], "t1");
    const more = P.scoreHistory(cfg, [habit("phone_sep", "2026-10-02", 5)]);
    const delta = P.ledgerDelta(more, first, "t2");
    expect(delta).toEqual([expect.objectContaining({ key: "item:phone_sep:2026-10-02", points: 4, topUp: true })]);
  });
  test("never claws back paid points", () => {
    const paid = [{ key: "item:phone_sep:2026-10-02", points: 16 }];
    expect(P.ledgerDelta(awards, paid, "t")).toEqual([]);
  });
});

describe("currentStreaks", () => {
  const hist = [
    ...days("2026-10-01", 5).map((d) => habit("workout", d)), // alive through 10-05
    ...days("2026-09-25", 4).map((d) => habit("floss", d)), // broke after 09-28
  ];
  test("alive streak counts through yesterday", () => {
    const s = P.currentStreaks(cfg, hist, "2026-10-06").find((x) => x.item === "workout");
    expect(s).toMatchObject({ current: 5, recoverable: null });
  });
  test("broken streak shows 0 and the recoverable prior streak", () => {
    const s = P.currentStreaks(cfg, hist, "2026-10-03").find((x) => x.item === "floss");
    expect(s).toMatchObject({ current: 0, recoverable: 4 });
  });
});

describe("goal", () => {
  const ledger = [
    { day: "2026-10-05", points: 100 },
    { day: "2026-10-07", points: 50 },
    { day: "2026-09-30", points: 999 }, // previous week + month
  ];
  test("periodScore sums the period containing today", () => {
    expect(P.periodScore(ledger, "week", "2026-10-07")).toBe(150);
    expect(P.periodScore(ledger, "day", "2026-10-07")).toBe(50);
    expect(P.periodScore(ledger, "month", "2026-10-07")).toBe(150);
  });
  test("goalProgress: pct, remaining, pro-rata pace", () => {
    const p = P.goalProgress({ target: 350, period: "week", setAt: "" }, 150, "2026-10-07"); // Wed = day 3/7
    expect(p).toMatchObject({ pct: 43, remaining: 200, expectedByNow: 150, onPace: true, dayOfPeriod: 3, periodDays: 7 });
  });
  test("save/load round-trip and clear", () => {
    P.saveGoal({ target: 400, period: "week", setAt: "2026-10-07T00:00:00Z" });
    expect(P.loadGoal()).toMatchObject({ target: 400, period: "week" });
    P.saveGoal(null);
    expect(P.loadGoal()).toBeNull();
  });
});

describe("routine catalogue", () => {
  const daily = `## Anchors — Morning\n\n| Time | Activity | Notes |\n| --- | --- | --- |\n| 7:00am | Wake up, make bed | |\n\n## Blocks — Afternoon\n\n| Block | Duration |\n| ----- | -------- |\n| Workout | 60 min |\n| Boredom block | 10 min |\n\n## Not yet active (planner ignores this section)\n\n| Block | Duration |\n| --- | --- |\n| Meditation | 10 |\n`;
  const weekly = `## Anchors (day-fixed)\n\n| Day | Time-ish | Item |\n| --- | --- | --- |\n| Sunday | evening | Weekly review |\n\n## Cadence targets\n\n| Target | Item |\n| --- | --- |\n| ≥ 6 days/week | Daily lead completion |\n`;

  test("parseBehaviors reads the name column and skips inactive sections", () => {
    expect(P.parseBehaviors(daily)).toEqual(["Wake up, make bed", "Workout", "Boredom block"]);
    expect(P.parseBehaviors(weekly)).toEqual(["Weekly review", "Daily lead completion"]);
  });

  test("catalogue maps aliases to items, ignores routineIgnore, defaults the rest", () => {
    const cat = P.routineCatalogue(cfg, P.parseBehaviors(daily), P.parseBehaviors(weekly));
    expect(cat.get("workout")?.label).toBe("Workout");
    expect(cat.get("routine:boredom_block")?.cadence).toBe("daily");
    expect(cat.get("routine:weekly_review")?.cadence).toBe("weekly");
    expect([...cat.keys()].some((k) => k.includes("daily_lead"))).toBe(false);
  });

  test("resolveRoutine: exact, unique substring, ambiguous, missing", () => {
    const cat = P.routineCatalogue(cfg, P.parseBehaviors(daily), P.parseBehaviors(weekly));
    expect(P.resolveRoutine(cat, cfg, "workout")).toMatchObject({ item: "workout" });
    expect(P.resolveRoutine(cat, cfg, "make bed")).toMatchObject({ item: "routine:wake_up_make_bed" });
    expect("error" in P.resolveRoutine(cat, cfg, "b")).toBe(true);
    expect("error" in P.resolveRoutine(cat, cfg, "juggling")).toBe(true);
  });
});

describe("habit sources", () => {
  test("habitCompletions maps slugs, keeps counter values, skips zero/unknown", () => {
    const out = P.habitCompletions(cfg, [
      { date: "2026-10-02", habit: "workout", value: "1" },
      { date: "2026-10-02", habit: "phone_sep", value: "6" },
      { date: "2026-10-02", habit: "floss", value: "0" },
      { date: "2026-10-02", habit: "juggling", value: "1" },
    ]);
    expect(out.map((c) => [c.item, c.units])).toEqual([["workout", 1], ["phone_sep", 6]]);
  });
  test("dedupeToggles: a habit log + routine check of the same item pay once", () => {
    const out = P.dedupeToggles(cfg, [
      habit("workout", "2026-10-02"),
      { source: "routine", item: "workout", day: "2026-10-02", units: 1, label: "Workout" },
      habit("phone_sep", "2026-10-02", 3),
      habit("phone_sep", "2026-10-02", 2),
    ]);
    expect(out.filter((c) => c.item === "workout").length).toBe(1);
    expect(out.filter((c) => c.item === "phone_sep").length).toBe(2);
  });
});

describe("syncLedger end-to-end (temp DBs, read-only sources)", () => {
  const tasksDb = join(TMP, "tasks.db");
  const lifeosDb = join(TMP, "lifeos.db");
  const t = new Database(tasksDb);
  t.exec("CREATE TABLE tasks (id TEXT, title TEXT, status TEXT, priority INTEGER, estimated_minutes INTEGER, goal_id TEXT, disposition TEXT, completed_at TEXT)");
  const ins = t.prepare("INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?)");
  ins.run("t-mine", "Call landlord", "done", 1, null, null, "personal-todo", "2026-10-06T18:00:00.000Z");
  ins.run("t-agent", "Agent task", "done", 1, null, null, "autonomous", "2026-10-06T18:00:00.000Z");
  ins.run("t-open", "Open task", "next", 1, null, null, null, null);
  t.close();
  const l = new Database(lifeosDb);
  l.exec("CREATE TABLE habit_log (date TEXT, habit TEXT, value TEXT, notes TEXT)");
  l.prepare("INSERT INTO habit_log VALUES (?,?,?,?)").run("2026-10-06", "workout", "1", "");
  l.prepare("INSERT INTO habit_log VALUES (?,?,?,?)").run("2026-12-31", "workout", "1", ""); // future-dated
  l.close();
  const paths = { tasksDb, lifeosDb, dailyBehaviors: join(TMP, "none.md"), weeklyBehaviors: join(TMP, "none.md") };
  writeFileSync(join(TMP, "none.md"), "");

  test("readTaskCompletions excludes agent dispositions and open tasks", () => {
    const out = P.readTaskCompletions(cfg, tasksDb);
    expect(out.map((c) => c.item)).toEqual(["t-mine"]);
  });

  test("sync writes the ledger once; re-sync is a no-op; routine check adds points", async () => {
    const now = new Date("2026-10-07T12:00:00");
    const first = await P.syncLedger(cfg, now, paths);
    const keys = first.appended.map((e) => e.key).sort();
    expect(keys).toEqual(["item:workout:2026-10-06", "task:t-mine"]);
    expect(existsSync(P.pointsPaths().ledger)).toBe(true);

    const again = await P.syncLedger(cfg, now, paths);
    expect(again.appended).toEqual([]);
    expect(again.ledger.reduce((s, e) => s + e.points, 0)).toBe(25);

    P.appendRoutineCheck({ at: now.toISOString(), day: "2026-10-07", item: "routine:make_bed", label: "Make bed", cadence: "daily" });
    const third = await P.syncLedger(cfg, now, paths);
    expect(third.appended.map((e) => [e.key, e.points])).toEqual([["item:routine:make_bed:2026-10-07", 3]]);
    expect(P.readPointsLedger().length).toBe(3);
  });

  test("dry-run does not write", async () => {
    P.appendRoutineCheck({ at: "x", day: "2026-10-06", item: "routine:make_bed", label: "Make bed", cadence: "daily" });
    const before = P.readPointsLedger().length;
    const dry = await P.syncLedger(cfg, new Date("2026-10-07T12:00:00"), paths, true);
    expect(dry.appended.length).toBe(1);
    expect(P.readPointsLedger().length).toBe(before);
  });
});

describe("shipped config", () => {
  test("rewards.json has a valid points section", async () => {
    const { loadConfig } = await import("../Tools/RewardEngine.ts");
    const pc = loadConfig().points;
    expect(pc).toBeDefined();
    if (!pc) return;
    expect(/^\d{4}-\d{2}-\d{2}$/.test(pc.startDate)).toBe(true);
    expect(pc.items[pc.tasks.streakItem]).toBeDefined();
    for (const [id, d] of Object.entries(pc.items)) {
      expect(["daily", "weekly"]).toContain(d.cadence);
      expect(d.points >= 0 || d.unitPoints !== undefined).toBe(true);
      for (const b of d.bonuses) expect(["continuation", "recovery"]).toContain(b);
      expect(id.length).toBeGreaterThan(0);
    }
  });
});
