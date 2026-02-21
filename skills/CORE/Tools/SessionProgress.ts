#!/usr/bin/env bun
/**
 * Session Progress CLI
 *
 * Manages session continuity files for multi-session work.
 * Based on Anthropic's claude-progress.txt pattern.
 *
 * Usage:
 *   bun run ~/.claude/skills/CORE/Tools/SessionProgress.ts <command> [options]
 */

import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { createStateManager, type StateManager } from './StateManager';

// Zod schemas for validation
const DecisionSchema = z.object({
  timestamp: z.string(),
  decision: z.string(),
  rationale: z.string(),
});

const WorkItemSchema = z.object({
  timestamp: z.string(),
  description: z.string(),
  artifacts: z.array(z.string()),
});

const BlockerSchema = z.object({
  timestamp: z.string(),
  blocker: z.string(),
  resolution: z.string().nullable(),
});

const SessionProgressSchema = z.object({
  project: z.string(),
  created: z.string(),
  updated: z.string(),
  status: z.enum(['active', 'completed', 'blocked']),
  objectives: z.array(z.string()),
  decisions: z.array(DecisionSchema),
  work_completed: z.array(WorkItemSchema),
  blockers: z.array(BlockerSchema),
  handoff_notes: z.string(),
  next_steps: z.array(z.string()),
});

type SessionProgress = z.infer<typeof SessionProgressSchema>;

// Progress files are now in STATE/progress/ (consolidated from MEMORY/PROGRESS/)
const PROGRESS_DIR = join(process.env.HOME || '', '.claude', 'MEMORY', 'STATE', 'progress');

function getProgressPath(project: string): string {
  return join(PROGRESS_DIR, `${project}-progress.json`);
}

// Cached StateManager instances per project
const managers = new Map<string, StateManager<SessionProgress>>();

function getManager(project: string): StateManager<SessionProgress> {
  if (!managers.has(project)) {
    managers.set(project, createStateManager<SessionProgress>({
      path: getProgressPath(project),
      schema: SessionProgressSchema,
      defaults: {
        project,
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        status: 'active',
        objectives: [],
        decisions: [],
        work_completed: [],
        blockers: [],
        handoff_notes: '',
        next_steps: [],
      },
    }));
  }
  return managers.get(project)!;
}

async function loadProgress(project: string): Promise<SessionProgress | null> {
  const manager = getManager(project);
  if (!(await manager.exists())) return null;
  return manager.load();
}

async function saveProgress(progress: SessionProgress): Promise<void> {
  progress.updated = new Date().toISOString();
  const manager = getManager(progress.project);
  await manager.save(progress);
}

// Commands

async function createProgress(project: string, objectives: string[]): Promise<void> {
  const manager = getManager(project);
  if (await manager.exists()) {
    console.log(`Progress file already exists for ${project}`);
    console.log(`Use 'session-progress resume ${project}' to continue`);
    return;
  }

  const progress: SessionProgress = {
    project,
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    status: 'active',
    objectives,
    decisions: [],
    work_completed: [],
    blockers: [],
    handoff_notes: '',
    next_steps: []
  };

  await saveProgress(progress);
  console.log(`Created progress file: ${manager.getPath()}`);
  console.log(`Objectives: ${objectives.join(', ')}`);
}

async function addDecision(project: string, decision: string, rationale: string): Promise<void> {
  const progress = await loadProgress(project);
  if (!progress) {
    console.error(`No progress file for ${project}`);
    process.exit(1);
  }

  progress.decisions.push({
    timestamp: new Date().toISOString(),
    decision,
    rationale
  });

  await saveProgress(progress);
  console.log(`Added decision: ${decision}`);
}

async function addWork(project: string, description: string, artifacts: string[]): Promise<void> {
  const progress = await loadProgress(project);
  if (!progress) {
    console.error(`No progress file for ${project}`);
    process.exit(1);
  }

  progress.work_completed.push({
    timestamp: new Date().toISOString(),
    description,
    artifacts
  });

  await saveProgress(progress);
  console.log(`Added work: ${description}`);
}

async function addBlocker(project: string, blocker: string, resolution?: string): Promise<void> {
  const progress = await loadProgress(project);
  if (!progress) {
    console.error(`No progress file for ${project}`);
    process.exit(1);
  }

  progress.blockers.push({
    timestamp: new Date().toISOString(),
    blocker,
    resolution: resolution || null
  });

  progress.status = 'blocked';
  await saveProgress(progress);
  console.log(`Added blocker: ${blocker}`);
}

async function setNextSteps(project: string, steps: string[]): Promise<void> {
  const progress = await loadProgress(project);
  if (!progress) {
    console.error(`No progress file for ${project}`);
    process.exit(1);
  }

  progress.next_steps = steps;
  await saveProgress(progress);
  console.log(`Set ${steps.length} next steps`);
}

async function setHandoff(project: string, notes: string): Promise<void> {
  const progress = await loadProgress(project);
  if (!progress) {
    console.error(`No progress file for ${project}`);
    process.exit(1);
  }

  progress.handoff_notes = notes;
  await saveProgress(progress);
  console.log(`Set handoff notes`);
}

async function resumeProgress(project: string): Promise<void> {
  const progress = await loadProgress(project);
  if (!progress) {
    console.error(`No progress file for ${project}`);
    process.exit(1);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`SESSION RESUME: ${project}`);
  console.log(`${'='.repeat(60)}\n`);

  console.log(`Status: ${progress.status}`);
  console.log(`Last Updated: ${progress.updated}\n`);

  console.log(`OBJECTIVES:`);
  progress.objectives.forEach((o, i) => console.log(`  ${i + 1}. ${o}`));

  if (progress.decisions.length > 0) {
    console.log(`\nKEY DECISIONS:`);
    progress.decisions.slice(-3).forEach(d => {
      console.log(`  - ${d.decision}`);
      console.log(`    Rationale: ${d.rationale}`);
    });
  }

  if (progress.work_completed.length > 0) {
    console.log(`\nRECENT WORK:`);
    progress.work_completed.slice(-5).forEach(w => {
      console.log(`  - ${w.description}`);
      if (w.artifacts.length > 0) {
        console.log(`    Artifacts: ${w.artifacts.join(', ')}`);
      }
    });
  }

  if (progress.blockers.length > 0) {
    const unresolvedBlockers = progress.blockers.filter(b => !b.resolution);
    if (unresolvedBlockers.length > 0) {
      console.log(`\nACTIVE BLOCKERS:`);
      unresolvedBlockers.forEach(b => {
        console.log(`  - ${b.blocker}`);
      });
    }
  }

  if (progress.handoff_notes) {
    console.log(`\nHANDOFF NOTES:`);
    console.log(`  ${progress.handoff_notes}`);
  }

  if (progress.next_steps.length > 0) {
    console.log(`\nNEXT STEPS:`);
    progress.next_steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  }

  console.log(`\n${'='.repeat(60)}\n`);
}

async function listActive(): Promise<void> {
  if (!existsSync(PROGRESS_DIR)) {
    console.log('No progress files found');
    return;
  }

  const files = readdirSync(PROGRESS_DIR)
    .filter(f => f.endsWith('-progress.json'));

  if (files.length === 0) {
    console.log('No active progress files');
    return;
  }

  console.log(`\nActive Progress Files:\n`);

  for (const file of files) {
    // Extract project name from filename and use StateManager via getManager
    const projectName = file.replace('-progress.json', '');
    try {
      const progress = await getManager(projectName).load();
      const statusIcon = {
        active: 'ACTIVE',
        completed: 'DONE',
        blocked: 'BLOCKED'
      }[progress.status];

      console.log(`[${statusIcon}] ${progress.project} (${progress.status})`);
      console.log(`   Updated: ${new Date(progress.updated).toLocaleDateString()}`);
      console.log(`   Work items: ${progress.work_completed.length}`);
      if (progress.next_steps.length > 0) {
        console.log(`   Next: ${progress.next_steps[0]}`);
      }
      console.log('');
    } catch {
      console.log(`[ERROR] ${projectName} - failed to load`);
      console.log('');
    }
  }
}

async function completeProgress(project: string): Promise<void> {
  const progress = await loadProgress(project);
  if (!progress) {
    console.error(`No progress file for ${project}`);
    process.exit(1);
  }

  progress.status = 'completed';
  progress.handoff_notes = `Completed at ${new Date().toISOString()}`;
  await saveProgress(progress);
  console.log(`Marked ${project} as completed`);
}

// CLI Parser

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'create':
      if (!args[1]) {
        console.error('Usage: session-progress create <project> [objective1] [objective2] ...');
        process.exit(1);
      }
      await createProgress(args[1], args.slice(2));
      break;

    case 'decision':
      if (!args[1] || !args[2]) {
        console.error('Usage: session-progress decision <project> "<decision>" "<rationale>"');
        process.exit(1);
      }
      await addDecision(args[1], args[2], args[3] || '');
      break;

    case 'work':
      if (!args[1] || !args[2]) {
        console.error('Usage: session-progress work <project> "<description>" [artifact1] [artifact2] ...');
        process.exit(1);
      }
      await addWork(args[1], args[2], args.slice(3));
      break;

    case 'blocker':
      if (!args[1] || !args[2]) {
        console.error('Usage: session-progress blocker <project> "<blocker>" ["resolution"]');
        process.exit(1);
      }
      await addBlocker(args[1], args[2], args[3]);
      break;

    case 'next':
      if (!args[1]) {
        console.error('Usage: session-progress next <project> <step1> <step2> ...');
        process.exit(1);
      }
      await setNextSteps(args[1], args.slice(2));
      break;

    case 'handoff':
      if (!args[1] || !args[2]) {
        console.error('Usage: session-progress handoff <project> "<notes>"');
        process.exit(1);
      }
      await setHandoff(args[1], args[2]);
      break;

    case 'resume':
      if (!args[1]) {
        console.error('Usage: session-progress resume <project>');
        process.exit(1);
      }
      await resumeProgress(args[1]);
      break;

    case 'list':
      await listActive();
      break;

    case 'complete':
      if (!args[1]) {
        console.error('Usage: session-progress complete <project>');
        process.exit(1);
      }
      await completeProgress(args[1]);
      break;

    default:
      console.log(`
Session Progress CLI - Multi-session continuity management

Commands:
  create <project> [objectives...]    Create new progress file
  decision <project> <decision> <rationale>  Record a decision
  work <project> <description> [artifacts...]  Record completed work
  blocker <project> <blocker> [resolution]    Add blocker
  next <project> <step1> <step2>...   Set next steps
  handoff <project> <notes>           Set handoff notes
  resume <project>                    Display context for resuming
  list                                List all active progress files
  complete <project>                  Mark project as completed

Examples:
  session-progress create auth-feature "Implement user authentication"
  session-progress decision auth-feature "Using JWT" "Simpler than sessions for our API"
  session-progress work auth-feature "Created User model" src/models/user.ts
  session-progress next auth-feature "Write auth tests" "Implement login endpoint"
  session-progress resume auth-feature
`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
