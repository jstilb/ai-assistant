import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type Board, localIso } from "./Board.ts";
import { checkLinks, driverSection, feedbackFiles, findFeedbackItem, imageReminders, loadBoard, parseImage, parseKeyDrivers, parseLink, parseNumber, type StatusUpdate, unitWords } from "./Status.ts";

const TOOL = join(import.meta.dir, "Status.ts");
const ROOT = mkdtempSync(join(tmpdir(), "endstate-status-test-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const ago = (min: number): string => localIso(new Date(Date.now() - min * 60_000));

/** R1 proven (exam mark 2 h ago), R2 claimed rank 1, R3 untested rank 2; U1 closed 1 h ago (moved, live), U2 open. */
function board(dir: string): Board {
  const ev = join(dir, "evidence.txt");
  writeFileSync(ev, "ok");
  const rule = { name: "t", kind: "known-answer" as const, command: null, passRule: "10 of 10", ruleFile: null, ruleSetAt: ago(600) };
  return {
    schema: "endstate-board/v1",
    project: "demo",
    folder: join(dir, "project"),
    endState: { source: "END_STATE.md", approvedBy: "Jm", summary: "demo" },
    finalCheck: [],
    rows: [
      {
        id: "R1",
        sentence: "Row one.",
        source: "E",
        test: rule,
        status: "proven",
        gap: "",
        rank: null,
        marks: [{ at: ago(120), by: "demo-exam-1", role: "examiner", status: "proven", evidence: [ev], set: "S1", note: "pass" }],
      },
      { id: "R2", sentence: "Row two.", source: "E", test: rule, status: "claimed", gap: "g", rank: 1, marks: [{ at: ago(300), by: "setup", role: "setup", status: "claimed", evidence: [], set: null, note: "" }] },
      { id: "R3", sentence: "Row three.", source: "E", test: rule, status: "untested", gap: "g", rank: 2, marks: [] },
    ],
    units: [
      { id: "U1", row: "R1", contract: "c", builder: "demo-unit-U1", startedAt: ago(200), endedAt: ago(60), result: "pass", statusHashAtOpen: "0", rowStatusAtOpen: "claimed", moved: true, note: "", kind: "product", shipped: "abc123; live" },
      { id: "U2", row: "R2", contract: "c", builder: "demo-unit-U2", startedAt: ago(30), endedAt: null, result: "open", statusHashAtOpen: "0", rowStatusAtOpen: "claimed", moved: null, note: "", kind: "product", shipped: null },
    ],
  };
}

function setup(name: string): { dir: string; path: string } {
  const dir = join(ROOT, name);
  mkdirSync(join(dir, "project"), { recursive: true });
  const path = join(dir, "SCOREBOARD.json");
  writeFileSync(path, JSON.stringify(board(dir), null, 2));
  return { dir, path };
}

function cli(...args: string[]): { code: number; out: string; err: string } {
  const p = Bun.spawnSync(["bun", TOOL, ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? -1, out: p.stdout.toString(), err: p.stderr.toString() };
}

const POST = ["--by", "demo-orch-1", "--where", "A builder works on the second goal.", "--done", "The first goal passed its exam.", "--left", "Goals two and three.", "--progress", "yes", "--progress-why", "One goal passed.", "--aligned", "yes", "--aligned-why", "Rows match Jm's words.", "--no-check"];

function updates(dir: string): StatusUpdate[] {
  const f = join(dir, "status", "STATUS.jsonl");
  return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l) as StatusUpdate) : [];
}

describe("post", () => {
  test("the first update needs --app; a refusal writes nothing", () => {
    const { dir, path } = setup("first-needs-app");
    const r = cli("post", path, ...POST);
    expect(r.code).toBe(1);
    expect(r.err).toContain("needs --app");
    expect(existsSync(join(dir, "status"))).toBe(false);
  });

  test("records the update, its facts, and prints the ArtifactData push", () => {
    const { dir, path } = setup("first");
    const r = cli("post", path, ...POST, "--app", "Demo app=https://demo.example/app?x=1", "--try", "The first drill=demo drill --row R1");
    expect(r.code).toBe(0);
    const [u] = updates(dir);
    expect(u?.id).toBe("demo-0001");
    expect(u?.facts.counts).toEqual({ proven: 1, claimed: 1, failed: 0, untested: 1, total: 3 });
    expect(u?.facts.sinceKind).toBe("24h");
    expect(u?.facts.provenDelta).toBeNull();
    expect(u?.facts.closed.map((x) => x.id)).toEqual(["U1"]);
    expect(u?.facts.liveChanges).toBe(1);
    expect(u?.facts.open.map((x) => x.id)).toEqual(["U2"]);
    expect(u?.facts.top?.id).toBe("R2");
    expect(u?.facts.lastExamAt).not.toBeNull();
    expect(u?.app[0]).toMatchObject({ label: "Demo app", target: "https://demo.example/app?x=1", check: "not-checked" });
    expect(u?.try[0]).toMatchObject({ label: "The first drill", target: "demo drill --row R1", check: "not-a-url" });
    const out = join(dir, "status", "out", "demo-0001.json");
    expect(JSON.parse(readFileSync(out, "utf8")).id).toBe("demo-0001");
    expect(r.out).toContain(`"collection":"updates","doc_id":"demo-0001","file_path":"${out}"`);
  });

  test("the second update carries the app links and counts what moved since the first", () => {
    const { dir, path } = setup("second");
    expect(cli("post", path, ...POST, "--app", "Demo app=https://demo.example").code).toBe(0);
    const b = JSON.parse(readFileSync(path, "utf8")) as Board;
    const r2 = b.rows[1];
    if (r2 === undefined) throw new Error("fixture");
    r2.marks.push({ at: localIso(new Date(Date.now() + 2000)), by: "demo-exam-2", role: "examiner", status: "proven", evidence: [join(dir, "evidence.txt")], set: "S2", note: "pass" });
    r2.status = "proven";
    r2.rank = null;
    writeFileSync(path, JSON.stringify(b, null, 2));
    expect(cli("post", path, ...POST).code).toBe(0);
    const [, u2] = updates(dir);
    expect(u2?.id).toBe("demo-0002");
    expect(u2?.facts.sinceKind).toBe("last-update");
    expect(u2?.facts.provenDelta).toBe(1);
    expect(u2?.facts.rowMoves).toEqual([{ row: "R2", from: "claimed", to: "proven", dir: "up", sentence: "Row two." }]);
    expect(u2?.facts.closed).toEqual([]);
    expect(u2?.app.map((l) => l.target)).toEqual(["https://demo.example"]);
  });

  test("caps and verdicts refuse with nothing written", () => {
    const { dir, path } = setup("caps");
    const app = ["--app", "A=https://a.example"];
    const long = cli("post", path, ...POST, ...app, "--where", "x".repeat(400));
    expect(long.code).toBe(2); // --where given twice
    const base = POST.filter((_, i) => i !== 2 && i !== 3); // drop the --where pair
    expect(cli("post", path, ...base, ...app, "--where", "x".repeat(400)).err).toContain("the cap is 200");
    const many = Array.from({ length: 5 }, (_, i) => ["--done", `item ${i}`]).flat();
    expect(cli("post", path, ...POST, ...app, ...many).err).toContain("the cap is 4");
    const bad = POST.map((x) => (x === "yes" ? "maybe" : x));
    expect(cli("post", path, ...bad, ...app).code).toBe(2);
    expect(cli("post", path, ...POST, "--app", "no-label-here").code).toBe(2);
    expect(existsSync(join(dir, "status"))).toBe(false);
  });

});



describe("answers", () => {
  const ITEM = '### F-028 · 2026-11-18 · a session\n- **Jm (verbatim):** "make the review answers reach Learn"\n- **Need:** x\n';
  test("--answer takes an F-item from FEEDBACK.md, from --feedback-file, or from FEEDBACK-HISTORY.md beside it", () => {
    const { dir, path } = setup("answer-files");
    const tracker = join(dir, "tracker", "FEEDBACK.md");
    mkdirSync(dirname(tracker), { recursive: true });
    writeFileSync(tracker, `# Feedback\n\n## Open\n\n${ITEM}\n### F-0281 · 2026-11-18 · s\n- **Jm (verbatim):** "other"\n`);
    expect(feedbackFiles(tracker)).toEqual([tracker]);
    expect(cli("post", path, ...POST, "--app", "A=https://a.example", "--answer", "F-028=Done in the next build.").code).toBe(1); // not in <project>/FEEDBACK.md
    const r = cli("post", path, ...POST, "--app", "A=https://a.example", "--answer", "F-028=Done in the next build.", "--feedback-file", tracker);
    expect(r.code).toBe(0);
    expect(updates(dir)[0]?.answers).toEqual([{ feedback: null, ref: "F-028", text: "Done in the next build.", words: "make the review answers reach Learn" }]);
    // decided: the item moved to the history file beside the open file
    writeFileSync(tracker, "# Feedback\n\n## Open\n");
    writeFileSync(join(dirname(tracker), "FEEDBACK-HISTORY.md"), `# Feedback history\n\n${ITEM}`);
    expect(cli("post", path, ...POST, "--answer", "F-028=It is live.", "--feedback-file", tracker).code).toBe(0);
    expect(updates(dir)[1]?.answers[0]?.words).toBe("make the review answers reach Learn");
  });

  test("an item with a Page item line answers Jm's page message by its doc id", () => {
    const { dir, path } = setup("answer-page");
    const file = join(dir, "page", "FEEDBACK.md");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '# Feedback\n\n## Open\n\n### F-003 · 2026-11-25 · status page\n- **Jm (verbatim):** "the list is too long"\n- **Page item:** `fb_abc123`\n');
    expect(cli("post", path, ...POST, "--app", "A=https://a.example", "--answer", "F-003=Cut to nine.", "--feedback-file", file).code).toBe(0);
    expect(updates(dir)[0]?.answers).toEqual([{ feedback: "fb_abc123", ref: "F-003", text: "Cut to nine.", words: null }]);
  });

  test("pull and inbox are removed: they print the new steps and exit 0", () => {
    const { path } = setup("removed-door");
    const r = cli("pull", path);
    expect(r.code).toBe(0);
    expect(r.out).toContain('"collection":"feedback"');
    expect(cli("inbox", path, "--by", "x").code).toBe(0);
  });
});

describe("helpers", () => {


  test("findFeedbackItem takes the exact F-number and skips comments", () => {
    const text = '<!-- ### F-028 · example -->\n### F-0281 · x\n- **Jm (verbatim):** "wrong"\n\n### F-028 · y\n- **Jm (verbatim):** "right"\n### F-029 · z\n- **Need:** n\n';
    expect(findFeedbackItem(text, "F-028")).toEqual({ words: "right", pageDoc: null });
    expect(findFeedbackItem(text, "F-029")).toEqual({ words: null, pageDoc: null });
    expect(findFeedbackItem(text, "F-030")).toBeNull();
    expect(findFeedbackItem(text, "F-02.")).toBeNull();
  });

  test("parseLink splits at the first = only", () => {
    expect(parseLink("try", "Lesson=https://x.example/?a=1&b=2")).toMatchObject({ label: "Lesson", target: "https://x.example/?a=1&b=2" });
  });

  test("checkLinks marks a live server ok, a 404 and a closed port dead, a command not-a-url", async () => {
    const server = Bun.serve({ port: 0, fetch: (req) => new Response("x", { status: new URL(req.url).pathname === "/gone" ? 404 : 200 }) });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const got = await checkLinks([
        parseLink("app", `ok=${base}/`),
        parseLink("app", `gone=${base}/gone`),
        parseLink("app", "closed=http://127.0.0.1:9/"),
        parseLink("app", "cmd=learn drill"),
      ]);
      expect(got.map((l) => [l.check, l.code])).toEqual([
        ["ok", 200],
        ["dead", 404],
        ["dead", null],
        ["not-a-url", null],
      ]);
    } finally {
      server.stop(true);
    }
  });
});

const DRIVERS_MD = [
  "# Key drivers",
  "",
  "| Driver | What | Rows |",
  "|---|---|---|",
  "| **D1: a good first goal** (the choice) | text | R1, R9 (R1 proven) |",
  "| **D2. Second driver** | text | R2 |",
  "| Support | nav | R3 |",
  "",
].join("\n");

describe("key drivers", () => {
  test("parseKeyDrivers reads the Rows column, keeps only board rows, skips support", () => {
    const d = parseKeyDrivers(DRIVERS_MD, new Set(["R1", "R2", "R3"]));
    expect(d).toEqual([
      { id: "D1", name: "a good first goal", rows: ["R1"] },
      { id: "D2", name: "Second driver", rows: ["R2"] },
    ]);
    expect(parseKeyDrivers("no table here", new Set(["R1"]))).toBeNull();
  });

  test("a board with a KEY-DRIVERS file: shipped units per driver, newest first", () => {
    const { dir, path } = setup("drivers");
    writeFileSync(join(dir, "KEY-DRIVERS-1.md"), "| Driver | Rows |\n|---|---|\n| **D1 old** | R3 |\n");
    writeFileSync(join(dir, "KEY-DRIVERS-2.md"), DRIVERS_MD);
    const u1 = join(dir, "units", "U1", "render", "before");
    mkdirSync(u1, { recursive: true });
    mkdirSync(join(dir, "units", "U1", "render", "after"), { recursive: true });
    writeFileSync(join(u1, "home.png"), "x");
    writeFileSync(join(dir, "units", "U1", "render", "after", "home.png"), "x");
    writeFileSync(join(dir, "units", "U1", "render", "after", "notes.txt"), "x");
    const s = driverSection(loadBoard(path), dir);
    expect(s.written).toBe(true);
    expect(s.source).toBe("KEY-DRIVERS-2.md");
    const d1 = s.items.find((x) => x.id === "D1");
    expect(d1?.shippedTotal).toBe(1);
    expect(d1?.shipped[0]?.unit).toBe("U1");
    expect(d1?.shipped[0]?.words).toBe("Row one.");
    expect(d1?.shipped[0]?.where).toBe("abc123; live");
    expect(d1?.images).toBeUndefined();
    expect(d1?.lastShippedAt).not.toBeNull();
    const d2 = s.items.find((x) => x.id === "D2");
    expect(d2?.shippedTotal).toBe(0);
    expect(d2?.lastShippedAt).toBeNull();
    expect(s.supportShipped).toBe(0);
  });

  test("a closed test-tool unit with a shipped line is not a driver's live change", () => {
    const { dir, path } = setup("drivers-test-kind");
    writeFileSync(join(dir, "KEY-DRIVERS-1.md"), DRIVERS_MD);
    const b = JSON.parse(readFileSync(path, "utf8")) as Board;
    b.units.push({ ...b.units[0], id: "U3", builder: "demo-unit-U3", endedAt: ago(5), kind: "test", shipped: "def456; replay tool live" });
    writeFileSync(path, JSON.stringify(b));
    const d1 = driverSection(loadBoard(path), dir).items.find((x) => x.id === "D1");
    expect(d1?.shippedTotal).toBe(1);
    expect(d1?.shipped.map((c) => c.unit)).toEqual(["U1"]);
  });

  test("a board with no KEY-DRIVERS file says not written and guesses no mapping", () => {
    const { dir, path } = setup("no-drivers");
    const s = driverSection(loadBoard(path), dir);
    expect(s).toEqual({ written: false, source: null, items: [], supportShipped: 0 });
    const r = cli("facts", path);
    expect(r.out).toContain("key drivers: not written");
  });

  test("facts lead with the drivers; rows proven is a support count; no usage text", () => {
    const { dir, path } = setup("lead");
    writeFileSync(join(dir, "KEY-DRIVERS-1.md"), DRIVERS_MD);
    const r = cli("facts", path);
    expect(r.code).toBe(0);
    const lines = r.out.split("\n");
    expect(lines[0]).toContain("driver D1");
    expect(lines[0]).toContain("1 live change(s)");
    expect(lines.findIndex((l) => l.startsWith("support count: 1 of 3 rows proven"))).toBeGreaterThan(1);
    expect(r.out.toLowerCase()).not.toMatch(/usage|visit|session count|weekly/);
    const page = readFileSync(join(import.meta.dir, "StatusPage.html"), "utf8").toLowerCase();
    expect(page).not.toMatch(/usage|visits/);
  });

  test("post records the drivers as an additive field", () => {
    const { dir, path } = setup("post-drivers");
    writeFileSync(join(dir, "KEY-DRIVERS-1.md"), DRIVERS_MD);
    const r = cli("post", path, ...POST, "--app", "Demo app=https://demo.example/app");
    expect(r.code).toBe(0);
    expect(updates(dir)[0]?.facts.drivers?.items.length).toBe(2);
  });
});

describe("what changed in words, and images", () => {
  test("unitWords: contract H1 (row tail cut), else first sentence of the note, else the row sentence", () => {
    const { dir, path } = setup("words");
    const b = loadBoard(path);
    const u = b.units[0];
    if (u === undefined) throw new Error("fixture has no unit");
    const contract = join(dir, "U1.md");
    writeFileSync(contract, "# Unit U1: each match's correction goes into Learn (row R1, project demo)\n\nbody\n");
    expect(unitWords(b, { ...u, contract })).toBe("each match's correction goes into Learn");
    expect(unitWords(b, { ...u, note: "The bench now reads labels. More text." })).toBe("The bench now reads labels.");
    expect(unitWords(b, u)).toBe("Row one.");
  });

  test("parseImage accepts /_blob/ and https, refuses anything else", () => {
    expect(parseImage("D1 before=/_blob/abc123")).toEqual({ driver: "D1", kind: "before", url: "/_blob/abc123" });
    expect(parseImage("D2 after=https://x.example/a.png").kind).toBe("after");
    expect(() => parseImage("D1 before=/Users/jm/a.png")).toThrow();
    expect(() => parseImage("D1 during=/_blob/a")).toThrow();
    expect(() => parseImage("before=/_blob/a")).toThrow();
  });

  test("post --image is kept on the driver; an unknown driver is refused; no --image: old shape", () => {
    const { dir, path } = setup("images");
    writeFileSync(join(dir, "KEY-DRIVERS-1.md"), DRIVERS_MD);
    const bad = cli("post", path, ...POST, "--app", "A=https://demo.example/a", "--image", "D9 before=/_blob/x");
    expect(bad.code).toBe(1);
    expect(updates(dir).length).toBe(0);
    const ok = cli("post", path, ...POST, "--app", "A=https://demo.example/a", "--image", "D1 before=/_blob/b1", "--image", "D1 after=/_blob/a1");
    expect(ok.code).toBe(0);
    const [u] = updates(dir);
    expect(u?.facts.drivers?.items.find((x) => x.id === "D1")?.images).toEqual({ before: ["/_blob/b1"], after: ["/_blob/a1"] });
    expect(u?.facts.drivers?.items.find((x) => x.id === "D2")?.images).toBeUndefined();
  });

  test("post without --image prints the exact upload call when the unit folder has before/after files", () => {
    const { dir, path } = setup("reminder");
    writeFileSync(join(dir, "KEY-DRIVERS-1.md"), DRIVERS_MD);
    const shots = join(dir, "units", "U1", "render");
    mkdirSync(shots, { recursive: true });
    writeFileSync(join(shots, "before-home.png"), "x");
    writeFileSync(join(shots, "after-home.png"), "x");
    const r = cli("post", path, ...POST, "--app", "A=https://demo.example/a");
    expect(r.code).toBe(0);
    expect(r.err).toContain("reminder: driver D1");
    expect(r.err).toContain('"asset":true');
    expect(r.err).toContain(join(shots, "before-home.png"));
    expect(r.err).toContain(join(shots, "after-home.png"));
    const [u] = updates(dir);
    if (u === undefined) throw new Error("no update");
    expect(imageReminders(u, path, [{ driver: "D1", kind: "before", url: "/_blob/x" }])).toEqual([]);
  });

  test("the page renders images only from /_blob/ or https, lazy, with alt text; drivers without images render as before", () => {
    const page = readFileSync(join(import.meta.dir, "StatusPage.html"), "utf8");
    expect(page).toContain('<img loading="lazy" src="');
    expect(page).toContain('indexOf("/_blob/") === 0');
    expect(page).not.toContain("Copy path");
    expect(page).toContain("(pics ?");
  });
});

describe("help", () => {
  test("post --help prints the field rules and exits 0, with no board path", () => {
    const r = cli("post", "--help");
    expect(r.code).toBe(0);
    for (const s of ["`--where`", "`--progress`: `yes` only when what Jm receives got better", "`--app`", "`--try`", "Plain words", "write no unit, row or exam code", "dead link"]) expect(r.out).toContain(s);
  });
});

describe("driver numbers and the audit copy", () => {
  const APP = ["--app", "A=https://demo.example/a"];

  test("post --number is kept as numbers; empty before and bar stay empty", () => {
    const { dir, path } = setup("numbers-ok");
    const r = cli("post", path, ...POST, ...APP, "--number", "Cards that pass|18 of 20|11 of 20|18 of 20", "--number", "Open complaints|3||");
    expect(r.code).toBe(0);
    expect(updates(dir)[0]?.numbers).toEqual([
      { label: "Cards that pass", now: "18 of 20", before: "11 of 20", bar: "18 of 20" },
      { label: "Open complaints", now: "3", before: "", bar: "" },
    ]);
  });

  test("post --number refuses an empty label or now, 5 parts, 9 numbers", () => {
    const { dir, path } = setup("numbers-bad");
    expect(cli("post", path, ...POST, ...APP, "--number", "|3||").code).toBe(1);
    expect(cli("post", path, ...POST, ...APP, "--number", "Label||1|2").code).toBe(1);
    expect(cli("post", path, ...POST, ...APP, "--number", "a|b|c|d|e").code).toBe(2);
    const nine = Array.from({ length: 9 }, (_, i) => ["--number", `Label ${i}|${i}||`]).flat();
    expect(cli("post", path, ...POST, ...APP, ...nine).err).toContain("the cap is 8");
    expect(updates(dir).length).toBe(0);
    expect(() => parseNumber("x")).toThrow();
  });

  test("post without --number has no numbers field (old shape)", () => {
    const { dir, path } = setup("numbers-absent");
    expect(cli("post", path, ...POST, ...APP).code).toBe(0);
    expect(updates(dir)[0]).not.toHaveProperty("numbers");
  });

  test("facts.closed copies the unit audit (note cut to 200); no audit: no field", () => {
    const { dir, path } = setup("audit-copy");
    const b = JSON.parse(readFileSync(path, "utf8")) as Board;
    const u = b.units[0];
    if (u === undefined) throw new Error("fixture has no unit");
    u.audit = { at: ago(30), by: "demo-audit-1", result: "fail", note: "x".repeat(300), evidence: ["e.txt"] };
    writeFileSync(path, JSON.stringify(b, null, 2));
    expect(cli("post", path, ...POST, ...APP).code).toBe(0);
    const c = updates(dir)[0]?.facts.closed[0];
    expect(c?.audit).toEqual({ result: "fail", by: "demo-audit-1", note: "x".repeat(200) });
    const { path: p2, dir: d2 } = setup("audit-none");
    expect(cli("post", p2, ...POST, ...APP).code).toBe(0);
    expect(updates(d2)[0]?.facts.closed[0]).not.toHaveProperty("audit");
  });

  test("post --help lists --number", () => {
    expect(cli("post", "x", "--help").out).toContain("--number");
  });
});
