#!/usr/bin/env bun

/**
 * Explore.ts — Deep exploration of KayaUpgrade findings
 *
 * Reads raw findings from Anthropic.ts and YouTube.ts state files,
 * fetches full release notes, READMEs, article text, and video transcripts,
 * then writes enriched findings and an exploration registry for caching.
 *
 * Usage:
 *   bun Tools/Explore.ts                   # Explore latest findings
 *   bun Tools/Explore.ts --dry-run         # Preview without fetching/saving
 *   bun Tools/Explore.ts --timeout 120000  # Override timeout (ms)
 */

import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import { createStateManager } from '../../../../lib/core/StateManager.ts';
import { httpClient } from '../../../../lib/core/CachedHTTPClient.ts';
import { notifySync } from '../../../../lib/core/NotificationService.ts';

// ============================================================================
// Configuration
// ============================================================================

const HOME = homedir();
const SKILL_DIR = join(HOME, '.claude', 'skills', 'System', 'KayaUpgrade');
const STATE_DIR = join(SKILL_DIR, 'State');
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

// ============================================================================
// CLI Args
// ============================================================================

const cliArgs = process.argv.slice(2);
const DRY_RUN = cliArgs.includes('--dry-run');

const timeoutArgIdx = cliArgs.findIndex(a => a === '--timeout');
const EXPLORE_TIMEOUT_MS = timeoutArgIdx !== -1 && cliArgs[timeoutArgIdx + 1]
  ? parseInt(cliArgs[timeoutArgIdx + 1], 10)
  : parseInt(process.env.EXPLORE_TIMEOUT_MS ?? '600000', 10); // 10 min default

// ============================================================================
// Schemas — Exploration Registry
// ============================================================================

const ExploredReleaseSchema = z.object({
  exploredAt: z.string(),
  features: z.array(z.string()),
  summary: z.string(),
});

const ExploredRepoSchema = z.object({
  exploredAt: z.string(),
  summary: z.string(),
  relevance: z.enum(['HIGH', 'MEDIUM', 'LOW', 'IRRELEVANT']),
});

const ExploredVideoSchema = z.object({
  exploredAt: z.string(),
  summary: z.string(),
});

const ExploredArticleSchema = z.object({
  exploredAt: z.string(),
  summary: z.string(),
});

const ExplorationRegistrySchema = z.object({
  releases: z.record(z.string(), ExploredReleaseSchema),
  repos: z.record(z.string(), ExploredRepoSchema),
  videos: z.record(z.string(), ExploredVideoSchema),
  articles: z.record(z.string(), ExploredArticleSchema),
  lastPrunedAt: z.string().optional(),
});

export type ExplorationRegistry = z.infer<typeof ExplorationRegistrySchema>;

// ============================================================================
// Schemas — Source Findings (matches UpgradeTriage.ts shapes)
// ============================================================================

const AnthropicUpdateSchema = z.object({
  source: z.string(),
  category: z.string(),
  type: z.string(),
  title: z.string(),
  url: z.string(),
  date: z.string(),
  summary: z.string().optional(),
  priority: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  sha: z.string().optional(),
  hash: z.string().optional(),
  version: z.string().optional(),
});

const AnthropicFindingsSchema = z.object({
  timestamp: z.string(),
  daysChecked: z.number(),
  updates: z.array(AnthropicUpdateSchema),
  fetchErrors: z.record(z.string(), z.string()).optional(),
});

const YouTubeVideoSchema = z.object({
  channel: z.string(),
  videoId: z.string(),
  title: z.string(),
  url: z.string(),
  duration: z.number(),
  relevance: z.enum(['HIGH', 'MEDIUM', 'LOW']),
});

const YouTubeFindingsSchema = z.object({
  timestamp: z.string(),
  videos: z.array(YouTubeVideoSchema),
});

// ============================================================================
// Schemas — Enriched Findings Output
// ============================================================================

const EnrichedUpdateSchema = z.object({
  source: z.string(),
  category: z.string(),
  type: z.string(),
  title: z.string(),
  url: z.string(),
  date: z.string(),
  summary: z.string().optional(),
  priority: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  sha: z.string().optional(),
  hash: z.string().optional(),
  version: z.string().optional(),
  // Enrichment fields
  explored: z.boolean().default(false),
  fullContent: z.string().optional(),
  contentSummary: z.string().optional(),
  features: z.array(z.string()).optional(),
});

const EnrichedVideoSchema = z.object({
  channel: z.string(),
  videoId: z.string(),
  title: z.string(),
  url: z.string(),
  duration: z.number(),
  relevance: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  // Enrichment
  explored: z.boolean().default(false),
  transcript: z.string().optional(),
  transcriptSummary: z.string().optional(),
});

const ExploredFindingsSchema = z.object({
  timestamp: z.string(),
  exploredAt: z.string(),
  anthropicFindings: z.object({
    timestamp: z.string(),
    daysChecked: z.number(),
    updates: z.array(EnrichedUpdateSchema),
    fetchErrors: z.record(z.string(), z.string()).optional(),
  }),
  youtubeFindings: z.object({
    timestamp: z.string(),
    videos: z.array(EnrichedVideoSchema),
  }),
});

// Inferred types
type AnthropicUpdate = z.infer<typeof AnthropicUpdateSchema>;
type YouTubeVideo = z.infer<typeof YouTubeVideoSchema>;
type EnrichedUpdate = z.infer<typeof EnrichedUpdateSchema>;
type EnrichedVideo = z.infer<typeof EnrichedVideoSchema>;

// ============================================================================
// State Managers
// ============================================================================

const registrySm = createStateManager({
  path: join(STATE_DIR, 'exploration-registry.json'),
  schema: ExplorationRegistrySchema,
  defaults: () => ({
    releases: {},
    repos: {},
    videos: {},
    articles: {},
  }),
});

const exploredFindingsSm = createStateManager({
  path: join(STATE_DIR, 'latest-explored-findings.json'),
  schema: ExploredFindingsSchema,
  defaults: () => ({
    timestamp: new Date().toISOString(),
    exploredAt: new Date().toISOString(),
    anthropicFindings: { timestamp: '', daysChecked: 0, updates: [] },
    youtubeFindings: { timestamp: '', videos: [] },
  }),
});

// ============================================================================
// Exported Pure Utility Functions (testable)
// ============================================================================

/**
 * Check whether a registry entry for the given key is still fresh within ttlDays.
 * IRRELEVANT repos use a 30-day TTL automatically.
 */
export function isAlreadyExplored(
  registry: ExplorationRegistry,
  type: 'releases' | 'repos' | 'videos' | 'articles',
  key: string,
  ttlDays: number = 7,
): boolean {
  const entry = registry[type][key];
  if (!entry) return false;
  // For IRRELEVANT repos, apply a longer TTL
  if (type === 'repos' && 'relevance' in entry && entry.relevance === 'IRRELEVANT') {
    ttlDays = 30;
  }
  const age = Date.now() - new Date(entry.exploredAt).getTime();
  return age < ttlDays * 24 * 60 * 60 * 1000;
}

/**
 * Return true if we're still within the allowed fraction of the time budget.
 * Default fraction 0.8 reserves 20% as a safety margin.
 */
export function hasTimeRemaining(startTime: number, budgetMs: number, fraction: number = 0.8): boolean {
  return Date.now() - startTime < budgetMs * fraction;
}

/**
 * Remove registry entries older than maxAgeDays.
 * Updates registry.lastPrunedAt in place. Returns count of pruned entries.
 */
export function pruneRegistry(registry: ExplorationRegistry, maxAgeDays: number = 60): number {
  let pruned = 0;
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  for (const section of ['releases', 'repos', 'videos', 'articles'] as const) {
    for (const [key, entry] of Object.entries(registry[section])) {
      if (Date.now() - new Date(entry.exploredAt).getTime() > maxAgeMs) {
        delete registry[section][key];
        pruned++;
      }
    }
  }
  registry.lastPrunedAt = new Date().toISOString();
  return pruned;
}

// ============================================================================
// Inference Helper
// ============================================================================

async function runInference(systemPrompt: string, userPrompt: string): Promise<string> {
  const { inference } = await import('../../../../lib/core/Inference.ts');
  const result = await inference({
    systemPrompt,
    userPrompt,
    level: 'standard', // Sonnet — better judgment for relevance scoring
  });
  if (!result.success) {
    throw new Error(`Inference failed: ${result.error}`);
  }
  return result.output;
}

// ============================================================================
// GitHub Headers Helper
// ============================================================================

function githubHeaders(accept: string = 'application/vnd.github+json'): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: accept,
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (GITHUB_TOKEN) {
    headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`;
  }
  return headers;
}

// ============================================================================
// Core Exploration Functions (all exported)
// ============================================================================

/**
 * Fetch full release notes from GitHub API and extract user-facing features.
 */
export async function exploreRelease(update: AnthropicUpdate): Promise<EnrichedUpdate> {
  const match = update.url.match(/github\.com\/([^/]+)\/([^/]+)\/releases\/tag\/(.+)/);
  if (!match) {
    console.warn(`  ⚠️  Cannot parse release URL: ${update.url}`);
    return { ...update, explored: false };
  }

  const [, owner, repo, tag] = match;
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`;

  const releaseData = await httpClient.fetchJson<{ body?: string }>(apiUrl, {
    headers: githubHeaders(),
    cache: 'disk',
    ttl: 86400, // 24h
    timeout: 15000,
  });

  const body = releaseData.body ?? '';

  const inferenceResult = await runInference(
    'You are a technical writer summarizing software releases for an AI developer.',
    `Extract a bullet list of user-facing features and changes from these release notes. Be concise, one line per feature. Only include meaningful changes, skip version bumps and infrastructure.\n\nRelease: ${update.title}\n\n${body.slice(0, 4000)}`,
  );

  // Parse features: lines starting with - or *
  const features = inferenceResult
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('-') || l.startsWith('*'))
    .map(l => l.replace(/^[-*]\s*/, '').trim())
    .filter(l => l.length > 0);

  return {
    ...update,
    explored: true,
    fullContent: body,
    contentSummary: inferenceResult,
    features,
  };
}

/**
 * Fetch repository README from GitHub API and assess relevance.
 */
export async function exploreRepo(update: AnthropicUpdate): Promise<EnrichedUpdate> {
  const match = update.url.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!match) {
    console.warn(`  ⚠️  Cannot parse repo URL: ${update.url}`);
    return { ...update, explored: false };
  }

  const [, owner, repo] = match;
  // Strip any trailing path segments (issues, PRs, etc.)
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/readme`;

  const readme = await httpClient.fetchText(apiUrl, {
    headers: githubHeaders('application/vnd.github.raw'),
    cache: 'disk',
    ttl: 86400,
    timeout: 15000,
  });

  const inferenceResult = await runInference(
    `You evaluate repositories for relevance to Kaya — a personal AI assistant built on Claude Code.

Kaya is a TypeScript CLI system with: 54 skills, hooks (PreToolUse/PostToolUse), MCP servers, a cron daemon, autonomous work pipelines, and a knowledge graph. It runs on macOS.

RELEVANT repos involve: LLM agent orchestration, MCP server implementations, Claude Code extensions/plugins, AI coding assistants, context engineering, prompt engineering tools, human-in-the-loop agent patterns, AI agent evaluation/testing, or TypeScript CLI tooling for AI workflows.

NOT RELEVANT: general-purpose utilities (system monitors, text editors, game servers), web frameworks, mobile apps, data visualization, DevOps tools, or programming language implementations — UNLESS they specifically target AI agent development.`,
    `Summarize this repository in 2-3 sentences. Then on a new line write exactly one of: HIGH, MEDIUM, LOW, or IRRELEVANT followed by a one-sentence reason.

HIGH = directly applicable to Kaya (agent frameworks, MCP tools, Claude extensions)
MEDIUM = potentially useful (TypeScript CLI patterns, AI dev tools, prompt libraries)
LOW = tangentially related (general dev tools with some AI applicability)
IRRELEVANT = no meaningful connection to AI agent development

README:\n${readme.slice(0, 6000)}`,
  );

  return {
    ...update,
    explored: true,
    fullContent: readme.slice(0, 8000),
    contentSummary: inferenceResult,
  };
}

/**
 * Scrape full article text and summarize for an AI developer audience.
 */
export async function exploreArticle(update: AnthropicUpdate): Promise<EnrichedUpdate> {
  // cross-skill-allowed: upgrade research scrapes release pages via the BrightData client by design (lazy import)
  const { BrightDataTool } = await import('../../../Data/BrightData/Tools/BrightDataTool.ts');

  const result = await new BrightDataTool().scrape(update.url, {
    startTier: 1,
    skipBrowser: false, // Allow Tier 3/4 for client-rendered pages (Next.js blogs)
    timeoutMs: 30000,
  });

  if (!result.success || !result.content) {
    console.warn(`  ⚠️  Failed to scrape article: ${result.error}`);
    return { ...update, explored: false };
  }

  const stripped = result.content
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const inferenceResult = await runInference(
    'You are a senior AI agent developer reading technical articles.',
    `Summarize this article in 3-5 sentences for an AI agent developer. Focus on technical insights, patterns, or tools.\n\nArticle: ${update.title}\n\n${stripped.slice(0, 4000)}`,
  );

  return {
    ...update,
    explored: true,
    fullContent: stripped.slice(0, 8000),
    contentSummary: inferenceResult,
  };
}

/**
 * Extract and summarize a YouTube video transcript.
 * Only processes HIGH relevance videos.
 */
export async function exploreVideo(video: YouTubeVideo): Promise<EnrichedVideo> {
  if (video.relevance !== 'HIGH') {
    return { ...video, explored: false };
  }

  const transcriptPath = join(HOME, '.claude', 'lib', 'core', 'GetTranscript.ts');

  let rawOutput: string;
  try {
    rawOutput = execSync(
      `/opt/homebrew/bin/bun "${transcriptPath}" "${video.url}"`,
      {
        timeout: 120_000,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  ⚠️  Transcript extraction failed for ${video.title}: ${msg}`);
    return { ...video, explored: false };
  }

  // Extract transcript between markers
  const startMarker = '--- TRANSCRIPT START ---';
  const endMarker = '--- TRANSCRIPT END ---';
  const startIdx = rawOutput.indexOf(startMarker);
  const endIdx = rawOutput.indexOf(endMarker);

  let transcript: string;
  if (startIdx !== -1 && endIdx !== -1) {
    transcript = rawOutput.slice(startIdx + startMarker.length, endIdx).trim();
  } else {
    // No markers — use entire output as fallback
    transcript = rawOutput.trim();
  }

  if (!transcript) {
    console.warn(`  ⚠️  Empty transcript for: ${video.title}`);
    return { ...video, explored: false };
  }

  const summary = await runInference(
    'You are a senior AI agent developer watching technical videos.',
    `Summarize this video in 3-5 sentences for an AI agent developer. Extract any actionable techniques.\n\nVideo: ${video.title}\n\n${transcript.slice(0, 4000)}`,
  );

  return {
    ...video,
    explored: true,
    transcript: transcript.slice(0, 10000),
    transcriptSummary: summary,
  };
}

// ============================================================================
// Registry Key Helpers
// ============================================================================

type RegistryType = 'releases' | 'repos' | 'videos' | 'articles';

interface QueueItem {
  registryType: RegistryType;
  key: string;
  title: string;
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  // Discriminated union payload
  kind: 'release' | 'repo' | 'article' | 'video';
  update?: AnthropicUpdate;
  video?: YouTubeVideo;
}

function releaseRegistryKey(update: AnthropicUpdate): string {
  // Derive a stable key from URL: "owner/repo@tag"
  const match = update.url.match(/github\.com\/([^/]+)\/([^/]+)\/releases\/tag\/(.+)/);
  if (match) {
    const [, owner, repo, tag] = match;
    return `${owner}/${repo}@${tag}`;
  }
  return update.title;
}

function repoRegistryKey(update: AnthropicUpdate): string {
  const match = update.url.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (match) {
    const [, owner, repo] = match;
    return `${owner}/${repo}`;
  }
  return update.title;
}

function articleRegistryKey(update: AnthropicUpdate): string {
  // Use a stable URL-derived key
  try {
    const u = new URL(update.url);
    return `${u.hostname}${u.pathname}`;
  } catch {
    return update.url;
  }
}

function videoRegistryKey(video: YouTubeVideo): string {
  return video.videoId;
}

// ============================================================================
// Parse relevance from inference output (for repo exploration)
// ============================================================================

function parseRelevance(
  inferenceOutput: string,
): 'HIGH' | 'MEDIUM' | 'LOW' | 'IRRELEVANT' {
  const firstLines = inferenceOutput.slice(0, 300).toUpperCase();
  if (firstLines.includes('IRRELEVANT')) return 'IRRELEVANT';
  if (firstLines.includes('HIGH')) return 'HIGH';
  if (firstLines.includes('MEDIUM')) return 'MEDIUM';
  if (firstLines.includes('LOW')) return 'LOW';
  return 'LOW';
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const startTime = Date.now();

  console.log('🔍 KayaUpgrade Explorer\n');
  console.log(`⏱️  Time budget: ${EXPLORE_TIMEOUT_MS / 1000}s`);
  if (DRY_RUN) console.log('🔵 DRY RUN — no fetches or saves\n');

  // ── 1. Load raw findings ──────────────────────────────────────────────────

  const anthropicPath = join(STATE_DIR, 'latest-anthropic-findings.json');
  const youtubePath = join(STATE_DIR, 'latest-youtube-findings.json');

  const anthropicSm = createStateManager({
    path: anthropicPath,
    schema: AnthropicFindingsSchema,
    defaults: () => ({ timestamp: '', daysChecked: 0, updates: [] }),
  });

  const youtubeSm = createStateManager({
    path: youtubePath,
    schema: YouTubeFindingsSchema,
    defaults: () => ({ timestamp: '', videos: [] }),
  });

  const [anthropicFindings, youtubeFindings] = await Promise.all([
    existsSync(anthropicPath) ? anthropicSm.load() : Promise.resolve({ timestamp: '', daysChecked: 0, updates: [] as AnthropicUpdate[] }),
    existsSync(youtubePath) ? youtubeSm.load() : Promise.resolve({ timestamp: '', videos: [] as YouTubeVideo[] }),
  ]);

  console.log(`📂 Loaded ${anthropicFindings.updates.length} Anthropic updates, ${youtubeFindings.videos.length} YouTube videos\n`);

  // ── 2. Load exploration registry ──────────────────────────────────────────

  const registry = await registrySm.load();

  // ── 3. Prune stale entries if needed ──────────────────────────────────────

  if (!registry.lastPrunedAt || Date.now() - new Date(registry.lastPrunedAt).getTime() > 30 * 24 * 60 * 60 * 1000) {
    const pruned = pruneRegistry(registry);
    if (pruned > 0) console.log(`🧹 Pruned ${pruned} stale registry entries\n`);
  }

  // ── 4. Build exploration queue, sorted by priority ────────────────────────

  const queue: QueueItem[] = [];

  for (const update of anthropicFindings.updates) {
    const lowerType = update.type.toLowerCase();
    const lowerCategory = update.category.toLowerCase();

    if (lowerType === 'release' || lowerCategory === 'release') {
      // Release → explore full release notes
      queue.push({
        registryType: 'releases',
        key: releaseRegistryKey(update),
        title: update.title,
        priority: update.priority,
        kind: 'release',
        update,
      });
    } else if (lowerCategory === 'trending' || update.source === 'GitHub Trending') {
      // Trending repo → explore README
      queue.push({
        registryType: 'repos',
        key: repoRegistryKey(update),
        title: update.title,
        priority: update.priority,
        kind: 'repo',
        update,
      });
    } else if (lowerType === 'blog' || lowerType === 'docs' || lowerType === 'changelog') {
      // Blog/docs/changelog → scrape article text
      queue.push({
        registryType: 'articles',
        key: articleRegistryKey(update),
        title: update.title,
        priority: update.priority,
        kind: 'article',
        update,
      });
    }
    // Commits and other types pass through without exploration — title + summary is sufficient
  }

  for (const video of youtubeFindings.videos) {
    if (video.relevance !== 'HIGH') continue; // skip non-HIGH videos early
    queue.push({
      registryType: 'videos',
      key: videoRegistryKey(video),
      title: video.title,
      priority: video.relevance, // HIGH/MEDIUM/LOW maps to priority
      kind: 'video',
      video,
    });
  }

  // Sort: HIGH releases first → HIGH articles → HIGH videos → MEDIUM releases → MEDIUM others
  const priorityRank: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  const kindRank: Record<string, number> = { release: 0, article: 1, video: 2, repo: 3 };
  queue.sort((a, b) => {
    const pr = (priorityRank[a.priority] ?? 2) - (priorityRank[b.priority] ?? 2);
    if (pr !== 0) return pr;
    return (kindRank[a.kind] ?? 3) - (kindRank[b.kind] ?? 3);
  });

  console.log(`📋 Exploration queue: ${queue.length} items\n`);

  if (DRY_RUN) {
    for (const item of queue) {
      const cached = isAlreadyExplored(registry, item.registryType, item.key);
      const status = cached ? '[CACHED]' : '[PENDING]';
      console.log(`  ${status} [${item.priority}] [${item.kind}] ${item.title}`);
    }
    console.log('\n🔵 Dry run complete — nothing fetched or saved.');
    return;
  }

  // ── 5. Build enriched findings maps from source data ─────────────────────

  // Start with un-enriched copies; exploration will replace entries in place
  const enrichedUpdates: Map<string, EnrichedUpdate> = new Map(
    anthropicFindings.updates.map(u => [u.url, { ...u, explored: false }]),
  );
  const enrichedVideos: Map<string, EnrichedVideo> = new Map(
    youtubeFindings.videos.map(v => [v.videoId, { ...v, explored: false }]),
  );

  // ── 6. Copy cached summaries into enriched output immediately ─────────────

  for (const item of queue) {
    if (!isAlreadyExplored(registry, item.registryType, item.key)) continue;

    if (item.kind === 'video' && item.video) {
      const cached = registry.videos[item.key];
      if (cached) {
        const existing = enrichedVideos.get(item.video.videoId);
        if (existing) {
          enrichedVideos.set(item.video.videoId, {
            ...existing,
            explored: true,
            transcriptSummary: cached.summary,
          });
        }
      }
    } else if (item.update) {
      const existing = enrichedUpdates.get(item.update.url);
      if (existing) {
        const regEntry = registry[item.registryType][item.key];
        enrichedUpdates.set(item.update.url, {
          ...existing,
          explored: true,
          contentSummary: regEntry.summary,
          features: item.kind === 'release' && 'features' in regEntry
            ? (regEntry as z.infer<typeof ExploredReleaseSchema>).features
            : undefined,
        });
      }
    }
  }

  // ── 7. Process queue within time budget ──────────────────────────────────

  let explored = 0;
  let skipped = 0;
  let timeSkipped = 0;

  for (const item of queue) {
    if (isAlreadyExplored(registry, item.registryType, item.key)) {
      skipped++;
      continue;
    }

    if (!hasTimeRemaining(startTime, EXPLORE_TIMEOUT_MS)) {
      timeSkipped++;
      continue;
    }

    console.log(`  🔎 [${item.priority}] ${item.title.slice(0, 80)}...`);

    try {
      if (item.kind === 'release' && item.update) {
        const enriched = await exploreRelease(item.update);
        enrichedUpdates.set(item.update.url, enriched);

        // Update registry
        registry.releases[item.key] = {
          exploredAt: new Date().toISOString(),
          features: enriched.features ?? [],
          summary: enriched.contentSummary ?? '',
        };

        explored++;

      } else if (item.kind === 'repo' && item.update) {
        const enriched = await exploreRepo(item.update);
        enrichedUpdates.set(item.update.url, enriched);

        const relevance = parseRelevance(enriched.contentSummary ?? '');
        registry.repos[item.key] = {
          exploredAt: new Date().toISOString(),
          summary: enriched.contentSummary ?? '',
          relevance,
        };

        explored++;

      } else if (item.kind === 'article' && item.update) {
        const enriched = await exploreArticle(item.update);
        enrichedUpdates.set(item.update.url, enriched);

        registry.articles[item.key] = {
          exploredAt: new Date().toISOString(),
          summary: enriched.contentSummary ?? '',
        };

        explored++;

      } else if (item.kind === 'video' && item.video) {
        const enriched = await exploreVideo(item.video);
        enrichedVideos.set(item.video.videoId, enriched);

        if (enriched.explored) {
          registry.videos[item.key] = {
            exploredAt: new Date().toISOString(),
            summary: enriched.transcriptSummary ?? '',
          };
        }

        explored++;
      }
    } catch (error) {
      console.warn(
        `  ⚠️  Failed to explore "${item.title}":`,
        error instanceof Error ? error.message : String(error),
      );
      // Continue — never abort full run on single failure
    }
  }

  // Count remaining time-skipped items
  // (already tracked in the loop above, but recount for any that weren't iterated)
  const actualTimeSkipped = queue.filter(item => {
    if (isAlreadyExplored(registry, item.registryType, item.key)) return false;
    return !hasTimeRemaining(startTime, EXPLORE_TIMEOUT_MS);
  }).length;
  // Use the higher count — the loop variable is authoritative
  void actualTimeSkipped;

  // ── 8. Save enriched findings ─────────────────────────────────────────────

  const exploredFindingsData = {
    timestamp: anthropicFindings.timestamp || new Date().toISOString(),
    exploredAt: new Date().toISOString(),
    anthropicFindings: {
      timestamp: anthropicFindings.timestamp,
      daysChecked: anthropicFindings.daysChecked,
      updates: Array.from(enrichedUpdates.values()),
      fetchErrors: anthropicFindings.fetchErrors,
    },
    youtubeFindings: {
      timestamp: youtubeFindings.timestamp,
      videos: Array.from(enrichedVideos.values()),
    },
  };

  await exploredFindingsSm.save(exploredFindingsData);
  await registrySm.save(registry);

  // ── 9. Summary ─────────────────────────────────────────────────────────────

  console.log(`\n📊 Exploration complete: ${explored} explored, ${skipped} cached, ${timeSkipped} skipped (time)`);
  console.log(`📁 Saved: ${join(STATE_DIR, 'latest-explored-findings.json')}`);

  notifySync(`KayaUpgrade Explore: ${explored} items explored`);
}

main().catch(error => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
