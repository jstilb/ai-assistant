#!/usr/bin/env bun
/**
 * ReverseSpecTools.test.ts — Inventory + SpecLint against a synthetic Kaya tree.
 *
 * Covers:
 * - inferKind / specPathFor mapping for every subject kind
 * - enumerateSubjects finds skills, categories, hooks, components, agents, bin
 * - hashSubject is content-sensitive and order-independent; skips State/Output
 * - inventory status: missing → current → stale as the subject changes
 * - renderIndex/writeIndex produce the coverage header and per-kind tables
 * - SpecLint passes a template-conformant spec and fails each structural defect
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  enumerateSubjects,
  hashSubject,
  inferKind,
  inventory,
  parseFrontmatter,
  renderIndex,
  specPathFor,
  subjectFilesFor,
  writeIndex,
} from "./Inventory";
import { lintSpecContent, splitSections, tableRows, findAllSpecs, REQUIRED_SECTIONS } from "./SpecLint";

const ROOT = join(tmpdir(), `reversespec-test-${process.pid}-${Date.now()}`);

function write(rel: string, content: string): void {
  const abs = join(ROOT, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf-8");
}

function goodSpec(subject: string, kind: string, hash: string, files: number, overrides: Partial<Record<string, string>> = {}): string {
  const sections: Record<string, string> = {
    Summary: "A plain-language summary with no code in it.",
    Purpose: "Exists so callers do not repeat X. Deleting it would reappear across 3 callers.",
    Context: "- Location: `skills/Life/Alpha`\n- Callers: /alpha\n- Uses: none",
    Ontology: "**Alpha**: the thing.\n\n- An Alpha has one Beta.",
    Interface: "- Entry: `bun Tools/Run.ts`\n- Errors: fails loud on missing input",
    Features: "1. F1 does a thing\n2. F2 does another",
    "Acceptance Criteria":
      "| ID | Criterion | Verification | Status |\n|----|-----------|--------------|--------|\n| AC1 | a | `bun x` | observed |\n| AC2 | b | `bun y` | inferred |\n| AC3 | c | `bun z` | observed |\n| AC4 | d | manual | unverified |",
    "Tests And Edge Cases": "- Existing: none\n- Edge cases: empty input (uncovered)",
    "Evals And Metrics": "- Existing evals: none\n- Proposed: measure accuracy",
    Diagrams: "```mermaid\nclassDiagram\n  Alpha --> Beta\n```\n\n```mermaid\nsequenceDiagram\n  A->>B: go\n```",
    "Rebuild Notes": "Create SKILL.md then Tools/Run.ts.",
    Findings: "### Improvements\n\nnone found\n\n### Redundancies\n\nnone found\n\n### Synergies\n\nnone found\n\n### Contradictions\n\nnone found\n\n### Open Questions\n\nnone found",
    ...overrides,
  };
  const body = REQUIRED_SECTIONS.map((t) => `## ${t}\n\n${sections[t]}\n`).join("\n");
  return `---
subject: ${subject}
kind: ${kind}
spec_version: 1
source_hash: ${hash}
source_files: ${files}
generated: 2026-09-20
generated_by: ReverseSpec
status: draft
confidence: medium
---

# Alpha — Reverse-Engineered Spec

${body}`;
}

beforeAll(() => {
  mkdirSync(ROOT, { recursive: true });
  // category with two skills
  write("skills/Life/SKILL.md", "---\nname: Life\ndescription: Life. USE WHEN life.\n---\n# Life\n## Sub-Skills\n");
  write("skills/Life/Alpha/SKILL.md", "---\nname: Alpha\ndescription: Alpha. USE WHEN alpha.\n---\n# Alpha\n");
  write("skills/Life/Alpha/Tools/Run.ts", "export const x = 1;\n");
  write("skills/Life/Alpha/State/state.json", '{"ignored": true}');
  write("skills/Life/Alpha/Output/out.md", "ignored output");
  write("skills/Life/Beta/SKILL.md", "---\nname: Beta\ndescription: Beta. USE WHEN beta.\n---\n# Beta\n");
  // hooks
  write("hooks/Guard.hook.ts", "if (import.meta.main) {}\n");
  write("hooks/Guard.hook.test.ts", "// test\n");
  write("hooks/Other.hook.ts", "// other\n");
  write("hooks/Task.sh", "#!/bin/sh\n");
  write("hooks/handlers/Handler.ts", "export {};\n");
  write("hooks/lib/util.ts", "export {};\n");
  // lib components
  write("lib/core/Thing.ts", "export const thing = 1;\n");
  write("lib/core/Thing.test.ts", "// test\n");
  write("lib/core/Thing.extra.test.ts", "// test 2\n");
  write("lib/core/Thing.help.md", "help\n");
  write("lib/test/pin.ts", "export {};\n");
  write("lib/core/__tests__/ignored.ts", "export {};\n");
  // agents + bin
  write("agents/Engineer.md", "# Engineer\n");
  write("bin/merge.sh", "#!/bin/sh\n");
  write("bin/merge.test.sh", "#!/bin/sh\n");
  write("bin/__tests__/merge.test.ts", "// t\n");
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("inferKind / specPathFor", () => {
  it("maps every subject kind to its canonical spec path", () => {
    expect(inferKind("skills/Life")).toBe("category");
    expect(inferKind("skills/Life/Alpha")).toBe("skill");
    expect(inferKind("skills/Life/Alpha/Tools/Run.ts")).toBe("component");
    expect(inferKind("hooks/Guard.hook.ts")).toBe("hook");
    expect(inferKind("hooks/Task.sh")).toBe("hook");
    expect(inferKind("hooks/handlers/Handler.ts")).toBe("component");
    expect(inferKind("lib/core/Thing.ts")).toBe("component");
    expect(inferKind("agents/Engineer.md")).toBe("agent");
    expect(inferKind("bin/merge.sh")).toBe("bin");
    expect(inferKind("USER/ABOUTME.md")).toBeNull();

    expect(specPathFor("skills/Life")).toBe("docs/specs/skills/Life.md");
    expect(specPathFor("skills/Life/Alpha")).toBe("docs/specs/skills/Life/Alpha.md");
    expect(specPathFor("hooks/Guard.hook.ts")).toBe("docs/specs/hooks/Guard.md");
    expect(specPathFor("lib/core/Thing.ts")).toBe("docs/specs/lib/core/Thing.md");
    expect(specPathFor("agents/Engineer.md")).toBe("docs/specs/agents/Engineer.md");
    expect(specPathFor("bin/merge.sh")).toBe("docs/specs/bin/merge.md");
  });
});

describe("enumerateSubjects", () => {
  it("finds every kind and nothing from test/state dirs", () => {
    const subjects = enumerateSubjects(ROOT).map((s) => `${s.kind}:${s.subject}`);
    expect(subjects).toContain("category:skills/Life");
    expect(subjects).toContain("skill:skills/Life/Alpha");
    expect(subjects).toContain("skill:skills/Life/Beta");
    expect(subjects).toContain("hook:hooks/Guard.hook.ts");
    expect(subjects).toContain("hook:hooks/Task.sh");
    expect(subjects).toContain("component:hooks/handlers/Handler.ts");
    expect(subjects).toContain("component:hooks/lib/util.ts");
    expect(subjects).toContain("component:lib/core/Thing.ts");
    expect(subjects).toContain("agent:agents/Engineer.md");
    expect(subjects).toContain("bin:bin/merge.sh");
    expect(subjects.some((s) => s.includes("Thing.test.ts"))).toBe(false);
    expect(subjects.some((s) => s.includes("lib/test/"))).toBe(false);
    expect(subjects.some((s) => s.includes("__tests__"))).toBe(false);
    expect(subjects.some((s) => s.includes("merge.test.sh"))).toBe(false);
  });

  it("filters by kind", () => {
    const hooks = enumerateSubjects(ROOT, ["hook"]);
    expect(hooks.every((s) => s.kind === "hook")).toBe(true);
    expect(hooks.length).toBe(3);
  });
});

describe("subjectFilesFor / hashSubject", () => {
  it("skill dirs include tools but skip State/ and Output/", () => {
    const files = subjectFilesFor(ROOT, "skills/Life/Alpha").map((f) => f.replace(ROOT + "/", ""));
    expect(files).toEqual(["skills/Life/Alpha/SKILL.md", "skills/Life/Alpha/Tools/Run.ts"]);
  });

  it("category subjects hash only their own SKILL.md", () => {
    const files = subjectFilesFor(ROOT, "skills/Life").map((f) => f.replace(ROOT + "/", ""));
    expect(files).toEqual(["skills/Life/SKILL.md"]);
  });

  it("single-file subjects pull in their tests and help", () => {
    const hook = subjectFilesFor(ROOT, "hooks/Guard.hook.ts").map((f) => f.replace(ROOT + "/", ""));
    expect(hook).toEqual(["hooks/Guard.hook.test.ts", "hooks/Guard.hook.ts"]);
    const comp = subjectFilesFor(ROOT, "lib/core/Thing.ts").map((f) => f.replace(ROOT + "/", ""));
    expect(comp).toEqual(["lib/core/Thing.extra.test.ts", "lib/core/Thing.help.md", "lib/core/Thing.test.ts", "lib/core/Thing.ts"]);
    const bin = subjectFilesFor(ROOT, "bin/merge.sh").map((f) => f.replace(ROOT + "/", ""));
    expect(bin).toEqual(["bin/__tests__/merge.test.ts", "bin/merge.sh", "bin/merge.test.sh"]);
  });

  it("hash is 12 hex chars, changes with content, ignores State/", () => {
    const before = hashSubject(ROOT, "skills/Life/Alpha");
    expect(before.hash).toMatch(/^[0-9a-f]{12}$/);
    expect(before.loc).toBeGreaterThan(0);
    write("skills/Life/Alpha/State/state.json", '{"changed": true}');
    expect(hashSubject(ROOT, "skills/Life/Alpha").hash).toBe(before.hash);
    write("skills/Life/Alpha/Tools/Run.ts", "export const x = 2;\n");
    expect(hashSubject(ROOT, "skills/Life/Alpha").hash).not.toBe(before.hash);
  });

  it("returns an empty file list for a missing subject", () => {
    expect(subjectFilesFor(ROOT, "skills/Life/Nope")).toEqual([]);
    expect(hashSubject(ROOT, "skills/Life/Nope").files).toEqual([]);
  });
});

describe("inventory status + index", () => {
  it("tracks missing → current → stale", () => {
    const subject = "skills/Life/Beta";
    const spec = specPathFor(subject);
    let row = inventory(ROOT, ["skill"]).find((r) => r.subject === subject)!;
    expect(row.status).toBe("missing");

    const { hash, files } = hashSubject(ROOT, subject);
    write(spec, goodSpec(subject, "skill", hash, files.length));
    row = inventory(ROOT, ["skill"]).find((r) => r.subject === subject)!;
    expect(row.status).toBe("current");
    expect(row.generated).toBe("2026-09-20");

    write("skills/Life/Beta/SKILL.md", "---\nname: Beta\ndescription: Beta v2. USE WHEN beta.\n---\n# Beta\n");
    row = inventory(ROOT, ["skill"]).find((r) => r.subject === subject)!;
    expect(row.status).toBe("stale");

    write(spec, "# no frontmatter\n");
    row = inventory(ROOT, ["skill"]).find((r) => r.subject === subject)!;
    expect(row.status).toBe("invalid");
    rmSync(join(ROOT, spec));
  });

  it("renders a coverage header and one table per kind, and writeIndex persists it", () => {
    const rows = inventory(ROOT);
    const md = renderIndex(rows, "2026-09-20");
    expect(md).toContain("# Spec Index");
    expect(md).toContain("**Coverage:**");
    expect(md).toContain("## skill (");
    expect(md).toContain("## hook (");
    expect(md).toContain("| `skills/Life/Alpha` |");
    const target = writeIndex(ROOT, "2026-09-20");
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf-8")).toContain("Do not hand-edit");
  });

  it("parseFrontmatter strips inline comments and quotes", () => {
    const fm = parseFrontmatter('---\nsubject: "skills/Life/Alpha"   # the dir\nkind: skill\n---\nbody');
    expect(fm?.subject).toBe("skills/Life/Alpha");
    expect(fm?.kind).toBe("skill");
    expect(parseFrontmatter("no frontmatter")).toBeNull();
  });
});

describe("SpecLint", () => {
  const subject = "skills/Life/Alpha";
  const specRel = specPathFor(subject);

  function lint(content: string) {
    return lintSpecContent(ROOT, specRel, content);
  }

  it("passes a template-conformant spec with a current hash", () => {
    const { hash, files } = hashSubject(ROOT, subject);
    const r = lint(goodSpec(subject, "skill", hash, files.length));
    expect(r.errors).toBe(0);
    expect(r.warnings).toBe(0);
  });

  it("warns (not errors) when the hash is stale", () => {
    const r = lint(goodSpec(subject, "skill", "000000000000", 2));
    expect(r.errors).toBe(0);
    expect(r.issues.some((i) => i.level === "warning" && /stale/.test(i.message))).toBe(true);
  });

  it("fails on missing frontmatter keys, wrong kind, bad status, wrong path, missing subject", () => {
    const { hash, files } = hashSubject(ROOT, subject);
    const base = goodSpec(subject, "skill", hash, files.length);
    expect(lint(base.replace("confidence: medium\n", "")).issues.map((i) => i.message)).toContain("frontmatter: missing `confidence`");
    expect(lint(base.replace("kind: skill", "kind: hook")).errors).toBeGreaterThan(0);
    expect(lint(base.replace("status: draft", "status: final")).errors).toBeGreaterThan(0);
    expect(lintSpecContent(ROOT, "docs/specs/wrong/Place.md", base).issues.some((i) => /canonical path/.test(i.message))).toBe(true);
    expect(lint(goodSpec("skills/Life/Ghost", "skill", "abc", 1)).issues.some((i) => /does not exist on disk/.test(i.message))).toBe(true);
  });

  it("fails on a missing, empty, duplicated, or out-of-order section", () => {
    const { hash, files } = hashSubject(ROOT, subject);
    const base = goodSpec(subject, "skill", hash, files.length);
    expect(lint(base.replace("## Purpose\n", "## Goal\n")).issues.map((i) => i.message)).toContain("missing section `## Purpose`");
    expect(lint(goodSpec(subject, "skill", hash, files.length, { Purpose: "<!-- only a comment -->" })).issues.map((i) => i.message)).toContain(
      "section `## Purpose` is empty",
    );
    expect(lint(base + "\n## Summary\n\nagain\n").issues.some((i) => /appears 2 times/.test(i.message))).toBe(true);
    const swapped = base.replace("## Summary\n", "## TMP\n").replace("## Purpose\n", "## Summary\n").replace("## TMP\n", "## Purpose\n");
    expect(lint(swapped).issues.some((i) => /out of order/.test(i.message))).toBe(true);
  });

  it("enforces Findings subsections, AC row minimum, and mermaid count", () => {
    const { hash, files } = hashSubject(ROOT, subject);
    const noSub = goodSpec(subject, "skill", hash, files.length, {
      Findings: "### Improvements\n\nnone found\n\n### Redundancies\n\nnone found\n\n### Synergies\n\nnone found\n\n### Contradictions\n\nnone found",
    });
    expect(lint(noSub).issues.map((i) => i.message)).toContain("Findings: missing `### Open Questions`");
    const emptySub = goodSpec(subject, "skill", hash, files.length, {
      Findings: "### Improvements\n\n### Redundancies\n\nnone found\n\n### Synergies\n\nnone found\n\n### Contradictions\n\nnone found\n\n### Open Questions\n\nnone found",
    });
    expect(lint(emptySub).issues.some((i) => /`### Improvements` is empty/.test(i.message))).toBe(true);

    const fewRows = goodSpec(subject, "skill", hash, files.length, {
      "Acceptance Criteria": "| ID | Criterion | Verification | Status |\n|---|---|---|---|\n| AC1 | a | `x` | observed |",
    });
    expect(lint(fewRows).issues.some((i) => /1 table rows, minimum is 4/.test(i.message))).toBe(true);

    const oneDiagram = goodSpec(subject, "skill", hash, files.length, { Diagrams: "```mermaid\ngraph TD\nA-->B\n```" });
    const r1 = lint(oneDiagram);
    expect(r1.errors).toBe(0);
    expect(r1.issues.some((i) => /only one mermaid/.test(i.message))).toBe(true);
    const noDiagram = goodSpec(subject, "skill", hash, files.length, { Diagrams: "prose only" });
    expect(lint(noDiagram).issues.map((i) => i.message)).toContain("Diagrams: no ```mermaid block");
  });

  it("warns on leftover template comments, backticks in Summary, unresolvable paths, and unverified '0 fail'", () => {
    const { hash, files } = hashSubject(ROOT, subject);
    const r = lint(
      goodSpec(subject, "skill", hash, files.length, {
        Summary: "Uses `lib/core/Thing.ts` directly.\n<!-- 3–6 sentences of plain language. -->",
        Context: "See `skills/Life/Missing/SKILL.md:12` and `lib/core/Thing.ts:3`.",
        "Tests And Edge Cases": "All tests pass, 0 fail.",
      }),
    );
    expect(r.errors).toBe(0);
    const msgs = r.issues.map((i) => i.message).join("\n");
    expect(msgs).toMatch(/template guidance comment/);
    expect(msgs).toMatch(/Summary: contains backticks/);
    expect(msgs).toMatch(/referenced path does not exist: `skills\/Life\/Missing\/SKILL.md`/);
    expect(msgs).not.toMatch(/lib\/core\/Thing.ts`/);
    expect(msgs).toMatch(/"0 fail" without/);
  });

  it("helpers: splitSections ignores headings inside fences; tableRows skips separators", () => {
    const secs = splitSections("---\na: b\n---\n## One\n\n```md\n## NotASection\n```\n\n### Sub\ntext\n");
    expect(secs.map((s) => `${s.level}:${s.title}`)).toEqual(["2:One", "3:Sub"]);
    expect(tableRows("| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |")).toEqual([["1", "2"], ["3", "4"]]);
  });

  it("findAllSpecs excludes INDEX.md and CROSS-SPEC.md", () => {
    write("docs/specs/INDEX.md", "# idx");
    write("docs/specs/CROSS-SPEC.md", "# x");
    write("docs/specs/skills/Life/Alpha.md", "# spec");
    const all = findAllSpecs(ROOT).map((p) => p.replace(ROOT + "/", ""));
    expect(all).toEqual(["docs/specs/skills/Life/Alpha.md"]);
  });
});
