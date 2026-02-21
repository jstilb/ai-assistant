#!/usr/bin/env bun

/**
 * Claude Web Research Tool - Intelligent Multi-Query WebSearch
 *
 * Analyzes research questions, decomposes into 4-8 targeted sub-queries,
 * and provides structured output for parallel WebSearch execution.
 *
 * Usage:
 *   bun ~/.claude/skills/Research/Tools/ClaudeResearch.ts "your research question"
 *
 * Features:
 * - Intelligent query decomposition
 * - Multiple search angle generation
 * - Uses Claude's built-in WebSearch (no API keys needed)
 */

const originalQuestion = process.argv.slice(2).join(' ');

if (!originalQuestion) {
  console.error('Usage: bun ClaudeResearch.ts "your research question"');
  process.exit(1);
}

interface SearchQuery {
  query: string;
  angle: string;
  priority: 'high' | 'medium' | 'low';
}

function generateSearchQueries(question: string): SearchQuery[] {
  const queries: SearchQuery[] = [];
  const currentYear = new Date().getFullYear();

  // Core question - highest priority
  queries.push({
    query: question,
    angle: 'direct',
    priority: 'high'
  });

  // Background context
  queries.push({
    query: `what is ${question} background context overview`,
    angle: 'background',
    priority: 'high'
  });

  // Recent developments
  queries.push({
    query: `${question} latest news ${currentYear}`,
    angle: 'recent',
    priority: 'high'
  });

  queries.push({
    query: `${question} recent developments updates ${currentYear}`,
    angle: 'updates',
    priority: 'medium'
  });

  // Technical details
  queries.push({
    query: `${question} technical details how it works explained`,
    angle: 'technical',
    priority: 'medium'
  });

  // Comparisons and alternatives
  queries.push({
    query: `${question} comparison alternatives options pros cons`,
    angle: 'comparison',
    priority: 'medium'
  });

  // Expert analysis
  queries.push({
    query: `${question} expert analysis opinion research`,
    angle: 'expert',
    priority: 'low'
  });

  // Implications
  queries.push({
    query: `${question} implications impact consequences future`,
    angle: 'implications',
    priority: 'low'
  });

  return queries.slice(0, 8);
}

// Output as JSON for programmatic use
const queries = generateSearchQueries(originalQuestion);

console.log(JSON.stringify({
  originalQuestion,
  generatedAt: new Date().toISOString(),
  queryCount: queries.length,
  queries
}, null, 2));
