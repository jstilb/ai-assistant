#!/usr/bin/env bun
/**
 * ProfileBuilder.ts — materialize a Claude Code config directory ("profile")
 * from a spec, so `claude -p` can be booted against it via CLAUDE_CONFIG_DIR.
 *
 * WHY: every eval in this skill has always run against the LIVE ~/.claude
 * (cwd + default config dir), so there was no way to answer "how much of
 * this score is the model vs. our CLAUDE.md / skills / hooks?" — or to
 * re-ask it cheaply when a new model ships. A profile is the unit of
 * comparison: `clean` (vanilla Claude Code, nothing of ours), `full` (a
 * faithful mirror of the live setup), and ablations of `full` with named
 * components removed (or of `clean` with components added back).
 *
 * MECHANISM (live-verified 2026-09-04, Claude Code 2.1.261): with
 * CLAUDE_CONFIG_DIR=<dir>, claude reads <dir>/settings.json, <dir>/CLAUDE.md
 * (user memory), <dir>/skills/*\/SKILL.md, <dir>/commands/*.md,
 * <dir>/agents/*.md, <dir>/plugins/, and <dir>/.claude.json — and follows
 * symlinks for all of them, so a profile is mostly a directory of symlinks
 * into the source home plus a few generated files. Auth is the env
 * CLAUDE_CODE_OAUTH_TOKEN that buildHardenedClaudeEnv() already injects, so
 * no credentials live in the profile. `--bare` was rejected as the isolation
 * mechanism: it forces ANTHROPIC_API_KEY auth (no subscription OAuth).
 *
 * COMPONENTS (each individually includable/removable — see ProfileSpec):
 *   claudemd  <dir>/CLAUDE.md          copied from <home>/CLAUDE.md, with
 *                                      optional section/line/regex surgery
 *   skills    <dir>/skills/<Category>  symlink per category; a category with
 *                                      a removed child becomes a real dir of
 *                                      per-entry symlinks minus the child
 *   commands  <dir>/commands/<n>.md    symlink per file from <home>/Commands
 *   agents    <dir>/agents/<n>.md      symlink per file from <home>/agents
 *   hooks     settings.json "hooks"    copied from <home>/settings.json,
 *                                      filterable by event name or command
 *                                      substring
 *   env       settings.json "env"      copied, filterable by key
 *   plugins   <dir>/plugins            symlink to <home>/plugins
 *   mcp       .claude.json mcpServers  copied from ~/.claude.json
 *   memory    <dir>/memory             COPY (snapshot) of the live auto-memory
 *                                      dir; settings.autoMemoryDirectory is
 *                                      rewired to it so eval agents can never
 *                                      write into the live memory
 *
 * Everything else in settings.json (permissions, model, misc keys) rides
 * along unchanged for base:full and is absent for base:clean; use
 * `settings_overrides` for surgical changes. `env.KAYA_DIR` is always
 * rewritten to the source home so hooks resolve against the home being
 * tested (pass `--home <worktree>` to test a branch's hooks/skills).
 *
 * Pure functions (ablateClaudeMd, selectHooks, selectNames, ...) are
 * exported for hermetic tests; buildProfile() is the only thing that
 * touches the filesystem.
 */

import { z } from 'zod';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, symlinkSync,
  statSync, rmSync, cpSync, lstatSync,
} from 'fs';
import { join, resolve, isAbsolute, basename } from 'path';
import { createHash } from 'crypto';
import { parse as parseYaml } from 'yaml';
import { defaultKayaHome, expandPath } from '../../../../../lib/core/KayaHome.ts';

// ============================================================================
// Spec
// ============================================================================

/** Name-list components: '*' selects every entry; names are matched exactly
 *  (skills additionally accept 'Category/Child' for a nested skill dir;
 *  hooks accept an event name like 'SessionStart' OR a substring of the hook
 *  command like 'LoadContext'). */
const NameList = z.array(z.string().min(1));

export const ComponentSelectorSchema = z.object({
  claudemd: z.boolean().optional(),
  skills: NameList.optional(),
  commands: NameList.optional(),
  agents: NameList.optional(),
  hooks: NameList.optional(),
  env: NameList.optional(),
  plugins: z.boolean().optional(),
  mcp: z.boolean().optional(),
  memory: z.boolean().optional(),
}).strict();
export type ComponentSelector = z.infer<typeof ComponentSelectorSchema>;

export const ProfileSpecSchema = z.object({
  name: z.string().min(1).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, 'profile name must be a safe path segment'),
  description: z.string().optional(),
  /** `full` starts with every component of the source home selected;
   *  `clean` starts with none. `include` then adds, `remove` then subtracts. */
  base: z.enum(['clean', 'full']).default('full'),
  include: ComponentSelectorSchema.optional(),
  remove: ComponentSelectorSchema.optional(),
  /** CLAUDE.md surgery (applied to the selected CLAUDE.md, in this order:
   *  replace-file → drop sections/lines/matching (all computed against the
   *  ORIGINAL line numbering) → append). */
  claudemd: z.object({
    /** Replace CLAUDE.md wholesale with this file (absolute, ~/, or relative to the source home). */
    file: z.string().optional(),
    /** Drop markdown sections whose heading text contains this (case-insensitive),
     *  through the next heading of the same or higher level. */
    drop_sections: z.array(z.string().min(1)).optional(),
    /** Drop 1-indexed inclusive line ranges of the ORIGINAL file: "77", "10-30". */
    drop_lines: z.array(z.string().regex(/^\d+(-\d+)?$/)).optional(),
    /** Drop every line matching any of these regexes (JS syntax, no delimiters). */
    drop_matching: z.array(z.string().min(1)).optional(),
    /** Append this text (verbatim) to the end of CLAUDE.md. */
    append: z.string().optional(),
  }).strict().optional(),
  /** Deep-merged into the generated settings.json last (null deletes a key). */
  settings_overrides: z.record(z.string(), z.unknown()).optional(),
  /** Default `--model` for cells of this profile when the runner is not given --models. */
  model: z.string().optional(),
}).strict();
export type ProfileSpec = z.infer<typeof ProfileSpecSchema>;

// ============================================================================
// Pure helpers
// ============================================================================

/** Resolve the selected subset of `all` for one name-list component. */
export function selectNames(
  all: readonly string[],
  base: 'clean' | 'full',
  include: readonly string[] | undefined,
  remove: readonly string[] | undefined,
  matches: (name: string, selector: string) => boolean = (n, s) => n === s,
): { selected: string[]; removed: string[]; unknownSelectors: string[] } {
  const unknownSelectors: string[] = [];
  const expand = (list: readonly string[] | undefined): Set<string> => {
    const out = new Set<string>();
    for (const sel of list ?? []) {
      if (sel === '*') { for (const n of all) out.add(n); continue; }
      let hit = false;
      for (const n of all) if (matches(n, sel)) { out.add(n); hit = true; }
      if (!hit) unknownSelectors.push(sel);
    }
    return out;
  };
  const selected = new Set<string>(base === 'full' ? all : []);
  for (const n of expand(include)) selected.add(n);
  for (const n of expand(remove)) selected.delete(n);
  return {
    selected: all.filter(n => selected.has(n)),
    removed: all.filter(n => !selected.has(n)),
    unknownSelectors,
  };
}

/** Boolean components: full→true, clean→false, include→true, remove→false. */
export function selectFlag(base: 'clean' | 'full', include: boolean | undefined, remove: boolean | undefined): boolean {
  let on = base === 'full';
  if (include === true) on = true;
  if (remove === true) on = false;
  return on;
}

export interface ClaudeMdAblationResult {
  content: string;
  droppedLines: number[];          // 1-indexed, original numbering
  droppedSections: { heading: string; from: number; to: number }[];
  unmatchedSections: string[];
  unmatchedPatterns: string[];
}

/**
 * Drop sections / line ranges / regex-matching lines from a markdown file.
 * All three selectors are resolved against the ORIGINAL line numbering and
 * unioned, so "drop lines 10-30" means the file Jm is looking at, not a
 * post-section-removal renumbering. Fails loud on an out-of-range line spec
 * (a silently-ignored range is exactly the kind of false-ablation this tool
 * exists to prevent). Unmatched section titles / patterns are reported, not
 * thrown — a profile is allowed to reference a section that a given home's
 * CLAUDE.md no longer has, but the manifest must say so.
 */
export function ablateClaudeMd(
  content: string,
  opts: { drop_sections?: string[]; drop_lines?: string[]; drop_matching?: string[] },
): ClaudeMdAblationResult {
  const lines = content.split('\n');
  const drop = new Set<number>(); // 0-indexed
  const droppedSections: ClaudeMdAblationResult['droppedSections'] = [];
  const unmatchedSections: string[] = [];
  const unmatchedPatterns: string[] = [];

  // Sections
  const headings: { idx: number; level: number; text: string }[] = [];
  let inFence = false;
  lines.forEach((line, idx) => {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return; }
    if (inFence) return;
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) headings.push({ idx, level: m[1]!.length, text: m[2]!.trim() });
  });
  for (const wanted of opts.drop_sections ?? []) {
    const needle = wanted.toLowerCase();
    const hits = headings.filter(h => h.text.toLowerCase().includes(needle));
    if (hits.length === 0) { unmatchedSections.push(wanted); continue; }
    for (const h of hits) {
      const next = headings.find(o => o.idx > h.idx && o.level <= h.level);
      const end = next ? next.idx - 1 : lines.length - 1;
      for (let i = h.idx; i <= end; i++) drop.add(i);
      droppedSections.push({ heading: h.text, from: h.idx + 1, to: end + 1 });
    }
  }

  // Line ranges (1-indexed inclusive, original numbering)
  for (const spec of opts.drop_lines ?? []) {
    const [aStr, bStr] = spec.split('-');
    const a = parseInt(aStr!, 10);
    const b = bStr === undefined ? a : parseInt(bStr, 10);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < 1 || b < a || b > lines.length) {
      throw new Error(`ablateClaudeMd: drop_lines "${spec}" is out of range for a ${lines.length}-line file`);
    }
    for (let i = a - 1; i <= b - 1; i++) drop.add(i);
  }

  // Regex lines
  for (const pat of opts.drop_matching ?? []) {
    const re = new RegExp(pat);
    let hit = false;
    lines.forEach((line, idx) => { if (re.test(line)) { drop.add(idx); hit = true; } });
    if (!hit) unmatchedPatterns.push(pat);
  }

  const kept = lines.filter((_, idx) => !drop.has(idx));
  return {
    content: kept.join('\n'),
    droppedLines: [...drop].sort((x, y) => x - y).map(i => i + 1),
    droppedSections,
    unmatchedSections,
    unmatchedPatterns,
  };
}

/** Claude Code settings.json "hooks" shape (only the parts we filter on). */
export interface HookEntry { type?: string; command?: string; timeout?: number; [k: string]: unknown }
export interface HookGroup { matcher?: string; hooks: HookEntry[]; [k: string]: unknown }
export type HooksConfig = Record<string, HookGroup[]>;

/** Flat, stable ids for every hook: "<Event>[<groupIdx>]#<hookIdx> <command>". */
export function listHookIds(hooks: HooksConfig): string[] {
  const ids: string[] = [];
  for (const [event, groups] of Object.entries(hooks)) {
    groups.forEach((g, gi) => (g.hooks ?? []).forEach((h, hi) => {
      ids.push(`${event}[${gi}]#${hi} ${h.command ?? h.type ?? ''}`);
    }));
  }
  return ids;
}

/** A hook id matches a selector when the selector equals its event name or
 *  is a substring of its command. */
export function hookMatches(id: string, selector: string): boolean {
  const event = id.slice(0, id.indexOf('['));
  const command = id.slice(id.indexOf(' ') + 1);
  return event === selector || command.includes(selector);
}

/** Rebuild a hooks config keeping only the given ids (drops empty groups/events). */
export function filterHooks(hooks: HooksConfig, keepIds: ReadonlySet<string>): HooksConfig {
  const out: HooksConfig = {};
  for (const [event, groups] of Object.entries(hooks)) {
    const keptGroups: HookGroup[] = [];
    groups.forEach((g, gi) => {
      const keptHooks = (g.hooks ?? []).filter((h, hi) =>
        keepIds.has(`${event}[${gi}]#${hi} ${h.command ?? h.type ?? ''}`));
      if (keptHooks.length) keptGroups.push({ ...g, hooks: keptHooks });
    });
    if (keptGroups.length) out[event] = keptGroups;
  }
  return out;
}

/** Deep-merge `patch` into `base`; a null patch value deletes the key. */
export function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) { delete out[k]; continue; }
    const cur = out[k];
    if (isPlainObject(v) && isPlainObject(cur)) out[k] = deepMerge(cur, v);
    else out[k] = v;
  }
  return out;
}
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Turn `--without` / `--with` CLI selectors into a ProfileSpec. Grammar
 * (one selector per flag; `--with` uses the same grammar into `include`):
 *   skills | skill:<Category[/Child]> | commands | command:<name>
 *   agents | agent:<name> | hooks | hook:<event-or-command-substring>
 *   env | env:<KEY> | claudemd | claudemd-section:<heading> |
 *   claudemd-lines:<a[-b]> | claudemd-matching:<regex> | plugins | mcp | memory
 */
export function specFromSelectors(
  name: string,
  base: 'clean' | 'full',
  without: readonly string[],
  withSel: readonly string[] = [],
): ProfileSpec {
  const remove: ComponentSelector = {};
  const include: ComponentSelector = {};
  const claudemd: NonNullable<ProfileSpec['claudemd']> = {};
  const apply = (sel: string, target: ComponentSelector, isRemove: boolean): void => {
    const colon = sel.indexOf(':');
    const key = colon === -1 ? sel : sel.slice(0, colon);
    const arg = colon === -1 ? undefined : sel.slice(colon + 1);
    const push = (k: 'skills' | 'commands' | 'agents' | 'hooks' | 'env', v: string): void => {
      (target[k] ??= []).push(v);
    };
    switch (key) {
      case 'skills': push('skills', '*'); break;
      case 'skill': push('skills', need(arg, sel)); break;
      case 'commands': push('commands', '*'); break;
      case 'command': push('commands', need(arg, sel)); break;
      case 'agents': push('agents', '*'); break;
      case 'agent': push('agents', need(arg, sel)); break;
      case 'hooks': push('hooks', '*'); break;
      case 'hook': push('hooks', need(arg, sel)); break;
      case 'env': if (arg) push('env', arg); else push('env', '*'); break;
      case 'claudemd': target.claudemd = true; break;
      case 'plugins': target.plugins = true; break;
      case 'mcp': target.mcp = true; break;
      case 'memory': target.memory = true; break;
      case 'claudemd-section':
        if (!isRemove) throw new Error(`selector "${sel}" is only valid with --without`);
        (claudemd.drop_sections ??= []).push(need(arg, sel)); break;
      case 'claudemd-lines':
        if (!isRemove) throw new Error(`selector "${sel}" is only valid with --without`);
        (claudemd.drop_lines ??= []).push(need(arg, sel)); break;
      case 'claudemd-matching':
        if (!isRemove) throw new Error(`selector "${sel}" is only valid with --without`);
        (claudemd.drop_matching ??= []).push(need(arg, sel)); break;
      default:
        throw new Error(`unknown component selector "${sel}" — see ProfileBuilder.ts specFromSelectors() for the grammar`);
    }
  };
  for (const s of without) apply(s, remove, true);
  for (const s of withSel) apply(s, include, false);
  const spec: ProfileSpec = { name, base };
  if (Object.keys(remove).length) spec.remove = remove;
  if (Object.keys(include).length) spec.include = include;
  if (Object.keys(claudemd).length) spec.claudemd = claudemd;
  return ProfileSpecSchema.parse(spec);
}
function need(arg: string | undefined, sel: string): string {
  if (!arg) throw new Error(`selector "${sel}" needs an argument after the colon`);
  return arg;
}

// ============================================================================
// Spec loading
// ============================================================================

export const PROFILES_DIR = join(import.meta.dir, '..', '..', 'Profiles');

/** List the built-in profile names (Profiles/*.yaml). */
export function listProfileNames(): string[] {
  if (!existsSync(PROFILES_DIR)) return [];
  return readdirSync(PROFILES_DIR).filter(f => f.endsWith('.yaml')).map(f => f.slice(0, -5)).sort();
}

/**
 * Resolve a profile reference: a built-in name (Profiles/<name>.yaml), a
 * path to a YAML/JSON file, or an inline JSON object string. Validated
 * against ProfileSpecSchema — fails loud naming the source.
 */
export function loadProfileSpec(ref: string): ProfileSpec {
  let raw: unknown;
  let source: string;
  if (ref.trim().startsWith('{')) {
    raw = JSON.parse(ref); source = '<inline json>';
  } else {
    const candidates = [ref, join(PROFILES_DIR, `${ref}.yaml`), join(PROFILES_DIR, ref)];
    const path = candidates.find(c => existsSync(c) && statSync(c).isFile());
    if (!path) {
      throw new Error(`profile "${ref}" not found — not a file and not one of the built-ins: ${listProfileNames().join(', ')}`);
    }
    raw = parseYaml(readFileSync(path, 'utf-8')); source = path;
  }
  const parsed = ProfileSpecSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(i => `  ${i.path.join('.') || '<root>'}: ${i.message}`).join('\n');
    throw new Error(`profile spec invalid (${source}):\n${issues}`);
  }
  return parsed.data;
}

// ============================================================================
// Build
// ============================================================================

export interface ProfileManifest {
  name: string;
  base: 'clean' | 'full';
  description?: string;
  built_at: string;
  home: string;
  profile_dir: string;
  spec: ProfileSpec;
  components: {
    claudemd: {
      selected: boolean;
      source?: string;
      bytes: number;
      lines: number;
      sha256?: string;
      dropped_lines?: number[];
      dropped_sections?: { heading: string; from: number; to: number }[];
      unmatched_sections?: string[];
      unmatched_patterns?: string[];
      appended_bytes?: number;
    };
    skills: { selected: string[]; removed: string[]; unknown_selectors: string[] };
    commands: { selected: string[]; removed: string[]; unknown_selectors: string[] };
    agents: { selected: string[]; removed: string[]; unknown_selectors: string[] };
    hooks: { selected: string[]; removed: string[]; unknown_selectors: string[] };
    env: { selected: string[]; removed: string[]; unknown_selectors: string[] };
    plugins: { selected: boolean; source?: string };
    mcp: { selected: boolean; servers: string[] };
    memory: { selected: boolean; source?: string; files?: number };
  };
  settings_keys: string[];
}

export interface BuildOptions {
  /** Source Kaya home to mirror (default: the real ~/.claude, NOT KAYA_HOME —
   *  pass a worktree path explicitly to test a branch). */
  home?: string;
  /** Parent dir for the profile; the profile lands at <outDir>/<name>. */
  outDir: string;
  /** Path of the live global config (default ~/.claude.json) — mcp source. */
  globalConfigPath?: string;
  /** Live auto-memory dir to snapshot when `memory` is selected (default:
   *  settings.autoMemoryDirectory of the source home, else <home>/memory
   *  is NOT assumed — memory is skipped with a manifest note). */
  memoryDir?: string;
  /** Replace an existing profile dir (default true). */
  overwrite?: boolean;
}

function listDirNames(dir: string, filter: (name: string, full: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(n => !n.startsWith('.') && filter(n, join(dir, n))).sort();
}

function resolveUnderHome(p: string, home: string): string {
  const expanded = expandPath(p);
  return isAbsolute(expanded) ? expanded : resolve(home, expanded);
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * Materialize `spec` at <outDir>/<spec.name>. Returns the manifest (also
 * written to <profileDir>/PROFILE.json so a directory is self-describing —
 * `CLAUDE_CONFIG_DIR=<profileDir> claude` is a valid way to try a profile
 * interactively).
 */
export function buildProfile(spec: ProfileSpec, options: BuildOptions): ProfileManifest {
  const home = resolve(expandPath(options.home ?? defaultKayaHome()));
  if (!existsSync(home)) throw new Error(`buildProfile: source home does not exist: ${home}`);
  const profileDir = resolve(options.outDir, spec.name);
  if (existsSync(profileDir)) {
    if (options.overwrite === false) throw new Error(`buildProfile: ${profileDir} exists (overwrite:false)`);
    rmSync(profileDir, { recursive: true, force: true });
  }
  mkdirSync(profileDir, { recursive: true });

  const base = spec.base;
  const inc = spec.include ?? {};
  const rem = spec.remove ?? {};

  // ---- settings.json source ---------------------------------------------
  const liveSettingsPath = join(home, 'settings.json');
  const liveSettings: Record<string, unknown> = existsSync(liveSettingsPath)
    ? (JSON.parse(readFileSync(liveSettingsPath, 'utf-8')) as Record<string, unknown>)
    : {};
  const liveHooks = (isPlainObject(liveSettings.hooks) ? liveSettings.hooks : {}) as HooksConfig;
  const liveEnv = (isPlainObject(liveSettings.env) ? liveSettings.env : {}) as Record<string, string>;

  // ---- CLAUDE.md ------------------------------------------------------------
  const claudemdSelected = selectFlag(base, inc.claudemd, rem.claudemd);
  let claudemdManifest: ProfileManifest['components']['claudemd'] = { selected: false, bytes: 0, lines: 0 };
  if (claudemdSelected) {
    const src = spec.claudemd?.file ? resolveUnderHome(spec.claudemd.file, home) : join(home, 'CLAUDE.md');
    if (!existsSync(src)) throw new Error(`buildProfile: CLAUDE.md source not found: ${src}`);
    const original = readFileSync(src, 'utf-8');
    const ablated = ablateClaudeMd(original, {
      drop_sections: spec.claudemd?.drop_sections,
      drop_lines: spec.claudemd?.drop_lines,
      drop_matching: spec.claudemd?.drop_matching,
    });
    let content = ablated.content;
    if (spec.claudemd?.append) content = `${content.replace(/\n*$/, '\n')}\n${spec.claudemd.append}\n`;
    writeFileSync(join(profileDir, 'CLAUDE.md'), content, 'utf-8');
    claudemdManifest = {
      selected: true,
      source: src,
      bytes: Buffer.byteLength(content),
      lines: content.split('\n').length,
      sha256: sha256(content),
      dropped_lines: ablated.droppedLines,
      dropped_sections: ablated.droppedSections,
      unmatched_sections: ablated.unmatchedSections,
      unmatched_patterns: ablated.unmatchedPatterns,
      appended_bytes: spec.claudemd?.append ? Buffer.byteLength(spec.claudemd.append) : 0,
    };
  }

  // ---- skills (Category and Category/Child) ---------------------------------
  const skillsSrc = join(home, 'skills');
  const categories = listDirNames(skillsSrc, (_, full) => statSync(full).isDirectory());
  const allSkillNames: string[] = [];
  for (const cat of categories) {
    allSkillNames.push(cat);
    for (const child of listDirNames(join(skillsSrc, cat), (_, full) => statSync(full).isDirectory())) {
      allSkillNames.push(`${cat}/${child}`);
    }
  }
  // Selecting/removing a category implies its children; a child selector
  // only touches that child.
  const skillSel = selectNames(allSkillNames, base, inc.skills, rem.skills,
    (name, sel) => name === sel || name.startsWith(`${sel}/`));
  const selectedSkills = new Set(skillSel.selected);
  const skillsDir = join(profileDir, 'skills');
  for (const cat of categories) {
    const children = allSkillNames.filter(n => n.startsWith(`${cat}/`));
    const catSelected = selectedSkills.has(cat);
    const selectedChildren = children.filter(c => selectedSkills.has(c));
    if (!catSelected && selectedChildren.length === 0) continue;
    const allChildrenSelected = selectedChildren.length === children.length;
    if (catSelected && allChildrenSelected) {
      mkdirSync(skillsDir, { recursive: true });
      symlinkSync(join(skillsSrc, cat), join(skillsDir, cat));
      continue;
    }
    // Partial category: real dir; symlink every non-dir entry (SKILL.md etc.)
    // plus the selected child dirs only.
    const catDir = join(skillsDir, cat);
    mkdirSync(catDir, { recursive: true });
    for (const entry of readdirSync(join(skillsSrc, cat))) {
      const full = join(skillsSrc, cat, entry);
      const isDir = statSync(full).isDirectory();
      if (isDir && !selectedChildren.includes(`${cat}/${entry}`)) continue;
      // Non-dir entries (the category SKILL.md above all) are always linked,
      // even when only a child was selected: nested SKILL.md files are NOT
      // discovered by Claude Code (verified 2026-09-04), so a child is only
      // reachable through its category's SKILL.md routing.
      symlinkSync(full, join(catDir, entry));
    }
  }
  // Report only the names a human would ablate (category + children).
  const skillsManifest = { selected: skillSel.selected, removed: skillSel.removed, unknown_selectors: skillSel.unknownSelectors };

  // ---- commands / agents (flat .md files) -----------------------------------
  const linkFlat = (srcDir: string, dstName: string, include: string[] | undefined, remove: string[] | undefined) => {
    const files = listDirNames(srcDir, (n, full) => n.endsWith('.md') && statSync(full).isFile());
    const names = files.map(f => f.slice(0, -3));
    const sel = selectNames(names, base, include, remove);
    if (sel.selected.length) {
      const dst = join(profileDir, dstName);
      mkdirSync(dst, { recursive: true });
      for (const n of sel.selected) symlinkSync(join(srcDir, `${n}.md`), join(dst, `${n}.md`));
    }
    return { selected: sel.selected, removed: sel.removed, unknown_selectors: sel.unknownSelectors };
  };
  // The live home spells it `Commands/` (case-insensitive FS makes it work);
  // the profile always uses the canonical lowercase name.
  const commandsSrc = ['commands', 'Commands'].map(d => join(home, d)).find(d => existsSync(d)) ?? join(home, 'commands');
  const commandsManifest = linkFlat(commandsSrc, 'commands', inc.commands, rem.commands);
  const agentsManifest = linkFlat(join(home, 'agents'), 'agents', inc.agents, rem.agents);

  // ---- hooks / env ----------------------------------------------------------
  const hookIds = listHookIds(liveHooks);
  const hookSel = selectNames(hookIds, base, inc.hooks, rem.hooks, hookMatches);
  const hooksOut = filterHooks(liveHooks, new Set(hookSel.selected));
  const envKeys = Object.keys(liveEnv);
  const envSel = selectNames(envKeys, base, inc.env, rem.env);
  const envOut: Record<string, string> = {};
  for (const k of envSel.selected) envOut[k] = liveEnv[k]!;

  // ---- plugins --------------------------------------------------------------
  const pluginsSelected = selectFlag(base, inc.plugins, rem.plugins);
  const pluginsSrc = join(home, 'plugins');
  let pluginsManifest: ProfileManifest['components']['plugins'] = { selected: false };
  if (pluginsSelected && existsSync(pluginsSrc)) {
    symlinkSync(pluginsSrc, join(profileDir, 'plugins'));
    pluginsManifest = { selected: true, source: pluginsSrc };
  }

  // ---- mcp (.claude.json) ---------------------------------------------------
  const mcpSelected = selectFlag(base, inc.mcp, rem.mcp);
  // Claude Code's global config sits NEXT TO the default config dir
  // (~/.claude.json beside ~/.claude/), i.e. `${defaultKayaHome()}.json` when
  // CLAUDE_CONFIG_DIR is unset for the live session that owns the MCP list.
  const globalConfigPath = options.globalConfigPath ?? `${defaultKayaHome()}.json`;
  let mcpServers: Record<string, unknown> = {};
  if (mcpSelected && existsSync(globalConfigPath)) {
    try {
      const g = JSON.parse(readFileSync(globalConfigPath, 'utf-8')) as Record<string, unknown>;
      if (isPlainObject(g.mcpServers)) mcpServers = g.mcpServers;
    } catch (e) {
      throw new Error(`buildProfile: could not parse ${globalConfigPath} for mcpServers: ${e}`);
    }
  }
  const globalOut: Record<string, unknown> = { hasCompletedOnboarding: true };
  if (Object.keys(mcpServers).length) globalOut.mcpServers = mcpServers;
  writeFileSync(join(profileDir, '.claude.json'), JSON.stringify(globalOut, null, 2), 'utf-8');

  // ---- memory (snapshot copy) -----------------------------------------------
  const memorySelected = selectFlag(base, inc.memory, rem.memory);
  let memoryManifest: ProfileManifest['components']['memory'] = { selected: false };
  let memoryDirOut: string | undefined;
  if (memorySelected) {
    const liveMemory = options.memoryDir
      ?? (typeof liveSettings.autoMemoryDirectory === 'string' ? expandPath(liveSettings.autoMemoryDirectory) : undefined);
    if (liveMemory && existsSync(liveMemory)) {
      memoryDirOut = join(profileDir, 'memory');
      cpSync(liveMemory, memoryDirOut, { recursive: true, dereference: true });
      const count = countFiles(memoryDirOut);
      memoryManifest = { selected: true, source: liveMemory, files: count };
    } else {
      memoryManifest = { selected: false, source: liveMemory };
    }
  }

  // ---- settings.json ----------------------------------------------------------
  let settings: Record<string, unknown> = base === 'full' ? { ...liveSettings } : {};
  delete settings.hooks;
  delete settings.env;
  delete settings.autoMemoryDirectory;
  if (Object.keys(hooksOut).length) settings.hooks = hooksOut;
  // KAYA_DIR always points at the home under test so `${KAYA_DIR}/hooks/...`
  // commands resolve there (worktree testing). Only meaningful when hooks or
  // env are present.
  const needsKayaDir = Object.keys(hooksOut).length > 0 || envSel.selected.includes('KAYA_DIR');
  if (Object.keys(envOut).length || needsKayaDir) {
    settings.env = needsKayaDir ? { ...envOut, KAYA_DIR: home } : envOut;
  }
  if (memoryDirOut) settings.autoMemoryDirectory = memoryDirOut;
  if (spec.settings_overrides) settings = deepMerge(settings, spec.settings_overrides);
  writeFileSync(join(profileDir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf-8');

  const manifest: ProfileManifest = {
    name: spec.name,
    base,
    description: spec.description,
    built_at: new Date().toISOString(),
    home,
    profile_dir: profileDir,
    spec,
    components: {
      claudemd: claudemdManifest,
      skills: skillsManifest,
      commands: commandsManifest,
      agents: agentsManifest,
      hooks: { selected: hookSel.selected, removed: hookSel.removed, unknown_selectors: hookSel.unknownSelectors },
      env: { selected: envSel.selected, removed: envSel.removed, unknown_selectors: envSel.unknownSelectors },
      plugins: pluginsManifest,
      mcp: { selected: mcpSelected, servers: Object.keys(mcpServers) },
      memory: memoryManifest,
    },
    settings_keys: Object.keys(settings).sort(),
  };
  writeFileSync(join(profileDir, 'PROFILE.json'), JSON.stringify(manifest, null, 2), 'utf-8');

  // Fail loud on selectors that matched nothing: a typo'd ablation that
  // silently removes nothing is a false experiment.
  const unknown = [
    ...skillSel.unknownSelectors.map(s => `skills:${s}`),
    ...commandsManifest.unknown_selectors.map(s => `commands:${s}`),
    ...agentsManifest.unknown_selectors.map(s => `agents:${s}`),
    ...hookSel.unknownSelectors.map(s => `hooks:${s}`),
    ...envSel.unknownSelectors.map(s => `env:${s}`),
    ...(claudemdManifest.unmatched_sections ?? []).map(s => `claudemd-section:${s}`),
    ...(claudemdManifest.unmatched_patterns ?? []).map(s => `claudemd-matching:${s}`),
  ];
  if (unknown.length) {
    throw new Error(
      `buildProfile(${spec.name}): ${unknown.length} selector(s) matched NOTHING in ${home} — refusing to run a false ablation:\n  ` +
      unknown.join('\n  ') + `\n(profile dir left at ${profileDir} for inspection; PROFILE.json has the full component lists)`,
    );
  }
  return manifest;
}

function countFiles(dir: string): number {
  let n = 0;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = lstatSync(full);
    if (st.isDirectory()) n += countFiles(full);
    else n += 1;
  }
  return n;
}

/** One-line human summary of what a manifest removed relative to a full mirror. */
export function describeManifest(m: ProfileManifest): string {
  const c = m.components;
  const parts: string[] = [`base=${m.base}`];
  const rm = (label: string, list: string[]) => { if (list.length) parts.push(`-${label}(${list.length}: ${list.slice(0, 4).join(', ')}${list.length > 4 ? ', …' : ''})`); };
  if (!c.claudemd.selected) parts.push('-claudemd');
  else {
    if (c.claudemd.dropped_sections?.length) parts.push(`-claudemd-sections(${c.claudemd.dropped_sections.map(s => s.heading).join('; ')})`);
    if (c.claudemd.dropped_lines?.length) parts.push(`-claudemd-lines(${c.claudemd.dropped_lines.length})`);
    if (c.claudemd.appended_bytes) parts.push(`+claudemd-append(${c.claudemd.appended_bytes}B)`);
  }
  rm('skills', c.skills.removed.filter(n => !n.includes('/') || !c.skills.removed.includes(n.split('/')[0]!)));
  rm('commands', c.commands.removed);
  rm('agents', c.agents.removed);
  rm('hooks', c.hooks.removed.map(id => id.slice(0, id.indexOf(' ')) + ' ' + basename(id.slice(id.indexOf(' ') + 1))));
  rm('env', c.env.removed);
  if (!c.plugins.selected) parts.push('-plugins');
  if (!c.mcp.selected) parts.push('-mcp');
  if (!c.memory.selected) parts.push('-memory');
  return parts.join(' ');
}

// ============================================================================
// CLI (build / show a profile by hand)
// ============================================================================

if (import.meta.main) {
  const { parseArgs } = await import('util');
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      profile: { type: 'string', short: 'p' },
      out: { type: 'string', short: 'o' },
      home: { type: 'string' },
      without: { type: 'string', multiple: true },
      with: { type: 'string', multiple: true },
      base: { type: 'string' },
      name: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });
  const cmd = positionals[0];
  if (values.help || !cmd) {
    console.log(`ProfileBuilder — materialize a Claude Code config dir (CLAUDE_CONFIG_DIR) from a profile spec

Commands:
  list                                  built-in profiles (Profiles/*.yaml)
  build  --profile <name|path|json>     build at --out <dir>/<name> (default /tmp/kaya-ablation/profiles)
  build  --without <sel> [--without …]  ad-hoc profile from selectors (see specFromSelectors grammar)
         [--with <sel>] [--base full|clean] [--name <n>] [--home <kaya home>]

Then try it interactively:  CLAUDE_CONFIG_DIR=<dir> claude
`);
    process.exit(0);
  }
  if (cmd === 'list') {
    for (const n of listProfileNames()) {
      const s = loadProfileSpec(n);
      console.log(`${n.padEnd(28)} base=${s.base.padEnd(5)} ${s.description ?? ''}`);
    }
    process.exit(0);
  }
  if (cmd === 'build') {
    const base = (values.base ?? 'full') as 'clean' | 'full';
    const spec = values.profile
      ? loadProfileSpec(values.profile)
      : specFromSelectors(values.name ?? 'adhoc', base, values.without ?? [], values.with ?? []);
    const outDir = values.out ?? '/tmp/kaya-ablation/profiles';
    const manifest = buildProfile(spec, { outDir, home: values.home });
    console.log(`built ${manifest.profile_dir}`);
    console.log(`  ${describeManifest(manifest)}`);
    console.log(`  try: CLAUDE_CONFIG_DIR=${manifest.profile_dir} claude`);
    process.exit(0);
  }
  console.error(`unknown command: ${cmd}`);
  process.exit(1);
}
