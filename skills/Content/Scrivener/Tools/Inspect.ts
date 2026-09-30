#!/usr/bin/env bun
/**
 * Inspect.ts - Read-only inventory and integrity report for a Scrivener 3 .scriv project.
 *
 * READ-ONLY GUARANTEE: this tool never writes inside the .scriv package. It opens
 * files for reading only. Safe to run while Scrivener is open (it reports, not edits).
 *
 * Usage:
 *   bun ~/.claude/skills/Content/Scrivener/Tools/Inspect.ts <project.scriv> [options]
 *
 * Options:
 *   --format md|json   Output format (default: md)
 *   --words            Include word counts (uses macOS textutil; slower)
 *   --check            Run integrity checks (lock file, scrivx<->Data consistency)
 *   --help             Show usage
 *
 * @author Kaya System
 * @version 1.0.0
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { basename, join } from "path";

// ---------- Minimal XML parser (scrivx is machine-generated, well-formed XML) ----------

interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function parseAttrs(s: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const name = m[1];
    const value = m[2];
    if (name !== undefined && value !== undefined) attrs[name] = decodeEntities(value);
  }
  return attrs;
}

/** Parse a well-formed XML document into a node tree. Throws on structural mismatch. */
function parseXml(xml: string): XmlNode {
  const root: XmlNode = { tag: "#document", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  const tagRe = /<(\/?)([\w:.-]+)((?:[^"'>]|"[^"]*"|'[^']*')*?)(\/?)>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(xml)) !== null) {
    const parent = stack[stack.length - 1];
    if (parent === undefined) throw new Error("XML parse error: empty stack");
    const textChunk = xml.slice(lastIndex, m.index);
    if (textChunk.trim().length > 0) parent.text += decodeEntities(textChunk);
    lastIndex = tagRe.lastIndex;
    const [full, closing, tag, attrText, selfClose] = m;
    if (tag === undefined) continue; // comment / PI / CDATA — skipped
    if (closing === "/") {
      const popped = stack.pop();
      if (popped === undefined || popped.tag !== tag) {
        throw new Error(`XML parse error: mismatched </${tag}> near offset ${m.index} (open: ${popped?.tag ?? "none"})`);
      }
    } else {
      const node: XmlNode = { tag, attrs: parseAttrs(attrText ?? ""), children: [], text: "" };
      parent.children.push(node);
      if (selfClose !== "/") stack.push(node);
    }
    void full;
  }
  if (stack.length !== 1) {
    const open = stack[stack.length - 1];
    throw new Error(`XML parse error: unclosed <${open?.tag ?? "?"}>`);
  }
  return root;
}

function child(node: XmlNode, tag: string): XmlNode | undefined {
  return node.children.find((c) => c.tag === tag);
}

function childText(node: XmlNode, tag: string): string {
  return child(node, tag)?.text.trim() ?? "";
}

// ---------- Scrivener model ----------

interface BinderDoc {
  uuid: string;
  type: string;
  title: string;
  labelId: string | null;
  statusId: string | null;
  includeInCompile: boolean;
  hasDataDir: boolean;
  hasContent: boolean;
  hasSynopsis: boolean;
  hasNotes: boolean;
  words: number | null;
  children: BinderDoc[];
}

interface ProjectReport {
  project: string;
  path: string;
  scrivx: { file: string; version: string; creator: string; modified: string };
  formatVersion: string | null;
  labelAxis: { title: string; labels: Record<string, string> };
  statusAxis: { title: string; statuses: Record<string, string> };
  tree: BinderDoc[];
  stats: {
    totalItems: number;
    byType: Record<string, number>;
    inCompile: number;
    trashedItems: number;
    draftWords: number | null;
  };
  checks: IntegrityChecks | null;
}

interface IntegrityChecks {
  lockFiles: string[];
  binderBackupPresent: boolean;
  searchIndexesPresent: boolean;
  orphanDataDirs: string[];
  textItemsWithoutData: string[];
}

function fail(msg: string): never {
  console.error(`\x1b[31mERROR:\x1b[0m ${msg}`);
  process.exit(1);
}

function findScrivx(projectPath: string): string {
  const entries = readdirSync(projectPath).filter((f) => f.endsWith(".scrivx"));
  const first = entries[0];
  if (first === undefined) fail(`No .scrivx file found in ${projectPath} — is this a Scrivener 3 project?`);
  return join(projectPath, first);
}

function wordCount(rtfPath: string): number {
  const proc = Bun.spawnSync(["textutil", "-convert", "txt", "-stdout", rtfPath]);
  if (proc.exitCode !== 0) return 0;
  const text = proc.stdout.toString();
  const words = text.trim().split(/\s+/).filter((w) => w.length > 0);
  return words.length;
}

function parseBinderItem(node: XmlNode, dataDir: string, countWords: boolean): BinderDoc {
  const uuid = node.attrs["UUID"] ?? "";
  const meta = child(node, "MetaData");
  const itemDataDir = join(dataDir, uuid);
  const hasDataDir = uuid.length > 0 && existsSync(itemDataDir);
  const contentPath = join(itemDataDir, "content.rtf");
  const hasContent = hasDataDir && existsSync(contentPath);
  const doc: BinderDoc = {
    uuid,
    type: node.attrs["Type"] ?? "Unknown",
    title: childText(node, "Title"),
    labelId: meta ? childText(meta, "LabelID") || null : null,
    statusId: meta ? childText(meta, "StatusID") || null : null,
    includeInCompile: meta ? childText(meta, "IncludeInCompile") === "Yes" : false,
    hasDataDir,
    hasContent,
    hasSynopsis: hasDataDir && existsSync(join(itemDataDir, "synopsis.txt")),
    hasNotes: hasDataDir && existsSync(join(itemDataDir, "notes.rtf")),
    words: countWords && hasContent ? wordCount(contentPath) : null,
    children: [],
  };
  const childrenNode = child(node, "Children");
  if (childrenNode) {
    for (const c of childrenNode.children) {
      if (c.tag === "BinderItem") doc.children.push(parseBinderItem(c, dataDir, countWords));
    }
  }
  return doc;
}

function parseIdMap(settings: XmlNode | undefined, listTag: string, itemTag: string): Record<string, string> {
  const map: Record<string, string> = {};
  if (!settings) return map;
  const list = child(settings, listTag);
  if (!list) return map;
  for (const item of list.children) {
    if (item.tag !== itemTag) continue;
    const id = item.attrs["ID"];
    if (id !== undefined) map[id] = item.text.trim();
  }
  return map;
}

function walk(docs: BinderDoc[], fn: (d: BinderDoc, inTrash: boolean) => void, inTrash = false): void {
  for (const d of docs) {
    const trashed = inTrash || d.type === "TrashFolder";
    fn(d, trashed);
    walk(d.children, fn, trashed);
  }
}

function collectUuids(docs: BinderDoc[]): Set<string> {
  const set = new Set<string>();
  walk(docs, (d) => {
    if (d.uuid.length > 0) set.add(d.uuid);
  });
  return set;
}

function runChecks(projectPath: string, tree: BinderDoc[]): IntegrityChecks {
  const filesDir = join(projectPath, "Files");
  const dataDir = join(filesDir, "Data");
  const lockFiles = readdirSync(projectPath).filter((f) => /\.lock$/i.test(f));
  const binderUuids = collectUuids(tree);
  const orphanDataDirs: string[] = [];
  if (existsSync(dataDir)) {
    for (const entry of readdirSync(dataDir)) {
      const p = join(dataDir, entry);
      if (!statSync(p).isDirectory()) continue;
      if (!binderUuids.has(entry)) orphanDataDirs.push(entry);
    }
  }
  const textItemsWithoutData: string[] = [];
  walk(tree, (d) => {
    if (d.type === "Text" && !d.hasDataDir) textItemsWithoutData.push(`${d.title} (${d.uuid})`);
  });
  return {
    lockFiles,
    binderBackupPresent: existsSync(join(filesDir, "binder.backup")),
    searchIndexesPresent: existsSync(join(filesDir, "search.indexes")),
    orphanDataDirs,
    textItemsWithoutData,
  };
}

// ---------- Report rendering ----------

const TYPE_ICONS: Record<string, string> = {
  DraftFolder: "📖",
  ResearchFolder: "🔬",
  TrashFolder: "🗑️",
  Folder: "📁",
  Text: "📄",
};

function renderTree(
  docs: BinderDoc[],
  labels: Record<string, string>,
  statuses: Record<string, string>,
  lines: string[],
  depth = 0
): void {
  for (const d of docs) {
    const icon = TYPE_ICONS[d.type] ?? "❔";
    const parts: string[] = [`${"  ".repeat(depth)}- ${icon} **${d.title || "(untitled)"}**`];
    const tags: string[] = [];
    if (d.labelId !== null && d.labelId !== "-1") tags.push(`label:${labels[d.labelId] ?? d.labelId}`);
    if (d.statusId !== null && d.statusId !== "-1") tags.push(`status:${statuses[d.statusId] ?? d.statusId}`);
    if (d.includeInCompile) tags.push("compile");
    if (d.words !== null) tags.push(`${d.words}w`);
    if (tags.length > 0) parts.push(`\`[${tags.join(" | ")}]\``);
    lines.push(parts.join(" "));
    renderTree(d.children, labels, statuses, lines, depth + 1);
  }
}

function renderMarkdown(r: ProjectReport): string {
  const lines: string[] = [];
  lines.push(`# Scrivener Project: ${r.project}`);
  lines.push("");
  lines.push(`- **Path:** ${r.path}`);
  lines.push(`- **Scrivener:** ${r.scrivx.creator} (scrivx v${r.scrivx.version}, package v${r.formatVersion ?? "?"})`);
  lines.push(`- **Last modified:** ${r.scrivx.modified}`);
  lines.push(`- **Label axis:** "${r.labelAxis.title}" (${Object.keys(r.labelAxis.labels).length} values)`);
  lines.push(`- **Status axis:** "${r.statusAxis.title}" (${Object.keys(r.statusAxis.statuses).length} values)`);
  lines.push("");
  lines.push("## Stats");
  lines.push("");
  lines.push(`- Total binder items: ${r.stats.totalItems} (${Object.entries(r.stats.byType).map(([t, n]) => `${t}: ${n}`).join(", ")})`);
  lines.push(`- In compile: ${r.stats.inCompile}`);
  lines.push(`- In trash: ${r.stats.trashedItems}`);
  if (r.stats.draftWords !== null) lines.push(`- Draft word count: ${r.stats.draftWords}`);
  lines.push("");
  lines.push("## Binder");
  lines.push("");
  renderTree(r.tree, r.labelAxis.labels, r.statusAxis.statuses, lines);
  if (r.checks) {
    lines.push("");
    lines.push("## Integrity Checks");
    lines.push("");
    const c = r.checks;
    lines.push(
      c.lockFiles.length > 0
        ? `- ⚠️ **Lock file(s) present:** ${c.lockFiles.join(", ")} — project may be open in Scrivener. Do NOT modify.`
        : "- ✅ No lock files (project not flagged as open)"
    );
    lines.push(`- ${c.binderBackupPresent ? "✅" : "ℹ️"} binder.backup ${c.binderBackupPresent ? "present" : "absent"}`);
    lines.push(`- ${c.searchIndexesPresent ? "✅" : "ℹ️"} search.indexes ${c.searchIndexesPresent ? "present (regenerable, never edit)" : "absent (Scrivener will rebuild)"}`);
    lines.push(
      c.orphanDataDirs.length > 0
        ? `- ⚠️ **Orphan Data dirs (not in binder):** ${c.orphanDataDirs.length} — ${c.orphanDataDirs.slice(0, 5).join(", ")}${c.orphanDataDirs.length > 5 ? ", …" : ""}`
        : "- ✅ No orphan Data directories"
    );
    lines.push(
      c.textItemsWithoutData.length > 0
        ? `- ℹ️ Text items with no Data dir (empty docs — usually fine): ${c.textItemsWithoutData.length}`
        : "- ✅ Every Text item has a Data directory"
    );
  }
  lines.push("");
  return lines.join("\n");
}

// ---------- Main ----------

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length === 0) {
    console.log(`Usage: bun Inspect.ts <project.scriv> [--format md|json] [--words] [--check]

Read-only inventory of a Scrivener 3 project. Never writes inside the package.

Options:
  --format md|json   Output format (default: md)
  --words            Word counts via macOS textutil (slower)
  --check            Integrity checks (lock files, scrivx<->Data consistency)`);
    process.exit(args.length === 0 ? 1 : 0);
  }

  const positional = args.filter((a) => !a.startsWith("--") && a !== "md" && a !== "json");
  const projectPath = positional[0];
  if (projectPath === undefined) fail("Missing <project.scriv> path");
  const formatIdx = args.indexOf("--format");
  const format = formatIdx >= 0 ? (args[formatIdx + 1] ?? "md") : "md";
  if (format !== "md" && format !== "json") fail(`Invalid --format "${format}" (expected md or json)`);
  const countWords = args.includes("--words");
  const check = args.includes("--check");

  if (!existsSync(projectPath)) fail(`Path does not exist: ${projectPath}`);
  if (!projectPath.endsWith(".scriv")) fail(`Not a .scriv package: ${projectPath}`);

  const scrivxPath = findScrivx(projectPath);
  const xml = readFileSync(scrivxPath, "utf-8");
  const docRoot = parseXml(xml);
  const project = child(docRoot, "ScrivenerProject");
  if (!project) fail(`No <ScrivenerProject> root element in ${scrivxPath}`);

  const binder = child(project, "Binder");
  if (!binder) fail(`No <Binder> element in ${scrivxPath}`);

  const dataDir = join(projectPath, "Files", "Data");
  const tree: BinderDoc[] = [];
  for (const item of binder.children) {
    if (item.tag === "BinderItem") tree.push(parseBinderItem(item, dataDir, countWords));
  }

  const labelSettings = child(project, "LabelSettings");
  const statusSettings = child(project, "StatusSettings");

  const byType: Record<string, number> = {};
  let totalItems = 0;
  let inCompile = 0;
  let trashedItems = 0;
  let draftWords: number | null = countWords ? 0 : null;
  walk(tree, (d, inTrash) => {
    totalItems += 1;
    byType[d.type] = (byType[d.type] ?? 0) + 1;
    if (d.includeInCompile) inCompile += 1;
    if (inTrash && d.type !== "TrashFolder") trashedItems += 1;
  });
  if (countWords) {
    const draft = tree.find((d) => d.type === "DraftFolder");
    if (draft) {
      let sum = 0;
      walk([draft], (d) => {
        if (d.words !== null) sum += d.words;
      });
      draftWords = sum;
    }
  }

  const versionTxt = join(projectPath, "Files", "version.txt");
  const report: ProjectReport = {
    project: basename(projectPath, ".scriv"),
    path: projectPath,
    scrivx: {
      file: basename(scrivxPath),
      version: project.attrs["Version"] ?? "?",
      creator: project.attrs["Creator"] ?? "?",
      modified: project.attrs["Modified"] ?? "?",
    },
    formatVersion: existsSync(versionTxt) ? readFileSync(versionTxt, "utf-8").trim() : null,
    labelAxis: {
      title: labelSettings ? childText(labelSettings, "Title") : "Label",
      labels: parseIdMap(labelSettings, "Labels", "Label"),
    },
    statusAxis: {
      title: statusSettings ? childText(statusSettings, "Title") : "Status",
      statuses: parseIdMap(statusSettings, "StatusItems", "Status"),
    },
    tree,
    stats: { totalItems, byType, inCompile, trashedItems, draftWords },
    checks: check ? runChecks(projectPath, tree) : null,
  };

  if (format === "json") {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderMarkdown(report));
  }
}

main();
