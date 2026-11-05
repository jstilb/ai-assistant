import { describe, expect, test } from "bun:test";
import { normalizeSource } from "./sourceText.ts";

describe("normalizeSource", () => {
  test("drops line and block comments", () => {
    const out = normalizeSource("// header\nconst a = 1; /* mid */ const b = 2; // tail\n");
    expect(out).not.toContain("header");
    expect(out).not.toContain("mid");
    expect(out).not.toContain("tail");
    expect(out).toContain("const a = 1");
  });

  test("makes quote style and line breaks irrelevant", () => {
    const a = normalizeSource("import { x } from './a.ts';");
    const b = normalizeSource('import {\n  x,\n} from "./a.ts";');
    expect(a).toContain('from "./a.ts"');
    expect(b).toContain('from "./a.ts"');
  });

  test("keeps a // inside a URL string", () => {
    expect(normalizeSource('const u = "https://example.com";')).toContain("https://example.com");
  });
});
