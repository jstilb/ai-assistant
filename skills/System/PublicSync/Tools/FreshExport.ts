#!/usr/bin/env bun
/**
 * FreshExport.ts — build a clean, reviewable export of exactly what PublicSync
 * would publish, and diff it against what the public mirror currently holds.
 *
 * Read-only with respect to the source tree, the staging clone, sync-state,
 * and GitHub. It writes only to `--out` (the export tree) and the report
 * paths. It never prints a blocked identifier or credential value — only
 * path names, counts, and 6-char prefixes.
 *
 * Why this exists (t-mubgddow-ale5k, 2026-09-27): the mirror at
 * github.com/[user]/ai-assistant is being deleted and recreated from a
 * fresh sync. Jm has to be able to review the exact file list before the
 * irreversible step, and verify the recreated repo afterwards. The runner's
 * --dry-run only shows CHANGED files against the hash registry; this shows
 * the whole allowed set, the orphans, and the gate checks in one report.
 *
 * Usage:
 *   bun FreshExport.ts [--source DIR] [--blocklist PATH] [--out DIR]
 *                      [--remote owner/repo | --remote none] [--branch main]
 *                      [--report PATH.md] [--json PATH.json]
 *
 * Exit code 0 when every gate passes, 1 otherwise (so it can sit in a runbook).
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, rmSync } from "fs";
import { dirname, join } from "path";
import { execFileSync } from "child_process";
import { defaultKayaHome } from "../../../../lib/core/KayaHome";
import {
  BlocklistFilter,
  ContentTransformer,
  SecretScanner,
  DEFAULT_TRANSFORM_CONFIG,
  loadBlocklistConfigFrom,
  walkAllowedFiles,
  type BlocklistConfig,
} from "./SyncEngine";

// ─────────────────────────────────────────────────────────────
// CLI args
// ─────────────────────────────────────────────────────────────

interface Args {
  source: string;
  blocklist: string;
  out: string;
  remote: string | null;
  branch: string;
  report: string;
  json: string;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const source = get("--source") ?? defaultKayaHome();
  const stamp = new Date().toISOString().slice(0, 10);
  const out = get("--out") ?? `/tmp/publicsync-fresh-export-${stamp}`;
  const remoteArg = get("--remote") ?? "[user]/ai-assistant";
  return {
    source,
    blocklist: get("--blocklist") ?? join(source, "skills", "System", "PublicSync", "State", "blocklist.yaml"),
    out,
    remote: remoteArg === "none" ? null : remoteArg,
    branch: get("--branch") ?? "main",
    report: get("--report") ?? join(out, "REPORT.md"),
    json: get("--json") ?? join(out, "report.json"),
  };
}

// ─────────────────────────────────────────────────────────────
// Remote tree (read-only, via authenticated gh — anonymous works too for a
// public repo, gh just avoids the unauthenticated rate limit)
// ─────────────────────────────────────────────────────────────

interface RemoteTree {
  sha: string;
  paths: string[];
  truncated: boolean;
}

function fetchRemoteTree(repo: string, branch: string): RemoteTree | { error: string } {
  try {
    const raw = execFileSync(
      "gh",
      ["api", `repos/${repo}/git/trees/${branch}?recursive=1`],
      { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }
    );
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { error: "unexpected tree payload" };
    const obj = parsed as { sha?: unknown; truncated?: unknown; tree?: unknown };
    const entries = Array.isArray(obj.tree) ? obj.tree : [];
    const paths: string[] = [];
    for (const e of entries) {
      if (e && typeof e === "object") {
        const rec = e as { type?: unknown; path?: unknown };
        if (rec.type === "blob" && typeof rec.path === "string") paths.push(rec.path);
      }
    }
    return {
      sha: typeof obj.sha === "string" ? obj.sha : "?",
      truncated: obj.truncated === true,
      paths: paths.sort(),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `could not fetch remote tree (${message.split("\n")[0]})` };
  }
}

// ─────────────────────────────────────────────────────────────
// Gate definitions
// ─────────────────────────────────────────────────────────────

/** Paths the audits named explicitly — must be absent from the allowed set. */
const KNOWN_ID_BEARING_PATHS = [
  "skills/Productivity/InformationManager/SheetReference.md",
  "skills/Productivity/InformationManager/config/dtr.json",
  "skills/Productivity/InformationManager/config/telos.json",
  "skills/InformationManager/SheetReference.md",
  "skills/InformationManager/config/dtr.json",
  "skills/InformationManager/config/telos.json",
  "skills/Productivity/LifeOS/config/workbook.json",
  "skills/Productivity/LifeOS/StorageIO/Config.ts",
];

/** Top-level prefixes that must never appear in the published set. */
const FORBIDDEN_PREFIXES = [
  "MEMORY/",
  "context/",
  "USER/",
  "KAYASECURITYSYSTEM/",
  "Commands/",
  ".playwright-mcp/",
  "plans/",
  "sessions/",
  "daemon/",
];

const MAX_SIZE_BYTES = 500 * 1024; // mirrors SafetyValidator layer 3

/** Informational PII probes — counts only, never content. */
const PII_PROBES: Array<{ label: string; regex: RegExp }> = [
  { label: "gmail address", regex: /[A-Za-z0-9._%+-]+@gmail\.com/ },
  { label: "surname 'Stilb'", regex: /\bStilb\b/ },
  { label: "US phone number", regex: /\b\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/ },
];

interface Blocked {
  path: string;
  pattern: string;
  line: number;
}

interface Report {
  generatedAt: string;
  source: string;
  blocklist: string;
  out: string;
  allowedTopLevel: string[];
  counts: {
    allowedFiles: number;
    exported: number;
    blocked: number;
    unreadable: number;
    oversize: number;
    byTopLevel: Record<string, number>;
  };
  blocked: Blocked[];
  oversize: Array<{ path: string; kb: number }>;
  remote: null | {
    repo: string;
    branch: string;
    sha: string;
    truncated: boolean;
    pathCount: number;
    orphans: string[];
    orphansByTopLevel: Record<string, number>;
    additions: string[];
    common: number;
    matchesAllowedSet: boolean;
    error?: string;
  };
  gates: Array<{ name: string; passed: boolean; detail: string }>;
  pii: Array<{ label: string; files: number }>;
  allowedFiles: string[];
}

function topLevel(p: string): string {
  const i = p.indexOf("/");
  return i < 0 ? p : p.slice(0, i) + "/";
}

function tally(paths: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of paths) out[topLevel(p)] = (out[topLevel(p)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

function run(args: Args): Report {
  const config: BlocklistConfig = loadBlocklistConfigFrom(args.blocklist);
  const filter = new BlocklistFilter(config);
  const scanner = new SecretScanner(config.blockedIdentifiers ?? []);
  const transformer = new ContentTransformer(DEFAULT_TRANSFORM_CONFIG);

  console.log(`[FreshExport] source:    ${args.source}`);
  console.log(`[FreshExport] blocklist: ${args.blocklist}`);
  console.log(`[FreshExport] out:       ${args.out}`);

  if (existsSync(args.out)) rmSync(args.out, { recursive: true, force: true });
  mkdirSync(args.out, { recursive: true });

  const allowedFiles = walkAllowedFiles(args.source, filter).sort();
  console.log(`[FreshExport] allowed files: ${allowedFiles.length}`);

  const blocked: Blocked[] = [];
  const oversize: Array<{ path: string; kb: number }> = [];
  const piiFiles = PII_PROBES.map(() => 0);
  let exported = 0;
  let unreadable = 0;

  for (const rel of allowedFiles) {
    const abs = join(args.source, rel);
    let raw: string;
    try {
      raw = readFileSync(abs, "utf8");
    } catch {
      unreadable++;
      continue;
    }
    const content = transformer.transform(raw).content;
    const scan = scanner.scan(content);
    if (scan.hasSecrets) {
      const f = scan.findings[0];
      blocked.push({ path: rel, pattern: f.pattern, line: f.line });
      continue; // never written to the export tree
    }
    const dest = join(args.out, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content, "utf8");
    exported++;
    const size = statSync(dest).size;
    if (size > MAX_SIZE_BYTES) oversize.push({ path: rel, kb: Math.round(size / 1024) });
    PII_PROBES.forEach((probe, i) => {
      if (probe.regex.test(content)) piiFiles[i]++;
    });
  }

  // ── Remote diff ─────────────────────────────────────────
  let remote: Report["remote"] = null;
  if (args.remote) {
    const tree = fetchRemoteTree(args.remote, args.branch);
    const allowedSet = new Set(allowedFiles);
    if ("error" in tree) {
      remote = {
        repo: args.remote, branch: args.branch, sha: "?", truncated: false, pathCount: 0,
        orphans: [], orphansByTopLevel: {}, additions: [], common: 0, matchesAllowedSet: false,
        error: tree.error,
      };
    } else {
      const remoteSet = new Set(tree.paths);
      const orphans = tree.paths.filter((p) => !allowedSet.has(p));
      const additions = allowedFiles.filter((p) => !remoteSet.has(p));
      remote = {
        repo: args.remote,
        branch: args.branch,
        sha: tree.sha,
        truncated: tree.truncated,
        pathCount: tree.paths.length,
        orphans,
        orphansByTopLevel: tally(orphans),
        additions,
        common: tree.paths.length - orphans.length,
        matchesAllowedSet: orphans.length === 0 && additions.length === 0 && !tree.truncated,
      };
    }
  }

  // ── Gates ───────────────────────────────────────────────
  const allowedSet = new Set(allowedFiles);
  const idPathsPresent = KNOWN_ID_BEARING_PATHS.filter((p) => allowedSet.has(p));
  const forbiddenPresent = allowedFiles.filter((p) => FORBIDDEN_PREFIXES.some((pre) => p.startsWith(pre)));
  const identifierHits = blocked.filter((b) => b.pattern.startsWith("blocked-identifier"));
  const gates: Report["gates"] = [
    {
      name: "allowlist is fail-closed",
      passed: (config.allowedTopLevel?.length ?? 0) > 0,
      detail: `allowedTopLevel has ${config.allowedTopLevel?.length ?? 0} entries`,
    },
    {
      name: "no known Sheet-ID-bearing path in allowed set",
      passed: idPathsPresent.length === 0,
      detail: idPathsPresent.length === 0 ? `0 of ${KNOWN_ID_BEARING_PATHS.length} present` : idPathsPresent.join(", "),
    },
    {
      name: "no private identifier in any exported file",
      passed: identifierHits.length === 0,
      detail: identifierHits.length === 0 ? "0 files" : identifierHits.map((b) => b.path).join(", "),
    },
    {
      name: "no forbidden prefix (MEMORY/, context/, KAYASECURITYSYSTEM/, …)",
      passed: forbiddenPresent.length === 0,
      detail: forbiddenPresent.length === 0 ? "0 files" : forbiddenPresent.slice(0, 10).join(", "),
    },
    {
      name: "no file would abort the sync (secret/identifier scan)",
      passed: blocked.length === 0,
      detail: blocked.length === 0 ? "0 blocked" : `${blocked.length} blocked — see list`,
    },
    {
      name: "no file exceeds the 500KB size-anomaly cap",
      passed: oversize.length === 0,
      detail: oversize.length === 0 ? "0 oversize" : oversize.map((o) => `${o.path} (${o.kb}KB)`).join(", "),
    },
  ];
  if (remote && !remote.error) {
    gates.push({
      name: "remote tree fetched completely",
      passed: !remote.truncated,
      detail: `${remote.pathCount} blobs at ${remote.sha.slice(0, 12)}${remote.truncated ? " (TRUNCATED)" : ""}`,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    source: args.source,
    blocklist: args.blocklist,
    out: args.out,
    allowedTopLevel: config.allowedTopLevel ?? [],
    counts: {
      allowedFiles: allowedFiles.length,
      exported,
      blocked: blocked.length,
      unreadable,
      oversize: oversize.length,
      byTopLevel: tally(allowedFiles),
    },
    blocked,
    oversize,
    remote,
    gates,
    pii: PII_PROBES.map((probe, i) => ({ label: probe.label, files: piiFiles[i] })),
    allowedFiles,
  };
}

// ─────────────────────────────────────────────────────────────
// Report rendering
// ─────────────────────────────────────────────────────────────

function renderMarkdown(r: Report): string {
  const lines: string[] = [];
  const tick = (ok: boolean): string => (ok ? "PASS" : "FAIL");
  lines.push(`# PublicSync fresh-export report`);
  lines.push("");
  lines.push(`Generated ${r.generatedAt}. Source \`${r.source}\`. Blocklist \`${r.blocklist}\`. Export tree \`${r.out}\`.`);
  lines.push("");
  lines.push(`## Gates`);
  lines.push("");
  lines.push(`| Gate | Result | Detail |`);
  lines.push(`|---|---|---|`);
  for (const g of r.gates) lines.push(`| ${g.name} | ${tick(g.passed)} | ${g.detail} |`);
  lines.push("");
  lines.push(`## Counts`);
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`|---|---|`);
  lines.push(`| Allowed files (would be published) | ${r.counts.allowedFiles} |`);
  lines.push(`| Exported to review tree | ${r.counts.exported} |`);
  lines.push(`| Blocked by secret/identifier scan | ${r.counts.blocked} |`);
  lines.push(`| Unreadable (binary/permission) | ${r.counts.unreadable} |`);
  lines.push(`| Over 500KB | ${r.counts.oversize} |`);
  lines.push("");
  lines.push(`### Allowed files by top-level entry`);
  lines.push("");
  lines.push(`| Entry | Files |`);
  lines.push(`|---|---|`);
  for (const [k, v] of Object.entries(r.counts.byTopLevel)) lines.push(`| \`${k}\` | ${v} |`);
  lines.push("");
  lines.push(`Allowed top-level entries: ${r.allowedTopLevel.map((e) => `\`${e}\``).join(", ")}`);
  lines.push("");
  if (r.blocked.length > 0) {
    lines.push(`## Blocked files (would abort a live sync)`);
    lines.push("");
    for (const b of r.blocked) lines.push(`- \`${b.path}\` — ${b.pattern} at line ${b.line}`);
    lines.push("");
  }
  if (r.oversize.length > 0) {
    lines.push(`## Oversize files`);
    lines.push("");
    for (const o of r.oversize) lines.push(`- \`${o.path}\` — ${o.kb}KB`);
    lines.push("");
  }
  if (r.remote) {
    lines.push(`## Remote diff — ${r.remote.repo}@${r.remote.branch}`);
    lines.push("");
    if (r.remote.error) {
      lines.push(`Remote tree unavailable: ${r.remote.error}`);
    } else {
      lines.push(`Remote HEAD tree \`${r.remote.sha}\` holds ${r.remote.pathCount} blobs${r.remote.truncated ? " (TRUNCATED listing)" : ""}.`);
      lines.push("");
      lines.push(`| Set | Files |`);
      lines.push(`|---|---|`);
      lines.push(`| On remote AND in allowed set (kept) | ${r.remote.common} |`);
      lines.push(`| Orphans: on remote, NOT allowed (deleted by recreate) | ${r.remote.orphans.length} |`);
      lines.push(`| Additions: allowed, NOT yet on remote (new on recreate) | ${r.remote.additions.length} |`);
      lines.push(`| Remote already equals allowed set | ${r.remote.matchesAllowedSet ? "yes" : "no"} |`);
      lines.push("");
      lines.push(`### Orphans by top-level entry`);
      lines.push("");
      lines.push(`| Entry | Orphan files |`);
      lines.push(`|---|---|`);
      for (const [k, v] of Object.entries(r.remote.orphansByTopLevel)) lines.push(`| \`${k}\` | ${v} |`);
      lines.push("");
      lines.push(`Full orphan and addition lists are in \`report.json\` (\`remote.orphans\`, \`remote.additions\`).`);
    }
    lines.push("");
  }
  lines.push(`## PII probes (informational, counts of exported files)`);
  lines.push("");
  lines.push(`| Probe | Files |`);
  lines.push(`|---|---|`);
  for (const p of r.pii) lines.push(`| ${p.label} | ${p.files} |`);
  lines.push("");
  lines.push(`Post-transform: the owner's e-mail and LinkedIn handle are replaced by placeholders; the bare username becomes \`[user]\`. Surname mentions are reported, not rewritten.`);
  lines.push("");
  return lines.join("\n");
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`
PublicSync FreshExport — clean export + mirror diff + gate report (read-only)

USAGE:
  bun FreshExport.ts [--source DIR] [--blocklist PATH] [--out DIR]
                     [--remote owner/repo | --remote none] [--branch main]
                     [--report PATH.md] [--json PATH.json]

DEFAULTS:
  --source     ~/.claude (defaultKayaHome)
  --blocklist  <source>/skills/System/PublicSync/State/blocklist.yaml
  --out        /tmp/publicsync-fresh-export-<YYYY-MM-DD>
  --remote     [user]/ai-assistant (use "none" to skip the GitHub tree fetch)

Exit 0 when every gate passes, 1 otherwise.
`);
    process.exit(0);
  }
  const args = parseArgs(argv);
  const report = run(args);
  mkdirSync(dirname(args.report), { recursive: true });
  mkdirSync(dirname(args.json), { recursive: true });
  writeFileSync(args.report, renderMarkdown(report), "utf8");
  writeFileSync(args.json, JSON.stringify(report, null, 2), "utf8");

  console.log("");
  for (const g of report.gates) console.log(`  [${g.passed ? "PASS" : "FAIL"}] ${g.name} — ${g.detail}`);
  if (report.remote && !report.remote.error) {
    console.log(`  remote: ${report.remote.pathCount} blobs, ${report.remote.orphans.length} orphans, ${report.remote.additions.length} additions`);
  } else if (report.remote?.error) {
    console.log(`  remote: ${report.remote.error}`);
  }
  console.log(`\n[FreshExport] report: ${args.report}\n[FreshExport] json:   ${args.json}`);
  process.exit(report.gates.every((g) => g.passed) ? 0 : 1);
}
