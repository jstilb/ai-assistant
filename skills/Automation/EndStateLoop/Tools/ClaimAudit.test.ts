import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Board, Unit } from "./Board.ts";
import { buildBrief, checkSection, decide, extractAudit, findPost, mergedCommit, pickUnit, type Verdict } from "./ClaimAudit.ts";

const ROOT = mkdtempSync(join(tmpdir(), "endstate-claimaudit-test-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

function unit(id: string, over: Partial<Unit> = {}): Unit {
  return {
    id,
    row: "E2",
    contract: `/x/units/${id}-E2.md`,
    builder: `b-${id}`,
    startedAt: "2026-11-24T10:00:00-08:00",
    endedAt: "2026-11-24T11:00:00-08:00",
    result: "pass",
    statusHashAtOpen: "0".repeat(64),
    rowStatusAtOpen: "failed",
    moved: true,
    note: "",
    kind: "product",
    shipped: "abc1234def on local and origin main",
    ...over,
  };
}

function board(units: Unit[]): Board {
  return {
    schema: "endstate-board/v1" as Board["schema"],
    project: "demo",
    folder: "/x/repo",
    endState: { source: "END.md", approvedBy: "Jm", summary: "s" },
    finalCheck: [],
    rows: [
      {
        id: "E2",
        sentence: "Every touch is typed",
        source: 'AL:551 "tags every touch"',
        test: { name: "t", kind: "known-answer", command: null, passRule: "r", ruleFile: null, ruleSetAt: "2026-11-17T10:00:00-08:00" },
        status: "failed",
        gap: "g",
        rank: 1,
        marks: [],
      },
    ],
    units,
  };
}

const NOW = Date.parse("2026-11-24T15:00:00-08:00");

describe("pickUnit", () => {
  test("oldest unaudited unit that shipped a live change, at or after --since", () => {
    const b = board([
      unit("U5"),
      unit("U6", { audit: { at: "x", by: "y", result: "pass", note: "n", evidence: [] } }),
      unit("U7", { shipped: "none", moved: false }),
      unit("U8", { result: "open", endedAt: null, moved: null, shipped: null }),
      unit("U10"),
      unit("U9"),
    ]);
    expect(pickUnit(b, 0, () => null, NOW)?.id).toBe("U5");
    expect(pickUnit(b, 6, () => null, NOW)?.id).toBe("U9");
    expect(pickUnit(board([unit("U7", { shipped: "none" })]), 0, () => null, NOW)).toBeNull();
  });
  test("a recent or third failed attempt holds the unit back", () => {
    const b = board([unit("U1"), unit("U2")]);
    const recent = { n: 1, last: "2026-11-24T14:50:00-08:00" };
    const old = { n: 1, last: "2026-11-24T14:00:00-08:00" };
    const third = { n: 3, last: "2026-11-24T10:00:00-08:00" };
    expect(pickUnit(b, 0, (id) => (id === "U1" ? recent : null), NOW)?.id).toBe("U2");
    expect(pickUnit(b, 0, (id) => (id === "U1" ? old : null), NOW)?.id).toBe("U1");
    expect(pickUnit(b, 0, (id) => (id === "U1" ? third : null), NOW)?.id).toBe("U2");
  });
});

test("mergedCommit takes the first hex run of shipped", () => {
  expect(mergedCommit(unit("U1", { shipped: "6efeb886c245 on local and origin main" }))).toBe("6efeb886c245");
  expect(mergedCommit(unit("U1", { shipped: "main 5815ba1, Worker c2904c55" }))).toBe("5815ba1");
  expect(mergedCommit(unit("U1", { shipped: "deployed" }))).toBeNull();
});

test("findPost: the newest post whose facts.closed names the unit, else the newest post written while it was open", () => {
  const out = join(ROOT, "out");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "demo-0001.json"), JSON.stringify({ at: "2026-11-24T09:00:00-08:00", facts: { closed: [{ id: "U5" }] } }));
  writeFileSync(join(out, "demo-0002.json"), JSON.stringify({ at: "2026-11-24T09:30:00-08:00", facts: { closed: [{ id: "U5" }, { id: "U6" }] } }));
  writeFileSync(join(out, "demo-0003.json"), JSON.stringify({ at: "2026-11-24T10:30:00-08:00", facts: { closed: [] } }));
  writeFileSync(join(out, "demo-0004.json"), JSON.stringify({ at: "2026-11-24T11:05:00-08:00", facts: { closed: [] } }));
  writeFileSync(join(out, "demo-0005.json"), JSON.stringify({ at: "2026-11-24T11:30:00-08:00", facts: { closed: [] } }));
  writeFileSync(join(out, "demo-0006.json"), "{ not json");
  expect(findPost(out, unit("U5"))).toBe(join(out, "demo-0002.json"));
  // U9 ran 10:00-11:00: 0004 (11:05) is within 10 min of the close and newer than 0003; 0005 (11:30) is too late.
  expect(findPost(out, unit("U9"))).toBe(join(out, "demo-0004.json"));
  expect(findPost(out, unit("U9", { startedAt: "2026-11-24T12:00:00-08:00", endedAt: "2026-11-24T13:00:00-08:00" }))).toBeNull();
  expect(findPost(join(ROOT, "missing"), unit("U5"))).toBeNull();
});

test("checkSection takes the claim-audit section of the real Check.md, up to the next heading", () => {
  const real = readFileSync(join(import.meta.dir, "..", "Workflows", "Check.md"), "utf-8");
  const s = checkSection(real);
  expect(s.startsWith("## Claim audit (per merge)")).toBe(true);
  expect(s).toContain("On UNCLEAR or over-wide");
  expect(s).not.toContain("## Do not");
  expect(() => checkSection("# no section")).toThrow();
});

test("buildBrief names the commit, the row words, the post and the rules, and forbids the builder's verdict", () => {
  const b = board([unit("U5")]);
  const brief = buildBrief({ board: b, boardPath: "/x/endstate/SCOREBOARD.json", unit: b.units[0], commit: "abc1234def", post: "/x/out/demo-0002.json", rules: "RULES-TEXT" });
  expect(brief).toContain("abc1234def");
  expect(brief).toContain('"Every touch is typed"');
  expect(brief).toContain('AL:551 "tags every touch"');
  expect(brief).toContain("/x/out/demo-0002.json");
  expect(brief).toContain("/x/endstate/units/U5");
  expect(brief).toContain("RULES-TEXT");
  expect(brief).toContain("Do NOT use the builder's or reviewer's verdict");
  expect(buildBrief({ board: b, boardPath: "/x/S.json", unit: b.units[0], commit: "c", post: null, rules: "R" })).toContain("No status post names this unit");
});

describe("decide (Check.md rules)", () => {
  const v = (o: Partial<Verdict>): Verdict => ({ true: 0, false: 0, unclear: 0, liveChange: "verified", note: "n", ...o });
  test("any FALSE fails, with a correction", () => {
    expect(decide(v({ true: 4, false: 1 }))).toEqual({ result: "fail", correction: true });
  });
  test("UNCLEAR passes only when the live change is verified", () => {
    expect(decide(v({ true: 2, unclear: 1 }))).toEqual({ result: "pass", correction: true });
    expect(decide(v({ true: 2, unclear: 1, liveChange: "not-verified" }))).toEqual({ result: "fail", correction: true });
  });
  test("all TRUE passes; no claims at all is no verdict", () => {
    expect(decide(v({ true: 3 }))).toEqual({ result: "pass", correction: false });
    expect(decide(v({}))).toBeNull();
  });
});

test("extractAudit takes the audit block, or null", () => {
  expect(extractAudit("x <audit>\n- TRUE: a — f:1\n</audit> <verdict>{}</verdict>")).toBe("- TRUE: a — f:1");
  expect(extractAudit("<audit>  </audit>")).toBeNull();
  expect(extractAudit("no block")).toBeNull();
});
