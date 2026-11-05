import { describe, expect, test } from "bun:test";
import { findRawAppendCalls } from "./no-raw-append.ts";

describe("findRawAppendCalls", () => {
  test("flags a real call", () => {
    expect(findRawAppendCalls(`import fs from 'fs';\nfs.appendFileSync(p, 'x');`)).toEqual([2]);
  });

  test("ignores comments and import lists that only mention the token", () => {
    const src = [
      `import { appendFileSync } from 'fs';`,
      `// we no longer call appendFileSync( here`,
      ` * appendFileSync( in a doc block`,
    ].join("\n");
    expect(findRawAppendCalls(src)).toEqual([]);
  });

  test("honours a lint-allow marker on the line above", () => {
    const src = `// lint-allow: no-raw-append — shell rc\nappendFileSync(rc, line);`;
    expect(findRawAppendCalls(src)).toEqual([]);
  });

  test("honours the older EXEMPT marker within the window", () => {
    const src = `// EXEMPT (appendFileSync sweep): one-shot report\nconst a = 1;\nappendFileSync(f, c);`;
    expect(findRawAppendCalls(src)).toEqual([]);
  });

  test("a marker far above does not cover a later call", () => {
    const src = [`// lint-allow: no-raw-append — first`, ...Array(20).fill("x();"), `appendFileSync(f, c);`].join("\n");
    expect(findRawAppendCalls(src)).toEqual([22]);
  });
});
