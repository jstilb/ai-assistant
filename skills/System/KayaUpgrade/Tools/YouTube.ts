#!/usr/bin/env bun

/**
 * YouTube Channel Monitor - Check YouTube channels for new AI-related content
 *
 * Monitors configured YouTube channels for new videos and provides
 * prioritized reports of Kaya-relevant content.
 *
 * Usage:
 *   bun ~/.claude/skills/System/KayaUpgrade/Tools/YouTube.ts              # Check for new videos
 *   bun ~/.claude/skills/System/KayaUpgrade/Tools/YouTube.ts --force      # Force check all (ignore state)
 *   bun ~/.claude/skills/System/KayaUpgrade/Tools/YouTube.ts --dry-run    # Preview without updating state
 *   bun ~/.claude/skills/System/KayaUpgrade/Tools/YouTube.ts --transcript <video-id>  # Get transcript for specific video
 *
 * Configuration:
 *   - Channels: youtube-channels.json (in skill directory)
 *   - State: State/youtube-videos.json
 *
 * Dependencies:
 *   - yt-dlp (brew install yt-dlp)
 *   - LoadSkillConfig.ts for merging base + user channels
 */

import { execSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { z } from 'zod';
import { loadSkillConfig } from '../../../../lib/core/LoadSkillConfig.ts';
import { createStateManager } from '../../../../lib/core/StateManager.ts';

// Types
interface YouTubeChannel {
  name: string;
  channel_id: string; // @handle format
  url: string;
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  description?: string;
}

interface ChannelsConfig {
  channels: YouTubeChannel[];
}

interface VideoInfo {
  id: string;
  title: string;
  url: string;
  upload_date: string;
  duration: number;
  view_count?: number;
  description?: string;
}

interface ChannelState {
  last_check: string;
  seen_videos: string[]; // Keep last 100 video IDs per channel
}

interface YouTubeState {
  last_check_timestamp: string;
  channels: Record<string, ChannelState>;
}

interface NewVideo {
  channel: string;
  channel_priority: 'HIGH' | 'MEDIUM' | 'LOW';
  video: VideoInfo;
  transcript?: string;
  relevance?: 'HIGH' | 'MEDIUM' | 'LOW';
  recommendation?: string;
}

// Config
const HOME = homedir();
const SKILL_DIR = join(HOME, '.claude', 'skills', 'KayaUpgrade');
const STATE_DIR = join(SKILL_DIR, 'State');
const STATE_FILE = join(STATE_DIR, 'youtube-videos.json');
const CHANNELS_FILE = 'youtube-channels.json';
const MAX_VIDEOS_PER_CHANNEL = 5; // How many recent videos to check
const MAX_SEEN_VIDEOS = 100; // How many video IDs to keep in state per channel

// Parse args
const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const DRY_RUN = args.includes('--dry-run');
const TRANSCRIPT_MODE = args.includes('--transcript');
const TRANSCRIPT_VIDEO_ID = TRANSCRIPT_MODE ? args[args.indexOf('--transcript') + 1] : null;

// Zod schema for YouTube state validation
const ChannelStateSchema = z.object({
  last_check: z.string(),
  seen_videos: z.array(z.string()),
});

const YouTubeStateSchema = z.object({
  last_check_timestamp: z.string(),
  channels: z.record(z.string(), ChannelStateSchema),
});

// StateManager instance for YouTube state
const youtubeStateManager = createStateManager<YouTubeState>({
  path: STATE_FILE,
  schema: YouTubeStateSchema,
  defaults: () => ({
    last_check_timestamp: new Date(0).toISOString(),
    channels: {}
  }),
});

// Utilities
function ensureDir(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

async function loadChannels(): Promise<YouTubeChannel[]> {
  try {
    const config = await loadSkillConfig<ChannelsConfig>(SKILL_DIR, CHANNELS_FILE);
    return config.channels || [];
  } catch (error) {
    console.error('❌ Failed to load YouTube channels config:', error);
    return [];
  }
}

async function loadState(): Promise<YouTubeState> {
  try {
    return await youtubeStateManager.load();
  } catch (error) {
    console.warn('⚠️ Failed to load YouTube state, starting fresh:', error);
    return {
      last_check_timestamp: new Date(0).toISOString(),
      channels: {}
    };
  }
}

async function saveState(state: YouTubeState): Promise<void> {
  if (DRY_RUN) {
    console.log('🔍 [DRY RUN] Would save state (skipped)');
    return;
  }

  try {
    await youtubeStateManager.save(state);
  } catch (error) {
    console.error('❌ Failed to save YouTube state:', error);
  }
}

/**
 * Check if yt-dlp is installed
 */
function checkYtDlp(): boolean {
  try {
    execSync('which yt-dlp', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetch recent videos from a YouTube channel using yt-dlp
 */
function fetchRecentVideos(channel: YouTubeChannel): VideoInfo[] {
  const videos: VideoInfo[] = [];

  try {
    // Use yt-dlp to get flat playlist (video metadata only, no download)
    const channelUrl = channel.url.includes('/videos')
      ? channel.url
      : `${channel.url}/videos`;

    const result = spawnSync('yt-dlp', [
      '--flat-playlist',
      '--dump-json',
      '--playlist-end', String(MAX_VIDEOS_PER_CHANNEL),
      '--no-warnings',
      channelUrl
    ], {
      encoding: 'utf-8',
      timeout: 60000, // 1 minute timeout
      maxBuffer: 10 * 1024 * 1024 // 10MB buffer
    });

    if (result.error) {
      console.warn(`⚠️ Error fetching ${channel.name}:`, result.error.message);
      return videos;
    }

    if (result.status !== 0) {
      // Non-zero exit but might still have partial output
      if (!result.stdout) {
        console.warn(`⚠️ Failed to fetch ${channel.name}: exit code ${result.status}`);
        return videos;
      }
    }

    // Parse each line as separate JSON object
    const lines = (result.stdout || '').trim().split('\n').filter(Boolean);

    for (const line of lines) {
      try {
        const data = JSON.parse(line);
        videos.push({
          id: data.id,
          title: data.title || 'Unknown Title',
          url: data.url || `https://www.youtube.com/watch?v=${data.id}`,
          upload_date: data.upload_date || '',
          duration: data.duration || 0,
          view_count: data.view_count,
          description: data.description?.substring(0, 500)
        });
      } catch {
        // Skip malformed JSON lines
      }
    }

  } catch (error) {
    console.warn(`⚠️ Error fetching ${channel.name}:`, error);
  }

  return videos;
}

/**
 * Filter videos to only new ones based on state
 */
function filterNewVideos(
  channel: YouTubeChannel,
  videos: VideoInfo[],
  state: YouTubeState
): VideoInfo[] {
  if (FORCE) {
    return videos;
  }

  const channelState = state.channels[channel.channel_id];
  if (!channelState) {
    return videos; // All videos are new if no state exists
  }

  const seenSet = new Set(channelState.seen_videos);
  return videos.filter(v => !seenSet.has(v.id));
}

/**
 * Extract transcript for a video using fabric (via GetTranscript)
 */
function extractTranscript(videoUrl: string): string | null {
  try {
    const transcriptTool = join(HOME, '.claude', 'skills', 'CORE', 'Tools', 'GetTranscript.ts');

    if (!existsSync(transcriptTool)) {
      console.warn('⚠️ GetTranscript.ts not found, skipping transcript extraction');
      return null;
    }

    const result = execSync(`bun "${transcriptTool}" "${videoUrl}"`, {
      encoding: 'utf-8',
      timeout: 120000, // 2 minute timeout
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // Extract just the transcript content
    const match = result.match(/--- TRANSCRIPT START ---\n([\s\S]*?)\n--- TRANSCRIPT END ---/);
    if (match) {
      return match[1].trim();
    }

    // If no markers, return the raw output (might be direct transcript)
    return result.trim() || null;

  } catch (error) {
    console.warn(`⚠️ Failed to extract transcript:`, error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * Assess relevance of a video for Kaya based on title and description
 */
function assessRelevance(video: VideoInfo): 'HIGH' | 'MEDIUM' | 'LOW' {
  const text = `${video.title} ${video.description || ''}`.toLowerCase();

  // HIGH relevance keywords
  const highKeywords = [
    'claude code', 'claude-code', 'anthropic', 'mcp', 'model context protocol',
    'ai agent', 'ai agents', 'skill system', 'agentic', 'prompt engineering',
    'claude 3', 'claude opus', 'claude sonnet', 'ai coding', 'ai programming'
  ];

  // MEDIUM relevance keywords
  const mediumKeywords = [
    'llm', 'large language model', 'ai assistant', 'chatgpt', 'gpt-4',
    'automation', 'ai workflow', 'typescript', 'cli tool', 'developer tools',
    'ai api', 'openai', 'gemini', 'llama', 'ai development'
  ];

  if (highKeywords.some(k => text.includes(k))) {
    return 'HIGH';
  }

  if (mediumKeywords.some(k => text.includes(k))) {
    return 'MEDIUM';
  }

  return 'LOW';
}

/**
 * Generate recommendation for a video based on its content
 */
function generateRecommendation(video: VideoInfo, channelName: string): string {
  const relevance = assessRelevance(video);
  const titleLower = video.title.toLowerCase();

  // Check for specific topic areas
  if (titleLower.includes('claude code') || titleLower.includes('claude-code')) {
    return `**Kaya Impact:** CRITICAL - Direct Claude Code content\n` +
      `**Why:** This video covers Claude Code directly - check for new features, patterns, or workflows.\n` +
      `**Action:** Watch or review transcript immediately. Update Kaya if new capabilities discovered.`;
  }

  if (titleLower.includes('mcp') || titleLower.includes('model context protocol')) {
    return `**Kaya Impact:** HIGH - MCP infrastructure content\n` +
      `**Why:** Kaya uses MCP servers - new MCP patterns or servers could enhance capabilities.\n` +
      `**Action:** Review for new MCP server ideas or integration patterns.`;
  }

  if (titleLower.includes('agent') || titleLower.includes('agentic')) {
    return `**Kaya Impact:** HIGH - Agent patterns\n` +
      `**Why:** Agent orchestration and patterns directly applicable to Kaya's agent system.\n` +
      `**Action:** Review for agent patterns, orchestration techniques, or new approaches.`;
  }

  if (titleLower.includes('anthropic') || titleLower.includes('claude')) {
    return `**Kaya Impact:** HIGH - Anthropic/Claude content\n` +
      `**Why:** Official or detailed Claude content may reveal features or best practices.\n` +
      `**Action:** Review for new Claude capabilities or API features to leverage.`;
  }

  if (relevance === 'HIGH') {
    return `**Kaya Impact:** HIGH - Relevant AI development content\n` +
      `**Why:** Matches Kaya's focus areas based on keywords.\n` +
      `**Action:** Review transcript or watch video for applicable patterns.`;
  }

  if (relevance === 'MEDIUM') {
    return `**Kaya Impact:** MEDIUM - General AI/dev content\n` +
      `**Why:** May contain useful patterns or insights.\n` +
      `**Action:** Skim transcript for relevant sections. Lower priority.`;
  }

  return `**Kaya Impact:** LOW - General awareness\n` +
    `**Why:** From monitored channel but topic less directly relevant.\n` +
    `**Action:** Review if time permits. Good for staying informed.`;
}

/**
 * Format duration as human-readable string
 */
function formatDuration(seconds: number): string {
  if (!seconds) return 'N/A';
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins >= 60) {
    const hours = Math.floor(mins / 60);
    const remainingMins = mins % 60;
    return `${hours}h ${remainingMins}m`;
  }
  return `${mins}m ${secs}s`;
}

/**
 * Format upload date
 */
function formatDate(dateStr: string): string {
  if (!dateStr || dateStr.length !== 8) return dateStr || 'Unknown';
  // Format: YYYYMMDD -> YYYY-MM-DD
  return `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
}

/**
 * Update state with newly seen videos
 */
function updateState(
  state: YouTubeState,
  channel: YouTubeChannel,
  videos: VideoInfo[]
): void {
  if (!state.channels[channel.channel_id]) {
    state.channels[channel.channel_id] = {
      last_check: new Date().toISOString(),
      seen_videos: []
    };
  }

  const channelState = state.channels[channel.channel_id];
  channelState.last_check = new Date().toISOString();

  // Add new video IDs
  for (const video of videos) {
    if (!channelState.seen_videos.includes(video.id)) {
      channelState.seen_videos.unshift(video.id);
    }
  }

  // Trim to max size
  if (channelState.seen_videos.length > MAX_SEEN_VIDEOS) {
    channelState.seen_videos = channelState.seen_videos.slice(0, MAX_SEEN_VIDEOS);
  }

  state.last_check_timestamp = new Date().toISOString();
}

// Main execution
async function main() {
  // Handle transcript mode
  if (TRANSCRIPT_MODE) {
    if (!TRANSCRIPT_VIDEO_ID) {
      console.error('❌ Video ID required for --transcript mode');
      process.exit(1);
    }

    const url = TRANSCRIPT_VIDEO_ID.startsWith('http')
      ? TRANSCRIPT_VIDEO_ID
      : `https://www.youtube.com/watch?v=${TRANSCRIPT_VIDEO_ID}`;

    console.log(`📝 Extracting transcript for: ${url}`);
    const transcript = extractTranscript(url);

    if (transcript) {
      console.log('\n--- TRANSCRIPT ---\n');
      console.log(transcript);
      console.log('\n--- END TRANSCRIPT ---\n');
    } else {
      console.error('❌ No transcript available');
      process.exit(1);
    }
    return;
  }

  console.log('📺 YouTube Channel Monitor\n');
  console.log(`📅 Date: ${new Date().toISOString().split('T')[0]}`);
  console.log(`🔄 Force mode: ${FORCE ? 'Yes' : 'No'}`);
  console.log(`🔍 Dry run: ${DRY_RUN ? 'Yes' : 'No'}`);
  console.log();

  // Check yt-dlp
  if (!checkYtDlp()) {
    console.error('❌ yt-dlp not found. Install with: brew install yt-dlp');
    process.exit(1);
  }

  // Load channels and state
  const channels = await loadChannels();
  const state = await loadState();

  if (channels.length === 0) {
    console.log('⚠️ No YouTube channels configured.');
    console.log('');
    console.log('To add channels:');
    console.log('Edit youtube-channels.json in the skill directory');
    console.log('');
    console.log('Example format:');
    console.log(JSON.stringify({
      channels: [{
        name: "AI Explained",
        channel_id: "@aiexplained-official",
        url: "https://www.youtube.com/@aiexplained-official",
        priority: "HIGH",
        description: "Deep dives on AI papers and developments"
      }]
    }, null, 2));
    return;
  }

  console.log(`📡 Monitoring ${channels.length} channel(s):`);
  channels.forEach(c => console.log(`   - ${c.name} (${c.priority})`));
  console.log();

  // Fetch and process each channel
  const allNewVideos: NewVideo[] = [];

  for (const channel of channels) {
    console.log(`🔍 Checking ${channel.name}...`);

    const videos = fetchRecentVideos(channel);
    console.log(`   Found ${videos.length} recent video(s)`);

    const newVideos = filterNewVideos(channel, videos, state);
    console.log(`   ${newVideos.length} new video(s)`);

    for (const video of newVideos) {
      const relevance = assessRelevance(video);
      const recommendation = generateRecommendation(video, channel.name);

      allNewVideos.push({
        channel: channel.name,
        channel_priority: channel.priority,
        video,
        relevance,
        recommendation
      });
    }

    // Update state for this channel
    updateState(state, channel, videos);
  }

  // Save state
  await saveState(state);

  // Persist raw findings for AI triage (UpgradeTriage.ts reads this)
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

  const findingsState = createStateManager({
    path: join(STATE_DIR, 'latest-youtube-findings.json'),
    schema: YouTubeFindingsSchema,
    defaults: () => ({ timestamp: '', videos: [] }),
  });

  await findingsState.save({
    timestamp: new Date().toISOString(),
    videos: allNewVideos.map(v => ({
      channel: v.channel,
      videoId: v.video.id,
      title: v.video.title,
      url: v.video.url,
      duration: v.video.duration,
      relevance: v.relevance || 'LOW',
    })),
  });
  console.log(`💾 Raw findings persisted to State/latest-youtube-findings.json`);

  console.log();

  // Generate report
  if (allNewVideos.length === 0) {
    console.log('✨ No new videos found. All channels up to date!\n');
    console.log('📊 STATUS: All monitored YouTube channels checked, no new content');
    console.log('➡️ NEXT: Check again later or use --force to see recent videos');
    return;
  }

  // Sort by relevance then channel priority
  const priorityOrder = { 'HIGH': 0, 'MEDIUM': 1, 'LOW': 2 };
  allNewVideos.sort((a, b) => {
    const relevanceDiff = priorityOrder[a.relevance || 'LOW'] - priorityOrder[b.relevance || 'LOW'];
    if (relevanceDiff !== 0) return relevanceDiff;
    return priorityOrder[a.channel_priority] - priorityOrder[b.channel_priority];
  });

  console.log('═'.repeat(80));
  console.log('\n# 🎬 New YouTube Videos Report\n');
  console.log(`📅 Generated: ${new Date().toISOString().split('T')[0]}`);
  console.log(`📺 Videos found: ${allNewVideos.length}\n`);

  const highRelevance = allNewVideos.filter(v => v.relevance === 'HIGH');
  const mediumRelevance = allNewVideos.filter(v => v.relevance === 'MEDIUM');
  const lowRelevance = allNewVideos.filter(v => v.relevance === 'LOW');

  // HIGH RELEVANCE
  if (highRelevance.length > 0) {
    console.log(`## 🔥 HIGH RELEVANCE (${highRelevance.length})\n`);
    for (const item of highRelevance) {
      console.log(`### ${item.video.title}\n`);
      console.log(`**Channel:** ${item.channel}`);
      console.log(`**Date:** ${formatDate(item.video.upload_date)}`);
      console.log(`**Duration:** ${formatDuration(item.video.duration)}`);
      console.log(`**Link:** ${item.video.url}`);
      if (item.video.view_count) {
        console.log(`**Views:** ${item.video.view_count.toLocaleString()}`);
      }
      console.log(`\n${item.recommendation}\n`);
      console.log('---\n');
    }
  }

  // MEDIUM RELEVANCE
  if (mediumRelevance.length > 0) {
    console.log(`## 📌 MEDIUM RELEVANCE (${mediumRelevance.length})\n`);
    for (const item of mediumRelevance) {
      console.log(`### ${item.video.title}\n`);
      console.log(`**Channel:** ${item.channel}`);
      console.log(`**Date:** ${formatDate(item.video.upload_date)}`);
      console.log(`**Duration:** ${formatDuration(item.video.duration)}`);
      console.log(`**Link:** ${item.video.url}`);
      console.log(`\n${item.recommendation}\n`);
      console.log('---\n');
    }
  }

  // LOW RELEVANCE
  if (lowRelevance.length > 0) {
    console.log(`## 📝 LOW RELEVANCE (${lowRelevance.length})\n`);
    for (const item of lowRelevance) {
      console.log(`- **${item.video.title}** (${item.channel}) - [Watch](${item.video.url}) - ${formatDate(item.video.upload_date)}`);
    }
    console.log('\n');
  }

  console.log('═'.repeat(80));
  console.log('\n📊 STATUS: YouTube monitoring complete');
  console.log(`✅ Found ${allNewVideos.length} new video(s) across ${channels.length} channel(s)`);
  console.log('➡️ NEXT: Review HIGH relevance videos first. Use --transcript <video-id> for transcripts.');
  console.log();
}

main().catch(error => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
