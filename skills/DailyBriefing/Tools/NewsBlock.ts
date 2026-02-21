#!/usr/bin/env bun
/**
 * NewsBlock.ts - Multi-topic news aggregation
 *
 * Uses web search to fetch news for configured topics,
 * then summarizes with Inference tool.
 */

import { join } from "path";
import type { BlockResult } from "./types.ts";
import { createHTTPClient } from "../../CORE/Tools/CachedHTTPClient.ts";

export type { BlockResult };

const KAYA_HOME = process.env.KAYA_DIR || join(process.env.HOME!, ".claude");
const httpClient = createHTTPClient({ defaultTtlMs: 15 * 60 * 1000 });

interface NewsTopic {
  name: string;
  keywords: string[];
}

interface NewsArticle {
  title: string;
  source?: string;
  url?: string;
}

interface TopicNews {
  topic: string;
  articles: NewsArticle[];
}

export interface NewsBlockConfig {
  maxArticlesPerTopic?: number;
  topics?: NewsTopic[];
}

async function searchNews(query: string, maxResults: number = 3): Promise<NewsArticle[]> {
  // Use a simple web fetch approach for news
  // In production, this would use the WebSearch tool or a news API
  const articles: NewsArticle[] = [];

  try {
    // Use CachedHTTPClient instead of raw fetch()
    const searchQuery = encodeURIComponent(`${query} news today`);
    const searchUrl = `https://lite.duckduckgo.com/lite/?q=${searchQuery}`;

    const html = await httpClient.fetchText(searchUrl, {
      timeoutMs: 10000,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Kaya/1.0)" },
    });

    if (html) {
      // Extract result titles (very basic parsing)
      const titleMatches = html.matchAll(/<a[^>]*class="result-link"[^>]*>([^<]+)<\/a>/gi);
      for (const match of titleMatches) {
        if (articles.length >= maxResults) break;
        const title = match[1]?.trim();
        if (title && title.length > 10) {
          articles.push({ title });
        }
      }

      // Fallback: look for any links with news-like content
      if (articles.length === 0) {
        const linkMatches = html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([^<]{20,100})<\/a>/gi);
        for (const match of linkMatches) {
          if (articles.length >= maxResults) break;
          const linkUrl = match[1];
          const title = match[2]?.trim();
          if (title && !title.includes("DuckDuckGo") && !title.includes("Privacy")) {
            articles.push({ title, url: linkUrl });
          }
        }
      }
    }
  } catch {
    // Search failed
  }

  // If web search fails, return placeholder
  if (articles.length === 0) {
    articles.push({
      title: `No recent news found for "${query}"`,
    });
  }

  return articles;
}

async function summarizeWithInference(articles: NewsArticle[], topic: string): Promise<string> {
  // Skip summarization if no real articles
  if (articles.length === 0 || articles[0].title.includes("No recent news")) {
    return articles[0]?.title || "No news available";
  }

  // For now, just format the articles directly
  // Full implementation would use Inference.ts
  return articles.map((a) => `- ${a.title}`).join("\n");
}

export async function execute(config: NewsBlockConfig = {}): Promise<BlockResult> {
  const {
    maxArticlesPerTopic = 3,
    topics = [
      { name: "AI", keywords: ["artificial intelligence news", "LLM", "Claude AI"] },
      { name: "Local", keywords: ["your city news"] },
    ],
  } = config;

  try {
    const topicResults: TopicNews[] = [];
    let totalArticles = 0;

    // Fetch news for each topic (limit concurrency)
    for (const topic of topics.slice(0, 6)) {
      // Max 6 topics
      const query = topic.keywords[0] || topic.name;
      const articles = await searchNews(query, maxArticlesPerTopic);

      topicResults.push({
        topic: topic.name,
        articles,
      });

      totalArticles += articles.filter((a) => !a.title.includes("No recent news")).length;

      // Small delay between requests
      await new Promise((r) => setTimeout(r, 200));
    }

    // Format markdown
    let markdown = "## News\n\n";

    for (const result of topicResults) {
      markdown += `### ${result.topic}\n`;

      for (const article of result.articles) {
        if (article.url) {
          markdown += `- [${article.title}](${article.url})\n`;
        } else {
          markdown += `- ${article.title}\n`;
        }
      }

      markdown += "\n";
    }

    // Generate summary
    const summary =
      totalArticles > 0
        ? `${totalArticles} articles across ${topicResults.length} topics`
        : "No news fetched";

    return {
      blockName: "news",
      success: totalArticles > 0,
      data: { topics: topicResults, totalArticles },
      markdown,
      summary,
    };
  } catch (error) {
    return {
      blockName: "news",
      success: false,
      data: { topics: [], totalArticles: 0 },
      markdown: "## News\n\nFailed to load news.\n",
      summary: "News unavailable",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// CLI entry point
if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes("--test") || args.includes("-t")) {
    execute({
      maxArticlesPerTopic: 2,
      topics: [
        { name: "AI", keywords: ["artificial intelligence news"] },
        { name: "your city", keywords: ["your city local news"] },
      ],
    })
      .then((result) => {
        console.log("=== News Block Test ===\n");
        console.log("Success:", result.success);
        console.log("\nMarkdown:\n", result.markdown);
        console.log("\nSummary:", result.summary);
        if (result.error) console.log("\nError:", result.error);
      })
      .catch(console.error);
  } else {
    console.log("Usage: bun NewsBlock.ts --test");
  }
}
