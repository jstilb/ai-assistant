#!/usr/bin/env bun
/**
 * TopicMatcher.ts - Keyword-Based Topic Matching & Relevance Pre-Filter
 *
 * Phase 1 implementation: Pure keyword matching against TopicProfiles.
 * No AI scoring yet -- that comes in Phase 2 with RelevanceScorer.
 *
 * Scoring formula:
 *   - Topic keyword match: 40 points (multiple topics stack diminishingly)
 *   - Source trust score:   15 points (scaled from 0-100 to 0-15)
 *   - Recency:              10 points (exponential decay over 48 hours)
 *   - Tag overlap:          10 points (source tags matching topic keywords)
 *   - Title keyword density: 25 points (% of title words matching keywords)
 *
 * CLI Usage:
 *   bun TopicMatcher.ts --test                Run self-test
 */

import type { ContentItem, TopicProfile } from "./types.ts";

// ============================================================================
// Default Topic Profiles
// ============================================================================

export const DEFAULT_TOPIC_PROFILES: TopicProfile[] = [
  {
    id: "ai-ml",
    name: "AI & Machine Learning",
    keywords: [
      "artificial intelligence", "machine learning", "deep learning", "llm",
      "large language model", "claude", "gpt", "anthropic", "openai",
      "neural network", "transformer", "ai safety", "alignment",
      "ai agent", "generative ai", "reasoning", "inference",
      "foundation model", "multimodal", "agi", "superintelligence",
    ],
    goalIds: ["G28"],
    priority: "high",
    minRelevanceThreshold: 30,
  },
  {
    id: "writing-craft",
    name: "Writing & Storytelling",
    keywords: [
      "writing", "storytelling", "narrative", "craft", "fiction",
      "creative writing", "novel", "short story", "prose",
      "editing", "publishing", "author", "writer", "plot",
      "character development", "worldbuilding", "screenplay",
    ],
    goalIds: [],
    priority: "high",
    minRelevanceThreshold: 30,
  },
  {
    id: "security-privacy",
    name: "Security & Privacy",
    keywords: [
      "cybersecurity", "security", "privacy", "infosec",
      "vulnerability", "exploit", "hacking", "breach",
      "encryption", "zero-day", "malware", "ransomware",
      "data protection", "surveillance", "opsec",
      "authentication", "authorization", "pentest",
    ],
    goalIds: [],
    priority: "medium",
    minRelevanceThreshold: 35,
  },
  {
    id: "san-diego",
    name: "San Diego Local",
    keywords: [
      "san diego", "sd", "north county", "encinitas",
      "carlsbad", "oceanside", "del mar", "la jolla",
      "gaslamp", "balboa", "padres", "chargers",
      "ucsd", "sdsu", "san diego county",
    ],
    goalIds: [],
    priority: "medium",
    minRelevanceThreshold: 25,
  },
  {
    id: "startup-entrepreneurship",
    name: "Startup & Entrepreneurship",
    keywords: [
      "startup", "entrepreneur", "founder", "venture capital",
      "funding", "bootstrap", "saas", "product market fit",
      "growth", "scale", "business model", "revenue",
      "acquisition", "ipo", "pitch", "investor",
    ],
    goalIds: [],
    priority: "medium",
    minRelevanceThreshold: 35,
  },
  {
    id: "philosophy-psychology",
    name: "Philosophy & Psychology",
    keywords: [
      "philosophy", "psychology", "consciousness", "stoicism",
      "meditation", "mindfulness", "cognitive", "behavioral",
      "mental model", "decision making", "bias", "heuristic",
      "existential", "meaning", "purpose", "wisdom",
      "first principles", "critical thinking",
    ],
    goalIds: [],
    priority: "low",
    minRelevanceThreshold: 40,
  },
  {
    id: "creative-process",
    name: "Creative Process",
    keywords: [
      "creativity", "creative process", "inspiration", "innovation",
      "artistic", "design thinking", "flow state", "maker",
      "craft", "practice", "mastery", "deliberate practice",
      "music production", "beat making", "songwriting",
    ],
    goalIds: [],
    priority: "low",
    minRelevanceThreshold: 40,
  },
  {
    id: "tech-industry",
    name: "Technology Industry",
    keywords: [
      "tech industry", "silicon valley", "big tech", "apple",
      "google", "meta", "microsoft", "amazon", "typescript",
      "programming", "software engineering", "developer",
      "open source", "api", "cloud", "distributed systems",
    ],
    goalIds: [],
    priority: "low",
    minRelevanceThreshold: 40,
  },
];

// ============================================================================
// Scoring Functions
// ============================================================================

/**
 * Score a content item against all topic profiles
 */
export function scoreItem(
  item: ContentItem,
  profiles: TopicProfile[] = DEFAULT_TOPIC_PROFILES,
  sourceTrustScore = 70
): { score: number; matchedTopics: string[]; matchedGoals: string[] } {
  let totalScore = 0;
  const matchedTopics: string[] = [];
  const matchedGoals: string[] = [];

  // Combine text for matching
  const searchText = `${item.title} ${item.body} ${item.tags.join(" ")}`.toLowerCase();
  const titleLower = item.title.toLowerCase();

  // 1. Topic keyword matching (40 points max)
  let topicScore = 0;
  let topicMatchCount = 0;

  for (const profile of profiles) {
    const matchedKeywords = profile.keywords.filter((kw) =>
      searchText.includes(kw.toLowerCase())
    );

    if (matchedKeywords.length > 0) {
      matchedTopics.push(profile.id);
      matchedGoals.push(...profile.goalIds);

      // Diminishing returns for multiple topic matches
      const topicContribution = Math.min(
        20,
        matchedKeywords.length * (profile.priority === "high" ? 8 : profile.priority === "medium" ? 5 : 3)
      );

      topicScore += topicContribution / (1 + topicMatchCount * 0.3);
      topicMatchCount++;
    }
  }

  totalScore += Math.min(40, topicScore);

  // 2. Source trust score (15 points max)
  totalScore += (sourceTrustScore / 100) * 15;

  // 3. Recency (10 points max) - exponential decay over 48 hours
  const ageMs = Date.now() - new Date(item.publishedAt).getTime();
  const ageHours = ageMs / (1000 * 60 * 60);
  const recencyScore = Math.max(0, 10 * Math.exp(-ageHours / 24));
  totalScore += recencyScore;

  // 4. Tag overlap (10 points max)
  const allKeywords = new Set(
    profiles.flatMap((p) => p.keywords.map((k) => k.toLowerCase()))
  );
  const matchingTags = item.tags.filter((t) =>
    allKeywords.has(t.toLowerCase())
  );
  totalScore += Math.min(10, matchingTags.length * 3);

  // 5. Title keyword density (25 points max)
  const titleWords = titleLower.split(/\s+/).filter((w) => w.length > 2);
  if (titleWords.length > 0) {
    const matchingTitleWords = titleWords.filter((word) => {
      for (const kw of allKeywords) {
        if (kw.includes(word) || word.includes(kw)) return true;
      }
      return false;
    });
    const density = matchingTitleWords.length / titleWords.length;
    totalScore += Math.min(25, density * 40);
  }

  return {
    score: Math.round(Math.min(100, Math.max(0, totalScore))),
    matchedTopics: [...new Set(matchedTopics)],
    matchedGoals: [...new Set(matchedGoals)],
  };
}

/**
 * Score and filter a batch of items
 */
export function scoreAndFilter(
  items: ContentItem[],
  profiles: TopicProfile[] = DEFAULT_TOPIC_PROFILES,
  sourceTrustScores: Map<string, number> = new Map(),
  minScore = 20
): ContentItem[] {
  return items
    .map((item) => {
      const trustScore = sourceTrustScores.get(item.sourceId) || 70;
      const { score, matchedTopics, matchedGoals } = scoreItem(
        item,
        profiles,
        trustScore
      );

      return {
        ...item,
        relevanceScore: score,
        topics: matchedTopics,
        goalAlignment: matchedGoals,
        status: "scored" as const,
      };
    })
    .filter((item) => item.relevanceScore >= minScore)
    .sort((a, b) => b.relevanceScore - a.relevanceScore);
}

// ============================================================================
// CLI Interface
// ============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes("--test")) {
    console.log("TopicMatcher Self-Test\n");

    let passed = 0;
    let failed = 0;

    const test = (name: string, fn: () => void) => {
      try {
        fn();
        console.log(`  [PASS] ${name}`);
        passed++;
      } catch (e) {
        console.log(`  [FAIL] ${name}: ${e instanceof Error ? e.message : e}`);
        failed++;
      }
    };

    const makeItem = (title: string, body: string, tags: string[] = []): ContentItem => ({
      id: "test",
      sourceId: "test",
      sourceType: "rss",
      title,
      url: "https://example.com",
      canonicalUrl: "https://example.com",
      author: "Test",
      publishedAt: new Date().toISOString(),
      collectedAt: new Date().toISOString(),
      body,
      tags,
      topics: [],
      relevanceScore: 0,
      goalAlignment: [],
      contentHash: "test",
      summary: "",
      status: "new",
      deliveredVia: [],
    });

    test("AI article scores high", () => {
      const item = makeItem(
        "Anthropic releases Claude 4 with improved reasoning",
        "The latest large language model from Anthropic shows significant improvements in AI safety and alignment.",
        ["ai", "claude"]
      );
      const { score, matchedTopics } = scoreItem(item);
      if (score < 40) throw new Error(`Score too low: ${score}`);
      if (!matchedTopics.includes("ai-ml")) throw new Error("Should match AI topic");
    });

    test("Security article matches security topic", () => {
      const item = makeItem(
        "Critical zero-day vulnerability found in major software",
        "Security researchers discover a new exploit affecting millions of users.",
        ["security", "vulnerability"]
      );
      const { matchedTopics } = scoreItem(item);
      if (!matchedTopics.includes("security-privacy")) throw new Error("Should match security topic");
    });

    test("Irrelevant article scores low", () => {
      const item = makeItem(
        "Best pasta recipes for weeknight dinners",
        "Quick and easy Italian cooking tips for busy families.",
        ["cooking", "food"]
      );
      const { score } = scoreItem(item);
      if (score > 30) throw new Error(`Score too high: ${score}`);
    });

    test("San Diego article matches local topic", () => {
      const item = makeItem(
        "San Diego approves new transit expansion plan",
        "The city council voted to expand public transit in North County.",
        ["san diego", "local"]
      );
      const { matchedTopics } = scoreItem(item);
      if (!matchedTopics.includes("san-diego")) throw new Error("Should match SD topic");
    });

    test("scoreAndFilter removes low-scoring items", () => {
      const items = [
        makeItem("AI breakthrough in neural networks", "Deep learning advances.", ["ai"]),
        makeItem("Best pasta recipes", "Cooking tips.", ["food"]),
      ];
      // Use minScore of 30 to filter out items that only score from trust+recency
      const filtered = scoreAndFilter(items, undefined, undefined, 30);
      if (filtered.length !== 1) throw new Error(`Expected 1, got ${filtered.length}`);
      if (!filtered[0].title.includes("AI")) throw new Error("Wrong item kept");
    });

    test("older items score lower", () => {
      const recent = makeItem("AI news today", "Machine learning update.");
      const old = makeItem("AI news today", "Machine learning update.");
      old.publishedAt = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString(); // 3 days ago

      const recentScore = scoreItem(recent).score;
      const oldScore = scoreItem(old).score;
      if (oldScore >= recentScore) throw new Error(`Old (${oldScore}) should be < recent (${recentScore})`);
    });

    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  } else if (args.includes("--profiles")) {
    console.log(JSON.stringify(DEFAULT_TOPIC_PROFILES, null, 2));
  } else {
    console.log("Usage: bun TopicMatcher.ts --test | --profiles");
  }
}
