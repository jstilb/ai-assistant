#!/usr/bin/env bun
/**
 * SemanticIndexer - Keyword-Based Semantic Search for Knowledge Graphs
 *
 * Implements TF-IDF keyword extraction and concept matching for
 * semantic search across the knowledge graph. Uses local computation
 * (no API calls) for fast, free, offline search.
 *
 * How it works:
 *   1. Extract keywords from each note (tokenize, remove stopwords, stem)
 *   2. Compute TF-IDF scores (term frequency * inverse document frequency)
 *   3. Build an inverted index for fast lookup
 *   4. Match queries against the index using cosine similarity
 *
 * CLI:
 *   bun SemanticIndexer.ts --build                       # Build index from graph
 *   bun SemanticIndexer.ts --query "transformers attention"  # Search
 *   bun SemanticIndexer.ts --query "..." --limit 10      # Limit results
 *   bun SemanticIndexer.ts --related <nodeId>             # Find related notes
 */

import { readFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname, basename } from "path";
import { createStateManager } from "../../CORE/Tools/StateManager";
import { z } from "zod";
import { loadGraphState } from "./GraphBuilder";
import type {
  GraphState,
  GraphNode,
  SemanticIndexState,
  ConceptIndex,
  KeywordScore,
  SearchResult,
} from "./types.ts";

// ============================================
// STOPWORDS
// ============================================

const STOPWORDS = new Set([
  "a", "about", "above", "after", "again", "against", "all", "am", "an", "and",
  "any", "are", "as", "at", "be", "because", "been", "before", "being", "below",
  "between", "both", "but", "by", "can", "could", "did", "do", "does", "doing",
  "down", "during", "each", "few", "for", "from", "further", "get", "got", "had",
  "has", "have", "having", "he", "her", "here", "hers", "herself", "him",
  "himself", "his", "how", "i", "if", "in", "into", "is", "it", "its", "itself",
  "just", "know", "let", "like", "ll", "may", "me", "might", "more", "most",
  "my", "myself", "no", "nor", "not", "now", "of", "off", "on", "once", "only",
  "or", "other", "our", "ours", "ourselves", "out", "over", "own", "re", "s",
  "same", "shall", "she", "should", "so", "some", "such", "t", "than", "that",
  "the", "their", "theirs", "them", "themselves", "then", "there", "these",
  "they", "this", "those", "through", "to", "too", "under", "until", "up",
  "use", "used", "using", "ve", "very", "was", "we", "were", "what", "when",
  "where", "which", "while", "who", "whom", "why", "will", "with", "would",
  "you", "your", "yours", "yourself", "yourselves",
  // Markdown/formatting noise
  "md", "https", "http", "www", "com", "png", "jpg", "image", "resources",
  "true", "false", "null", "undefined", "var", "const", "let", "function",
  // Common academic words to de-weight
  "also", "see", "note", "example", "e", "g", "ie", "etc",
]);

// ============================================
// TOKENIZATION AND STEMMING
// ============================================

/**
 * Simple suffix-stripping stemmer (Porter-lite).
 * Handles common English suffixes to normalize terms.
 */
function simpleStem(word: string): string {
  if (word.length < 4) return word;

  // Order matters: longest suffixes first
  const suffixes = [
    "ational", "tional", "ization", "fulness", "ousness", "iveness",
    "ation", "ence", "ance", "ment", "ness", "ible", "able", "tion",
    "sion", "ical", "ally", "ious", "eous", "ful", "ous", "ive",
    "ing", "ity", "ism", "ist", "ize", "ise", "ate", "ant", "ent",
    "ies", "ied", "ing", "est", "ess", "ers", "ler", "ted", "ting",
    "ed", "ly", "er", "al", "es", "en", "ty",
  ];

  for (const suffix of suffixes) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
      return word.slice(0, word.length - suffix.length);
    }
  }

  // Handle trailing 's' for plurals
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 3) {
    return word.slice(0, -1);
  }

  return word;
}

/**
 * Tokenize text into normalized terms.
 * Strips markdown, lowercases, removes stopwords, stems.
 */
export function tokenize(text: string): string[] {
  // Strip markdown formatting
  const cleaned = text
    .replace(/```[\s\S]*?```/g, " ") // Code blocks
    .replace(/`[^`]+`/g, " ") // Inline code
    .replace(/!\[\[.*?\]\]/g, " ") // Embeds
    .replace(/\[\[([^\]|]*?)(?:\|[^\]]*?)?\]\]/g, "$1") // Wikilinks -> just the target
    .replace(/\[([^\]]*?)\]\([^)]*?\)/g, "$1") // Markdown links -> just text
    .replace(/<[^>]+>/g, " ") // HTML tags
    .replace(/^#{1,6}\s+/gm, " ") // Heading markers
    .replace(/[#*_~>`|\\{}()\[\]!]/g, " ") // Special chars
    .replace(/---+/g, " ") // Horizontal rules
    .replace(/\d+\.\s/g, " ") // Numbered list markers
    .replace(/-\s/g, " ") // Bullet markers
    .toLowerCase();

  // Split into words
  const words = cleaned.split(/\s+/).filter((w) => w.length >= 2);

  // Remove stopwords and stem
  const terms: string[] = [];
  for (const word of words) {
    // Remove non-alphabetic noise
    const clean = word.replace(/[^a-z-]/g, "");
    if (clean.length < 2) continue;
    if (STOPWORDS.has(clean)) continue;

    const stemmed = simpleStem(clean);
    if (stemmed.length >= 2 && !STOPWORDS.has(stemmed)) {
      terms.push(stemmed);
    }
  }

  return terms;
}

/**
 * Extract 2-3 word phrases from text (bigrams/trigrams).
 */
export function extractPhrases(text: string): string[] {
  const cleaned = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#*_~>`|\\{}()\[\]!]/g, " ")
    .replace(/\[\[([^\]|]*?)(?:\|[^\]]*?)?\]\]/g, "$1")
    .toLowerCase();

  const words = cleaned.split(/\s+/).filter(
    (w) => w.length >= 2 && !STOPWORDS.has(w.replace(/[^a-z]/g, ""))
  );

  const phrases: string[] = [];

  // Bigrams
  for (let i = 0; i < words.length - 1; i++) {
    const a = words[i].replace(/[^a-z-]/g, "");
    const b = words[i + 1].replace(/[^a-z-]/g, "");
    if (a.length >= 2 && b.length >= 2) {
      phrases.push(`${a} ${b}`);
    }
  }

  // Trigrams (selective - only from headings and first sentences)
  const headingText = text.match(/^#{1,6}\s+(.+)$/gm)?.join(" ") || "";
  const headingWords = headingText
    .replace(/#{1,6}\s+/g, "")
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 2);
  for (let i = 0; i < headingWords.length - 2; i++) {
    const a = headingWords[i].replace(/[^a-z-]/g, "");
    const b = headingWords[i + 1].replace(/[^a-z-]/g, "");
    const c = headingWords[i + 2].replace(/[^a-z-]/g, "");
    if (a.length >= 2 && b.length >= 2 && c.length >= 2) {
      phrases.push(`${a} ${b} ${c}`);
    }
  }

  return [...new Set(phrases)];
}

// ============================================
// TF-IDF COMPUTATION
// ============================================

/**
 * Compute term frequency for a document.
 */
function computeTF(terms: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const term of terms) {
    counts.set(term, (counts.get(term) || 0) + 1);
  }
  // Normalize by document length
  const maxCount = Math.max(...counts.values(), 1);
  const tf = new Map<string, number>();
  for (const [term, count] of counts) {
    tf.set(term, 0.5 + (0.5 * count) / maxCount); // Augmented TF
  }
  return tf;
}

/**
 * Compute document frequency across all documents.
 */
function computeDF(
  allTerms: Map<string, string[]>[]
): Record<string, number> {
  const df: Record<string, number> = Object.create(null);
  for (const termMap of allTerms) {
    const seenTerms = new Set<string>();
    for (const [term] of termMap) {
      if (!seenTerms.has(term)) {
        df[term] = (df[term] || 0) + 1;
        seenTerms.add(term);
      }
    }
  }
  return df;
}

/**
 * Build complete semantic index from graph state.
 */
export function buildIndex(
  graphState: GraphState,
  vaultRoot: string
): SemanticIndexState {
  const indices: ConceptIndex[] = [];
  const allTermFreqs: Map<string, number>[] = [];

  // Step 1: Tokenize all documents and compute TF
  for (const node of graphState.nodes) {
    const filePath = join(vaultRoot, node.id);
    let content = "";
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    // Boost title and headings by repeating them
    const boostedContent = [
      node.title,
      node.title,
      node.title,
      ...node.headings,
      ...node.headings,
      ...node.tags.map((t) => t.replace(/-/g, " ")),
      ...node.tags.map((t) => t.replace(/-/g, " ")),
      content,
    ].join(" ");

    const terms = tokenize(boostedContent);
    const tf = computeTF(terms);
    allTermFreqs.push(tf);

    // Extract phrases
    const phrases = extractPhrases(content);

    indices.push({
      nodeId: node.id,
      keywords: [], // Will be filled after IDF computation
      phrases,
    });
  }

  // Step 2: Compute document frequency
  const N = allTermFreqs.length;
  const df: Record<string, number> = Object.create(null);
  for (const tfMap of allTermFreqs) {
    for (const term of tfMap.keys()) {
      df[term] = (df[term] || 0) + 1;
    }
  }

  // Step 3: Compute TF-IDF and set keywords
  for (let i = 0; i < indices.length; i++) {
    const tf = allTermFreqs[i];
    const keywords: KeywordScore[] = [];

    for (const [term, tfScore] of tf) {
      const docFreq = df[term] || 1;
      const idf = Math.log(N / docFreq);
      const tfidf = tfScore * idf;

      if (tfidf > 0.01) {
        keywords.push({ term, score: tfidf });
      }
    }

    // Sort by score descending, keep top 50
    keywords.sort((a, b) => b.score - a.score);
    indices[i].keywords = keywords.slice(0, 50);
  }

  return {
    version: 1,
    built: new Date().toISOString(),
    indices,
    documentFrequency: df,
    totalDocuments: N,
  };
}

// ============================================
// SEARCH
// ============================================

/**
 * Search the index using natural language query.
 * Returns ranked results by relevance.
 */
export function search(
  query: string,
  indexState: SemanticIndexState,
  graphState: GraphState,
  limit: number = 20
): SearchResult[] {
  const queryTerms = tokenize(query);
  const queryPhrases = extractPhrases(query);

  if (queryTerms.length === 0) return [];

  const results: SearchResult[] = [];

  for (const idx of indexState.indices) {
    let score = 0;
    const matchedTerms: string[] = [];
    const matchedPhrases: string[] = [];

    // Keyword matching (TF-IDF weighted)
    const keywordMap = new Map(idx.keywords.map((k) => [k.term, k.score]));

    for (const queryTerm of queryTerms) {
      const keyScore = keywordMap.get(queryTerm);
      if (keyScore) {
        score += keyScore;
        matchedTerms.push(queryTerm);
      }

      // Partial match (prefix matching for stems)
      for (const [term, termScore] of keywordMap) {
        if (term.startsWith(queryTerm) || queryTerm.startsWith(term)) {
          if (!matchedTerms.includes(term)) {
            score += termScore * 0.5; // Partial match discount
            matchedTerms.push(term);
          }
        }
      }
    }

    // Phrase matching (bonus for exact phrase matches)
    for (const queryPhrase of queryPhrases) {
      if (idx.phrases.includes(queryPhrase)) {
        score += 2.0; // Big bonus for phrase match
        matchedPhrases.push(queryPhrase);
      }
      // Partial phrase match
      for (const docPhrase of idx.phrases) {
        if (
          docPhrase.includes(queryPhrase) ||
          queryPhrase.includes(docPhrase)
        ) {
          if (!matchedPhrases.includes(docPhrase)) {
            score += 0.5;
            matchedPhrases.push(docPhrase);
          }
        }
      }
    }

    if (score > 0) {
      const node = graphState.nodes.find((n) => n.id === idx.nodeId);
      results.push({
        nodeId: idx.nodeId,
        title: node?.title || basename(idx.nodeId, ".md"),
        folder: node?.folder || "",
        score,
        matchedTerms: [...new Set(matchedTerms)],
        matchedPhrases: [...new Set(matchedPhrases)],
      });
    }
  }

  // Normalize scores
  const maxScore = Math.max(...results.map((r) => r.score), 1);
  for (const r of results) {
    r.score = r.score / maxScore;
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

/**
 * Find notes related to a given note using semantic similarity.
 */
export function findRelated(
  nodeId: string,
  indexState: SemanticIndexState,
  graphState: GraphState,
  limit: number = 10
): SearchResult[] {
  const nodeIndex = indexState.indices.find((idx) => idx.nodeId === nodeId);
  if (!nodeIndex) return [];

  // Use top keywords as query
  const queryTerms = nodeIndex.keywords.slice(0, 15).map((k) => k.term);
  const query = queryTerms.join(" ");

  const results = search(query, indexState, graphState, limit + 1);
  // Remove the source note itself
  return results.filter((r) => r.nodeId !== nodeId).slice(0, limit);
}

// ============================================
// PERSISTENCE (via StateManager)
// ============================================

const KeywordScoreSchema = z.object({
  term: z.string(),
  score: z.number(),
});

const ConceptIndexSchema = z.object({
  nodeId: z.string(),
  keywords: z.array(KeywordScoreSchema),
  phrases: z.array(z.string()),
});

const SemanticIndexSchema = z.object({
  version: z.number(),
  built: z.string(),
  indices: z.array(ConceptIndexSchema),
  documentFrequency: z.record(z.number()),
  totalDocuments: z.number(),
});

export async function saveIndex(
  state: SemanticIndexState,
  path: string
): Promise<void> {
  const manager = createStateManager({
    path,
    schema: SemanticIndexSchema as z.ZodSchema<SemanticIndexState>,
    defaults: state,
  });
  await manager.save(state);
}

export async function loadIndex(path: string): Promise<SemanticIndexState> {
  if (!existsSync(path)) throw new Error(`Index not found: ${path}`);
  const manager = createStateManager({
    path,
    schema: SemanticIndexSchema as z.ZodSchema<SemanticIndexState>,
    defaults: { version: 1, built: "", indices: [], documentFrequency: {}, totalDocuments: 0 },
  });
  return await manager.load();
}

// ============================================
// CLI
// ============================================

const DEFAULT_GRAPH_PATH = join(
  process.env.HOME || "~",
  ".claude",
  "MEMORY",
  "State",
  "knowledge-graph.json"
);

const DEFAULT_INDEX_PATH = join(
  process.env.HOME || "~",
  ".claude",
  "MEMORY",
  "State",
  "semantic-index.json"
);

const DEFAULT_VAULT = "~/Desktop/obsidian";

function formatResults(results: SearchResult[]): string {
  if (results.length === 0) return "No results found.";

  const lines: string[] = [
    `Found ${results.length} results:`,
    "",
  ];

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const score = (r.score * 100).toFixed(0);
    lines.push(`${i + 1}. [${score}%] ${r.title}`);
    lines.push(`   Path: ${r.folder}/${basename(r.nodeId)}`);
    if (r.matchedTerms.length > 0) {
      lines.push(`   Terms: ${r.matchedTerms.join(", ")}`);
    }
    if (r.matchedPhrases.length > 0) {
      lines.push(`   Phrases: ${r.matchedPhrases.join(", ")}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
SemanticIndexer - Keyword-Based Semantic Search

Usage:
  bun SemanticIndexer.ts --build                          # Build index
  bun SemanticIndexer.ts --query "transformers attention"  # Search
  bun SemanticIndexer.ts --related <nodeId>                # Related notes
  bun SemanticIndexer.ts --query "..." --limit 5           # Limit results
  bun SemanticIndexer.ts --query "..." --json              # JSON output

Options:
  --build            Build semantic index from graph state
  --query <text>     Search for notes matching query
  --related <nodeId> Find notes related to a given note
  --limit <n>        Max results (default: 20)
  --json             Output as JSON
  --help             Show this help
`);
    process.exit(0);
  }

  if (args.includes("--build")) {
    console.log("Loading graph state...");
    const graphState = await loadGraphState(DEFAULT_GRAPH_PATH);
    console.log(`Building semantic index for ${graphState.nodes.length} nodes...`);

    const startTime = Date.now();
    const indexState = buildIndex(graphState, DEFAULT_VAULT);
    const elapsed = Date.now() - startTime;

    await saveIndex(indexState, DEFAULT_INDEX_PATH);
    console.log(`Index built in ${elapsed}ms`);
    console.log(`Indexed ${indexState.indices.length} documents`);
    console.log(`Unique terms: ${Object.keys(indexState.documentFrequency).length}`);
    console.log(`Saved to: ${DEFAULT_INDEX_PATH}`);
    return;
  }

  const queryIdx = args.indexOf("--query");
  if (queryIdx >= 0) {
    const query = args[queryIdx + 1];
    if (!query) {
      console.error("Usage: --query <text>");
      process.exit(1);
    }

    const limitIdx = args.indexOf("--limit");
    const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1]) : 20;

    const graphState = await loadGraphState(DEFAULT_GRAPH_PATH);
    const indexState = await loadIndex(DEFAULT_INDEX_PATH);

    const results = search(query, indexState, graphState, limit);

    if (args.includes("--json")) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      console.log(formatResults(results));
    }
    return;
  }

  const relatedIdx = args.indexOf("--related");
  if (relatedIdx >= 0) {
    const nodeId = args[relatedIdx + 1];
    if (!nodeId) {
      console.error("Usage: --related <nodeId>");
      process.exit(1);
    }

    const limitIdx = args.indexOf("--limit");
    const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1]) : 10;

    const graphState = await loadGraphState(DEFAULT_GRAPH_PATH);
    const indexState = await loadIndex(DEFAULT_INDEX_PATH);

    const results = findRelated(nodeId, indexState, graphState, limit);

    if (args.includes("--json")) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      console.log(`Notes related to: ${nodeId}\n`);
      console.log(formatResults(results));
    }
    return;
  }

  console.log("Use --help for usage information.");
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
  });
}
