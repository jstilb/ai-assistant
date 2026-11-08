import { expect, test } from "bun:test";
import { addedLines } from "./StagedDiff.ts";

const DIFF = [
  "diff --git a/a.ts b/a.ts",
  "index 1..2 100644",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -3,0 +4,2 @@",
  "+const x = 1;",
  "+const y = 2;",
  "@@ -10 +12 @@",
  "-old",
  "+new",
  "diff --git a/skip.ts b/skip.ts",
  "--- a/skip.ts",
  "+++ b/skip.ts",
  "@@ -0,0 +1 @@",
  "+ignored",
].join("\n");

test("addedLines yields new-file line numbers and skips exempt files", () => {
  expect(addedLines(DIFF, (f) => f === "skip.ts")).toEqual([
    { file: "a.ts", line: 4, text: "const x = 1;" },
    { file: "a.ts", line: 5, text: "const y = 2;" },
    { file: "a.ts", line: 12, text: "new" },
  ]);
});
