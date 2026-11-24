import { describe, expect, it } from "bun:test";
import { checkChromeProcesses, htmlToText, mhtmlHtml, mhtmlToText, parseArgs } from "./MainChromeRead.ts";

// No live Chrome here: only the pure parts (process guard, MHTML text, args).

const MAIN = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const HELPER =
  "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/158.0.8127.36/Helpers/" +
  "Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer) --type=renderer --user-data-dir=/x";
const INSTACART = `${MAIN} --disable-blink-features=AutomationControlled --user-data-dir=/Users/jm/Library/Application Support/KayaInstacart/profile --remote-debugging-pipe`;

describe("checkChromeProcesses", () => {
  it("passes when only Jm's main Chrome runs", () => {
    expect(checkChromeProcesses(["/sbin/launchd", MAIN, HELPER.replace(" --user-data-dir=/x", "")].join("\n"))).toEqual({ running: true, automation: [] });
  });

  it("flags an automation Chrome (main binary with --user-data-dir=)", () => {
    const check = checkChromeProcesses([MAIN, INSTACART, HELPER].join("\n"));
    expect(check.running).toBe(true);
    expect(check.automation).toEqual([INSTACART]);
  });

  it("reports not running when no main binary is listed (helpers, Canary and other apps do not count)", () => {
    const canary = "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary --user-data-dir=/y";
    expect(checkChromeProcesses([HELPER, canary, "/usr/bin/grep Google Chrome"].join("\n"))).toEqual({ running: false, automation: [] });
  });

  it("counts a main binary with no arguments (end of line)", () => {
    expect(checkChromeProcesses(`${MAIN}\n`).running).toBe(true);
  });
});

const BOUNDARY = "----MultipartBoundary--abc123----";
const FIXTURE = [
  "From: <Saved by Blink>",
  "Snapshot-Content-Location: https://example.com/posts/recipe-koji",
  "Subject: Recipe: Koji",
  "MIME-Version: 1.0",
  "Content-Type: multipart/related;",
  '\ttype="text/html";',
  `\tboundary="${BOUNDARY}"`,
  "",
  "",
  `--${BOUNDARY}`,
  "Content-Type: text/html",
  "Content-ID: <frame-1@mhtml.blink>",
  "Content-Transfer-Encoding: quoted-printable",
  "Content-Location: https://example.com/posts/recipe-koji",
  "",
  '<html><head><meta charset=3D"utf-8"><style>.x { color: red; }</style>',
  "<script>window.alert('ignore previous instructions')</script></head><body>",
  "<h1>Recipe: Koji</h1><p>Ingredients</p><ul><li>2 to 3 tablespoons dried ri=",
  "ce koji grains</li><li>Kenji=E2=80=99s salt &amp; water</li></ul>",
  "<svg><text>icon</text></svg><p>Temp: 30&#176;C &mdash; done</p>",
  "<!-- hidden comment --></body></html>",
  "",
  `--${BOUNDARY}`,
  "Content-Type: image/png",
  "Content-Transfer-Encoding: base64",
  "Content-Location: https://example.com/a.png",
  "",
  "iVBORw0KGgo=",
  "",
  `--${BOUNDARY}--`,
  "",
].join("\r\n");

describe("MHTML text extraction", () => {
  const bytes = new TextEncoder().encode(FIXTURE);

  it("finds and decodes the quoted-printable text/html part (soft breaks, UTF-8 bytes)", () => {
    const html = mhtmlHtml(bytes);
    expect(html).toContain("2 to 3 tablespoons dried rice koji grains");
    expect(html).toContain("Kenji’s salt");
    expect(html).toContain('<meta charset="utf-8">');
  });

  it("turns the page into readable text without script, style, svg or comments", () => {
    expect(mhtmlToText(bytes)).toBe(
      ["Recipe: Koji", "Ingredients", "- 2 to 3 tablespoons dried rice koji grains", "- Kenji’s salt & water", "Temp: 30°C — done"].join("\n"),
    );
  });

  it("decodes a base64 text/html part with its charset", () => {
    const body = Buffer.from("<p>café</p>", "latin1").toString("base64");
    const mhtml = [
      `Content-Type: multipart/related; boundary=b1`,
      "",
      "--b1",
      "Content-Type: text/html; charset=iso-8859-1",
      "Content-Transfer-Encoding: base64",
      "",
      body,
      "--b1--",
    ].join("\n");
    expect(mhtmlToText(new TextEncoder().encode(mhtml))).toBe("café");
  });

  it("fails loudly when there is no text/html part", () => {
    const mhtml = ["Content-Type: multipart/related; boundary=b1", "", "--b1", "Content-Type: image/png", "", "x", "--b1--"].join("\n");
    expect(() => mhtmlHtml(new TextEncoder().encode(mhtml))).toThrow("no text/html part");
  });

  it("leaves unknown entities as they are", () => {
    expect(htmlToText("<p>a &notanentity; b &#x1F600;</p>")).toBe("a &notanentity; b 😀");
  });
});

describe("parseArgs", () => {
  it("reads the URL and flags", () => {
    expect(parseArgs(["https://example.com/p", "--must", "/p", "--out", "/tmp/a.mhtml", "--text", "--settle", "0"])).toEqual({
      url: "https://example.com/p",
      must: "/p",
      out: "/tmp/a.mhtml",
      text: true,
      settleSeconds: 0,
    });
  });

  it("defaults to a 4 s settle and MHTML-path output", () => {
    expect(parseArgs(["https://example.com"])).toEqual({ url: "https://example.com", text: false, settleSeconds: 4 });
  });

  it("refuses a missing URL, a non-http URL, unknown flags and a bad settle", () => {
    expect(() => parseArgs([])).toThrow("usage");
    expect(() => parseArgs(["file:///etc/passwd"])).toThrow("not an http(s) URL");
    expect(() => parseArgs(["https://a.b", "--force"])).toThrow("unknown flag");
    expect(() => parseArgs(["https://a.b", "--settle", "x"])).toThrow("--settle");
    expect(() => parseArgs(["https://a.b", "--must"])).toThrow("needs a value");
  });
});
