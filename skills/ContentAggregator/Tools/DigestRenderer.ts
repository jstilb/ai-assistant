#!/usr/bin/env bun
/**
 * DigestRenderer.ts - Markdown Digest Renderer
 *
 * Formats scored content items into clean, readable Markdown digests.
 * Saves to MEMORY/DIGESTS/{date}.md. Also exports a BlockResult-compatible
 * function for DailyBriefing News block integration.
 *
 * CLI Usage:
 *   bun DigestRenderer.ts                       Generate today's digest
 *   bun DigestRenderer.ts --preview             Preview without saving
 *   bun DigestRenderer.ts --limit 15            Limit items
 *   bun DigestRenderer.ts --json                JSON output
 */

import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import type { ContentItem } from "./types.ts";
import { DIGESTS_DIR, KAYA_HOME } from "./types.ts";

// ============================================================================
// BlockResult interface (compatible with DailyBriefing)
// ============================================================================

export interface BlockResult {
  blockName: string;
  success: boolean;
  data: Record<string, unknown>;
  markdown: string;
  summary: string;
  error?: string;
}

// ============================================================================
// Rendering Functions
// ============================================================================

/**
 * Group items by their primary topic
 */
function groupByTopic(items: ContentItem[]): Map<string, ContentItem[]> {
  const groups = new Map<string, ContentItem[]>();

  for (const item of items) {
    // Use first matched topic, or first tag, or "General"
    const topic = item.topics[0] || item.tags[0] || "general";
    const displayTopic = formatTopicName(topic);

    if (!groups.has(displayTopic)) {
      groups.set(displayTopic, []);
    }
    groups.get(displayTopic)!.push(item);
  }

  return groups;
}

/**
 * Format topic ID into display name
 */
function formatTopicName(topic: string): string {
  const nameMap: Record<string, string> = {
    "ai-ml": "AI & Machine Learning",
    "writing-craft": "Writing & Storytelling",
    "security-privacy": "Security & Privacy",
    "san-diego": "San Diego",
    "startup-entrepreneurship": "Startups & Entrepreneurship",
    "philosophy-psychology": "Philosophy & Psychology",
    "creative-process": "Creative Process",
    "tech-industry": "Technology",
    "ai": "AI & Machine Learning",
    "tech": "Technology",
    "security": "Security",
    "writing": "Writing",
    "sandiego": "San Diego",
    "local": "Local News",
    "startup": "Startups",
    "philosophy": "Philosophy",
    "creativity": "Creative Process",
    "ml": "Machine Learning",
    "programming": "Programming",
    "general": "General",
  };

  return nameMap[topic.toLowerCase()] || topic.charAt(0).toUpperCase() + topic.slice(1);
}

/**
 * Format a relative time string
 */
function relativeTime(isoDate: string): string {
  const now = Date.now();
  const then = new Date(isoDate).getTime();
  const diffMs = now - then;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  return new Date(isoDate).toLocaleDateString();
}

/**
 * Render a full Markdown digest from scored items
 */
export function renderDigest(
  items: ContentItem[],
  options: { title?: string; maxPerTopic?: number; showScores?: boolean } = {}
): string {
  const { title, maxPerTopic = 5, showScores = false } = options;
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const timeStr = now.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });

  const digestTitle = title || `Content Digest - ${dateStr}`;

  let md = `# ${digestTitle}\n\n`;
  md += `*Generated ${dateStr} at ${timeStr} | ${items.length} items*\n\n`;
  md += `---\n\n`;

  if (items.length === 0) {
    md += `No new content collected. Check source health with:\n`;
    md += `\`\`\`\nbun ~/.claude/skills/ContentAggregator/Tools/SourceManager.ts --health\n\`\`\`\n`;
    return md;
  }

  // Group and render by topic
  const groups = groupByTopic(items);

  // Sort groups by highest-scoring item
  const sortedGroups = [...groups.entries()].sort((a, b) => {
    const aMax = Math.max(...a[1].map((i) => i.relevanceScore));
    const bMax = Math.max(...b[1].map((i) => i.relevanceScore));
    return bMax - aMax;
  });

  for (const [topicName, topicItems] of sortedGroups) {
    const displayItems = topicItems
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, maxPerTopic);

    md += `## ${topicName}\n\n`;

    for (const item of displayItems) {
      const score = showScores ? ` [${item.relevanceScore}]` : "";
      const time = relativeTime(item.publishedAt);
      const author = item.author ? ` | ${item.author}` : "";

      // Use canonical URL for display (strips UTM params, www, etc.)
      const displayUrl = item.canonicalUrl || item.url;
      md += `### [${item.title}](${displayUrl})${score}\n`;
      md += `*${time}${author}*\n\n`;

      // Show body excerpt if available
      if (item.body && item.body.length > 0) {
        const excerpt = item.body.slice(0, 200).trim();
        const ellipsis = item.body.length > 200 ? "..." : "";
        md += `> ${excerpt}${ellipsis}\n\n`;
      }

      // Show tags
      if (item.tags.length > 0) {
        const uniqueTags = [...new Set(item.tags)].slice(0, 5);
        md += `Tags: ${uniqueTags.map((t) => `\`${t}\``).join(" ")}\n\n`;
      }
    }

    md += `---\n\n`;
  }

  // Footer
  md += `*Collected from ${new Set(items.map((i) => i.sourceId)).size} sources | `;
  md += `Powered by Kaya ContentAggregator*\n`;

  return md;
}

/**
 * Render a compact digest (for Telegram or DailyBriefing)
 */
export function renderCompactDigest(items: ContentItem[], maxItems = 10): string {
  const topItems = items
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, maxItems);

  if (topItems.length === 0) {
    return "No new content today.";
  }

  let md = "";
  const groups = groupByTopic(topItems);

  for (const [topicName, topicItems] of groups) {
    md += `**${topicName}**\n`;
    for (const item of topicItems.slice(0, 3)) {
      md += `- [${item.title}](${item.canonicalUrl || item.url})\n`;
    }
    md += `\n`;
  }

  return md.trim();
}

/**
 * Generate a BlockResult for DailyBriefing News block integration
 */
export function generateNewsBlock(items: ContentItem[]): BlockResult {
  const topItems = items
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, 15);

  if (topItems.length === 0) {
    return {
      blockName: "news",
      success: false,
      data: { topics: [], totalArticles: 0 },
      markdown: "## News\n\nNo content collected. Run content collection first.\n",
      summary: "No news available",
    };
  }

  const groups = groupByTopic(topItems);
  let markdown = "## News\n\n";

  const topicResults: Array<{ topic: string; articles: Array<{ title: string; url: string }> }> = [];

  for (const [topicName, topicItems] of groups) {
    markdown += `### ${topicName}\n`;
    const articles: Array<{ title: string; url: string }> = [];

    for (const item of topicItems.slice(0, 3)) {
      const url = item.canonicalUrl || item.url;
      markdown += `- [${item.title}](${url})\n`;
      articles.push({ title: item.title, url });
    }
    markdown += "\n";

    topicResults.push({ topic: topicName, articles });
  }

  const totalArticles = topItems.length;
  const summary = `${totalArticles} articles across ${groups.size} topics`;

  return {
    blockName: "news",
    success: true,
    data: { topics: topicResults, totalArticles },
    markdown,
    summary,
  };
}

/**
 * Save digest to MEMORY/DIGESTS/
 */
export async function saveDigest(markdown: string, filename?: string): Promise<string> {
  if (!existsSync(DIGESTS_DIR)) {
    mkdirSync(DIGESTS_DIR, { recursive: true });
  }

  const date = new Date().toISOString().slice(0, 10);
  const time = new Date().toISOString().slice(11, 16).replace(":", "");
  const name = filename || `${date}-${time}-digest.md`;
  const path = join(DIGESTS_DIR, name);

  writeFileSync(path, markdown, "utf-8");
  return path;
}

// ============================================================================
// CLI Interface
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const hasFlag = (name: string) => args.includes(name);
  const getArg = (name: string): string | undefined => {
    const idx = args.indexOf(name);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : undefined;
  };

  if (hasFlag("--help")) {
    console.log(`
DigestRenderer - Render content digests

Usage:
  bun DigestRenderer.ts                       Generate and save digest
  bun DigestRenderer.ts --preview             Preview without saving
  bun DigestRenderer.ts --limit 15            Limit items
  bun DigestRenderer.ts --scores              Show relevance scores
  bun DigestRenderer.ts --compact             Compact format (for Telegram)
  bun DigestRenderer.ts --news-block          Generate DailyBriefing news block
  bun DigestRenderer.ts --json                JSON output
`);
    return;
  }

  // Import ContentStore to get items
  const { getRecentItems, getTodaysItems, getUndeliveredItems } = await import("./ContentStore.ts");

  const limit = parseInt(getArg("--limit") || "20");
  const items = hasFlag("--today")
    ? await getTodaysItems()
    : await getUndeliveredItems(limit);

  if (hasFlag("--news-block")) {
    const block = generateNewsBlock(items);
    if (hasFlag("--json")) {
      console.log(JSON.stringify(block, null, 2));
    } else {
      console.log(block.markdown);
    }
    return;
  }

  if (hasFlag("--compact")) {
    const compact = renderCompactDigest(items, limit);
    console.log(compact);
    return;
  }

  const markdown = renderDigest(items, {
    maxPerTopic: Math.min(limit, 5),
    showScores: hasFlag("--scores"),
  });

  if (hasFlag("--preview")) {
    console.log(markdown);
    return;
  }

  if (hasFlag("--json")) {
    console.log(JSON.stringify({
      itemCount: items.length,
      markdown,
    }, null, 2));
    return;
  }

  // Save digest
  const path = await saveDigest(markdown);
  console.log(`Digest saved to: ${path}`);
  console.log(`Items: ${items.length}`);
  console.log();
  console.log(markdown);
}

if (import.meta.main) {
  main().catch(console.error);
}
