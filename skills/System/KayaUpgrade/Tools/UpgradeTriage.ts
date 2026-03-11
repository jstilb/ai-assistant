#!/usr/bin/env bun

/**
 * UpgradeTriage.ts — AI-powered analysis of raw upgrade findings
 *
 * Reads raw findings from Anthropic.ts and YouTube.ts state files,
 * sends them to an AI agent with Kaya architecture context, and
 * produces: queue items, insights, and a narrative report.
 *
 * Usage:
 *   bun Tools/UpgradeTriage.ts                    # Triage latest findings
 *   bun Tools/UpgradeTriage.ts --dry-run           # Preview without routing
 *   bun Tools/UpgradeTriage.ts --level smart        # Use Opus for analysis
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { z } from 'zod';
import { inference, type InferenceLevel } from '../../../../lib/core/Inference.ts';
import { emitInsight } from '../../../../lib/core/SkillIntegrationBridge.ts';
import { createStateManager } from '../../../../lib/core/StateManager.ts';
import { notifySync } from '../../../../lib/core/NotificationService.ts';

// ============================================================================
// Types
// ============================================================================

interface AnthropicFindings {
  timestamp: string;
  daysChecked: number;
  updates: Array<{
    source: string;
    category: string;
    type: string;
    title: string;
    url: string;
    date: string;
    summary?: string;
    priority: 'HIGH' | 'MEDIUM' | 'LOW';
  }>;
}

interface YouTubeFindings {
  timestamp: string;
  videos: Array<{
    channel: string;
    videoId: string;
    title: string;
    url: string;
    duration: number;
    relevance: 'HIGH' | 'MEDIUM' | 'LOW';
  }>;
}

interface ActionableItem {
  title: string;
  description: string;
  priority: 1 | 2 | 3;
  affectedComponents: string[];
  sourceUpdates: string[];
  estimatedEffort: 'S' | 'M' | 'L';
  researchGuidance: string;
}

interface TriageResult {
  actionableItems: ActionableItem[];
  narrative: string;
  dismissedCount: number;
  dismissalReasoning: string;
}

// ============================================================================
// Configuration
// ============================================================================

const HOME = homedir();
const SKILL_DIR = join(HOME, '.claude', 'skills', 'KayaUpgrade');
const STATE_DIR = join(SKILL_DIR, 'State');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const levelArg = args.find((_, i) => args[i - 1] === '--level');
const LEVEL: InferenceLevel = (['fast', 'standard', 'smart'].includes(levelArg || '') ? levelArg : 'standard') as InferenceLevel;

// ============================================================================
// State Loading
// ============================================================================

const AnthropicFindingsSchema = z.object({
  timestamp: z.string(),
  daysChecked: z.number(),
  updates: z.array(z.object({
    source: z.string(),
    category: z.string(),
    type: z.string(),
    title: z.string(),
    url: z.string(),
    date: z.string(),
    summary: z.string().optional(),
    priority: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  })),
});

const YouTubeFindingsSchema = z.object({
  timestamp: z.string(),
  videos: z.array(z.object({
    channel: z.string(),
    videoId: z.string(),
    title: z.string(),
    url: z.string(),
    duration: z.number(),
    relevance: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  })),
});

async function loadAnthropicFindings(): Promise<AnthropicFindings> {
  const path = join(STATE_DIR, 'latest-anthropic-findings.json');
  if (!existsSync(path)) {
    return { timestamp: '', daysChecked: 0, updates: [] };
  }
  const sm = createStateManager({
    path,
    schema: AnthropicFindingsSchema,
    defaults: () => ({ timestamp: '', daysChecked: 0, updates: [] }),
  });
  return await sm.load();
}

async function loadYouTubeFindings(): Promise<YouTubeFindings> {
  const path = join(STATE_DIR, 'latest-youtube-findings.json');
  if (!existsSync(path)) {
    return { timestamp: '', videos: [] };
  }
  const sm = createStateManager({
    path,
    schema: YouTubeFindingsSchema,
    defaults: () => ({ timestamp: '', videos: [] }),
  });
  return await sm.load();
}

// ============================================================================
// AI Triage
// ============================================================================

async function triageFindings(
  anthropicFindings: AnthropicFindings,
  youtubeFindings: YouTubeFindings,
  level: InferenceLevel,
): Promise<TriageResult> {
  const totalInputs = anthropicFindings.updates.length + youtubeFindings.videos.length;

  if (totalInputs === 0) {
    return {
      actionableItems: [],
      narrative: 'No findings to triage — both Anthropic and YouTube sources returned empty results.',
      dismissedCount: 0,
      dismissalReasoning: 'No input data.',
    };
  }

  const systemPrompt = `You are a Kaya system architect analyzing Anthropic ecosystem updates.

Kaya is a personal AI assistant built on Claude Code with:
- 54 skills (TypeScript tools + markdown workflows)
- MCP servers for chrome-devtools, brightdata, and more
- Hooks system for context loading and session management
- Agent system for parallel work delegation
- Skills use: StateManager, CachedHTTPClient, NotificationService, Zod

Your job: Given raw update findings, determine which are actionable for Kaya.

For each actionable finding, produce:
1. A clear title for the upgrade work item
2. A description explaining WHY this matters for Kaya and WHAT should change
3. Priority (1=urgent, 2=normal, 3=low)
4. Which Kaya components are affected
5. Research guidance: 2-4 specific questions about Kaya's codebase that need answering before implementing (e.g. "Which skills call inference() with array parameters?", "Does StateManager handle the new config format?")

Rules:
- Only flag truly actionable items — not every commit matters
- Group related updates into single work items when they represent one theme
- Releases and breaking changes are almost always actionable
- New features that map to existing Kaya gaps are HIGH priority
- SDK version bumps with no breaking changes are NOT actionable
- Documentation-only changes are NOT actionable unless they reveal new features

Return JSON:
{
  "actionableItems": [
    {
      "title": "string — imperative, e.g. 'Adopt context forking for skill isolation'",
      "description": "string — WHY it matters + WHAT to change in Kaya",
      "priority": 1|2|3,
      "affectedComponents": ["skills"|"hooks"|"agents"|"mcp"|"config"|"tools"],
      "sourceUpdates": ["title of related raw update(s)"],
      "estimatedEffort": "S|M|L",
      "researchGuidance": "string — 2-4 specific research questions for Kaya's codebase, e.g. which files use the affected API, what the current behavior is, what tests cover it"
    }
  ],
  "narrative": "string — 2-3 paragraph executive summary of what's happening",
  "dismissedCount": number,
  "dismissalReasoning": "string — why non-actionable items were dismissed"
}`;

  // Build user prompt with all findings
  let userPrompt = `## Raw Anthropic Findings (${anthropicFindings.updates.length} updates)\n\n`;

  if (anthropicFindings.updates.length > 0) {
    userPrompt += anthropicFindings.updates.map(u =>
      `- [${u.priority}] [${u.category}/${u.type}] ${u.title}\n  Source: ${u.source} | Date: ${u.date}\n  URL: ${u.url}${u.summary ? '\n  Summary: ' + u.summary : ''}`
    ).join('\n\n');
  } else {
    userPrompt += 'No Anthropic updates found.\n';
  }

  userPrompt += `\n\n## Raw YouTube Findings (${youtubeFindings.videos.length} videos)\n\n`;

  if (youtubeFindings.videos.length > 0) {
    userPrompt += youtubeFindings.videos.map(v =>
      `- [${v.relevance}] ${v.title}\n  Channel: ${v.channel} | URL: ${v.url}`
    ).join('\n\n');
  } else {
    userPrompt += 'No YouTube findings.\n';
  }

  userPrompt += '\n\nAnalyze these findings and return the JSON structure.';

  const result = await inference({
    systemPrompt,
    userPrompt,
    level,
    expectJson: true,
    timeout: level === 'smart' ? 300000 : 180000,
  });

  if (!result.success || !result.parsed) {
    console.error(`\u26a0\ufe0f Inference failed: ${result.error || 'no JSON in response'}`);
    return {
      actionableItems: [],
      narrative: `AI triage failed: ${result.error || 'could not parse response'}`,
      dismissedCount: 0,
      dismissalReasoning: '',
    };
  }

  return result.parsed as TriageResult;
}

// ============================================================================
// Routing
// ============================================================================

async function routeResults(triage: TriageResult): Promise<void> {
  // 1. Route actionable items to QueueRouter spec-pipeline
  if (triage.actionableItems.length > 0) {
    let QueueManager: typeof import('../../../Automation/QueueRouter/Tools/QueueManager.ts').QueueManager;
    try {
      ({ QueueManager } = await import('../../../Automation/QueueRouter/Tools/QueueManager.ts'));
    } catch (err) {
      console.error(`\u274c Failed to import QueueManager:`, err);
      return;
    }
    const qm = new QueueManager();

    let queued = 0;
    for (const item of triage.actionableItems) {
      try {
        const id = await qm.add(
          {
            title: item.title,
            description: [
              item.description,
              '',
              `**Affected Components:** ${item.affectedComponents.join(', ')}`,
              `**Estimated Effort:** ${item.estimatedEffort}`,
              `**Source Updates:** ${item.sourceUpdates.join('; ')}`,
            ].join('\n'),
            context: {
              affectedComponents: item.affectedComponents,
              effort: item.estimatedEffort,
              sourceUpdates: item.sourceUpdates,
              notes: item.description,
              researchGuidance: item.researchGuidance,
            },
          },
          {
            source: 'KayaUpgrade',
            priority: item.priority as 1 | 2 | 3,
          },
        );
        queued++;
        console.log(`   \u2705 [P${item.priority}] ${item.title} → ${id}`);
      } catch (err) {
        console.error(`   \u274c Failed to queue "${item.title}":`, err instanceof Error ? err.message : err);
      }
    }
    console.log(`\ud83d\udccb Queued ${queued}/${triage.actionableItems.length} item(s) to spec-pipeline`);
  }

  // 2. Emit summary insight for ContinualLearning
  await emitInsight({
    source: 'KayaUpgrade',
    type: 'learning',
    category: 'upgrade_triage',
    title: `Upgrade triage: ${triage.actionableItems.length} actionable, ${triage.dismissedCount} dismissed`,
    content: triage.narrative,
    tags: ['kayaupgrade', 'triage', 'anthropic'],
    tier: 'hot',
    metadata: {
      actionableCount: triage.actionableItems.length,
      dismissedCount: triage.dismissedCount,
      items: triage.actionableItems.map(i => i.title),
    },
  }).catch(() => {});

  // 3. Emit individual insights for each actionable item
  for (const item of triage.actionableItems) {
    await emitInsight({
      source: 'KayaUpgrade',
      type: 'signal',
      category: 'upgrade_opportunity',
      title: item.title,
      content: item.description,
      tags: ['kayaupgrade', 'upgrade', ...item.affectedComponents],
      tier: 'hot',
      metadata: { priority: item.priority, effort: item.estimatedEffort },
    }).catch(() => {});
  }
}

// ============================================================================
// Report
// ============================================================================

function printReport(triage: TriageResult): void {
  console.log('\n' + '='.repeat(80));
  console.log('\n# Upgrade Triage Report\n');

  // Narrative
  console.log('## Executive Summary\n');
  console.log(triage.narrative);
  console.log();

  // Actionable items
  if (triage.actionableItems.length > 0) {
    console.log(`## Actionable Items (${triage.actionableItems.length})\n`);

    for (const item of triage.actionableItems) {
      const priorityLabel = item.priority === 1 ? 'URGENT' : item.priority === 2 ? 'NORMAL' : 'LOW';
      console.log(`### [P${item.priority}/${priorityLabel}] ${item.title}\n`);
      console.log(item.description);
      console.log(`\n**Components:** ${item.affectedComponents.join(', ')}`);
      console.log(`**Effort:** ${item.estimatedEffort}`);
      console.log(`**Sources:** ${item.sourceUpdates.join('; ')}`);
      console.log('\n---\n');
    }
  } else {
    console.log('## No Actionable Items\n');
    console.log('All findings were dismissed as non-actionable.\n');
  }

  // Dismissal reasoning
  if (triage.dismissedCount > 0) {
    console.log(`## Dismissed (${triage.dismissedCount})\n`);
    console.log(triage.dismissalReasoning);
    console.log();
  }

  console.log('='.repeat(80));
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log('\ud83e\udde0 KayaUpgrade AI Triage\n');
  console.log(`\ud83c\udfaf Level: ${LEVEL}`);
  console.log(`\ud83d\udd0d Dry run: ${DRY_RUN ? 'Yes' : 'No'}`);
  console.log();

  // Load raw findings
  console.log('\ud83d\udcc2 Loading raw findings...');
  const [anthropicFindings, youtubeFindings] = await Promise.all([
    loadAnthropicFindings(),
    loadYouTubeFindings(),
  ]);

  console.log(`   Anthropic: ${anthropicFindings.updates.length} updates (${anthropicFindings.timestamp ? 'from ' + anthropicFindings.timestamp.split('T')[0] : 'no data'})`);
  console.log(`   YouTube: ${youtubeFindings.videos.length} videos (${youtubeFindings.timestamp ? 'from ' + youtubeFindings.timestamp.split('T')[0] : 'no data'})`);

  if (anthropicFindings.updates.length === 0 && youtubeFindings.videos.length === 0) {
    console.log('\n\u2728 No findings to triage. Run Anthropic.ts and/or YouTube.ts first.');
    notifySync('Upgrade triage: no findings to analyze');
    return;
  }

  // Run AI triage
  console.log('\n\ud83e\udde0 Running AI triage...');
  const triage = await triageFindings(anthropicFindings, youtubeFindings, LEVEL);

  // Print report
  printReport(triage);

  // Route results (unless dry-run)
  if (!DRY_RUN) {
    console.log('\n\ud83d\udce4 Routing results...');
    await routeResults(triage);

    // Persist triage result to state
    const TriageStateSchema = z.object({
      timestamp: z.string(),
      level: z.string(),
      actionableCount: z.number(),
      dismissedCount: z.number(),
      items: z.array(z.object({
        title: z.string(),
        priority: z.number(),
        effort: z.string(),
      })),
    });

    const triageState = createStateManager({
      path: join(STATE_DIR, 'latest-triage-result.json'),
      schema: TriageStateSchema,
      defaults: () => ({ timestamp: '', level: '', actionableCount: 0, dismissedCount: 0, items: [] }),
    });

    await triageState.save({
      timestamp: new Date().toISOString(),
      level: LEVEL,
      actionableCount: triage.actionableItems.length,
      dismissedCount: triage.dismissedCount,
      items: triage.actionableItems.map(i => ({
        title: i.title,
        priority: i.priority,
        effort: i.estimatedEffort,
      })),
    });

    console.log('\u2705 Triage complete and results routed');
  } else {
    console.log('\n\ud83d\udd0d [DRY RUN] Results not routed');
  }

  // Summary notification
  notifySync(
    `Upgrade triage: ${triage.actionableItems.length} actionable, ${triage.dismissedCount} dismissed`
  );

  console.log('\n\ud83c\udfaf STATUS: Triage complete');
  console.log(`\u2705 ${triage.actionableItems.length} actionable items, ${triage.dismissedCount} dismissed`);
  if (!DRY_RUN && triage.actionableItems.length > 0) {
    console.log('\u27a1\ufe0f NEXT: Review queued items via /queue list');
  }
}

main().catch(error => {
  console.error('\u274c Fatal error:', error);
  process.exit(1);
});
