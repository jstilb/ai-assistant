import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Board, localIso, type Mark, parseBoard, type Row } from "./Board.ts";

const TOOL = join(import.meta.dir, "Board.ts");
const ROOT = mkdtempSync(join(tmpdir(), "endstate-board-test-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const LOCAL_ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/;

function mark(over: Partial<Mark>): Mark {
  return { at: "2026-11-09T10:00:00-08:00", by: "setup-1", role: "setup", status: "claimed", evidence: [], set: null, note: "loop test passes", ...over };
}

function newRow(id: string, over: Partial<Row>): Row {
  return {
    id,
    sentence: `Sentence of ${id}.`,
    source: "END_STATE.md",
    test: { name: `test-${id}`, kind: "known-answer", command: null, passRule: "10 of 10 planted faults found", ruleFile: null, ruleSetAt: "2026-11-09T09:00:00-08:00" },
    status: "untested",
    gap: `gap of ${id}`,
    rank: null,
    marks: [],
    ...over,
  };
}

/** R1 proven (examiner, set S1, evidence on disk + a URL), R2 claimed rank 1, R3 untested kind none rank 2, U1 closed and moved. */
function goodBoard(ev: string): Board {
  return {
    schema: "endstate-board/v1",
    project: "demo",
    folder: "/tmp/demo",
    endState: { source: "/tmp/demo/END_STATE.md", approvedBy: "Jm 2026-11-09", summary: "A demo product." },
    finalCheck: [{ what: "Jm reads one edition", value: "not yet", readAt: "2026-11-09T10:00:00-08:00" }],
    rows: [
      newRow("R1", {
        status: "proven",
        marks: [mark({}), mark({ by: "exam-1", role: "examiner", status: "proven", set: "S1", evidence: [ev, "https://example.com/run/1"] })],
      }),
      newRow("R2", { status: "claimed", rank: 1, marks: [mark({})] }),
      newRow("R3", { test: { name: "none-yet", kind: "none", command: null, passRule: null, ruleFile: null, ruleSetAt: null }, rank: 2 }),
    ],
    units: [
      {
        id: "U1",
        row: "R2",
        contract: "/tmp/demo/U1.md",
        builder: "demo-build-U1",
        startedAt: "2026-11-09T09:00:00-08:00",
        endedAt: "2026-11-09T09:30:00-08:00",
        result: "pass",
        statusHashAtOpen: "0",
        rowStatusAtOpen: null,
        moved: true,
        note: "",
        kind: "product",
        shipped: "abc1234 on main, live in the runner",
      },
    ],
  };
}

function row(b: Board, id: string): Row {
  const r = b.rows.find((x) => x.id === id);
  if (r === undefined) throw new Error(`fixture has no row ${id}`);
  return r;
}

function lastMark(r: Row): Mark {
  const m = r.marks.at(-1);
  if (m === undefined) throw new Error(`row ${r.id} has no marks`);
  return m;
}

function omit(o: object, key: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...o };
  delete copy[key];
  return copy;
}

interface Case {
  dir: string;
  path: string;
  ev: string;
}

/** A temp folder with an evidence file and a board; `edit` mutates the board or returns what to write. */
function setup(edit: (b: Board, ev: string, dir: string) => unknown = (b) => b): Case {
  const dir = mkdtempSync(join(ROOT, "case-"));
  const ev = join(dir, "exam-result.json");
  writeFileSync(ev, "{}\n");
  const path = join(dir, "SCOREBOARD.json");
  writeFileSync(path, `${JSON.stringify(edit(goodBoard(ev), ev, dir), null, 2)}\n`);
  return { dir, path, ev };
}

function runEnv(env: Record<string, string>, ...args: string[]): { code: number; out: string; err: string } {
  const p = Bun.spawnSync([process.execPath, TOOL, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

function run(...args: string[]): { code: number; out: string; err: string } {
  return runEnv({}, ...args);
}

function read(path: string): Board {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const { board, errors } = parseBoard(raw);
  if (board === null || errors.length > 0) throw new Error(`bad board: ${errors.join("; ")}`);
  return board;
}

describe("validate", () => {
  test("a good board passes", () => {
    const c = setup();
    const r = run("validate", c.path);
    expect(r.err).toBe("");
    expect(r.out.trim()).toBe("OK: 3 rows, 1 units");
    expect(r.code).toBe(0);
  });

  const errorCases: [string, (b: Board, ev: string, dir: string) => unknown, string][] = [
    ["wrong schema", (b) => ({ ...b, schema: "endstate-board/v0" }), 'board.schema: expected "endstate-board/v1"'],
    ["missing field", (b) => ({ ...b, rows: b.rows.map((r) => (r.id === "R2" ? omit(r, "gap") : r)) }), "board.rows[1].gap: missing"],
    ["wrong-typed field", (b) => ({ ...b, rows: b.rows.map((r) => (r.id === "R2" ? { ...r, rank: "1" } : r)) }), 'board.rows[1].rank: expected an integer >= 1 or null, got "1"'],
    ["unknown field", (b) => ({ ...b, extra: 1 }), 'board: unknown field "extra"'],
    ["duplicate row id", (b) => { row(b, "R3").id = "R2"; return b; }, "duplicate row id R2"],
    ["duplicate unit id", (b) => ({ ...b, units: [...b.units, ...b.units] }), "duplicate unit id U1"],
    ["status differs from last mark", (b) => { row(b, "R2").status = "failed"; return b; }, "R2: status failed differs from its last mark status claimed"],
    ["no marks but not untested", (b) => { const r = row(b, "R3"); r.test.kind = "judged"; r.test.passRule = "x"; r.status = "failed"; return b; }, "R3: status failed but no marks"],
    ["proven by setup", (b) => { lastMark(row(b, "R1")).role = "setup"; return b; }, "R1: proven but the last mark has role setup, not examiner"],
    ["proven with set null", (b) => { lastMark(row(b, "R1")).set = null; return b; }, "R1: proven but the last mark has set null"],
    ["proven with no evidence", (b) => { lastMark(row(b, "R1")).evidence = []; return b; }, "R1: proven but the last mark has no evidence"],
    ["proven with missing evidence", (b, _ev, dir) => { lastMark(row(b, "R1")).evidence = [join(dir, "missing.json")]; return b; }, "missing.json\" does not exist"],
    ["proven with relative evidence", (b) => { lastMark(row(b, "R1")).evidence = ["out/result.json"]; return b; }, "is not an absolute path"],
    ["kind none but claimed", (b) => { row(b, "R2").test.kind = "none"; return b; }, "R2: status claimed but test.kind is none"],
    ["claimed with passRule null", (b) => { row(b, "R2").test.passRule = null; return b; }, "R2: status claimed but test.passRule is null"],
    ["duplicate rank", (b) => { row(b, "R3").rank = 1; return b; }, "duplicate rank 1: R2, R3"],
    ["unit row not a row id", (b) => { b.units.forEach((u) => (u.row = "R9")); return b; }, "U1: row R9 is not a row id"],
    ["closed unit with moved null", (b) => { b.units.forEach((u) => (u.moved = null)); return b; }, "U1: closed unit (pass) must have endedAt and moved set"],
    ["empty rows", (b) => ({ ...b, rows: [], units: [] }), "board.rows: empty"],
  ];
  for (const [name, edit, message] of errorCases) {
    test(`error: ${name}`, () => {
      const c = setup(edit);
      const r = run("validate", c.path);
      expect(r.err).toContain(message);
      expect(r.out).toBe("");
      expect(r.code).toBe(1);
    });
  }

  test("warnings keep exit 0: missing evidence on a non-proven row, rank null", () => {
    const c = setup((b, _ev, dir) => {
      const r2 = row(b, "R2");
      lastMark(r2).evidence = [join(dir, "gone.json")];
      r2.rank = null;
      return b;
    });
    const r = run("validate", c.path);
    expect(r.err).toContain('warning: R2: evidence "');
    expect(r.err).toContain("gone.json\" does not exist");
    expect(r.err).toContain("warning: R2: claimed row has rank null");
    expect(r.out.trim()).toBe("OK: 3 rows, 1 units");
    expect(r.code).toBe(0);
  });

  test("URL evidence is not checked on disk", () => {
    const c = setup((b) => {
      lastMark(row(b, "R1")).evidence = ["https://example.com/never-on-disk", "http://example.com/x"];
      return b;
    });
    const r = run("validate", c.path);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
  });

  test("an invalid board blocks the read commands", () => {
    const c = setup((b) => {
      row(b, "R2").status = "failed";
      return b;
    });
    for (const cmd of ["next", "gate", "show"]) {
      const r = run(cmd, c.path);
      expect(r.code).toBe(1);
      expect(r.err).toContain("board invalid");
    }
  });
});

describe("mark", () => {
  test("an examiner with a set and evidence on disk marks proven", () => {
    const c = setup();
    const r = run("mark", c.path, "--row", "R2", "--status", "proven", "--by", "exam-2", "--role", "examiner", "--set", "S2", "--evidence", c.ev, "--note", "10 of 10");
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const r2 = row(read(c.path), "R2");
    expect(r2.status).toBe("proven");
    expect(r2.rank).toBe(null);
    const m = lastMark(r2);
    expect(m).toMatchObject({ by: "exam-2", role: "examiner", status: "proven", set: "S2", evidence: [c.ev], note: "10 of 10" });
    expect(m.at).toMatch(LOCAL_ISO);
  });

  const refusals: [string, (c: Case) => string[], string, ((b: Board) => Board)?][] = [
    ["setup cannot mark proven", (c) => ["--row", "R2", "--status", "proven", "--by", "s", "--role", "setup", "--set", "S2", "--evidence", c.ev], "role setup cannot mark proven"],
    ["proven needs a set", (c) => ["--row", "R2", "--status", "proven", "--by", "e", "--role", "examiner", "--evidence", c.ev], "proven needs --set"],
    ["proven needs evidence", () => ["--row", "R2", "--status", "proven", "--by", "e", "--role", "examiner", "--set", "S2"], "proven needs --evidence"],
    ["proven needs evidence that exists", (c) => ["--row", "R2", "--status", "proven", "--by", "e", "--role", "examiner", "--set", "S2", "--evidence", join(c.dir, "nope.json")], "nope.json\" does not exist"],
    ["failed needs a pass rule", () => ["--row", "R3", "--status", "failed", "--by", "s", "--role", "setup"], "R3: status failed but test.passRule is null"],
    [
      "claimed needs a test kind other than none",
      () => ["--row", "R3", "--status", "claimed", "--by", "s", "--role", "setup"],
      "R3: status claimed but test.kind is none",
      (b) => {
        row(b, "R3").test.passRule = "a rule";
        return b;
      },
    ],
    ["unknown row", () => ["--row", "R9", "--status", "claimed", "--by", "s", "--role", "setup"], "refused: unknown row R9"],
  ];
  for (const [name, flags, message, edit] of refusals) {
    test(`refused: ${name}; file byte-identical`, () => {
      const c = setup(edit);
      const before = readFileSync(c.path);
      const r = run("mark", c.path, ...flags(c), "--note", "n");
      expect(r.err).toContain(message);
      expect(r.code).toBe(1);
      expect(readFileSync(c.path).equals(before)).toBe(true);
      expect(existsSync(`${c.path}.bak`)).toBe(false);
      expect(existsSync(`${c.path}.lock`)).toBe(false);
    });
  }

  test("a write is 2-space JSON with a trailing newline, .bak holds the old file, no temp file or lock left", () => {
    const c = setup();
    const before = readFileSync(c.path);
    expect(run("mark", c.path, "--row", "R2", "--status", "failed", "--by", "s", "--role", "setup", "--note", "n").code).toBe(0);
    const text = readFileSync(c.path, "utf8");
    expect(text.startsWith('{\n  "schema": "endstate-board/v1",\n')).toBe(true);
    expect(text.endsWith("}\n")).toBe(true);
    expect(readFileSync(`${c.path}.bak`).equals(before)).toBe(true);
    expect(readdirSync(c.dir).sort()).toEqual(["SCOREBOARD.json", "SCOREBOARD.json.bak", "exam-result.json"]);
  });
});

describe("lock", () => {
  test("five writers at once all land and the board stays valid", async () => {
    const ids = ["R2", "R3", "R4", "R5", "R6"];
    const c = setup((b) => {
      const r3 = row(b, "R3");
      r3.test.kind = "judged";
      r3.test.passRule = "judge passes";
      b.rows.push(newRow("R4", { rank: 3 }), newRow("R5", { rank: 4 }), newRow("R6", { rank: 5 }));
      return b;
    });
    const procs = ids.map((id) =>
      Bun.spawn([process.execPath, TOOL, "mark", c.path, "--row", id, "--status", "failed", "--by", `w-${id}`, "--role", "setup", "--note", "n"], {
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    expect(await Promise.all(procs.map((p) => p.exited))).toEqual([0, 0, 0, 0, 0]);
    const b = read(c.path);
    for (const id of ids) expect(lastMark(row(b, id))).toMatchObject({ by: `w-${id}`, status: "failed" });
    expect(run("validate", c.path).code).toBe(0);
    expect(existsSync(`${c.path}.lock`)).toBe(false);
  });

  test("a stale lock (older than 60 s) is taken", () => {
    const c = setup();
    const lock = `${c.path}.lock`;
    mkdirSync(lock);
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    const r = run("mark", c.path, "--row", "R2", "--status", "failed", "--by", "s", "--role", "setup", "--note", "n");
    expect(r.code).toBe(0);
    expect(r.err).toContain(`took stale lock ${lock}`);
    expect(row(read(c.path), "R2").status).toBe("failed");
    expect(existsSync(lock)).toBe(false);
  });

  test("a live lock held past the timeout gives exit 1, names the lock, and changes nothing", () => {
    const c = setup();
    const lock = `${c.path}.lock`;
    mkdirSync(lock);
    const before = readFileSync(c.path);
    const started = Date.now();
    const r = runEnv({ BOARD_LOCK_TIMEOUT_MS: "300" }, "mark", c.path, "--row", "R2", "--status", "failed", "--by", "s", "--role", "setup", "--note", "n");
    expect(r.code).toBe(1);
    expect(r.err).toContain(`refused: board is locked by another writer: ${lock}`);
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(readFileSync(c.path).equals(before)).toBe(true);
    expect(existsSync(`${c.path}.bak`)).toBe(false);
    expect(existsSync(lock)).toBe(true);
  });

  test("a bad BOARD_LOCK_TIMEOUT_MS is a usage error", () => {
    const c = setup();
    const r = runEnv({ BOARD_LOCK_TIMEOUT_MS: "soon" }, "mark", c.path, "--row", "R2", "--status", "failed", "--by", "s", "--role", "setup", "--note", "n");
    expect(r.code).toBe(2);
    expect(r.err).toContain("BOARD_LOCK_TIMEOUT_MS must be a whole number");
  });
});

describe("units and gate", () => {
  function openUnit(c: Case, rowId = "R2", kind = "product"): string {
    const r = run("unit-open", c.path, "--row", rowId, "--contract", join(c.dir, "contract.md"), "--builder", "demo-build", "--kind", kind);
    expect(r.code).toBe(0);
    return r.out.trim();
  }
  function closeUnit(c: Case, id: string, result = "fail", shipped = "def5678 on main, live in the service"): Board {
    expect(run("unit-close", c.path, "--unit", id, "--result", result, "--shipped", shipped, "--note", "n").code).toBe(0);
    return read(c.path);
  }
  /** setup() with a pass rule on R3, so that R3 can be marked failed or claimed. */
  function ruled(edit: (b: Board) => unknown = (b) => b): Case {
    return setup((b) => {
      row(b, "R3").test = { name: "t3", kind: "known-answer", command: null, passRule: "9 of 10", ruleFile: null, ruleSetAt: "2026-11-09T09:00:00-08:00" };
      return edit(b);
    });
  }
  function setupMark(c: Case, rowId: string, status: string): void {
    const r = run("mark", c.path, "--row", rowId, "--status", status, "--by", "s", "--role", "setup", "--note", "n");
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
  }
  function unit(b: Board, id: string): Board["units"][number] {
    const u = b.units.find((x) => x.id === id);
    if (u === undefined) throw new Error(`no unit ${id}`);
    return u;
  }
  /** Write a re-plan file with one "Re-plan at:" line per time (the file time is now). */
  function stampFile(c: Case, name: string, ...isos: string[]): void {
    writeFileSync(join(c.dir, name), `# re-plan\n\n${isos.map((t) => `Re-plan at: ${t}\n`).join("")}`);
  }
  /** The end of a RE-PLAN line that names the re-plan files which answer it. */
  function answer(...rows: string[]): string {
    return `; a re-plan in ${rows.map((r) => `REPLAN-${r}.md`).join(" or ")} with the line "Re-plan at: <date +%Y-%m-%dT%H:%M:%S%z>" answers it`;
  }

  test("unit-open adds the next id as an open unit", () => {
    const c = setup();
    expect(openUnit(c)).toBe("U2");
    const u = unit(read(c.path), "U2");
    expect(u).toMatchObject({ row: "R2", builder: "demo-build", result: "open", endedAt: null, moved: null, note: "", rowStatusAtOpen: "claimed", kind: "product", shipped: null });
    expect(u.statusHashAtOpen).toMatch(/^[0-9a-f]{64}$/);
    expect(u.startedAt).toMatch(LOCAL_ISO);
  });

  test("moved is true when the unit passed, shipped a change, and its own row went up", () => {
    const c = ruled();
    const id = openUnit(c, "R3");
    setupMark(c, "R3", "claimed");
    const u = unit(closeUnit(c, id, "pass"), id);
    expect(u.moved).toBe(true);
    expect(u.result).toBe("pass");
    expect(u.shipped).toBe("def5678 on main, live in the service");
    expect(u.endedAt ?? "").toMatch(LOCAL_ISO);
  });

  test("moved is false with --shipped none, even when the row went up", () => {
    const c = ruled();
    const id = openUnit(c, "R3");
    setupMark(c, "R3", "claimed");
    const r = run("unit-close", c.path, "--unit", id, "--result", "pass", "--shipped", "none", "--note", "n");
    expect(r.out).toBe(`${id}: pass, moved false (R3 untested -> claimed; shipped none)\n`);
    expect(unit(read(c.path), id)).toMatchObject({ moved: false, shipped: "none" });
  });

  test("moved is false for untested -> failed, even with a shipped change; failed -> claimed with a shipped change moves", () => {
    const c = ruled();
    const first = openUnit(c, "R3");
    setupMark(c, "R3", "failed");
    expect(unit(closeUnit(c, first, "pass"), first).moved).toBe(false);
    const second = openUnit(c, "R3");
    setupMark(c, "R3", "claimed");
    expect(run("unit-close", c.path, "--unit", second, "--result", "pass", "--shipped", "f00 on main", "--note", "n").out).toBe(
      `${second}: pass, moved true (R3 failed -> claimed; shipped a change)\n`,
    );
  });

  test("unit-open needs --kind product|test; unit-close needs a non-empty --shipped", () => {
    const c = setup();
    const before = readFileSync(c.path);
    const base = ["unit-open", c.path, "--row", "R2", "--contract", join(c.dir, "contract.md"), "--builder", "demo-build"];
    for (const args of [base, [...base, "--kind", "docs"]]) {
      const r = run(...args);
      expect(r.code).toBe(2);
      expect(r.err).toContain("usage: bun Board.ts");
    }
    expect(readFileSync(c.path).equals(before)).toBe(true);
    const id = openUnit(c);
    const opened = readFileSync(c.path);
    for (const shipped of [null, "", "  "]) {
      const args = ["unit-close", c.path, "--unit", id, "--result", "pass", "--note", "n", ...(shipped === null ? [] : ["--shipped", shipped])];
      const r = run(...args);
      expect(r.code).toBe(2);
      expect(r.err).toContain(shipped === null ? "missing flag --shipped" : "--shipped needs what went live");
    }
    expect(readFileSync(c.path).equals(opened)).toBe(true);
  });

  test("a second test unit on one row is refused; product units and a test unit on another row are fine", () => {
    const c = ruled();
    const t1 = openUnit(c, "R2", "test");
    closeUnit(c, t1, "pass", "none");
    const before = readFileSync(c.path);
    const r = run("unit-open", c.path, "--row", "R2", "--contract", join(c.dir, "contract.md"), "--builder", "demo-build", "--kind", "test");
    expect(r.code).toBe(1);
    expect(r.err).toContain(`refused: row R2 already has the test unit ${t1}; put the test inside a product unit, or ask the examiner for a known-answer rule`);
    expect(readFileSync(c.path).equals(before)).toBe(true);
    const product = openUnit(c, "R2");
    expect(unit(read(c.path), product).kind).toBe("product");
    const other = openUnit(c, "R3", "test");
    expect(unit(read(c.path), other).kind).toBe("test");
  });

  test("a unit with a kind: open needs shipped null, closed needs shipped set, a bad kind or empty shipped is an error", () => {
    const cases: [(u: Board["units"][number]) => unknown, string][] = [
      [(u) => ({ ...u, result: "open", endedAt: null, moved: null }), "U1: open unit must have shipped null"],
      [(u) => ({ ...u, shipped: null }), "U1: closed unit with a kind (opened from release 11) must have shipped set"],
      [(u) => ({ ...u, kind: "docs" }), 'board.units[0].kind: expected "product" | "test" or null, got "docs"'],
      [(u) => ({ ...u, shipped: 7 }), "board.units[0].shipped: expected a string or null, got 7"],
      [(u) => ({ ...u, shipped: " " }), 'U1.shipped: empty (use "none" when nothing went live)'],
    ];
    for (const [edit, message] of cases) {
      const c = setup((b) => ({ ...b, units: [edit(unit(b, "U1"))] }));
      const r = run("validate", c.path);
      expect(r.err).toContain(message);
      expect(r.code).toBe(1);
    }
  });

  test("moved is false when a mark changed another row (a parallel exam)", () => {
    const c = ruled();
    const id = openUnit(c, "R3");
    setupMark(c, "R2", "failed");
    expect(unit(closeUnit(c, id, "pass"), id).moved).toBe(false);
  });

  test("moved is false when the row went up but the unit failed", () => {
    const c = ruled();
    const id = openUnit(c, "R3");
    setupMark(c, "R3", "claimed");
    expect(unit(closeUnit(c, id, "fail"), id).moved).toBe(false);
  });

  test("moved is false when the row went down or kept its status", () => {
    const c = setup();
    const down = openUnit(c);
    setupMark(c, "R2", "failed");
    expect(unit(closeUnit(c, down, "pass"), down).moved).toBe(false);
    const same = openUnit(c);
    setupMark(c, "R2", "failed");
    expect(unit(closeUnit(c, same, "pass"), same).moved).toBe(false);
  });

  test("a unit from before rowStatusAtOpen: valid, and unit-close reads the row's marks before its start", () => {
    const c = ruled((b) => {
      const open = { ...unit(b, "U1"), id: "U2", row: "R3", endedAt: null, result: "open", moved: null, shipped: null };
      return { ...b, units: [omit(unit(b, "U1"), "rowStatusAtOpen"), omit(open, "rowStatusAtOpen")] };
    });
    expect(run("validate", c.path).code).toBe(0);
    setupMark(c, "R3", "claimed");
    expect(run("unit-close", c.path, "--unit", "U2", "--result", "pass", "--shipped", "x", "--note", "n").out).toContain("moved true (R3 untested -> claimed; shipped a change)");
  });

  test("an old board without kind and shipped validates; its open unit closes with --shipped and keeps kind null", () => {
    const c = ruled((b) => {
      const old = (u: object) => omit(omit(omit(u, "kind"), "shipped"), "rowStatusAtOpen");
      const open = { ...unit(b, "U1"), id: "U2", row: "R3", endedAt: null, result: "open", moved: null };
      return { ...b, units: [old(unit(b, "U1")), old(open)] };
    });
    expect(run("validate", c.path)).toMatchObject({ code: 0, out: "OK: 3 rows, 2 units\n" });
    expect(unit(read(c.path), "U1")).toMatchObject({ kind: null, shipped: null, moved: true });
    setupMark(c, "R3", "claimed");
    const b = closeUnit(c, "U2", "pass");
    expect(unit(b, "U2")).toMatchObject({ kind: null, shipped: "def5678 on main, live in the service", moved: true });
    expect(unit(b, "U1")).toMatchObject({ kind: null, shipped: null, moved: true });
    expect(run("validate", c.path).code).toBe(0);
  });

  test("unit-open refuses a contract or builder name with another unit id; a name with no id or the right id is fine", () => {
    const c = setup();
    const before = readFileSync(c.path);
    const open = (contract: string, builder: string) => run("unit-open", c.path, "--row", "R2", "--contract", join(c.dir, contract), "--builder", builder, "--kind", "product");
    const badContract = open("U6-R2.md", "demo-unit-U2");
    expect(badContract.code).toBe(1);
    expect(badContract.err).toContain("refused: the contract name U6-R2.md says U6, but this unit gets the id U2");
    const badBuilder = open("U2-R2.md", "demo-unit-U6");
    expect(badBuilder.code).toBe(1);
    expect(badBuilder.err).toContain("refused: the builder name demo-unit-U6 says U6, but this unit gets the id U2");
    expect(readFileSync(c.path).equals(before)).toBe(true);
    expect(open("U2-R2.md", "demo-unit-U2")).toMatchObject({ code: 0, out: "U2\n" });
    expect(open("R18a-R2.md", "demo-unit-R18a")).toMatchObject({ code: 0, out: "U3\n" });
  });

  test("a unit that is not open cannot be closed", () => {
    const c = setup();
    const before = readFileSync(c.path);
    const r = run("unit-close", c.path, "--unit", "U1", "--result", "pass", "--shipped", "none", "--note", "n");
    expect(r.err).toContain("refused: unit U1 is not open");
    expect(r.code).toBe(1);
    expect(readFileSync(c.path).equals(before)).toBe(true);
  });

  test("gate: GO at stall 1, RE-PLAN at stall 2 (unit-open refused), GO again after a moved unit; open units ignored", () => {
    const c = ruled();
    expect(run("gate", c.path)).toMatchObject({ code: 0, out: "GO: stall 0\n" });
    closeUnit(c, openUnit(c));
    expect(run("gate", c.path)).toMatchObject({ code: 0, out: "GO: stall 1\n" });
    closeUnit(c, openUnit(c));
    const replan = run("gate", c.path);
    expect(replan.code).toBe(5);
    expect(replan.out).toBe(`RE-PLAN: 2 units in a row with no board move; top red row R2: Sentence of R2.${answer("R2")}\n`);
    const before = readFileSync(c.path);
    const refused = run("unit-open", c.path, "--row", "R3", "--contract", join(c.dir, "contract.md"), "--builder", "demo-build", "--kind", "product");
    expect(refused.code).toBe(5);
    expect(refused.err).toContain("refused: RE-PLAN: 2 units in a row with no board move");
    expect(readFileSync(c.path).equals(before)).toBe(true);
    stampFile(c, "REPLAN-R2.md", localIso());
    openUnit(c);
    expect(run("gate", c.path).code).toBe(0);
    const id = openUnit(c, "R3");
    setupMark(c, "R3", "claimed");
    closeUnit(c, id, "pass");
    expect(run("gate", c.path)).toMatchObject({ code: 0, out: "GO: stall 0\n" });
  });

  test("gate: a re-plan of the top row written during the stall answers it until 2 more units do not move", () => {
    const c = ruled((b) => {
      const u1 = unit(b, "U1");
      u1.moved = false;
      b.units.push({ ...u1, id: "U2", endedAt: "2026-11-09T09:40:00-08:00" });
      return b;
    });
    expect(run("gate", c.path).code).toBe(5);
    stampFile(c, "REPLAN-R2.md", "2026-11-09T10:00:00-08:00");
    const go = run("gate", c.path);
    expect(go.code).toBe(0);
    expect(go.out).toBe("GO: stall 2; REPLAN-R2.md re-plan at 2026-11-09T10:00:00-08:00; 0 unit(s) with no move since then\n");
    closeUnit(c, openUnit(c));
    expect(run("gate", c.path).code).toBe(0);
    closeUnit(c, openUnit(c));
    const again = run("gate", c.path);
    expect(again.code).toBe(5);
    expect(again.out).toBe(`RE-PLAN: 2 units with no board move since REPLAN-R2.md re-plan at 2026-11-09T10:00:00-08:00; top red row R2: Sentence of R2.${answer("R2")}\n`);
  });

  test("gate: the stamp counts, not the file time: an addendum or an unstamped file does not answer a later stall", () => {
    const c = ruled((b) => {
      const u1 = unit(b, "U1");
      u1.moved = false;
      b.units.push({ ...u1, id: "U2", endedAt: "2026-11-09T09:40:00-08:00" });
      return b;
    });
    const plain = `RE-PLAN: 2 units in a row with no board move; top red row R2: Sentence of R2.${answer("R2")}\n`;
    // written now (fresh file time), stamped before the stall: an addendum to an old re-plan
    stampFile(c, "REPLAN-R2.md", "2026-11-09T08:00:00-08:00");
    expect(run("gate", c.path)).toMatchObject({ code: 5, out: plain });
    writeFileSync(join(c.dir, "REPLAN-R2.md"), "# re-plan with no stamp line\nRe-plan at: soon\n");
    expect(run("gate", c.path)).toMatchObject({ code: 5, out: plain });
  });

  test("gate: the newest stamp in a file counts; an offset with no colon parses; a future stamp is ignored", () => {
    const c = ruled((b) => {
      const u1 = unit(b, "U1");
      u1.moved = false;
      b.units.push({ ...u1, id: "U2", endedAt: "2026-11-09T09:40:00-08:00" });
      return b;
    });
    const go = "GO: stall 2; REPLAN-R2.md re-plan at 2026-11-09T10:00:00-08:00; 0 unit(s) with no move since then\n";
    stampFile(c, "REPLAN-R2.md", "2026-11-09T09:35:00-08:00", "2026-11-09T10:00:00-0800");
    expect(run("gate", c.path)).toMatchObject({ code: 0, out: go });
    stampFile(c, "REPLAN-R2.md", "2026-11-09T10:00:00-08:00", "2099-01-01T00:00:00-08:00");
    expect(run("gate", c.path)).toMatchObject({ code: 0, out: go });
  });

  test("gate: a re-plan of a row that a unit of the stall attacked answers it; the newest candidate counts; other rows do not", () => {
    const c = ruled((b) => {
      const u1 = unit(b, "U1");
      u1.moved = false;
      u1.row = "R3";
      b.units.push({ ...u1, id: "U2", endedAt: "2026-11-09T09:40:00-08:00" });
      return b;
    });
    stampFile(c, "REPLAN-R1.md", "2026-11-09T10:00:00-08:00");
    expect(run("gate", c.path)).toMatchObject({
      code: 5,
      out: `RE-PLAN: 2 units in a row with no board move; top red row R2: Sentence of R2.${answer("R2", "R3")}\n`,
    });
    stampFile(c, "REPLAN-R2.md", "2026-11-09T09:35:00-08:00");
    stampFile(c, "REPLAN-R3.md", "2026-11-09T10:00:00-08:00");
    const go = run("gate", c.path);
    expect(go.code).toBe(0);
    expect(go.out).toBe("GO: stall 2; REPLAN-R3.md re-plan at 2026-11-09T10:00:00-08:00; 0 unit(s) with no move since then\n");
  });

  test("gate: with a re-plan of a stall row in the middle of the stall, units after it count", () => {
    const c = ruled((b) => {
      const u1 = unit(b, "U1");
      u1.moved = false;
      b.units.push({ ...u1, id: "U2", row: "R3", endedAt: "2026-11-09T09:40:00-08:00" });
      b.units.push({ ...u1, id: "U3", row: "R3", endedAt: "2026-11-09T09:50:00-08:00" });
      return b;
    });
    stampFile(c, "REPLAN-R3.md", "2026-11-09T09:35:00-08:00");
    expect(run("gate", c.path)).toMatchObject({
      code: 5,
      out: `RE-PLAN: 2 units with no board move since REPLAN-R3.md re-plan at 2026-11-09T09:35:00-08:00; top red row R2: Sentence of R2.${answer("R2", "R3")}\n`,
    });
  });

  test("gate orders closed units by endedAt, not by array order", () => {
    const c = setup((b) => {
      const u1 = unit(b, "U1");
      u1.moved = false;
      u1.endedAt = "2026-11-09T11:00:00-08:00";
      b.units.push({ ...u1, id: "U2", moved: true, endedAt: "2026-11-09T18:30:00+00:00" });
      return b;
    });
    // U2 ended 10:30 Pacific, before U1 (11:00 Pacific): the newest closed unit did not move.
    expect(run("gate", c.path).out).toBe("GO: stall 1\n");
  });
});

describe("next and rank", () => {
  test("next picks the non-proven row with the lowest rank", () => {
    const c = setup((b) => {
      row(b, "R2").rank = 3;
      return b;
    });
    const r = run("next", c.path);
    expect(r.code).toBe(0);
    const raw: unknown = JSON.parse(r.out);
    expect(raw).toMatchObject({ id: "R3", rank: 2 });
  });

  test("next takes the first non-proven row when no rank is set", () => {
    const c = setup((b) => {
      for (const r of b.rows) r.rank = null;
      return b;
    });
    const raw: unknown = JSON.parse(run("next", c.path).out);
    expect(raw).toMatchObject({ id: "R2" });
  });

  test("next prints done when every row is proven", () => {
    const c = setup((b) => ({ ...b, rows: b.rows.filter((r) => r.id === "R1"), units: [] }));
    const r = run("next", c.path);
    expect(r.out.trim()).toBe('{"done":true}');
    expect(r.code).toBe(0);
  });

  test("rank renumbers: listed first, then old ranked rows in old order; null stays null; proven gets null", () => {
    const c = setup((b) => {
      row(b, "R1").rank = 9;
      b.rows.push(newRow("R4", { rank: 5 }), newRow("R5", {}));
      return b;
    });
    const r = run("rank", c.path, "--order", "R4", "--by", "exam-1");
    expect(r.err).toBe("warning: R5: untested row has rank null\n");
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("ranked by exam-1: R4=1, R2=2, R3=3");
    const ranks = Object.fromEntries(read(c.path).rows.map((x) => [x.id, x.rank]));
    expect(ranks).toEqual({ R1: null, R2: 2, R3: 3, R4: 1, R5: null });
  });

  test("rank refuses a proven row and an unknown row", () => {
    const c = setup();
    const before = readFileSync(c.path);
    expect(run("rank", c.path, "--order", "R2,R1", "--by", "e").err).toContain("row R1 is proven");
    expect(run("rank", c.path, "--order", "R2,R7", "--by", "e").err).toContain("unknown row R7");
    expect(readFileSync(c.path).equals(before)).toBe(true);
  });
});

describe("set-test and show", () => {
  test("set-test with --pass-rule stamps ruleSetAt; without it keeps rule and stamp", () => {
    const c = setup();
    expect(run("set-test", c.path, "--row", "R3", "--name", "planted", "--kind", "known-answer", "--pass-rule", "9 of 10", "--command", "bun t.ts").code).toBe(0);
    const t3 = row(read(c.path), "R3").test;
    expect(t3).toMatchObject({ name: "planted", kind: "known-answer", passRule: "9 of 10", command: "bun t.ts", ruleFile: null });
    expect(t3.ruleSetAt ?? "").toMatch(LOCAL_ISO);

    expect(run("set-test", c.path, "--row", "R2", "--name", "renamed", "--kind", "judged").code).toBe(0);
    expect(row(read(c.path), "R2").test).toEqual({
      name: "renamed",
      kind: "judged",
      command: null,
      passRule: "10 of 10 planted faults found",
      ruleFile: null,
      ruleSetAt: "2026-11-09T09:00:00-08:00",
    });
  });

  test("show prints the header, stall, rows by rank, and the final check", () => {
    const c = setup((b) => {
      row(b, "R2").sentence = "x".repeat(200);
      return b;
    });
    const lines = run("show", c.path).out.split("\n");
    expect(lines[0]).toBe("demo: 1 of 3 proven · 1 claimed · 0 failed · 1 untested");
    expect(lines[1]).toBe("stall: 0 closed unit(s) in a row with no board move");
    const ids = lines.filter((l) => /^R\d/.test(l)).map((l) => l.split(" ")[0]);
    expect(ids).toEqual(["R2", "R3", "R1"]);
    expect(lines.join("\n")).toContain(`${"x".repeat(69)}…`);
    expect(lines.join("\n")).not.toContain("x".repeat(70));
    expect(lines).toContain("final check: Jm reads one edition = not yet (read 2026-11-09T10:00:00-08:00)");
  });

  test("show --json", () => {
    const c = setup();
    const raw: unknown = JSON.parse(run("show", c.path, "--json").out);
    expect(raw).toEqual({ project: "demo", counts: { proven: 1, claimed: 1, failed: 0, untested: 1, total: 3 }, stall: 0, next: "R2", nextUnit: "U2" });
  });
});

describe("arguments", () => {
  test("unknown command, missing flag and bad value exit 2 with usage", () => {
    const c = setup();
    for (const args of [["frob", c.path], ["mark", c.path, "--row", "R2"], ["mark", c.path, "--row", "R2", "--status", "done", "--by", "s", "--role", "setup", "--note", "n"], ["show"]]) {
      const r = run(...args);
      expect(r.code).toBe(2);
      expect(r.err).toContain("usage: bun Board.ts");
    }
  });
});
