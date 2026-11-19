import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Board, localIso } from "./Board.ts";
import { appendFeedbackItem, checkLinks, driverSection, findFeedbackItem, imageReminders, loadBoard, nextFeedbackId, parseImage, parseKeyDrivers, parseLink, type Receipt, type StatusUpdate, unitWords } from "./Status.ts";

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

  test("internal codes are refused in Jm's text, allowed in a command target and in --by", () => {
    const { dir, path } = setup("codes");
    const app = ["--app", "A=https://a.example"];
    for (const [flag, text, code] of [
      ["--done", "U66 shipped.", "U66"],
      ["--left", "Then the R22 exam.", "R22"],
      ["--done", "exam-81 passed.", "exam-81"],
      ["--done", "E1 step 0 passed.", "E1"],
      ["--left", "Ask edition-orch-13 first.", "edition-orch-13"],
    ] as const) {
      const r = cli("post", path, ...POST, ...app, flag, text);
      expect(r.code).toBe(1);
      expect(r.err).toContain(`internal code "${code}"`);
    }
    expect(existsSync(join(dir, "status"))).toBe(false);
    const ok = cli("post", path, ...POST, ...app, "--try", "The new drill=learn drill --row R2 --unit U9");
    expect(ok.code).toBe(0);
    expect(updates(dir)[0]?.by).toBe("demo-orch-1");
    expect(updates(dir)[0]?.facts.rows.map((r) => [r.id, r.status, r.sentence])).toEqual([
      ["R1", "proven", "Row one."],
      ["R2", "claimed", "Row two."],
      ["R3", "untested", "Row three."],
    ]);
  });
});

describe("inbox and answers", () => {
  test("new feedback goes verbatim under ## Open; a second run adds nothing; answers attach by F-number", () => {
    const { dir, path } = setup("inbox");
    const fb = join(dir, "project", "FEEDBACK.md");
    writeFileSync(fb, "# Feedback: demo\n\n## Open\n\n### F-007 · 2026-11-01 · s\n- **Jm (verbatim):** \"old\"\n\n## Decided\n\n### F-002 · 2026-10-01 · s\n");
    const inDir = join(dir, "status", "in", "feedback");
    mkdirSync(inDir, { recursive: true });
    writeFileSync(join(inDir, "abc123.json"), JSON.stringify({ project: "demo", text: "Ship the drill\nfirst, please.", at: "2026-11-18T23:00:00.000Z", to: "demo-orch-1" }));
    writeFileSync(join(inDir, "zzz999.json"), JSON.stringify({ project: "other", text: "not for demo", at: "2026-11-18T23:01:00.000Z", to: "x" }));

    const r = cli("inbox", path, "--by", "demo-orch-2");
    expect(r.code).toBe(0);
    expect(r.out).toContain('F-008 ← "Ship the drill first, please."');
    const text = readFileSync(fb, "utf8");
    expect(text.indexOf("### F-008")).toBeGreaterThan(text.indexOf("## Open"));
    expect(text.indexOf("### F-008")).toBeLessThan(text.indexOf("## Decided"));
    expect(text).toContain('- **Jm (verbatim):** "Ship the drill first, please."');
    expect(text).not.toContain("not for demo");
    const receipts = readFileSync(join(dir, "status", "INBOX.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Receipt);
    expect(receipts.map((x) => [x.feedback, x.ref, x.by])).toEqual([["abc123", "F-008", "demo-orch-2"]]);
    expect(r.out).toContain('"collection":"receipts","doc_id":"abc123"');

    const again = cli("inbox", path, "--by", "demo-orch-2");
    expect(again.out).toContain("no new feedback");
    expect(readFileSync(fb, "utf8")).toBe(text);

    expect(cli("post", path, ...POST, "--app", "A=https://a.example", "--answer", "F-099=nope").code).toBe(1);
    const ok = cli("post", path, ...POST, "--app", "A=https://a.example", "--answer", "F-008=Drill ships next.");
    expect(ok.code).toBe(0);
    expect(updates(dir)[0]?.answers).toEqual([{ feedback: "abc123", ref: "F-008", text: "Drill ships next.", words: null }]);
    expect(ok.err).not.toContain("no answer yet");
  });

  test("--answer takes an F-item that came by another door, from FEEDBACK.md or --feedback-file", () => {
    const { dir, path } = setup("other-door");
    const tracker = join(dir, "tracker-FEEDBACK.md");
    writeFileSync(tracker, '# Feedback\n\n## Open\n\n### F-028 · 2026-11-18 · a session\n- **Jm (verbatim):** "make the review answers reach Learn"\n- **Need:** x\n\n### F-0281 · 2026-11-18 · s\n- **Jm (verbatim):** "other"\n');
    expect(cli("post", path, ...POST, "--app", "A=https://a.example", "--answer", "F-028=Done in the next build.").code).toBe(1); // not in <project>/FEEDBACK.md
    const r = cli("post", path, ...POST, "--app", "A=https://a.example", "--answer", "F-028=Done in the next build.", "--feedback-file", tracker);
    expect(r.code).toBe(0);
    expect(updates(dir)[0]?.answers).toEqual([{ feedback: null, ref: "F-028", text: "Done in the next build.", words: "make the review answers reach Learn" }]);
  });

  test("a reply from the page names the item it answers", () => {
    const { dir, path } = setup("reply");
    const inDir = join(dir, "status", "in", "feedback");
    mkdirSync(inDir, { recursive: true });
    writeFileSync(join(inDir, "m1.json"), JSON.stringify({ project: "demo", text: "First message.", at: "2026-11-18T23:00:00.000Z", to: "demo-orch-1" }));
    expect(cli("inbox", path, "--by", "demo-orch-1").code).toBe(0);
    writeFileSync(join(inDir, "m2.json"), JSON.stringify({ project: "demo", text: "Thanks, but why?", at: "2026-11-18T23:30:00.000Z", to: "demo-orch-1", replyTo: "m1" }));
    const r = cli("inbox", path, "--by", "demo-orch-1");
    expect(r.out).toContain("F-002");
    expect(r.out).toContain("a reply to your answer on F-001");
    expect(readFileSync(join(dir, "project", "FEEDBACK.md"), "utf8")).toContain("; a reply to the answer on F-001; received by demo-orch-1");
  });

  test("a missing FEEDBACK.md is made from the project-standard starter", () => {
    const { dir, path } = setup("starter");
    const inDir = join(dir, "status", "in", "feedback");
    mkdirSync(inDir, { recursive: true });
    writeFileSync(join(inDir, "f1.json"), JSON.stringify({ project: "demo", text: "hello", at: "2026-11-18T23:00:00.000Z", to: "" }));
    expect(cli("inbox", path, "--by", "demo-orch-1").code).toBe(0);
    const text = readFileSync(join(dir, "project", "FEEDBACK.md"), "utf8");
    expect(text).toContain("# Feedback: demo");
    expect(text).toMatch(/### F-001 · \d{4}-\d\d-\d\d · status page/);
  });

  test("pull prints the query for this project and its out_dir", () => {
    const { dir, path } = setup("pull");
    const r = cli("pull", path);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`"where":[["project","==","demo"]]`);
    expect(r.out).toContain(`"out_dir":"${join(dir, "status", "in")}"`);
  });
});

describe("helpers", () => {
  test("nextFeedbackId skips the examples inside HTML comments", () => {
    expect(nextFeedbackId("<!-- ### F-900 -->\n### F-004 · x\n### F-012 · y")).toBe("F-013");
    expect(nextFeedbackId("# none")).toBe("F-001");
  });

  test("appendFeedbackItem without ## Decided appends at the end", () => {
    const out = appendFeedbackItem("# F\n\n## Open\n", { ref: "F-001", docId: "d", words: "w", sentAt: "s", to: "", by: "b", at: "2026-11-18T10:00:00-08:00" });
    expect(out.endsWith("<!-- feedback-end:d -->\n")).toBe(true);
  });

  test("findFeedbackItem takes the exact F-number and skips comments", () => {
    const text = '<!-- ### F-028 · example -->\n### F-0281 · x\n- **Jm (verbatim):** "wrong"\n\n### F-028 · y\n- **Jm (verbatim):** "right"\n### F-029 · z\n- **Need:** n\n';
    expect(findFeedbackItem(text, "F-028")).toEqual({ words: "right" });
    expect(findFeedbackItem(text, "F-029")).toEqual({ words: null });
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
    for (const s of ["`--where`", "`--progress`: `yes` only when what Jm receives got better", "`--app`", "`--try`", "Plain words", "refuses a unit, row or exam code", "dead link"]) expect(r.out).toContain(s);
  });
});

