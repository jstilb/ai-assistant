#!/usr/bin/env bun
/**
 * AblationRunner.ts — run an eval suite across a matrix of setup profiles ×
 * models and report per-cell / per-task deltas against a baseline profile.
 *
 * WHY: "does our CLAUDE.md / skill set / hook stack actually help, and does
 * that still hold on the next model?" was unanswerable — every eval ran
 * against the live ~/.claude only. This tool is the mechanism: each cell
 * boots `claude -p` from a materialized profile dir (ProfileBuilder.ts →
 * CLAUDE_CONFIG_DIR) with an explicit `--model`, runs the SAME suite through
 * the existing EvalExecutor.runSuite() (same graders, same trial runner,
 * same infra-failure classification), and the report lines the cells up.
 *
 * Isolation guarantees per cell:
 *   - CLAUDE_CONFIG_DIR = the profile dir (never the live ~/.claude)
 *   - `--no-session-persistence` (no session files written anywhere)
 *   - runSuite({ persist: false }) — ablation cells NEVER feed
 *     MEMORY/VALIDATION/evals/ (RegressionAlert / EvalHealthDigest baselines)
 *   - auto-memory, when included, is a SNAPSHOT copy inside the profile dir
 *
 * Cells run sequentially (rate limits + the fixed-path fixtures some tasks
 * use). Every cell's result is written as soon as it finishes
 * (Results/ablations/<runId>/cells/<profile>__<model>.json) and the report
 * is re-rendered after each, so a killed run still leaves a usable partial
 * matrix; `--resume <runId>` skips cells that already have a result file.
 *
 * Usage:
 *   bun AblationRunner.ts run --suite setup-ablation --profiles clean,full,no-skills --models haiku,sonnet [--trials 2]
 *   bun AblationRunner.ts run --suite setup-ablation --profiles full --without hooks --without claudemd-section:"Response Format"
 *   bun AblationRunner.ts run ... --dry-run          # build profiles + print the plan, no spawns
 *   bun AblationRunner.ts report --run <runId>       # re-render report.md from the cell files
 *   bun AblationRunner.ts list                        # profiles + prior runs
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { parseArgs } from 'util';
import { runSuite, taskPassedInSuite, isInfraSkippedRun } from '../EvalExecutor.ts';
import { loadSuite } from '../SuiteManager.ts';
import type { EvalRun } from '../../Types/index.ts';
import {
  buildProfile, loadProfileSpec, listProfileNames, specFromSelectors, describeManifest,
  type ProfileSpec, type ProfileManifest,
} from './ProfileBuilder.ts';

export const ABLATIONS_DIR = join(import.meta.dir, '..', '..', 'Results', 'ablations');

// ============================================================================
// Types
// ============================================================================

export interface TaskCellResult {
  task_id: string;
  status: 'scored' | 'infra_skipped';
  pass: boolean;
  pass_rate: number;
  mean_score: number;
  n_trials: number;
  infra_failures: number;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  duration_ms: number;
  run_id: string;
}

export interface CellResult {
  profile: string;
  model: string;           // 'default' when no --model flag was passed
  started_at: string;
  finished_at: string;
  wall_ms: number;
  tasks: TaskCellResult[];
  summary: { scored: number; passed: number; mean_score: number; cost_usd: number; infra_skipped: number };
  error?: string;
}

export interface AblationRunFile {
  run_id: string;
  suite: string;
  home: string;
  baseline: string;
  trials?: number;
  task_filter?: string[];
  profiles: Record<string, { description?: string; summary: string; manifest_path: string }>;
  models: string[];
  cells: CellResult[];
  started_at: string;
  updated_at: string;
}

// ============================================================================
// Result extraction (pure)
// ============================================================================

interface AgentOutcome {
  cost?: number; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number;
}

/** Pull cost/tokens out of the outcome executeWithClaude() attached to each
 *  trial transcript (final_outcome). Missing/malformed → zeros, never NaN. */
export function extractTaskCell(run: EvalRun): TaskCellResult {
  let cost = 0, inTok = 0, outTok = 0, cacheTok = 0;
  for (const t of run.trials) {
    const o = t.transcript?.final_outcome as AgentOutcome | undefined;
    if (o && typeof o === 'object') {
      cost += Number(o.cost ?? 0) || 0;
      inTok += Number(o.inputTokens ?? 0) || 0;
      outTok += Number(o.outputTokens ?? 0) || 0;
      cacheTok += Number(o.cacheReadTokens ?? 0) || 0;
    }
  }
  const infraSkipped = isInfraSkippedRun(run);
  return {
    task_id: run.task_id,
    status: infraSkipped ? 'infra_skipped' : 'scored',
    pass: !infraSkipped && taskPassedInSuite(run),
    pass_rate: run.pass_rate,
    mean_score: run.mean_score,
    n_trials: run.n_trials,
    infra_failures: run.infra_failures,
    cost_usd: cost,
    input_tokens: inTok,
    output_tokens: outTok,
    cache_read_tokens: cacheTok,
    duration_ms: run.total_duration_ms,
    run_id: run.id,
  };
}

export function summarizeCell(tasks: TaskCellResult[]): CellResult['summary'] {
  const scored = tasks.filter(t => t.status === 'scored');
  const mean = scored.length ? scored.reduce((a, t) => a + t.mean_score, 0) / scored.length : 0;
  return {
    scored: scored.length,
    passed: scored.filter(t => t.pass).length,
    mean_score: mean,
    cost_usd: tasks.reduce((a, t) => a + t.cost_usd, 0),
    infra_skipped: tasks.length - scored.length,
  };
}

// ============================================================================
// Report (pure)
// ============================================================================

const fmtMoney = (n: number): string => `$${n.toFixed(2)}`;
const fmtMs = (ms: number): string => ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}m` : `${Math.round(ms / 1000)}s`;
const fmtDelta = (n: number, digits = 2): string => (n === 0 ? '±0' : (n > 0 ? '+' : '') + n.toFixed(digits));

export function renderReport(file: AblationRunFile): string {
  const lines: string[] = [];
  const cellOf = (p: string, m: string) => file.cells.find(c => c.profile === p && c.model === m);
  const profiles = Object.keys(file.profiles);
  const models = file.models;

  lines.push(`# Setup ablation — ${file.run_id}`);
  lines.push('');
  lines.push(`Suite: \`${file.suite}\` · trials/task: ${file.trials ?? 'task default'} · home: \`${file.home}\` · baseline profile: **${file.baseline}**`);
  if (file.task_filter?.length) lines.push(`Tasks restricted to: ${file.task_filter.join(', ')}`);
  lines.push(`Updated: ${file.updated_at}`);
  lines.push('');

  // Matrix
  lines.push('## Matrix (passed/scored · mean score · cost · wall)');
  lines.push('');
  lines.push(`| profile | ${models.join(' | ')} |`);
  lines.push(`|---|${models.map(() => '---').join('|')}|`);
  for (const p of profiles) {
    const cells = models.map(m => {
      const c = cellOf(p, m);
      if (!c) return '_pending_';
      if (c.error) return `⚠️ error: ${c.error.slice(0, 60)}`;
      const s = c.summary;
      const infra = s.infra_skipped ? ` · ${s.infra_skipped} infra-skipped` : '';
      return `${s.passed}/${s.scored} · ${s.mean_score.toFixed(2)} · ${fmtMoney(s.cost_usd)} · ${fmtMs(c.wall_ms)}${infra}`;
    });
    lines.push(`| ${p === file.baseline ? `**${p}**` : p} | ${cells.join(' | ')} |`);
  }
  lines.push('');

  // Attribution vs baseline, per model
  lines.push(`## Attribution — each profile vs baseline \`${file.baseline}\` (same model)`);
  lines.push('');
  lines.push('| model | profile | Δ passed | Δ mean score | Δ cost | Δ wall |');
  lines.push('|---|---|---|---|---|---|');
  for (const m of models) {
    const base = cellOf(file.baseline, m);
    for (const p of profiles) {
      if (p === file.baseline) continue;
      const c = cellOf(p, m);
      if (!base || !c || base.error || c.error) { lines.push(`| ${m} | ${p} | _n/a_ | _n/a_ | _n/a_ | _n/a_ |`); continue; }
      lines.push(`| ${m} | ${p} | ${fmtDelta(c.summary.passed - base.summary.passed, 0)} | ${fmtDelta(c.summary.mean_score - base.summary.mean_score)} | ${fmtDelta(c.summary.cost_usd - base.summary.cost_usd)} | ${fmtDelta((c.wall_ms - base.wall_ms) / 1000, 0)}s |`);
    }
  }
  lines.push('');

  // Per-task per model
  for (const m of models) {
    const anyCell = profiles.map(p => cellOf(p, m)).find(c => c && !c.error);
    if (!anyCell) continue;
    const taskIds = [...new Set(profiles.flatMap(p => cellOf(p, m)?.tasks.map(t => t.task_id) ?? []))];
    lines.push(`## Per-task — model \`${m}\` (✅/❌ pass · mean score · cost)`);
    lines.push('');
    lines.push(`| task | ${profiles.map(p => p === file.baseline ? `**${p}**` : p).join(' | ')} |`);
    lines.push(`|---|${profiles.map(() => '---').join('|')}|`);
    for (const id of taskIds) {
      const baseT = cellOf(file.baseline, m)?.tasks.find(t => t.task_id === id);
      const cols = profiles.map(p => {
        const t = cellOf(p, m)?.tasks.find(x => x.task_id === id);
        if (!t) return '_—_';
        if (t.status === 'infra_skipped') return `⚠️ infra (${t.infra_failures}/${t.n_trials})`;
        const delta = baseT && p !== file.baseline && baseT.status === 'scored' ? ` (${fmtDelta(t.mean_score - baseT.mean_score)})` : '';
        return `${t.pass ? '✅' : '❌'} ${t.mean_score.toFixed(2)}${delta} · ${fmtMoney(t.cost_usd)}`;
      });
      lines.push(`| ${id} | ${cols.join(' | ')} |`);
    }
    lines.push('');
  }

  // Cross-model view of the baseline: "did the new model change things?"
  if (models.length > 1) {
    lines.push(`## Model comparison on baseline \`${file.baseline}\``);
    lines.push('');
    lines.push('| model | passed/scored | mean score | cost | wall |');
    lines.push('|---|---|---|---|---|');
    for (const m of models) {
      const c = cellOf(file.baseline, m);
      if (!c || c.error) { lines.push(`| ${m} | _n/a_ | | | |`); continue; }
      lines.push(`| ${m} | ${c.summary.passed}/${c.summary.scored} | ${c.summary.mean_score.toFixed(2)} | ${fmtMoney(c.summary.cost_usd)} | ${fmtMs(c.wall_ms)} |`);
    }
    lines.push('');
  }

  lines.push('## Profiles');
  lines.push('');
  for (const [name, p] of Object.entries(file.profiles)) {
    lines.push(`- **${name}**${p.description ? ` — ${p.description}` : ''}: \`${p.summary}\` (manifest: \`${p.manifest_path}\`)`);
  }
  lines.push('');
  lines.push('Cells with `infra-skipped` tasks carry no behavioral signal for those tasks (spawn/auth failures, not agent behavior) — re-run with `--resume` before drawing conclusions from them.');
  return lines.join('\n');
}

// ============================================================================
// Run
// ============================================================================

export interface RunOptions {
  suite: string;
  profiles: ProfileSpec[];
  models: string[];        // [] → one 'default' cell per profile (no --model flag)
  baseline?: string;       // default: first profile
  trials?: number;
  timeout?: number;
  home?: string;
  taskFilter?: string[];
  dryRun?: boolean;
  resumeRunId?: string;
  outDir?: string;         // default ABLATIONS_DIR
}

function cellFileName(profile: string, model: string): string {
  return `${profile}__${model.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`;
}

function writeRunFile(runDir: string, file: AblationRunFile): void {
  file.updated_at = new Date().toISOString();
  writeFileSync(join(runDir, 'matrix.json'), JSON.stringify(file, null, 2), 'utf-8');
  writeFileSync(join(runDir, 'report.md'), renderReport(file), 'utf-8');
}

export async function runAblation(opts: RunOptions): Promise<{ runDir: string; file: AblationRunFile }> {
  if (!loadSuite(opts.suite)) throw new Error(`suite not found: ${opts.suite}`);
  if (!opts.profiles.length) throw new Error('at least one profile is required');
  const names = opts.profiles.map(p => p.name);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  if (dupes.length) throw new Error(`duplicate profile names: ${dupes.join(', ')}`);
  const baseline = opts.baseline ?? names[0]!;
  if (!names.includes(baseline)) throw new Error(`baseline "${baseline}" is not one of the profiles: ${names.join(', ')}`);
  const models = opts.models.length ? opts.models : ['default'];

  const outRoot = opts.outDir ?? ABLATIONS_DIR;
  const runId = opts.resumeRunId ?? `abl-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  const runDir = join(outRoot, runId);
  const cellsDir = join(runDir, 'cells');
  const profilesDir = join(runDir, 'profiles');
  mkdirSync(cellsDir, { recursive: true });
  mkdirSync(profilesDir, { recursive: true });

  // Build (or rebuild) every profile up front — a selector typo fails the
  // whole run before any money is spent.
  const manifests: Record<string, ProfileManifest> = {};
  for (const spec of opts.profiles) {
    const m = buildProfile(spec, { outDir: profilesDir, home: opts.home });
    manifests[spec.name] = m;
    console.log(`[profile] ${spec.name}: ${describeManifest(m)}`);
  }

  const file: AblationRunFile = {
    run_id: runId,
    suite: opts.suite,
    home: manifests[names[0]!]!.home,
    baseline,
    trials: opts.trials,
    task_filter: opts.taskFilter,
    profiles: Object.fromEntries(names.map(n => [n, {
      description: manifests[n]!.description,
      summary: describeManifest(manifests[n]!),
      manifest_path: join(manifests[n]!.profile_dir, 'PROFILE.json'),
    }])),
    models,
    cells: [],
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  // Resume: load existing cell files.
  if (opts.resumeRunId && existsSync(cellsDir)) {
    for (const f of readdirSync(cellsDir).filter(f => f.endsWith('.json'))) {
      const c = JSON.parse(readFileSync(join(cellsDir, f), 'utf-8')) as CellResult;
      if (names.includes(c.profile) && models.includes(c.model) && !c.error) file.cells.push(c);
    }
    console.log(`[resume] ${file.cells.length} cell(s) loaded from ${cellsDir}`);
  }

  const plan = names.flatMap(p => models.map(m => ({ p, m })))
    .filter(({ p, m }) => !file.cells.some(c => c.profile === p && c.model === m));
  console.log(`\n[plan] ${plan.length} cell(s) to run: ${plan.map(({ p, m }) => `${p}×${m}`).join(', ')}`);
  console.log(`[plan] results → ${runDir}`);
  writeRunFile(runDir, file);
  if (opts.dryRun) {
    console.log('[dry-run] profiles built, no agents spawned.');
    return { runDir, file };
  }

  for (const { p, m } of plan) {
    const manifest = manifests[p]!;
    const startedAt = new Date();
    const t0 = performance.now();
    console.log(`\n${'#'.repeat(70)}\n# CELL ${p} × ${m}   (CLAUDE_CONFIG_DIR=${manifest.profile_dir})\n${'#'.repeat(70)}`);
    let cell: CellResult;
    try {
      const { results } = await runSuite(opts.suite, {
        trials: opts.trials,
        timeout: opts.timeout,
        // systemContext deliberately undefined: the profile's own CLAUDE.md
        // (or its absence) is the thing under test — the CLI's
        // resolveContextAtRef() injection would double-load it.
        env: { CLAUDE_CONFIG_DIR: manifest.profile_dir, KAYA_ABLATION_PROFILE: p },
        model: m === 'default' ? undefined : m,
        noSessionPersistence: true,
        persist: false,
        taskFilter: opts.taskFilter,
      });
      const tasks = results.map(extractTaskCell);
      cell = {
        profile: p, model: m,
        started_at: startedAt.toISOString(), finished_at: new Date().toISOString(),
        wall_ms: Math.round(performance.now() - t0),
        tasks, summary: summarizeCell(tasks),
      };
    } catch (e) {
      cell = {
        profile: p, model: m,
        started_at: startedAt.toISOString(), finished_at: new Date().toISOString(),
        wall_ms: Math.round(performance.now() - t0),
        tasks: [], summary: summarizeCell([]), error: String(e),
      };
      console.error(`[cell ${p}×${m}] FAILED: ${e}`);
    }
    writeFileSync(join(cellsDir, cellFileName(p, m)), JSON.stringify(cell, null, 2), 'utf-8');
    file.cells = file.cells.filter(c => !(c.profile === p && c.model === m)).concat(cell);
    writeRunFile(runDir, file);
  }

  console.log(`\n${renderReport(file)}`);
  console.log(`\nReport: ${join(runDir, 'report.md')}`);
  return { runDir, file };
}

// ============================================================================
// CLI
// ============================================================================

function listRuns(): string[] {
  if (!existsSync(ABLATIONS_DIR)) return [];
  return readdirSync(ABLATIONS_DIR).filter(d => existsSync(join(ABLATIONS_DIR, d, 'matrix.json'))).sort();
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      suite: { type: 'string', short: 's' },
      profiles: { type: 'string', short: 'p' },
      models: { type: 'string', short: 'm' },
      baseline: { type: 'string', short: 'b' },
      trials: { type: 'string' },
      timeout: { type: 'string' },
      tasks: { type: 'string' },
      home: { type: 'string' },
      without: { type: 'string', multiple: true },
      with: { type: 'string', multiple: true },
      base: { type: 'string' },
      name: { type: 'string' },
      'dry-run': { type: 'boolean' },
      resume: { type: 'string' },
      run: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });
  const cmd = positionals[0];
  if (values.help || !cmd) {
    console.log(`AblationRunner — run a suite across setup profiles × models, report deltas vs a baseline

Commands:
  run     --suite <name> --profiles <a,b,c> [--models haiku,sonnet,fable] [--baseline <profile>]
          [--trials N] [--timeout ms] [--tasks id1,id2] [--home <kaya home>] [--dry-run] [--resume <runId>]
          [--without <sel> ...] [--with <sel> ...] [--base full|clean] [--name <adhoc-name>]
            → adds ONE ad-hoc profile built from the selectors (see ProfileBuilder.ts specFromSelectors)
  report  --run <runId>            re-render Results/ablations/<runId>/report.md
  list                             built-in profiles and prior runs

Profiles are names from Profiles/*.yaml, paths to a YAML/JSON spec, or inline JSON.
Models are whatever \`claude --model\` accepts (aliases: haiku, sonnet, opus, fable; or full ids).
`);
    process.exit(0);
  }

  try {
    if (cmd === 'list') {
      console.log('Profiles:');
      for (const n of listProfileNames()) console.log(`  ${n.padEnd(26)} ${loadProfileSpec(n).description ?? ''}`);
      console.log('\nRuns:');
      for (const r of listRuns()) console.log(`  ${r}`);
      process.exit(0);
    }
    if (cmd === 'report') {
      if (!values.run) throw new Error('--run <runId> required');
      const runDir = join(ABLATIONS_DIR, values.run);
      const file = JSON.parse(readFileSync(join(runDir, 'matrix.json'), 'utf-8')) as AblationRunFile;
      // Re-read cell files so a partially-written matrix still renders fully.
      const cellsDir = join(runDir, 'cells');
      if (existsSync(cellsDir)) {
        file.cells = readdirSync(cellsDir).filter(f => f.endsWith('.json'))
          .map(f => JSON.parse(readFileSync(join(cellsDir, f), 'utf-8')) as CellResult);
      }
      writeRunFile(runDir, file);
      console.log(renderReport(file));
      process.exit(0);
    }
    if (cmd === 'run') {
      if (!values.suite) throw new Error('--suite required');
      const profiles: ProfileSpec[] = (values.profiles ?? '').split(',').map(s => s.trim()).filter(Boolean).map(loadProfileSpec);
      if (values.without?.length || values.with?.length) {
        profiles.push(specFromSelectors(values.name ?? 'adhoc', (values.base ?? 'full') as 'clean' | 'full', values.without ?? [], values.with ?? []));
      }
      if (!profiles.length) throw new Error('--profiles <a,b,...> and/or --without/--with selectors required');
      const models = (values.models ?? '').split(',').map(s => s.trim()).filter(Boolean);
      const { runDir } = await runAblation({
        suite: values.suite,
        profiles,
        models,
        baseline: values.baseline,
        trials: values.trials ? parseInt(values.trials, 10) : undefined,
        timeout: values.timeout ? parseInt(values.timeout, 10) : undefined,
        home: values.home ? resolve(values.home) : undefined,
        taskFilter: values.tasks ? values.tasks.split(',').map(s => s.trim()).filter(Boolean) : undefined,
        dryRun: values['dry-run'] ?? false,
        resumeRunId: values.resume,
      });
      console.log(`\nDone: ${runDir}`);
      process.exit(0);
    }
    throw new Error(`unknown command: ${cmd}`);
  } catch (e) {
    console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
