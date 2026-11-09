import { expect, test } from "bun:test";
import { HAND_OFFS, lintSecretsFileSources } from "./no-inline-secrets-file.ts";

const NONE: Readonly<Record<string, string>> = {};
const lint = (path: string, text: string) => lintSecretsFileSources([{ path, text }], NONE).errors;

const banned = [
  ['join(getKayaHome(), "secrets.json")', "double-quoted literal"],
  ["kayaHomePath('secrets.json')", "single-quoted literal"],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture text is source code
  ["Bun.file(`${home}/secrets.json`)", "template path"],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture text is source code
  ["const p = `${homedir()}/.claude/secrets.json`;", "template path under .claude"],
] as const;

for (const [line, name] of banned) {
  test(`flags a ${name}`, () => {
    const errors = lint("skills/X/Tools/Reader.ts", `// header\n${line}\n`);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toStartWith("skills/X/Tools/Reader.ts:2:");
  });
}

test("passes lib/core/Secrets.ts", () => {
  expect(lint("lib/core/Secrets.ts", 'return join(getKayaHome(), "secrets.json");\n')).toEqual([]);
});

test("passes tests, plans/ and the two exempt files", () => {
  for (const path of [
    "lib/core/Foo.test.ts",
    "bin/__tests__/foo.ts",
    "plans/x/rotate.ts",
    "skills/System/PublicSync/Tools/SyncEngine.ts",
    "skills/Development/CreateCLI/Tools/ScaffoldCLI.ts",
  ]) {
    expect(lint(path, 'excludedFiles: ["secrets.json"],\n')).toEqual([]);
  }
});

test("passes a message that only mentions secrets.json in prose", () => {
  const text = [
    'throw new Error("Add MY_KEY to secrets.json first");',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture text is source code
    "console.error(`Set ${name} in ~/.claude/secrets.json`);",
    "// reads secrets.json through lib/core/Secrets.ts",
  ].join("\n");
  expect(lint("bin/tool.ts", text)).toEqual([]);
});

test("a hand-off file that still matches passes", () => {
  const handOffs = { "lib/core/Notify.ts": "P09" };
  const sources = [{ path: "lib/core/Notify.ts", text: 'kayaHomePath("secrets.json")\n' }];
  expect(lintSecretsFileSources(sources, handOffs).errors).toEqual([]);
});

test("errors on a stale hand-off entry: file no longer matches", () => {
  const handOffs = { "lib/core/Notify.ts": "P09" };
  const sources = [{ path: "lib/core/Notify.ts", text: 'optionalSecret("telegram.bot_token")\n' }];
  const { errors } = lintSecretsFileSources(sources, handOffs);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain("lib/core/Notify.ts: stale hand-off entry (P09)");
});

test("errors on a stale hand-off entry: file is gone", () => {
  const { errors } = lintSecretsFileSources([], { "lib/core/Gone.ts": "P09" });
  expect(errors).toEqual([expect.stringContaining("lib/core/Gone.ts: stale hand-off entry (P09)")]);
});

test("every hand-off entry names a plan", () => {
  // P09 slices 2–4 removed the last entries (TelegramConfig, TelegramGateway,
  // ApprovalNudge, WaitingOnJmNotifier, NotificationService).
  expect(Object.keys(HAND_OFFS)).toHaveLength(0);
  for (const plan of Object.values(HAND_OFFS)) expect(plan).toMatch(/^P\d{2}$/);
});
