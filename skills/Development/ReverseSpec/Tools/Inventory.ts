#!/usr/bin/env bun
/**
 * Inventory.ts — Enumerate ReverseSpec subjects and their spec coverage.
 *
 * PURPOSE:
 * The deterministic half of the ReverseSpec skill. Walks the Kaya tree,
 * lists every spec-able subject (skills, categories, hooks, components,
 * agents, bin scripts), computes a content hash per subject, and compares
 * it with the `source_hash` recorded in the subject's spec frontmatter so
 * coverage and staleness are a fact, not a guess.
 *
 * Subject → spec path mapping is fixed here (specPathFor) so every writer
 * and reader agrees: `docs/specs/<subject-with-extension-stripped>.md`.
 *
 * USAGE:
 *   bun Inventory.ts list [--kind skill|category|hook|component|agent|bin]
 *                         [--missing|--stale|--current] [--json]
 *   bun Inventory.ts hash <subject>        # print hash + file count for frontmatter
 *   bun Inventory.ts show <subject>        # files, LOC, hash, spec path, status
 *   bun Inventory.ts index                 # (re)write docs/specs/INDEX.md
 *   --root <dir> overrides the Kaya home (tests use a temp tree).
 */

import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "fs";
import { basename, dirname, join, relative, sep } from "path";
import { parseArgs } from "util";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";

// ============================================================================
// Types
// ============================================================================

export type SubjectKind = "skill" | "category" | "hook" | "component" | "agent" | "bin";

export const SUBJECT_KINDS: readonly SubjectKind[] = [
  "skill",
  "category",
  "hook",
  "component",
  "agent",
  "bin",
];

export type SpecStatus = "missing" | "current" | "stale" | "invalid";

export interface Subject {
  /** Repo-relative path: dir for skills/categories, file otherwise. */
  subject: string;
  kind: SubjectKind;
}

export interface SubjectHash {
  hash: string;
  files: string[];
  loc: number;
}

export interface SpecFrontmatter {
  subject?: string;
  kind?: string;
  spec_version?: string;
  source_hash?: string;
  source_files?: string;
  generated?: string;
  generated_by?: string;
  status?: string;
  confidence?: string;
  [key: string]: string | undefined;
}

export interface InventoryRow extends Subject {
  specPath: string;
  specExists: boolean;
  status: SpecStatus;
  currentHash: string;
  recordedHash?: string;
  files: number;
  loc: number;
  generated?: string;
  confidence?: string;
  specStatus?: string;
}

// ============================================================================
// Constants
// ============================================================================

const SPECS_DIR = "docs/specs";
const INDEX_FILE = "INDEX.md";

const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".mjs", ".md", ".sh", ".yaml", ".yml", ".json",
  ".py", ".txt", ".toml", ".css", ".html", ".jsonl", ".csv",
]);

/** Directories inside a subject that are runtime state / output, not source. */
const SKIP_DIRS = new Set(["node_modules", "Output", "State", ".cache", "dist", "__pycache__", ".git"]);

const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Suffixes stripped (longest first) when mapping a subject to its spec path. */
const STRIP_SUFFIXES = [".hook.ts", ".test.ts", ".ts", ".sh", ".md", ".py"];

// ============================================================================
// Path helpers
// ============================================================================

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

function extOf(file: string): string {
  const b = basename(file);
  const i = b.lastIndexOf(".");
  return i === -1 ? "" : b.slice(i);
}

function isTestFile(file: string): boolean {
  const b = basename(file);
  return (
    b.endsWith(".test.ts") ||
    b.endsWith(".smoke.ts") ||
    b.endsWith(".test.sh") ||
    file.split("/").includes("__tests__") ||
    file.split("/").includes("__fixtures__")
  );
}

/** Infer the subject kind from its repo-relative path. */
export function inferKind(subject: string): SubjectKind | null {
  const s = toPosix(subject).replace(/\/+$/, "");
  const parts = s.split("/");
  if (parts[0] === "skills") {
    if (parts.length === 2) return "category";
    if (parts.length === 3) return "skill";
    return "component"; // a file or dir inside a skill (e.g. skills/X/Y/Tools/Foo.ts)
  }
  if (parts[0] === "hooks") {
    if (parts.length === 2 && (s.endsWith(".hook.ts") || s.endsWith(".sh"))) return "hook";
    return "component"; // hooks/handlers/*, hooks/lib/*
  }
  if (parts[0] === "lib") return "component";
  if (parts[0] === "agents" && parts.length === 2) return "agent";
  if (parts[0] === "bin" && parts.length === 2) return "bin";
  return null;
}

/** Spec file for a subject: docs/specs/<subject minus extension>.md */
export function specPathFor(subject: string): string {
  let s = toPosix(subject).replace(/\/+$/, "");
  for (const suf of STRIP_SUFFIXES) {
    if (s.endsWith(suf)) {
      s = s.slice(0, -suf.length);
      break;
    }
  }
  return `${SPECS_DIR}/${s}.md`;
}

// ============================================================================
// File collection
// ============================================================================

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), out);
    } else if (entry.isFile()) {
      out.push(join(dir, entry.name));
    }
  }
}

function isTextSource(absPath: string): boolean {
  if (!TEXT_EXTENSIONS.has(extOf(absPath))) return false;
  try {
    return statSync(absPath).size <= MAX_FILE_BYTES;
  } catch (err) {
    console.error(`[Inventory] stat failed for ${absPath}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** Sibling files that belong to a single-file subject (tests, help, smoke). */
function siblingFiles(root: string, subject: string): string[] {
  const abs = join(root, subject);
  const dir = dirname(abs);
  const b = basename(subject);
  const base = b.replace(/\.hook\.ts$/, "").replace(/\.(ts|sh|md|py)$/, "");
  const out: string[] = [abs];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name === b) continue;
    const n = entry.name;
    const matches =
      n === `${base}.test.ts` ||
      n === `${base}.hook.test.ts` ||
      n === `${base}.smoke.ts` ||
      n === `${base}.help.md` ||
      n === `${base}.test.sh` ||
      (n.startsWith(`${base}.`) && n.endsWith(".test.ts"));
    if (matches) out.push(join(dir, n));
  }
  const testsDir = join(dir, "__tests__");
  if (existsSync(testsDir)) {
    for (const entry of readdirSync(testsDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.toLowerCase().startsWith(base.toLowerCase())) {
        out.push(join(testsDir, entry.name));
      }
    }
  }
  return out;
}

/** Absolute paths of every source file that makes up a subject. */
export function subjectFilesFor(root: string, subject: string): string[] {
  const kind = inferKind(subject);
  const abs = join(root, subject);
  if (!existsSync(abs)) return [];
  const st = statSync(abs);
  let files: string[];
  if (kind === "category") {
    files = [join(abs, "SKILL.md")].filter(existsSync);
  } else if (st.isDirectory()) {
    files = [];
    walk(abs, files);
  } else {
    files = siblingFiles(root, subject);
  }
  return files.filter(isTextSource).sort();
}

/** Content hash (12 hex chars) + LOC over a file list, order-independent. */
export function hashFiles(root: string, files: string[]): SubjectHash {
  const sorted = [...files].sort();
  const h = createHash("sha256");
  let loc = 0;
  for (const f of sorted) {
    const content = readFileSync(f, "utf-8");
    loc += content.length === 0 ? 0 : content.split("\n").length;
    h.update(toPosix(relative(root, f)));
    h.update("\0");
    h.update(content);
    h.update("\0");
  }
  return { hash: h.digest("hex").slice(0, 12), files: sorted, loc };
}

export function hashSubject(root: string, subject: string): SubjectHash {
  return hashFiles(root, subjectFilesFor(root, subject));
}

// ============================================================================
// Subject enumeration
// ============================================================================

function listDir(root: string, rel: string): { name: string; isDir: boolean }[] {
  const abs = join(root, rel);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true })
    .map((e) => ({ name: e.name, isDir: e.isDirectory() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function walkRel(root: string, rel: string, out: string[]): void {
  for (const e of listDir(root, rel)) {
    if (e.isDir) {
      if (SKIP_DIRS.has(e.name) || e.name === "__tests__" || e.name === "test") continue;
      walkRel(root, `${rel}/${e.name}`, out);
    } else {
      out.push(`${rel}/${e.name}`);
    }
  }
}

/** Every subject in the tree, in a stable order. */
export function enumerateSubjects(root: string, kinds: readonly SubjectKind[] = SUBJECT_KINDS): Subject[] {
  const want = new Set(kinds);
  const out: Subject[] = [];

  // skills/<Cat> (category) and skills/<Cat>/<Name> (skill)
  for (const cat of listDir(root, "skills")) {
    if (!cat.isDir || cat.name.startsWith(".")) continue;
    const catRel = `skills/${cat.name}`;
    const catHasSkillMd = existsSync(join(root, catRel, "SKILL.md"));
    const subs = listDir(root, catRel).filter(
      (s) => s.isDir && existsSync(join(root, catRel, s.name, "SKILL.md")),
    );
    if (catHasSkillMd && subs.length > 0) {
      if (want.has("category")) out.push({ subject: catRel, kind: "category" });
      if (want.has("skill")) for (const s of subs) out.push({ subject: `${catRel}/${s.name}`, kind: "skill" });
    } else if (catHasSkillMd && want.has("skill")) {
      out.push({ subject: catRel, kind: "skill" }); // top-level skill without a category
    }
  }

  // hooks/*.hook.ts, hooks/*.sh
  if (want.has("hook")) {
    for (const e of listDir(root, "hooks")) {
      if (e.isDir) continue;
      if (e.name.endsWith(".hook.ts") || (e.name.endsWith(".sh") && !e.name.endsWith(".test.sh"))) {
        out.push({ subject: `hooks/${e.name}`, kind: "hook" });
      }
    }
  }

  // components: hooks/handlers/*.ts, hooks/lib/*.ts, lib/**/*.ts
  if (want.has("component")) {
    const rels: string[] = [];
    for (const d of ["hooks/handlers", "hooks/lib"]) {
      for (const e of listDir(root, d)) if (!e.isDir) rels.push(`${d}/${e.name}`);
    }
    walkRel(root, "lib", rels);
    for (const rel of rels) {
      if (!rel.endsWith(".ts") || isTestFile(rel)) continue;
      if (rel.startsWith("lib/test/")) continue;
      out.push({ subject: rel, kind: "component" });
    }
  }

  // agents/*.md
  if (want.has("agent")) {
    for (const e of listDir(root, "agents")) {
      if (!e.isDir && e.name.endsWith(".md")) out.push({ subject: `agents/${e.name}`, kind: "agent" });
    }
  }

  // bin/* (files only, no tests)
  if (want.has("bin")) {
    for (const e of listDir(root, "bin")) {
      if (e.isDir || isTestFile(e.name) || e.name.startsWith(".")) continue;
      out.push({ subject: `bin/${e.name}`, kind: "bin" });
    }
  }

  return out;
}

// ============================================================================
// Spec frontmatter
// ============================================================================

/** Parse the leading `---` block of a spec into key/value strings (no YAML lib needed). */
export function parseFrontmatter(content: string): SpecFrontmatter | null {
  if (!content.startsWith("---")) return null;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return null;
  const block = content.slice(3, end);
  const fm: SpecFrontmatter = {};
  for (const raw of block.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf(":");
    if (i === -1) continue;
    const key = line.slice(0, i).trim();
    let value = line.slice(i + 1).trim();
    const hash = value.indexOf(" #");
    if (hash !== -1) value = value.slice(0, hash).trim();
    fm[key] = value.replace(/^["']|["']$/g, "");
  }
  return fm;
}

export function readSpecFrontmatter(root: string, specPath: string): SpecFrontmatter | null {
  const abs = join(root, specPath);
  if (!existsSync(abs)) return null;
  return parseFrontmatter(readFileSync(abs, "utf-8"));
}

// ============================================================================
// Inventory
// ============================================================================

export function inventoryRow(root: string, s: Subject): InventoryRow {
  const specPath = specPathFor(s.subject);
  const { hash, files, loc } = hashSubject(root, s.subject);
  const specExists = existsSync(join(root, specPath));
  let status: SpecStatus = "missing";
  let fm: SpecFrontmatter | null = null;
  if (specExists) {
    fm = readSpecFrontmatter(root, specPath);
    if (!fm || !fm.source_hash) status = "invalid";
    else status = fm.source_hash === hash ? "current" : "stale";
  }
  return {
    ...s,
    specPath,
    specExists,
    status,
    currentHash: hash,
    recordedHash: fm?.source_hash,
    files: files.length,
    loc,
    generated: fm?.generated,
    confidence: fm?.confidence,
    specStatus: fm?.status,
  };
}

export function inventory(root: string, kinds: readonly SubjectKind[] = SUBJECT_KINDS): InventoryRow[] {
  return enumerateSubjects(root, kinds).map((s) => inventoryRow(root, s));
}

// ============================================================================
// Index rendering
// ============================================================================

function pct(n: number, d: number): string {
  return d === 0 ? "0.0%" : `${((100 * n) / d).toFixed(1)}%`;
}

export function renderIndex(rows: InventoryRow[], today: string): string {
  const total = rows.length;
  const count = (st: SpecStatus, list: InventoryRow[] = rows) => list.filter((r) => r.status === st).length;
  const lines: string[] = [];
  lines.push("# Spec Index");
  lines.push("");
  lines.push(
    `> Generated by \`bun skills/Development/ReverseSpec/Tools/Inventory.ts index\` on ${today}. Do not hand-edit — rerun the command.`,
  );
  lines.push("");
  lines.push(
    `**Coverage:** ${count("current")} current / ${total} subjects (${pct(count("current"), total)}) · ${count("stale")} stale · ${count("invalid")} invalid · ${count("missing")} missing`,
  );
  lines.push("");
  lines.push("Cross-spec findings ledger: [CROSS-SPEC.md](./CROSS-SPEC.md)");
  lines.push("");
  for (const kind of SUBJECT_KINDS) {
    const list = rows.filter((r) => r.kind === kind);
    if (list.length === 0) continue;
    lines.push(
      `## ${kind} (${list.length} — ${count("current", list)} current, ${count("stale", list)} stale, ${count("missing", list)} missing)`,
    );
    lines.push("");
    lines.push("| Subject | Spec | Status | Generated | Confidence | Files | LOC |");
    lines.push("|---------|------|--------|-----------|------------|-------|-----|");
    for (const r of list) {
      const specLink = r.specExists ? `[spec](../../${r.specPath})` : "—";
      lines.push(
        `| \`${r.subject}\` | ${specLink} | ${r.status} | ${r.generated ?? "—"} | ${r.confidence ?? "—"} | ${r.files} | ${r.loc} |`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** Local calendar date (YYYY-MM-DD) — not UTC, so an evening run does not stamp tomorrow. */
export function localDate(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function writeIndex(root: string, today: string = localDate()): string {
  const rows = inventory(root);
  const dir = join(root, SPECS_DIR);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, INDEX_FILE);
  writeFileSync(target, renderIndex(rows, today), "utf-8");
  return target;
}

// ============================================================================
// CLI
// ============================================================================

function renderTable(rows: InventoryRow[]): string {
  const lines = ["| Subject | Kind | Status | Files | LOC | Spec |", "|---|---|---|---|---|---|"];
  for (const r of rows) {
    lines.push(`| ${r.subject} | ${r.kind} | ${r.status} | ${r.files} | ${r.loc} | ${r.specExists ? r.specPath : "—"} |`);
  }
  return lines.join("\n");
}

function usage(): void {
  console.log(`Inventory — ReverseSpec subject coverage

Usage:
  bun Inventory.ts list [--kind <kind>] [--missing|--stale|--current] [--json]
  bun Inventory.ts hash <subject>
  bun Inventory.ts show <subject>
  bun Inventory.ts index
  bun Inventory.ts kinds

Options:
  --root <dir>   Kaya home override (default: getKayaHome())
  --kind <kind>  one of: ${SUBJECT_KINDS.join(", ")}
  --json         machine-readable output`);
}

function main(): void {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      root: { type: "string" },
      kind: { type: "string" },
      missing: { type: "boolean", default: false },
      stale: { type: "boolean", default: false },
      current: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  const root = values.root ?? getKayaHome();
  const cmd = positionals[0] ?? "list";
  if (values.help) {
    usage();
    return;
  }

  if (cmd === "kinds") {
    console.log(SUBJECT_KINDS.join("\n"));
    return;
  }

  if (cmd === "hash" || cmd === "show") {
    const subject = positionals[1];
    if (!subject) {
      console.error(`[Inventory] ${cmd} requires a <subject>`);
      process.exit(2);
    }
    const rel = toPosix(relative(root, join(root, subject)));
    if (inferKind(rel) === null) {
      console.error(`[Inventory] not a recognised subject path: ${rel}`);
      process.exit(2);
    }
    if (!existsSync(join(root, rel))) {
      console.error(`[Inventory] subject does not exist: ${rel}`);
      process.exit(2);
    }
    if (cmd === "hash") {
      const { hash, files } = hashSubject(root, rel);
      if (values.json) console.log(JSON.stringify({ subject: rel, source_hash: hash, source_files: files.length }));
      else console.log(`source_hash: ${hash}\nsource_files: ${files.length}`);
      return;
    }
    const row = inventoryRow(root, { subject: rel, kind: inferKind(rel) as SubjectKind });
    const files = subjectFilesFor(root, rel).map((f) => toPosix(relative(root, f)));
    if (values.json) {
      console.log(JSON.stringify({ ...row, fileList: files }, null, 2));
    } else {
      console.log(`subject:      ${row.subject}\nkind:         ${row.kind}\nspec:         ${row.specPath} (${row.status})`);
      console.log(`source_hash:  ${row.currentHash}${row.recordedHash ? `  (recorded ${row.recordedHash})` : ""}`);
      console.log(`files (${files.length}), ${row.loc} LOC:`);
      for (const f of files) console.log(`  ${f}`);
    }
    return;
  }

  if (cmd === "index") {
    const target = writeIndex(root);
    const rows = inventory(root);
    console.log(`[Inventory] wrote ${toPosix(relative(root, target))} — ${rows.filter((r) => r.status === "current").length}/${rows.length} current`);
    return;
  }

  if (cmd !== "list") {
    console.error(`[Inventory] unknown command: ${cmd}`);
    usage();
    process.exit(2);
  }

  let kinds: readonly SubjectKind[] = SUBJECT_KINDS;
  if (values.kind) {
    if (!SUBJECT_KINDS.includes(values.kind as SubjectKind)) {
      console.error(`[Inventory] unknown kind: ${values.kind}`);
      process.exit(2);
    }
    kinds = [values.kind as SubjectKind];
  }
  let rows = inventory(root, kinds);
  if (values.missing) rows = rows.filter((r) => r.status === "missing");
  if (values.stale) rows = rows.filter((r) => r.status === "stale");
  if (values.current) rows = rows.filter((r) => r.status === "current");

  if (values.json) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    console.log(renderTable(rows));
    const all = inventory(root, kinds);
    console.log(
      `\n${all.filter((r) => r.status === "current").length} current · ${all.filter((r) => r.status === "stale").length} stale · ${all.filter((r) => r.status === "invalid").length} invalid · ${all.filter((r) => r.status === "missing").length} missing · ${all.length} total`,
    );
  }
}

if (import.meta.main) {
  main();
}
