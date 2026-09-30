#!/usr/bin/env bun
/**
 * TopicMatcher.ts - LLM-Based Topic Matching & Relevance Pre-Filter
 *
 * Phase 2 implementation: LLM-primary scoring with keyword fallback.
 * scoreItem() calls inference for primary relevance scoring.
 * scoreAndFilter() batches items in groups of 10.
 *
 * CLI Usage:
 *   bun TopicMatcher.ts --test                Run self-test
 */

import type { ContentItem, TopicProfile } from "./types.ts";
import { inference as defaultInference } from "../../../../lib/core/Inference.ts";
import type { InferenceOptions, InferenceResult } from "../../../../lib/core/Inference.ts";
import { z } from "zod";

export type InferenceFn = (opts: InferenceOptions) => Promise<InferenceResult>;

const LLMScoredItemSchema = z.object({
  scores: z.record(z.string(), z.number().min(0).max(100)),
  matchedTopics: z.array(z.string()),
  matchedGoals: z.array(z.string()),
});

const LLMBatchScoringSchema = z.object({
  items: z.array(LLMScoredItemSchema),
});

type LLMScoredItem = z.infer<typeof LLMScoredItemSchema>;

// ============================================================================
// Fallback Keyword Scoring (private)
// ============================================================================

function keywordMatches(text: string, keyword: string): boolean {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\b${escaped}\\b`, "i");
  return pattern.test(text);
}

// ============================================================================
// Default Topic Profiles
// ============================================================================

export const DEFAULT_TOPIC_PROFILES: TopicProfile[] = [
  {
    id: "ai-ml",
    name: "AI & Machine Learning",
    keywords: [
      "artificial intelligence", "machine learning", "deep learning", "llm",
      "large language model", "claude", "anthropic",
      "neural network", "transformer", "ai safety", "alignment",
      "ai agent", "generative ai",
      "foundation model", "multimodal", "agi", "superintelligence",
    ],
    goalIds: ["G28"],
    priority: "high",
    minRelevanceThreshold: 45,
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
      "business model", "acquisition", "ipo", "investor",
    ],
    goalIds: [],
    priority: "medium",
    minRelevanceThreshold: 40,
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
      "tech industry", "silicon valley", "big tech",
      "typescript", "software engineering",
      "open source", "distributed systems",
    ],
    goalIds: [],
    priority: "low",
    minRelevanceThreshold: 50,
  },
];

// ============================================================================
// Fallback keyword scoring (continued)
// ============================================================================

/**
 * Fallback keyword-based scoring used when LLM inference fails.
 */
function _scoreItemFallback(
  item: ContentItem,
  profiles: TopicProfile[],
  sourceTrustScore: number
): { score: number; matchedTopics: string[]; matchedGoals: string[] } {
  let totalScore = 0;
  const matchedTopics: string[] = [];
  const matchedGoals: string[] = [];

  const searchText = `${item.title} ${item.body} ${item.tags.join(" ")}`.toLowerCase();
  const titleLower = item.title.toLowerCase();

  // 1. Topic keyword matching (40 points max)
  let topicScore = 0;
  let topicMatchCount = 0;
  const topicMatchStrength: Array<{ id: string; strength: number }> = [];

  for (const profile of profiles) {
    const matchedKeywords = profile.keywords.filter((kw) =>
      keywordMatches(searchText, kw)
    );

    if (matchedKeywords.length > 0) {
      topicMatchStrength.push({ id: profile.id, strength: matchedKeywords.length });
      matchedGoals.push(...profile.goalIds);

      const topicContribution = Math.min(
        20,
        matchedKeywords.length * (profile.priority === "high" ? 8 : profile.priority === "medium" ? 5 : 3)
      );

      topicScore += topicContribution / (1 + topicMatchCount * 0.3);
      topicMatchCount++;
    }
  }

  totalScore += Math.min(40, topicScore);

  topicMatchStrength.sort((a, b) => b.strength - a.strength);
  matchedTopics.push(...topicMatchStrength.map((t) => t.id));

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

// ============================================================================
// LLM Scoring
// ============================================================================

/**
 * Score a single content item against all topic profiles using LLM inference.
 * Falls back to keyword scoring on failure.
 */
export async function scoreItem(
  item: ContentItem,
  profiles: TopicProfile[] = DEFAULT_TOPIC_PROFILES,
  sourceTrustScore = 70,
  options?: { inferenceFn?: InferenceFn },
): Promise<{ score: number; matchedTopics: string[]; matchedGoals: string[] }> {
  const infer = options?.inferenceFn ?? defaultInference;

  const profileList = profiles.map((p) => `- ${p.id}: ${p.name}`).join("\n");
  const itemDesc = `Title: "${item.title}" | Tags: ${item.tags.join(", ")} | Body: "${(item.body || "").slice(0, 300)}"`;
  const contextNote = `Source trust: ${sourceTrustScore}/100. Published: ${item.publishedAt}.`;

  try {
    const result = await infer({
      level: "standard",
      expectJson: true,
      systemPrompt: `You are a content relevance scorer. Score how relevant an article is to a set of topic profiles (0-100 each). Return JSON only.`,
      userPrompt: `Article:\n${itemDesc}\n${contextNote}\n\nTopics:\n${profileList}\n\nReturn: {"scores": {"ai-ml": 85, "writing-craft": 10, ...}, "matchedTopics": ["ai-ml"], "matchedGoals": ["G28"]}`,
    });

    if (result.success && result.parsed !== undefined) {
      const parsed = LLMScoredItemSchema.safeParse(result.parsed);
      if (parsed.success) {
        const scores = parsed.data.scores;
        const maxScore = Object.values(scores).reduce((m, v) => Math.max(m, v), 0);
        return {
          score: Math.round(Math.min(100, Math.max(0, maxScore))),
          matchedTopics: parsed.data.matchedTopics,
          matchedGoals: parsed.data.matchedGoals,
        };
      }
    }
  } catch (err) {
    console.error("[TopicMatcher] LLM scoreItem error:", err instanceof Error ? err.message : String(err));
  }

  // Fallback to keyword scoring
  return _scoreItemFallback(item, profiles, sourceTrustScore);
}

/**
 * Score and filter a batch of items using LLM inference in groups of 10.
 */
export async function scoreAndFilter(
  items: ContentItem[],
  profiles: TopicProfile[] = DEFAULT_TOPIC_PROFILES,
  sourceTrustScores: Map<string, number> = new Map(),
  minScore = 20,
  options?: { inferenceFn?: InferenceFn },
): Promise<ContentItem[]> {
  const infer = options?.inferenceFn ?? defaultInference;
  const profileMap = new Map(profiles.map((p) => [p.id, p]));
  const profileList = profiles.map((p) => `- ${p.id}: ${p.name}`).join("\n");

  // Build output array with same length as input
  const scored: Array<ContentItem & { relevanceScore: number; topics: string[]; goalAlignment: string[]; status: "scored" }> =
    new Array(items.length);

  // Process in batches of 10
  const BATCH_SIZE = 10;
  for (let batchStart = 0; batchStart < items.length; batchStart += BATCH_SIZE) {
    const batch = items.slice(batchStart, batchStart + BATCH_SIZE);

    const batchDesc = batch.map((item, i) => {
      const trustScore = sourceTrustScores.get(item.sourceId) ?? 70;
      return `[${i}] Title: "${item.title}" | Tags: ${(item.tags || []).join(",")} | Body: "${(item.body || "").slice(0, 200)}" | Trust: ${trustScore}/100`;
    }).join("\n");

    let llmResults: LLMScoredItem[] | null = null;

    try {
      const result = await infer({
        level: "standard",
        expectJson: true,
        systemPrompt: `You are a content relevance scorer for a personal AI system. Score each article's relevance to topic profiles (0-100 each). Topics: AI/ML, writing/fiction, cybersecurity, San Diego, startups, philosophy, creative process, tech industry. Return JSON only.`,
        userPrompt: `Score these ${batch.length} articles against the topic profiles:\n\nArticles:\n${batchDesc}\n\nTopics:\n${profileList}\n\nReturn: {"items": [{"scores": {"ai-ml": 85}, "matchedTopics": ["ai-ml"], "matchedGoals": ["G28"]}, ...]} — one entry per article in order.`,
      });

      if (result.success && result.parsed !== undefined) {
        const parsed = LLMBatchScoringSchema.safeParse(result.parsed);
        if (parsed.success && parsed.data.items.length === batch.length) {
          llmResults = parsed.data.items;
        }
      }
    } catch (err) {
      console.error("[TopicMatcher] LLM batch error:", err instanceof Error ? err.message : String(err));
    }

    for (let i = 0; i < batch.length; i++) {
      const item = batch[i]!;
      const globalIdx = batchStart + i;
      const trustScore = sourceTrustScores.get(item.sourceId) ?? 70;

      if (llmResults !== null && llmResults[i] !== undefined) {
        const llmItem = llmResults[i]!;
        const scores = llmItem.scores;
        const maxScore = Object.values(scores).reduce((m, v) => Math.max(m, v), 0);

        // Apply recency and trust as context modifiers (arithmetic, not LLM)
        const ageMs = Date.now() - new Date(item.publishedAt).getTime();
        const ageHours = ageMs / (1000 * 60 * 60);
        const recencyBonus = Math.max(0, 5 * Math.exp(-ageHours / 24));
        const trustBonus = (trustScore / 100) * 5;
        const finalScore = Math.round(Math.min(100, Math.max(0, maxScore + recencyBonus + trustBonus)));

        scored[globalIdx] = {
          ...item,
          relevanceScore: finalScore,
          topics: llmItem.matchedTopics,
          goalAlignment: llmItem.matchedGoals,
          status: "scored" as const,
        };
      } else {
        // Fallback for this item
        const fallback = _scoreItemFallback(item, profiles, trustScore);
        scored[globalIdx] = {
          ...item,
          relevanceScore: fallback.score,
          topics: fallback.matchedTopics,
          goalAlignment: fallback.matchedGoals,
          status: "scored" as const,
        };
      }
    }
  }

  return scored
    .filter((item) => {
      if (item.topics.length === 0) return false;
      if (item.relevanceScore < minScore) return false;
      const lowestTopicThreshold = Math.min(...item.topics.map((tid) => profileMap.get(tid)?.minRelevanceThreshold ?? minScore));
      if (item.relevanceScore < lowestTopicThreshold) return false;
      return true;
    })
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

    const test = async (name: string, fn: () => Promise<void> | void) => {
      try {
        await fn();
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

    await test("AI article scores high", async () => {
      const item = makeItem(
        "Anthropic releases Claude 4 with improved reasoning",
        "The latest large language model from Anthropic shows significant improvements in AI safety and alignment.",
        ["ai", "claude"]
      );
      const { score, matchedTopics } = await scoreItem(item);
      if (score < 40) throw new Error(`Score too low: ${score}`);
      if (!matchedTopics.includes("ai-ml")) throw new Error("Should match AI topic");
    });

    await test("Security article matches security topic", async () => {
      const item = makeItem(
        "Critical zero-day vulnerability found in major software",
        "Security researchers discover a new exploit affecting millions of users.",
        ["security", "vulnerability"]
      );
      const { matchedTopics } = await scoreItem(item);
      if (!matchedTopics.includes("security-privacy")) throw new Error("Should match security topic");
    });

    await test("Irrelevant article scores low", async () => {
      const item = makeItem(
        "Best pasta recipes for weeknight dinners",
        "Quick and easy Italian cooking tips for busy families.",
        ["cooking", "food"]
      );
      const { score } = await scoreItem(item);
      if (score > 30) throw new Error(`Score too high: ${score}`);
    });

    await test("San Diego article matches local topic", async () => {
      const item = makeItem(
        "San Diego approves new transit expansion plan",
        "The city council voted to expand public transit in North County.",
        ["san diego", "local"]
      );
      const { matchedTopics } = await scoreItem(item);
      if (!matchedTopics.includes("san-diego")) throw new Error("Should match SD topic");
    });

    await test("scoreAndFilter removes low-scoring items", async () => {
      const items = [
        makeItem("Anthropic releases Claude with improved AI safety and alignment", "The latest large language model from Anthropic shows deep learning advances in artificial intelligence.", ["ai", "machine learning", "claude"]),
        makeItem("Best pasta recipes", "Cooking tips.", ["food"]),
      ];
      const filtered = await scoreAndFilter(items, undefined, undefined, 35);
      if (filtered.length !== 1) throw new Error(`Expected 1, got ${filtered.length}`);
      if (!filtered[0]!.title.includes("Claude")) throw new Error("Wrong item kept");
    });

    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  } else if (args.includes("--profiles")) {
    console.log(JSON.stringify(DEFAULT_TOPIC_PROFILES, null, 2));
  } else {
    console.log("Usage: bun TopicMatcher.ts --test | --profiles");
  }
}
