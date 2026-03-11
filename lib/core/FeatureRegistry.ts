#!/usr/bin/env bun
/**
 * Feature Registry CLI
 *
 * JSON-based feature tracking for complex multi-feature tasks.
 * Based on Anthropic's agent harness patterns - JSON is more robust
 * than Markdown because models are less likely to corrupt structured data.
 *
 * Usage:
 *   bun run ~/.claude/Tools/FeatureRegistry.ts <command> [options]
 *
 * Commands:
 *   init <project>              Initialize feature registry for project
 *   add <project> <feature>     Add feature to registry
 *   update <project> <id>       Update feature status
 *   list <project>              List all features
 *   verify <project>            Run verification for all features
 *   next <project>              Show next priority feature
 */

import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { createStateManager, type StateManager } from './StateManager';

// Zod schemas for validation
const TestStepSchema = z.object({
  step: z.string(),
  status: z.enum(['pending', 'passing', 'failing']),
});

const FeatureSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  priority: z.enum(['P1', 'P2', 'P3']),
  status: z.enum(['pending', 'in_progress', 'passing', 'failing', 'blocked']),
  test_steps: z.array(TestStepSchema),
  acceptance_criteria: z.array(z.string()),
  blocked_by: z.array(z.string()),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  notes: z.array(z.string()),
});

const FeatureRegistrySchema = z.object({
  project: z.string(),
  created: z.string(),
  updated: z.string(),
  version: z.string(),
  features: z.array(FeatureSchema),
  completion_summary: z.object({
    total: z.number(),
    passing: z.number(),
    failing: z.number(),
    pending: z.number(),
    blocked: z.number(),
  }),
});

type Feature = z.infer<typeof FeatureSchema>;
type FeatureRegistry = z.infer<typeof FeatureRegistrySchema>;

const REGISTRY_DIR = join(process.env.HOME || '', '.claude', 'MEMORY', 'progress');

function getRegistryPath(project: string): string {
  return join(REGISTRY_DIR, `${project}-features.json`);
}

// Cached StateManager instances per project
const managers = new Map<string, StateManager<FeatureRegistry>>();

function getManager(project: string): StateManager<FeatureRegistry> {
  if (!managers.has(project)) {
    managers.set(project, createStateManager<FeatureRegistry>({
      path: getRegistryPath(project),
      schema: FeatureRegistrySchema,
      defaults: {
        project,
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        version: '1.0.0',
        features: [],
        completion_summary: { total: 0, passing: 0, failing: 0, pending: 0, blocked: 0 },
      },
    }));
  }
  return managers.get(project)!;
}

async function loadRegistry(project: string): Promise<FeatureRegistry | null> {
  const manager = getManager(project);
  if (!(await manager.exists())) return null;
  return manager.load();
}

async function saveRegistry(registry: FeatureRegistry): Promise<void> {
  registry.updated = new Date().toISOString();
  registry.completion_summary = calculateSummary(registry.features);
  const manager = getManager(registry.project);
  await manager.save(registry);
}

function calculateSummary(features: Feature[]): FeatureRegistry['completion_summary'] {
  return {
    total: features.length,
    passing: features.filter(f => f.status === 'passing').length,
    failing: features.filter(f => f.status === 'failing').length,
    pending: features.filter(f => f.status === 'pending').length,
    blocked: features.filter(f => f.status === 'blocked').length,
  };
}

function generateId(features: Feature[]): string {
  const maxId = features.reduce((max, f) => {
    const num = parseInt(f.id.replace('feat-', ''));
    return num > max ? num : max;
  }, 0);
  return `feat-${maxId + 1}`;
}

// Commands

async function initRegistry(project: string): Promise<void> {
  if (!existsSync(REGISTRY_DIR)) {
    mkdirSync(REGISTRY_DIR, { recursive: true });
  }

  const manager = getManager(project);
  if (await manager.exists()) {
    console.log(`Registry already exists for ${project}`);
    return;
  }

  const registry: FeatureRegistry = {
    project,
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    version: '1.0.0',
    features: [],
    completion_summary: { total: 0, passing: 0, failing: 0, pending: 0, blocked: 0 }
  };

  await saveRegistry(registry);
  console.log(`Initialized feature registry: ${manager.getPath()}`);
}

async function addFeature(
  project: string,
  name: string,
  description: string = '',
  priority: 'P1' | 'P2' | 'P3' = 'P2',
  criteria: string[] = [],
  steps: string[] = []
): Promise<void> {
  const registry = await loadRegistry(project);
  if (!registry) {
    console.error(`No registry found for ${project}. Run: feature-registry init ${project}`);
    process.exit(1);
  }

  const feature: Feature = {
    id: generateId(registry.features),
    name,
    description,
    priority,
    status: 'pending',
    test_steps: steps.map(s => ({ step: s, status: 'pending' as const })),
    acceptance_criteria: criteria,
    blocked_by: [],
    started_at: null,
    completed_at: null,
    notes: []
  };

  registry.features.push(feature);
  await saveRegistry(registry);
  console.log(`Added feature ${feature.id}: ${name}`);
}

async function updateFeature(
  project: string,
  featureId: string,
  status?: Feature['status'],
  note?: string
): Promise<void> {
  const registry = await loadRegistry(project);
  if (!registry) {
    console.error(`No registry found for ${project}`);
    process.exit(1);
  }

  const feature = registry.features.find(f => f.id === featureId);
  if (!feature) {
    console.error(`Feature ${featureId} not found`);
    process.exit(1);
  }

  if (status) {
    feature.status = status;
    if (status === 'in_progress' && !feature.started_at) {
      feature.started_at = new Date().toISOString();
    }
    if (status === 'passing') {
      feature.completed_at = new Date().toISOString();
    }
  }

  if (note) {
    feature.notes.push(`[${new Date().toISOString()}] ${note}`);
  }

  await saveRegistry(registry);
  console.log(`Updated ${featureId}: status=${feature.status}`);
}

async function listFeatures(project: string): Promise<void> {
  const registry = await loadRegistry(project);
  if (!registry) {
    console.error(`No registry found for ${project}`);
    process.exit(1);
  }

  console.log(`\nFeature Registry: ${project}`);
  console.log(`Updated: ${registry.updated}`);
  console.log(`---`);

  const summary = registry.completion_summary;
  console.log(`Progress: ${summary.passing}/${summary.total} passing`);
  console.log(`  Pending: ${summary.pending} | Failing: ${summary.failing} | Blocked: ${summary.blocked}`);
  console.log(`---\n`);

  const byPriority = {
    P1: registry.features.filter(f => f.priority === 'P1'),
    P2: registry.features.filter(f => f.priority === 'P2'),
    P3: registry.features.filter(f => f.priority === 'P3'),
  };

  for (const [priority, features] of Object.entries(byPriority)) {
    if (features.length === 0) continue;
    console.log(`${priority} Features:`);
    for (const f of features) {
      const statusIcon = {
        pending: 'o',
        in_progress: '~',
        passing: '+',
        failing: 'x',
        blocked: '!'
      }[f.status];
      console.log(`  ${statusIcon} [${f.id}] ${f.name} (${f.status})`);
    }
    console.log('');
  }
}

async function verifyFeatures(project: string): Promise<void> {
  const registry = await loadRegistry(project);
  if (!registry) {
    console.error(`No registry found for ${project}`);
    process.exit(1);
  }

  console.log(`\nVerification Report: ${project}`);
  console.log(`===\n`);

  let allPassing = true;

  for (const feature of registry.features) {
    const icon = feature.status === 'passing' ? 'PASS' : 'FAIL';
    console.log(`[${icon}] ${feature.id}: ${feature.name}`);

    if (feature.status !== 'passing') {
      allPassing = false;
      console.log(`   Status: ${feature.status}`);
      if (feature.blocked_by.length > 0) {
        console.log(`   Blocked by: ${feature.blocked_by.join(', ')}`);
      }
    }

    for (const step of feature.test_steps) {
      const stepIcon = step.status === 'passing' ? '+' : step.status === 'failing' ? 'x' : 'o';
      console.log(`   ${stepIcon} ${step.step}`);
    }
    console.log('');
  }

  console.log(`===`);
  if (allPassing) {
    console.log(`ALL FEATURES PASSING - Ready for completion`);
  } else {
    console.log(`INCOMPLETE - Some features not passing`);
  }
}

async function nextFeature(project: string): Promise<void> {
  const registry = await loadRegistry(project);
  if (!registry) {
    console.error(`No registry found for ${project}`);
    process.exit(1);
  }

  const inProgress = registry.features.find(f => f.status === 'in_progress');
  if (inProgress) {
    console.log(`\nCurrent: [${inProgress.id}] ${inProgress.name}`);
    console.log(`Status: ${inProgress.status}`);
    console.log(`Started: ${inProgress.started_at}`);
    return;
  }

  for (const priority of ['P1', 'P2', 'P3'] as const) {
    const next = registry.features.find(f => f.priority === priority && f.status === 'pending');
    if (next) {
      console.log(`\nNext: [${next.id}] ${next.name} (${next.priority})`);
      console.log(`Description: ${next.description || 'None'}`);
      console.log(`\nTo start: feature-registry update ${project} ${next.id} in_progress`);
      return;
    }
  }

  console.log(`\nNo pending features. All features processed!`);
}

// CLI Parser

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'init':
      if (!args[1]) {
        console.error('Usage: feature-registry init <project>');
        process.exit(1);
      }
      await initRegistry(args[1]);
      break;

    case 'add':
      if (!args[1] || !args[2]) {
        console.error('Usage: feature-registry add <project> <feature-name> [--description "desc"] [--priority P1|P2|P3]');
        process.exit(1);
      }
      const descIdx = args.indexOf('--description');
      const desc = descIdx > -1 ? args[descIdx + 1] : '';
      const prioIdx = args.indexOf('--priority');
      const prio = prioIdx > -1 ? args[prioIdx + 1] as 'P1' | 'P2' | 'P3' : 'P2';
      await addFeature(args[1], args[2], desc, prio);
      break;

    case 'update':
      if (!args[1] || !args[2]) {
        console.error('Usage: feature-registry update <project> <feature-id> [status] [--note "note"]');
        process.exit(1);
      }
      const validStatuses = ['pending', 'in_progress', 'passing', 'failing', 'blocked'];
      const statusArg = validStatuses.includes(args[3]) ? args[3] as Feature['status'] : undefined;
      const noteIdx = args.indexOf('--note');
      const noteArg = noteIdx > -1 ? args[noteIdx + 1] : undefined;
      await updateFeature(args[1], args[2], statusArg, noteArg);
      break;

    case 'list':
      if (!args[1]) {
        console.error('Usage: feature-registry list <project>');
        process.exit(1);
      }
      await listFeatures(args[1]);
      break;

    case 'verify':
      if (!args[1]) {
        console.error('Usage: feature-registry verify <project>');
        process.exit(1);
      }
      await verifyFeatures(args[1]);
      break;

    case 'next':
      if (!args[1]) {
        console.error('Usage: feature-registry next <project>');
        process.exit(1);
      }
      await nextFeature(args[1]);
      break;

    default:
      console.log(`
Feature Registry CLI - JSON-based feature tracking

Commands:
  init <project>              Initialize feature registry
  add <project> <name>        Add feature (--description, --priority P1|P2|P3)
  update <project> <id>       Update status (pending|in_progress|passing|failing|blocked)
  list <project>              List all features with status
  verify <project>            Run verification report
  next <project>              Show next priority feature

Examples:
  feature-registry init my-app
  feature-registry add my-app "User Authentication" --priority P1
  feature-registry update my-app feat-1 in_progress
  feature-registry list my-app
  feature-registry verify my-app
`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
