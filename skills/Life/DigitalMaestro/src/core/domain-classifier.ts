/**
 * Domain Classifier
 *
 * Classifies learning topics into one of five domains using AI inference.
 * Falls back to keyword-based heuristics if AI is unavailable.
 */

import { inference } from '../../../../../lib/core/Inference.ts';
import type { DomainType, DomainClassification } from '../types/index.ts';

// ============================================
// KEYWORD MAPS FOR HEURISTIC FALLBACK
// ============================================

const DOMAIN_KEYWORDS: Record<DomainType, string[]> = {
  programming: [
    'code', 'coding', 'programming', 'software', 'javascript', 'typescript',
    'python', 'rust', 'golang', 'api', 'database', 'sql', 'html', 'css',
    'react', 'vue', 'angular', 'node', 'docker', 'kubernetes', 'git',
    'algorithm', 'data structure', 'web development', 'frontend', 'backend',
    'devops', 'cloud', 'aws', 'gcp', 'azure', 'terraform', 'ci/cd',
    'testing', 'tdd', 'compiler', 'operating system', 'networking',
  ],
  language: [
    'language', 'spanish', 'french', 'german', 'japanese', 'chinese',
    'mandarin', 'korean', 'italian', 'portuguese', 'arabic', 'hindi',
    'grammar', 'vocabulary', 'conjugation', 'pronunciation', 'fluency',
    'translation', 'linguistics', 'syntax', 'semantics', 'phonetics',
    'esl', 'ielts', 'toefl', 'duolingo', 'rosetta', 'immersion',
  ],
  science: [
    'science', 'biology', 'chemistry', 'physics', 'astronomy', 'geology',
    'ecology', 'genetics', 'evolution', 'neuroscience', 'anatomy',
    'physiology', 'biochemistry', 'organic chemistry', 'quantum',
    'thermodynamics', 'electromagnetism', 'optics', 'nuclear', 'particle',
    'microbiology', 'botany', 'zoology', 'cell', 'molecule', 'atom',
    'experiment', 'hypothesis', 'lab', 'research methodology',
  ],
  math: [
    'math', 'mathematics', 'algebra', 'calculus', 'geometry', 'trigonometry',
    'statistics', 'probability', 'linear algebra', 'differential equation',
    'discrete math', 'number theory', 'combinatorics', 'topology',
    'analysis', 'set theory', 'logic', 'proof', 'theorem', 'integral',
    'derivative', 'matrix', 'vector', 'eigenvalue', 'regression',
    'bayesian', 'stochastic', 'optimization',
  ],
  humanities: [
    'history', 'philosophy', 'literature', 'art', 'music', 'theology',
    'psychology', 'sociology', 'anthropology', 'political science',
    'economics', 'law', 'ethics', 'culture', 'civilization', 'religion',
    'writing', 'rhetoric', 'critical thinking', 'debate', 'logic',
    'ancient', 'medieval', 'renaissance', 'modern', 'contemporary',
    'film studies', 'media', 'communication', 'education',
  ],
};

// ============================================
// CLASSIFICATION FUNCTIONS
// ============================================

/**
 * Classify a topic into a learning domain using AI with heuristic fallback
 */
export async function classifyDomain(topic: string): Promise<DomainClassification> {
  try {
    return await classifyWithAI(topic);
  } catch {
    return classifyWithHeuristics(topic);
  }
}

/**
 * AI-powered domain classification
 */
async function classifyWithAI(topic: string): Promise<DomainClassification> {
  const systemPrompt = `You classify learning topics into domains. Return ONLY valid JSON:
{
  "domain": "programming|language|science|math|humanities",
  "confidence": 0.95,
  "subDomain": "specific sub-area",
  "keywords": ["key", "words"]
}

Domains:
- programming: Software, coding, CS, DevOps, web dev
- language: Foreign languages, linguistics, translation
- science: Natural sciences, biology, chemistry, physics
- math: Mathematics, statistics, logic
- humanities: History, philosophy, literature, social sciences, arts`;

  const result = await inference({
    systemPrompt,
    userPrompt: `Classify this learning topic: "${topic}"`,
    level: 'fast',
    expectJson: true,
    timeout: 15000,
  });

  if (!result.success || !result.parsed) {
    throw new Error('AI classification failed');
  }

  const parsed = result.parsed as {
    domain: string;
    confidence: number;
    subDomain: string;
    keywords: string[];
  };

  const validDomains: DomainType[] = ['programming', 'language', 'science', 'math', 'humanities'];
  const domain = validDomains.includes(parsed.domain as DomainType)
    ? (parsed.domain as DomainType)
    : classifyWithHeuristics(topic).domain;

  return {
    domain,
    confidence: Math.min(Math.max(parsed.confidence || 0.5, 0), 1),
    subDomain: parsed.subDomain || topic,
    keywords: parsed.keywords || [],
  };
}

/**
 * Heuristic keyword-based domain classification (no AI required)
 */
export function classifyWithHeuristics(topic: string): DomainClassification {
  const lowerTopic = topic.toLowerCase();
  const scores: Record<DomainType, number> = {
    programming: 0,
    language: 0,
    science: 0,
    math: 0,
    humanities: 0,
  };

  for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
    for (const keyword of keywords) {
      if (lowerTopic.includes(keyword)) {
        scores[domain as DomainType] += keyword.split(' ').length; // Multi-word matches score higher
      }
    }
  }

  const entries = Object.entries(scores) as [DomainType, number][];
  entries.sort((a, b) => b[1] - a[1]);

  const [bestDomain, bestScore] = entries[0];
  const totalScore = entries.reduce((sum, [, s]) => sum + s, 0);

  return {
    domain: bestScore > 0 ? bestDomain : 'humanities', // Default to humanities
    confidence: totalScore > 0 ? bestScore / totalScore : 0.3,
    subDomain: topic,
    keywords: DOMAIN_KEYWORDS[bestDomain]?.filter(k => lowerTopic.includes(k)) || [],
  };
}
