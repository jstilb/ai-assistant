import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findViolations } from "./no-cross-skill-import.ts";

let root: string;

function touch(rel: string): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, "export {};\n");
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "xskill-lint-"));
  touch("skills/Cat/Other/Tools/Thing.ts");
  touch("skills/Cat/Self/Tools/Own.ts");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const FILE = "skills/Cat/Self/Tools/Main.ts";

describe("no-cross-skill-import findViolations", () => {
  test("flags an unmarked static import", () => {
    const v = findViolations(root, FILE, `import { x } from "../../Other/Tools/Thing.ts";\n`);
    expect(v).toHaveLength(1);
  });

  test("allows same-skill and package imports", () => {
    const src = `import a from "./Own.ts";\nimport b from "zod";\n`;
    expect(findViolations(root, FILE, src)).toHaveLength(0);
  });

  test("marker on the line above clears a single-line import", () => {
    const src = `// cross-skill-allowed: test\nimport { x } from "../../Other/Tools/Thing.ts";\n`;
    expect(findViolations(root, FILE, src)).toHaveLength(0);
  });

  test("marker above a multi-line import clears the closing from-line", () => {
    const src = `// cross-skill-allowed: test\nimport {\n  a,\n  b,\n} from "../../Other/Tools/Thing.ts";\n`;
    expect(findViolations(root, FILE, src)).toHaveLength(0);
  });

  test("a marker far above an unrelated dynamic import does not leak", () => {
    const src = `// cross-skill-allowed: other thing\nconst a = 1;\nconst b = 2;\nconst { x } = await import("../../Other/Tools/Thing.ts");\n`;
    expect(findViolations(root, FILE, src)).toHaveLength(1);
  });

  test("flags a variable-specifier dynamic import into another skill", () => {
    const src = `const P = "../../Other/Tools/Thing.ts";\nconst m = await import(P);\n`;
    const v = findViolations(root, FILE, src);
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain("variable-specifier");
  });

  test("allows a marked variable-specifier import", () => {
    const src = `// cross-skill-allowed: test\nconst P = "../../Other/Tools/Thing.ts";\nconst m = await import(P);\n`;
    expect(findViolations(root, FILE, src)).toHaveLength(0);
  });

  test("allows a variable-specifier import inside the same skill", () => {
    const src = `const P = "./Own.ts";\nconst m = await import(P);\n`;
    expect(findViolations(root, FILE, src)).toHaveLength(0);
  });

  test("flags a template-literal import into another skill", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture is source text that contains a template literal
    const src = "const m = await import(`../../Other/Tools/Thing.ts?t=${Date.now()}`);\n";
    expect(findViolations(root, FILE, src)).toHaveLength(1);
  });

  test("ignores files outside skills/", () => {
    expect(findViolations(root, "lib/x.ts", `import a from "../skills/Cat/Other/Tools/Thing.ts";\n`)).toHaveLength(0);
  });
});
