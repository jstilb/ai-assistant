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

  test("flags a literal path to another skill's DB file", () => {
    const src = `const p = join(home, "skills/Cat/Other/Data/other.db");\n`;
    const v = findViolations(root, FILE, src);
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain("reads another skill's database file");
  });

  test("flags a template-literal path to another skill's DB file", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture is source text that contains a template literal
    const src = "const p = `${KAYA_HOME}/skills/Cat/Other/Data/other.db`;\n";
    expect(findViolations(root, FILE, src)).toHaveLength(1);
  });

  test("flags the join form of another skill's Data dir", () => {
    const src = `const p = join(home, "skills", 'Cat', "Other", "Data", "other.db");\n`;
    const v = findViolations(root, FILE, src);
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain("reads another skill's database file");
  });

  test("a marker on the line or the line above clears a DB path", () => {
    const inline = `const p = "skills/Cat/Other/Data/other.db"; // cross-skill-allowed: test\n`;
    const above = `// cross-skill-allowed: test\nconst p = join(home, "skills", "Cat", "Other", "Data");\n`;
    expect(findViolations(root, FILE, inline)).toHaveLength(0);
    expect(findViolations(root, FILE, above)).toHaveLength(0);
  });

  test("allows the file's own skill DB path", () => {
    const src = `const a = "skills/Cat/Self/Data/self.db";\nconst b = join(h, "skills", "Cat", "Self", "Data");\n`;
    expect(findViolations(root, FILE, src)).toHaveLength(0);
  });

  test("does not flag a bare DB file name without a skills/<Cat>/<Skill>/Data/ prefix", () => {
    const src = `const p = join(tmpdir(), "lucidtasks.db");\n`;
    expect(findViolations(root, FILE, src)).toHaveLength(0);
  });

  test("flags a lowercase data/ path and join form (case-insensitive file system)", () => {
    expect(findViolations(root, FILE, `const p = "skills/Cat/Other/data/other.db";\n`)).toHaveLength(1);
    expect(findViolations(root, FILE, `const p = join(h, "skills", "Cat", "Other", "data");\n`)).toHaveLength(1);
  });

  test("does not flag a whole-line comment that names another skill's DB path", () => {
    const src = [
      "// reads skills/Cat/Other/Data/other.db",
      "/* reads skills/Cat/Other/Data/other.db */",
      " * reads skills/Cat/Other/Data/other.db",
      "",
    ].join("\n");
    expect(findViolations(root, FILE, src)).toHaveLength(0);
  });

  test("the owner compare uses category and skill: same skill name in another category is flagged", () => {
    const src = `const p = "skills/OtherCat/Self/Data/self.db";\n`;
    expect(findViolations(root, FILE, src)).toHaveLength(1);
  });

  test("ignores files outside skills/", () => {
    expect(findViolations(root, "lib/x.ts", `import a from "../skills/Cat/Other/Tools/Thing.ts";\n`)).toHaveLength(0);
  });
});
