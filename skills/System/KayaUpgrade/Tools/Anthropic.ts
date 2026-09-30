#!/usr/bin/env bun

/**
 * Check Anthropic Changes - Comprehensive Update Monitoring
 *
 * Monitors 30+ official Anthropic sources for updates and provides
 * AI-powered recommendations for improving Kaya infrastructure.
 *
 * Usage:
 *   /check-anthropic-changes              # Check last 7 days
 *   /check-anthropic-changes 14           # Check last 14 days
 *   /check-anthropic-changes --force      # Force check all (ignore state)
 *
 * Sources Monitored:
 *   - 4 blogs/news sites
 *   - 9 GitHub repositories (commits + releases)
 *   - 4 changelog pages
 *   - 6 documentation sites
 *   - 1 community channel (manual reference)
 *
 * Output:
 *   - Prioritized report (HIGH/MEDIUM/LOW)
 *   - Actionable recommendations
 *   - Links to all changes
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { z } from 'zod';
import { httpClient } from '../../../../lib/core/CachedHTTPClient.ts';
import { createStateManager } from '../../../../lib/core/StateManager.ts';
import { loadSkillConfig } from '../../../../lib/core/LoadSkillConfig.ts';
import { notifySync } from '../../../../lib/core/NotificationService.ts';
import { createAppendLog } from '../../../../lib/core/AppendLog.ts';

// Types
interface Source {
  name: string;
  url?: string;
  owner?: string;
  repo?: string;
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  type: string;
  check_commits?: boolean;
  check_releases?: boolean;
  check_issues?: boolean;
  note?: string;
}

interface Sources {
  blogs: Source[];
  github_repos: Source[];
  changelogs: Source[];
  documentation: Source[];
  community: Source[];
}

interface Update {
  source: string;
  category: string;
  type: 'commit' | 'release' | 'blog' | 'changelog' | 'docs' | 'community';
  title: string;
  url: string;
  date: string;
  summary?: string;
  hash?: string;
  sha?: string;
  version?: string;
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  recommendation?: string;
}

interface State {
  last_check_timestamp: string;
  sources: Record<string, {
    last_hash?: string;
    last_title?: string;
    last_sha?: string;
    last_version?: string;
    last_checked: string;
  }>;
}

// Config
const HOME = homedir();
const SKILL_DIR = join(HOME, '.claude', 'skills', 'System', 'KayaUpgrade');
const STATE_DIR = join(SKILL_DIR, 'State');
const STATE_FILE = join(STATE_DIR, 'last-check.json');
const SOURCES_FILE = join(SKILL_DIR, 'sources.json');

// Parse args
const args = process.argv.slice(2);
const daysArg = args.find(a => !a.startsWith('--'));
const DAYS = daysArg ? parseInt(daysArg) : 30; // Default to 30 days for comprehensive review
const FORCE = args.includes('--force');
const LOG_DIR = join(SKILL_DIR, 'Logs');
const LOG_FILE = join(LOG_DIR, 'run-history.jsonl');

// ISC AppendLog seam: one instance reused for the run-history log.
const runHistoryLog = createAppendLog(LOG_FILE);

// Zod schema for state validation
const SourceStateSchema = z.object({
  last_hash: z.string().optional(),
  last_title: z.string().optional(),
  last_sha: z.string().optional(),
  last_version: z.string().optional(),
  last_checked: z.string(),
});

const AnthropicStateSchema = z.object({
  last_check_timestamp: z.string(),
  sources: z.record(z.string(), SourceStateSchema),
});

// StateManager instance for persistent state
const stateManager = createStateManager<State>({
  path: STATE_FILE,
  schema: AnthropicStateSchema,
  defaults: () => ({
    last_check_timestamp: new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000).toISOString(),
    sources: {}
  }),
});

// Utilities - hash function now provided by CachedHTTPClient

async function loadSources(): Promise<Sources> {
  try {
    return await loadSkillConfig<Sources>(SKILL_DIR, 'sources.json');
  } catch (error) {
    console.error('❌ Failed to load sources.json:', error);
    process.exit(1);
  }
}

async function loadState(): Promise<State> {
  try {
    return await stateManager.load();
  } catch (error) {
    console.warn('⚠️ Failed to load state, starting fresh:', error);
    return {
      last_check_timestamp: new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000).toISOString(),
      sources: {}
    };
  }
}

async function saveState(state: State): Promise<void> {
  try {
    await stateManager.save(state);
  } catch (error) {
    console.error('❌ Failed to save state:', error);
  }
}

function logRun(updatesFound: number, high: number, medium: number, low: number): void {
  try {
    const logEntry = {
      timestamp: new Date().toISOString(),
      days_checked: DAYS,
      forced: FORCE,
      updates_found: updatesFound,
      high_priority: high,
      medium_priority: medium,
      low_priority: low
    };

    runHistoryLog.append(logEntry);
  } catch (error) {
    console.warn('⚠️ Failed to log run:', error);
  }
}

function getLastRunInfo(): { days_ago: number, last_timestamp: string } | null {
  try {
    if (!existsSync(LOG_FILE)) return null;

    const logs = readFileSync(LOG_FILE, 'utf-8').trim().split('\n');
    if (logs.length === 0) return null;

    const lastLog = JSON.parse(logs[logs.length - 1]);
    const lastTime = new Date(lastLog.timestamp);
    const now = new Date();
    const daysAgo = Math.floor((now.getTime() - lastTime.getTime()) / (1000 * 60 * 60 * 24));

    return {
      days_ago: daysAgo,
      last_timestamp: lastLog.timestamp
    };
  } catch (error) {
    return null;
  }
}

// Content extraction helpers
export function extractPageHeadings(html: string): string[] {
  const navPattern = /^(menu|close|search|skip|navigation|toggle|home|about|contact|sign|log)/i;

  const extract = (tag: 'h2' | 'h3'): string[] => {
    const tagPattern = new RegExp(`<${tag}[^>]*>(.*?)<\/${tag}>`, 'gi');
    const results: string[] = [];
    let match;
    while ((match = tagPattern.exec(html)) !== null) {
      const text = match[1].replace(/<[^>]+>/g, '').trim();
      if (text.length >= 10 && !navPattern.test(text)) {
        results.push(text);
      }
    }
    return results.slice(0, 5);
  };

  const h2Results = extract('h2');
  return h2Results.length > 0 ? h2Results : extract('h3');
}

export function extractChangelogSections(html: string): Array<{ version: string; bullets: string[] }> {
  const plainText = html.replace(/<[^>]+>/g, '\n').replace(/&[^;]+;/g, ' ');
  const lines = plainText.split('\n');
  const versionPattern = /^#{0,3}\s*(v?[\d]+\.[\d]+[\w.-]*)/i;
  const sections: Array<{ version: string; bullets: string[] }> = [];

  for (let i = 0; i < lines.length && sections.length < 3; i++) {
    const versionMatch = lines[i].trim().match(versionPattern);
    if (versionMatch) {
      const bullets: string[] = [];
      for (let j = i + 1; j < lines.length && bullets.length < 5; j++) {
        const trimmed = lines[j].trim();
        if (trimmed.startsWith('-') || trimmed.startsWith('*')) {
          bullets.push(trimmed.slice(1).trim());
        } else if (versionPattern.test(trimmed)) {
          break;
        }
      }
      sections.push({ version: versionMatch[1], bullets });
    }
  }

  return sections;
}

// Fetching functions - Using CachedHTTPClient for caching, retry, and hash-based change detection
async function fetchBlog(source: Source, state: State): Promise<Update[]> {
  try {
    const stateKey = `blog_${source.name.toLowerCase().replace(/\s+/g, '_')}`;
    const lastHash = state.sources[stateKey]?.last_hash;

    // Use fetchWithHash for change detection - hash first 5KB of content
    const result = await httpClient.fetchWithHash(source.url!, lastHash, {
      cache: 'disk',
      ttl: 3600, // 1 hour cache
      retry: 2
    });

    if (result.status >= 400) {
      console.warn(`⚠️ Failed to fetch ${source.name}: ${result.status}`);
      return [];
    }

    // Hash only first 5KB for change detection consistency
    const contentForHash = result.data.substring(0, 5000);
    const contentHash = result.hash; // Hash is computed by httpClient

    if (!FORCE && !result.changed) {
      return []; // No changes
    }

    // Extract headings from HTML
    const headings = extractPageHeadings(result.data);
    const title = headings[0] || 'New content detected';

    return [{
      source: source.name,
      category: 'blog',
      type: 'blog',
      title: `${source.name}: ${title}`,
      url: source.url!,
      date: new Date().toISOString().split('T')[0],
      hash: contentHash,
      priority: source.priority,
      summary: headings.length > 0
        ? `Articles: ${headings.join(' | ')}`
        : `New content detected on ${source.name}`,
    }];

  } catch (error) {
    console.warn(`⚠️ Error fetching blog ${source.name}:`, error);
    return [];
  }
}

export function isNoiseCommit(authorName: string, message: string): boolean {
  const NOISE_PATTERNS = [
    /^chore: update changelog/i,
    /^chore\(release\)/i,
    /^build\(deps\)/i,
    /^merge pull request.*dependabot/i,
  ];
  const isBot = authorName === 'GitHub Actions' || authorName.includes('dependabot');
  return isBot && NOISE_PATTERNS.some(p => p.test(message));
}

async function fetchGitHubRepo(source: Source, state: State): Promise<Update[]> {
  const updates: Update[] = [];
  const token = process.env.GITHUB_TOKEN || '';
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'Kaya-Anthropic-Monitor'
  };
  if (token) headers['Authorization'] = `token ${token}`;

  // Set rate limit for GitHub API (5000 requests/hour with token, 60 without)
  httpClient.setRateLimit('api.github.com', token ? 80 : 1, 60000); // per minute

  try {
    // Check commits
    if (source.check_commits) {
      const since = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000).toISOString();
      const url = `https://api.github.com/repos/${source.owner}/${source.repo}/commits?since=${since}&per_page=10`;

      const commits = await httpClient.fetchJson<any[]>(url, {
        cache: 'memory',
        ttl: 300, // 5 minute cache for commits
        retry: 2,
        headers
      });

      const stateKey = `github_${source.repo}_commits`;
      const lastSha = state.sources[stateKey]?.last_sha;

      for (const commit of commits) {
        if (FORCE || commit.sha !== lastSha) {
          const commitMsg = commit.commit.message.split('\n')[0];
          const commitAuthor = commit.commit.author.name ?? '';
          // Skip bot noise (CHANGELOG updates, dependabot, etc.)
          if (isNoiseCommit(commitAuthor, commitMsg)) continue;
          updates.push({
            source: source.name,
            category: 'github',
            type: 'commit',
            title: commitMsg,
            url: commit.html_url,
            date: commit.commit.author.date.split('T')[0],
            sha: commit.sha,
            priority: source.priority,
            summary: `Commit by ${commitAuthor}`
          });
        }
        if (commit.sha === lastSha) break;
      }
    }

    // Check releases
    if (source.check_releases) {
      const url = `https://api.github.com/repos/${source.owner}/${source.repo}/releases?per_page=5`;

      const releases = await httpClient.fetchJson<any[]>(url, {
        cache: 'memory',
        ttl: 600, // 10 minute cache for releases
        retry: 2,
        headers
      });

      const stateKey = `github_${source.repo}_releases`;
      const lastVersion = state.sources[stateKey]?.last_version;

      for (const release of releases) {
        if (FORCE || release.tag_name !== lastVersion) {
          updates.push({
            source: source.name,
            category: 'github',
            type: 'release',
            title: `${release.tag_name}: ${release.name || 'New Release'}`,
            url: release.html_url,
            date: release.published_at.split('T')[0],
            version: release.tag_name,
            priority: source.priority,
            summary: release.body ?? 'See release notes'
          });
        }
        if (release.tag_name === lastVersion) break;
      }
    }

  } catch (error) {
    console.warn(`⚠️ Error fetching GitHub repo ${source.name}:`, error);
  }

  return updates;
}

async function fetchChangelog(source: Source, state: State): Promise<Update[]> {
  try {
    const stateKey = `changelog_${source.name.toLowerCase().replace(/\s+/g, '_')}`;
    const lastHash = state.sources[stateKey]?.last_hash;

    // Use fetchWithHash for change detection - hash first 3KB of content
    const result = await httpClient.fetchWithHash(source.url!, lastHash, {
      cache: 'disk',
      ttl: 3600, // 1 hour cache
      retry: 2
    });

    if (result.status >= 400) {
      console.warn(`⚠️ Failed to fetch ${source.name}: ${result.status}`);
      return [];
    }

    if (!FORCE && !result.changed) {
      return []; // No changes
    }

    // Extract version sections from changelog
    const sections = extractChangelogSections(result.data);
    const title = sections[0]?.version || 'Latest update';
    const bulletSummary = sections[0]?.bullets.slice(0, 3).join('; ') || '';

    return [{
      source: source.name,
      category: 'changelog',
      type: 'changelog',
      title: `${source.name}: ${title}`,
      url: source.url!,
      date: new Date().toISOString().split('T')[0],
      hash: result.hash,
      priority: source.priority,
      summary: bulletSummary
        ? `${title}: ${bulletSummary}`.slice(0, 250)
        : `Changelog updated with new entries`,
    }];

  } catch (error) {
    console.warn(`⚠️ Error fetching changelog ${source.name}:`, error);
    return [];
  }
}

async function fetchDocs(source: Source, state: State): Promise<Update[]> {
  try {
    const stateKey = `docs_${source.name.toLowerCase().replace(/\s+/g, '_')}`;
    const lastHash = state.sources[stateKey]?.last_hash;

    // Use fetchWithHash for change detection - hash first 3KB of content
    const result = await httpClient.fetchWithHash(source.url!, lastHash, {
      cache: 'disk',
      ttl: 3600, // 1 hour cache
      retry: 2
    });

    if (result.status >= 400) {
      console.warn(`⚠️ Failed to fetch ${source.name}: ${result.status}`);
      return [];
    }

    if (!FORCE && !result.changed) {
      return []; // No changes
    }

    const headings = extractPageHeadings(result.data);
    const title = headings[0] || 'Documentation updated';

    return [{
      source: source.name,
      category: 'documentation',
      type: 'docs',
      title: `${source.name}: ${title}`,
      url: source.url!,
      date: new Date().toISOString().split('T')[0],
      hash: result.hash,
      priority: source.priority,
      summary: headings.length > 0
        ? `Sections: ${headings.join(', ')}`.slice(0, 250)
        : 'Documentation page has been updated',
    }];

  } catch (error) {
    console.warn(`⚠️ Error fetching docs ${source.name}:`, error);
    return [];
  }
}

export async function fetchGitHubTrending(): Promise<Update[]> {
  try {
    const result = await httpClient.fetchText(
      'https://github.com/trending?since=weekly&spoken_language_code=en',
      { cache: 'disk', ttl: 3600, retry: 2 }
    );

    // Extract repo paths from trending page links
    const repoMatches = [...result.matchAll(/href="\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)"/g)];
    const repos = [...new Set(repoMatches.map(m => m[1]))]
      .filter(r => {
        if (!r.includes('/')) return false;
        const noisePrefix = /^(features|settings|sponsors|trending|apps|actions|collections|orgs|topics|explore)\//;
        return !noisePrefix.test(r);
      })
      .slice(0, 10);

    if (repos.length === 0) return [];

    return repos.map(repo => ({
      source: 'GitHub Trending',
      category: 'trending',
      type: 'community' as const,
      title: `Trending: ${repo}`,
      url: `https://github.com/${repo}`,
      date: new Date().toISOString().split('T')[0],
      priority: 'MEDIUM' as const,
      summary: '', // README fetched by Explore.ts
    }));
  } catch (error) {
    console.warn('⚠️ GitHub Trending fetch failed:', error instanceof Error ? error.message : error);
    return [];
  }
}

// Recommendation engine - Kaya ecosystem focused
function generateRecommendation(update: Update): string {
  const { source, type, title, category } = update;
  const titleLower = title.toLowerCase();

  // SKILLS - Critical for Kaya's skill system
  if (titleLower.includes('skill') || titleLower.includes('skills')) {
    return `**Kaya Impact:** CRITICAL for skills ecosystem\n` +
      `**Why:** Kaya's entire infrastructure is built on skills - any changes to skill patterns, specifications, or examples directly affect how we build and organize Kaya's capabilities.\n` +
      `**Action:** Review immediately and update Kaya's skill templates/patterns if new conventions emerge. Check if new skill categories or capabilities can be adopted.`;
  }

  // MCP - Core infrastructure
  if (titleLower.includes('mcp') || source.toLowerCase().includes('mcp')) {
    return `**Kaya Impact:** HIGH - MCP infrastructure enhancement\n` +
      `**Why:** Kaya uses MCP servers for chrome-devtools, brightdata, Ref docs, content access, and Stripe. Changes to MCP spec/docs affect our integrations.\n` +
      `**Action:** Assess compatibility with existing MCP servers in .mcp.json. Look for new MCP capabilities to expand Kaya's tooling.`;
  }

  // Commands/Slash Commands
  if (titleLower.includes('command') || titleLower.includes('slash command')) {
    return `**Kaya Impact:** HIGH - Command system update\n` +
      `**Why:** Kaya uses slash commands extensively (~/.claude/Commands/). Changes affect our command architecture and user workflows.\n` +
      `**Action:** Review for new command patterns or capabilities. Update Kaya's command templates if conventions change.`;
  }

  // Agents/Hooks
  if (titleLower.includes('agent') || titleLower.includes('hook')) {
    return `**Kaya Impact:** HIGH - Agent/Hook system change\n` +
      `**Why:** Kaya uses agents (researcher, engineer, architect, etc.) and hooks (load-context, stop-hook) as core infrastructure components.\n` +
      `**Action:** Check if this affects Kaya's agent definitions or hook configurations. Test existing agent workflows.`;
  }

  // Claude Code releases
  if (type === 'release' && source.includes('claude-code')) {
    return `**Kaya Impact:** CRITICAL - Core platform update\n` +
      `**Why:** Kaya runs on Claude Code - releases may include new features, breaking changes, or performance improvements.\n` +
      `**Action:** Review changelog carefully. Test Kaya's critical workflows. Update skills/commands if APIs changed.`;
  }

  // MCP releases
  if (type === 'release' && source.includes('MCP')) {
    return `**Kaya Impact:** HIGH - MCP protocol update\n` +
      `**Why:** MCP protocol changes may require updates to server implementations or client integrations.\n` +
      `**Action:** Check MCP server compatibility. Look for new transports, authentication methods, or capabilities to adopt.`;
  }

  // Plugin/Marketplace
  if (titleLower.includes('plugin') || titleLower.includes('marketplace')) {
    return `**Kaya Impact:** MEDIUM - Ecosystem expansion\n` +
      `**Why:** Plugin/marketplace features could provide new capabilities to integrate into Kaya's toolkit.\n` +
      `**Action:** Explore available plugins. Assess if any solve current Kaya limitations or add valuable features.`;
  }

  // Cookbooks/Quickstarts/Courses - Implementation patterns
  if (source.includes('cookbook') || source.includes('quickstart') || source.includes('courses')) {
    return `**Kaya Impact:** MEDIUM - Implementation patterns\n` +
      `**Why:** Cookbooks/examples show best practices and patterns we can adopt in Kaya's codebase.\n` +
      `**Action:** Review for reusable patterns, especially around skills, agents, or Claude Code features. Extract learnings for Kaya.`;
  }

  // GitHub commits
  if (category === 'github' && type === 'commit') {
    return `**Kaya Impact:** LOW-MEDIUM - Code pattern review\n` +
      `**Why:** Commits may reveal implementation details, bug fixes, or patterns useful for Kaya development.\n` +
      `**Action:** Skim commit for code patterns. Low priority unless it touches skills/MCP/commands directly.`;
  }

  // Documentation
  if (titleLower.includes('doc') || type === 'docs') {
    return `**Kaya Impact:** MEDIUM - Capability discovery\n` +
      `**Why:** Doc updates often reveal new features or best practices not yet in Kaya.\n` +
      `**Action:** Review for new Claude Code features, API capabilities, or configuration options to leverage.`;
  }

  // SDK releases
  if (source.includes('sdk')) {
    return `**Kaya Impact:** LOW - SDK update\n` +
      `**Why:** SDK updates are less relevant since Kaya uses Claude Code CLI, not raw API SDKs.\n` +
      `**Action:** Note for reference. Only investigate if mentions features relevant to Kaya's agent implementations.`;
  }

  // Blog posts
  if (type === 'blog') {
    return `**Kaya Impact:** LOW-MEDIUM - Awareness\n` +
      `**Why:** Blogs announce new features and directions that may eventually affect Kaya.\n` +
      `**Action:** Skim for strategic announcements about Claude Code, Skills, or MCP. Track for future planning.`;
  }

  // Generic
  return `**Kaya Impact:** LOW - General awareness\n` +
    `**Why:** May have indirect relevance to Kaya ecosystem.\n` +
    `**Action:** Review if time permits. Low impact on Kaya's core functionality.`;
}

function assessRelevance(update: Update): 'HIGH' | 'MEDIUM' | 'LOW' {
  const titleLower = update.title.toLowerCase();

  // HIGH relevance keywords
  const highKeywords = ['skill', 'mcp', 'command', 'agent', 'hook', 'breaking', 'claude code'];
  if (highKeywords.some(k => titleLower.includes(k))) {
    return 'HIGH';
  }

  // Upgrade priority for key repos
  if (update.source.includes('claude-code') || update.source.includes('MCP')) {
    if (update.type === 'release') return 'HIGH';
    if (update.priority === 'HIGH') return 'HIGH';
    return 'MEDIUM';
  }

  // LOW relevance keywords
  const lowKeywords = ['typo', 'fix typo', 'readme', 'test', 'minor'];
  if (lowKeywords.some(k => titleLower.includes(k))) {
    return 'LOW';
  }

  // Default to source priority
  return update.priority;
}

// Generate narrative analysis focused on Kaya ecosystem
function generateNarrative(updates: Update[]): string {
  const high = updates.filter(u => u.priority === 'HIGH');
  const medium = updates.filter(u => u.priority === 'MEDIUM');
  const low = updates.filter(u => u.priority === 'LOW');

  // Categorize by theme
  const skillUpdates = updates.filter(u => u.title.toLowerCase().includes('skill') || u.source.toLowerCase().includes('skill'));
  const mcpUpdates = updates.filter(u => u.title.toLowerCase().includes('mcp') || u.source.toLowerCase().includes('mcp'));
  const codeUpdates = updates.filter(u => u.source.includes('claude-code'));
  const cookbookUpdates = updates.filter(u => u.source.includes('cookbook'));
  const docUpdates = updates.filter(u => u.type === 'docs');
  const releases = updates.filter(u => u.type === 'release');

  let narrative = `## 📖 Executive Summary: What This Means for Kaya\n\n`;

  // Overall activity
  narrative += `Found **${updates.length} updates** across the Anthropic ecosystem in the monitored period. `;

  if (high.length > 0) {
    narrative += `**${high.length} are HIGH priority** for Kaya's infrastructure, `;
  }
  if (medium.length > 0) {
    narrative += `${medium.length} are MEDIUM priority, `;
  }
  if (low.length > 0) {
    narrative += `and ${low.length} are LOW priority.\n\n`;
  }

  // Key themes
  const themes: string[] = [];

  if (skillUpdates.length > 0) {
    themes.push(`**Skills Ecosystem** (${skillUpdates.length} updates)`);
  }
  if (mcpUpdates.length > 0) {
    themes.push(`**MCP Infrastructure** (${mcpUpdates.length} updates)`);
  }
  if (codeUpdates.length > 0) {
    themes.push(`**Claude Code Platform** (${codeUpdates.length} updates)`);
  }
  if (cookbookUpdates.length > 0) {
    themes.push(`**Implementation Examples** (${cookbookUpdates.length} updates)`);
  }
  if (docUpdates.length > 0) {
    themes.push(`**Documentation** (${docUpdates.length} updates)`);
  }

  if (themes.length > 0) {
    narrative += `### 🎯 Key Activity Areas\n\n`;
    themes.forEach(theme => narrative += `- ${theme}\n`);
    narrative += `\n`;
  }

  // Detailed analysis
  narrative += `### 💡 What's Happening\n\n`;

  // Skills analysis (most critical)
  if (skillUpdates.length > 0) {
    const highSkills = skillUpdates.filter(u => u.priority === 'HIGH').length;
    if (highSkills > 0) {
      narrative += `**🔥 CRITICAL: Skills System Activity**\n`;
      narrative += `There are **${highSkills} HIGH-priority skill updates** - this is BIG because Kaya's entire architecture is built on the skills system. `;
      narrative += `Any changes to skill patterns, specifications, or conventions could require updates to Kaya's ${countSkills()} existing skills. `;

      const skillsRepo = skillUpdates.some(u => u.source === 'skills');
      if (skillsRepo) {
        narrative += `The official skills repository has new activity, suggesting Anthropic is actively developing the skills ecosystem. `;
      }

      const skillDocs = skillUpdates.some(u => u.type === 'docs');
      if (skillDocs) {
        narrative += `Skills documentation has also been updated - check for new patterns or best practices. `;
      }

      narrative += `\n\n**→ Priority Action:** Review all skill updates immediately. Update Kaya's skill templates if conventions changed.\n\n`;
    } else {
      narrative += `Skills system has **${skillUpdates.length} updates** but lower priority - likely documentation or minor improvements.\n\n`;
    }
  }

  // MCP analysis (infrastructure)
  if (mcpUpdates.length > 0) {
    const highMcp = mcpUpdates.filter(u => u.priority === 'HIGH').length;
    if (highMcp > 0) {
      narrative += `**🔧 IMPORTANT: MCP Infrastructure Changes**\n`;
      narrative += `**${highMcp} HIGH-priority MCP updates** detected. Since Kaya uses MCP servers for chrome-devtools, brightdata, Ref, content, and Stripe, `;
      narrative += `protocol changes could affect our integrations. `;

      const mcpRelease = mcpUpdates.find(u => u.type === 'release');
      if (mcpRelease) {
        narrative += `There's a new MCP release (${mcpRelease.title}) - check for new capabilities or breaking changes. `;
      }

      narrative += `\n\n**→ Priority Action:** Test existing MCP servers. Look for new MCP features to expand Kaya's toolkit.\n\n`;
    } else {
      narrative += `MCP has **${mcpUpdates.length} updates** - mostly documentation or minor improvements. Still worth monitoring.\n\n`;
    }
  }

  // Claude Code analysis (platform)
  if (codeUpdates.length > 0) {
    const highCode = codeUpdates.filter(u => u.priority === 'HIGH').length;
    if (highCode > 0) {
      narrative += `**⚡ PLATFORM UPDATE: Claude Code Changes**\n`;
      narrative += `**${highCode} HIGH-priority** Claude Code updates found. Since Kaya runs on Claude Code, platform changes can affect everything. `;

      const codeRelease = codeUpdates.find(u => u.type === 'release');
      if (codeRelease) {
        narrative += `New release detected: ${codeRelease.title}. This could include new features, bug fixes, or breaking changes. `;
      }

      narrative += `\n\n**→ Priority Action:** Review changelog. Test Kaya's core workflows after updating.\n\n`;
    } else {
      narrative += `Claude Code has **${codeUpdates.length} updates** but lower priority. Likely maintenance commits.\n\n`;
    }
  }

  // Cookbooks/patterns
  if (cookbookUpdates.length > 0) {
    narrative += `**📚 Implementation Patterns**\n`;
    narrative += `**${cookbookUpdates.length} cookbook updates** - these often contain useful patterns and examples. `;
    const skillCookbooks = cookbookUpdates.filter(u => u.title.toLowerCase().includes('skill'));
    if (skillCookbooks.length > 0) {
      narrative += `${skillCookbooks.length} specifically about skills - definitely review these for patterns to adopt in Kaya. `;
    }
    narrative += `\n\n`;
  }

  // Documentation
  if (docUpdates.length > 5) {
    narrative += `**📖 Documentation Updates**\n`;
    narrative += `**${docUpdates.length} documentation pages** updated. While less urgent, docs often reveal new capabilities or best practices not yet used in Kaya.\n\n`;
  }

  // Releases summary
  if (releases.length > 0) {
    narrative += `### 🎉 Releases Summary\n\n`;
    narrative += `**${releases.length} new releases** published:\n`;
    releases.forEach(r => {
      narrative += `- ${r.source}: ${r.title}\n`;
    });
    narrative += `\n`;
  }

  // Bottom line
  narrative += `### 🎯 Bottom Line for Kaya\n\n`;

  if (high.length > 5) {
    narrative += `**High activity period** with ${high.length} high-priority changes. This suggests significant ecosystem development. `;
    narrative += `Focus on the skill and MCP updates first, then work through platform changes.\n\n`;
  } else if (high.length > 0) {
    narrative += `**Moderate activity** with ${high.length} items requiring attention. Not urgent, but should review within the week.\n\n`;
  } else {
    narrative += `**Quiet period** - mostly low-priority updates. Good time to focus on Kaya development rather than external changes.\n\n`;
  }

  // Specific call-outs
  const topItems: string[] = [];

  if (skillUpdates.filter(u => u.priority === 'HIGH').length > 0) {
    topItems.push('1. **Skills system updates** - Review immediately, may affect Kaya architecture');
  }
  if (mcpUpdates.filter(u => u.priority === 'HIGH').length > 0) {
    topItems.push('2. **MCP changes** - Test existing integrations, look for new capabilities');
  }
  if (codeUpdates.filter(u => u.priority === 'HIGH').length > 0) {
    topItems.push('3. **Claude Code platform** - Review release notes, test workflows');
  }

  if (topItems.length > 0) {
    narrative += `**Recommended Review Order:**\n`;
    topItems.forEach(item => narrative += `${item}\n`);
    narrative += `\n`;
  }

  return narrative;
}

function countSkills(): number {
  try {
    const skillsDir = join(HOME, '.claude', 'skills');
    const entries = readdirSync(skillsDir);
    return entries.filter((entry: string) => {
      try {
        return statSync(join(skillsDir, entry)).isDirectory() && !entry.startsWith('.');
      } catch {
        return false;
      }
    }).length;
  } catch {
    return 57; // Fallback based on current known count
  }
}

// Main execution
async function main() {
  console.log('🔍 Checking Anthropic sources for updates...\n');
  console.log(`📅 Date: ${new Date().toISOString().split('T')[0]}`);
  console.log(`⏰ Looking back: ${DAYS} days`);
  console.log(`🔄 Force mode: ${FORCE ? 'Yes' : 'No'}`);

  // Show last run info
  const lastRun = getLastRunInfo();
  if (lastRun) {
    console.log(`📜 Last run: ${lastRun.days_ago} days ago (${lastRun.last_timestamp.split('T')[0]})`);
  } else {
    console.log(`📜 First run - no previous history`);
  }
  console.log();

  // Load configuration and state
  const sources = await loadSources();
  const state = await loadState();

  console.log(`📊 Last state update: ${state.last_check_timestamp.split('T')[0]}\n`);
  console.log('⚡ Fetching all sources in parallel...\n');

  // Fetch all sources in parallel
  const fetchErrors: Record<string, string> = {};
  const fetchPromises: Promise<Update[]>[] = [];

  // Blogs
  for (const blog of sources.blogs) {
    fetchPromises.push(
      fetchBlog(blog, state).catch(err => {
        fetchErrors[blog.name] = err instanceof Error ? err.message : String(err);
        return [] as Update[];
      })
    );
  }

  // GitHub repos
  for (const repo of sources.github_repos) {
    fetchPromises.push(
      fetchGitHubRepo(repo, state).catch(err => {
        fetchErrors[repo.name] = err instanceof Error ? err.message : String(err);
        return [] as Update[];
      })
    );
  }

  // Changelogs
  for (const changelog of sources.changelogs) {
    fetchPromises.push(
      fetchChangelog(changelog, state).catch(err => {
        fetchErrors[changelog.name] = err instanceof Error ? err.message : String(err);
        return [] as Update[];
      })
    );
  }

  // Documentation
  for (const docs of sources.documentation) {
    fetchPromises.push(
      fetchDocs(docs, state).catch(err => {
        fetchErrors[docs.name] = err instanceof Error ? err.message : String(err);
        return [] as Update[];
      })
    );
  }

  // GitHub Trending
  fetchPromises.push(
    fetchGitHubTrending().catch(err => {
      fetchErrors['GitHub Trending'] = err instanceof Error ? err.message : String(err);
      return [] as Update[];
    })
  );

  const totalSources =
    sources.blogs.length +
    sources.github_repos.length +
    sources.changelogs.length +
    sources.documentation.length +
    1; // GitHub Trending

  // Wait for all fetches
  const allUpdatesArrays = await Promise.all(fetchPromises);
  const allUpdates = allUpdatesArrays.flat();

  const errorCount = Object.keys(fetchErrors).length;
  if (errorCount > 0) {
    console.warn(`\n⚠️ Fetch errors (${errorCount}/${totalSources}): ${Object.keys(fetchErrors).join(', ')}`);
  }
  if (totalSources > 0 && errorCount / totalSources > 0.5) {
    notifySync(`WARNING: KayaUpgrade fetch errors on ${errorCount}/${totalSources} sources`);
  }

  console.log(`✅ Fetch complete. Found ${allUpdates.length} updates.\n`);

  // Persist raw findings for AI triage (UpgradeTriage.ts reads this)
  const FindingsSchema = z.object({
    timestamp: z.string(),
    daysChecked: z.number(),
    fetchErrors: z.record(z.string(), z.string()).optional(),
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

  const findingsState = createStateManager({
    path: join(STATE_DIR, 'latest-anthropic-findings.json'),
    schema: FindingsSchema,
    defaults: () => ({ timestamp: '', daysChecked: 0, updates: [] }),
  });

  await findingsState.save({
    timestamp: new Date().toISOString(),
    daysChecked: DAYS,
    fetchErrors: Object.keys(fetchErrors).length > 0 ? fetchErrors : undefined,
    updates: allUpdates.map(u => ({
      source: u.source, category: u.category, type: u.type,
      title: u.title, url: u.url, date: u.date,
      summary: u.summary, priority: u.priority,
    })),
  });
  console.log(`💾 Raw findings persisted to State/latest-anthropic-findings.json`);

  if (allUpdates.length === 0) {
    console.log('✨ No new updates found. Everything is up to date!\n');
    console.log('📊 STATUS: All monitored sources checked, no changes detected');
    console.log('➡️ NEXT: Check again later or use --force to see all current content');
    console.log('🎯 COMPLETED: Completed Anthropic changes monitoring check');
    notifySync('Anthropic monitoring complete, no new updates found');
    return;
  }

  // Enhance updates with recommendations
  for (const update of allUpdates) {
    update.recommendation = generateRecommendation(update);
    const relevance = assessRelevance(update);
    if (relevance !== update.priority) {
      update.priority = relevance; // Override with assessed relevance
    }
  }

  // Sort by priority
  const priorityOrder = { 'HIGH': 0, 'MEDIUM': 1, 'LOW': 2 };
  allUpdates.sort((a, b) => {
    const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
    if (priorityDiff !== 0) return priorityDiff;
    return new Date(b.date).getTime() - new Date(a.date).getTime();
  });

  // Generate report
  console.log('═'.repeat(80));
  console.log('\n# 🎯 Anthropic Changes Report\n');
  console.log(`📅 Generated: ${new Date().toISOString().split('T')[0]}`);
  console.log(`📊 Period: Last ${DAYS} days`);
  console.log(`🔍 Updates found: ${allUpdates.length}\n`);

  const highPriority = allUpdates.filter(u => u.priority === 'HIGH');
  const mediumPriority = allUpdates.filter(u => u.priority === 'MEDIUM');
  const lowPriority = allUpdates.filter(u => u.priority === 'LOW');

  // Generate and display narrative analysis
  const narrative = generateNarrative(allUpdates);
  console.log(narrative);
  console.log('═'.repeat(80));
  console.log();

  // HIGH PRIORITY
  if (highPriority.length > 0) {
    console.log(`## 🔥 HIGH PRIORITY (${highPriority.length})\n`);
    for (const update of highPriority) {
      console.log(`### [${update.category.toUpperCase()}] ${update.title}\n`);
      console.log(`**Source:** ${update.source}`);
      console.log(`**Date:** ${update.date}`);
      console.log(`**Type:** ${update.type}`);
      console.log(`**Link:** ${update.url}`);
      if (update.summary) console.log(`**Summary:** ${update.summary}`);
      console.log(`\n${update.recommendation}\n`);
      console.log('---\n');
    }
  }

  // MEDIUM PRIORITY
  if (mediumPriority.length > 0) {
    console.log(`## 📌 MEDIUM PRIORITY (${mediumPriority.length})\n`);
    for (const update of mediumPriority) {
      console.log(`### [${update.category.toUpperCase()}] ${update.title}\n`);
      console.log(`**Source:** ${update.source}`);
      console.log(`**Date:** ${update.date}`);
      console.log(`**Link:** ${update.url}`);
      console.log(`\n${update.recommendation}\n`);
      console.log('---\n');
    }
  }

  // LOW PRIORITY
  if (lowPriority.length > 0) {
    console.log(`## 📝 LOW PRIORITY (${lowPriority.length})\n`);
    for (const update of lowPriority) {
      console.log(`- **${update.title}** - [View](${update.url}) - ${update.date}`);
    }
    console.log('\n');
  }

  // Community reminder
  console.log('## 💬 Community Channel\n');
  console.log('**Discord:** https://discord.com/invite/6PPFFzqPDZ');
  console.log('_(Manual check recommended - automated scraping not performed)_\n');

  console.log('═'.repeat(80));
  console.log('\n📊 STATUS: Report generated successfully');
  console.log('➡️ NEXT: Review HIGH priority items and implement relevant recommendations');
  console.log('🎯 COMPLETED: Completed comprehensive Anthropic changes monitoring\n');

  // Update state
  const newState: State = {
    last_check_timestamp: new Date().toISOString(),
    sources: { ...state.sources }
  };

  for (const update of allUpdates) {
    let stateKey = '';

    if (update.category === 'blog') {
      stateKey = `blog_${update.source.toLowerCase().replace(/\s+/g, '_')}`;
      newState.sources[stateKey] = {
        last_hash: update.hash!,
        last_title: update.title,
        last_checked: new Date().toISOString()
      };
    } else if (update.category === 'github' && update.type === 'commit') {
      stateKey = `github_${update.source.toLowerCase().replace(/\s+/g, '_')}_commits`;
      newState.sources[stateKey] = {
        last_sha: update.sha!,
        last_title: update.title,
        last_checked: new Date().toISOString()
      };
    } else if (update.category === 'github' && update.type === 'release') {
      stateKey = `github_${update.source.toLowerCase().replace(/\s+/g, '_')}_releases`;
      newState.sources[stateKey] = {
        last_version: update.version!,
        last_title: update.title,
        last_checked: new Date().toISOString()
      };
    } else if (update.category === 'changelog') {
      stateKey = `changelog_${update.source.toLowerCase().replace(/\s+/g, '_')}`;
      newState.sources[stateKey] = {
        last_hash: update.hash!,
        last_title: update.title,
        last_checked: new Date().toISOString()
      };
    } else if (update.category === 'documentation') {
      stateKey = `docs_${update.source.toLowerCase().replace(/\s+/g, '_')}`;
      newState.sources[stateKey] = {
        last_hash: update.hash!,
        last_title: update.title,
        last_checked: new Date().toISOString()
      };
    }
  }

  await saveState(newState);
  console.log('💾 State saved successfully\n');

  // Log this run
  logRun(allUpdates.length, highPriority.length, mediumPriority.length, lowPriority.length);

  // Send voice notification with summary
  notifySync(`Anthropic monitoring found ${allUpdates.length} updates, ${highPriority.length} high priority`);
}

main().catch(error => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
