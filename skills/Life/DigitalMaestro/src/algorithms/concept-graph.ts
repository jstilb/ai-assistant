/**
 * AI Concept Graph Generation
 *
 * Uses AI inference to generate and manage concept graphs for learning topics.
 * Concept graphs represent the prerequisite relationships between concepts,
 * enabling optimal learning path navigation.
 */

import { inference } from '../../../../../lib/core/Inference.ts';
import type {
  ConceptGraph,
  ConceptNode,
  ConceptEdge,
  DomainType,
  DifficultyTier,
} from '../types/index.ts';

// ============================================
// GRAPH GENERATION
// ============================================

/**
 * Generate a concept graph for a topic using AI
 */
export async function generateConceptGraph(
  topic: string,
  domain: DomainType,
  maxConcepts: number = 10
): Promise<ConceptGraph> {
  const systemPrompt = `You are an expert curriculum designer. Generate a concept graph for learning a topic.
Return ONLY valid JSON with this exact structure:
{
  "nodes": [
    {
      "id": "unique-id",
      "name": "Concept Name",
      "description": "Brief description",
      "difficulty": "novice|beginner|intermediate|advanced|expert",
      "prerequisites": ["id-of-prerequisite"]
    }
  ],
  "edges": [
    {
      "from": "prerequisite-id",
      "to": "dependent-id",
      "relationship": "prerequisite|related|builds-on|applies",
      "weight": 0.8
    }
  ]
}

Rules:
- Order concepts from foundational to advanced
- Each concept should have 1-3 prerequisites (except foundational ones)
- Use lowercase-hyphenated ids
- Difficulty should progress from novice to expert
- Generate exactly ${maxConcepts} concepts
- Edges must reference valid node IDs`;

  const userPrompt = `Generate a concept graph for learning "${topic}" in the ${domain} domain. Include ${maxConcepts} key concepts ordered from foundational to advanced.`;

  const result = await inference({
    systemPrompt,
    userPrompt,
    level: 'standard',
    expectJson: true,
    timeout: 45000,
  });

  if (!result.success || !result.parsed) {
    // Return a minimal fallback graph
    return createFallbackGraph(topic, domain);
  }

  const parsed = result.parsed as {
    nodes: Array<{
      id: string;
      name: string;
      description: string;
      difficulty: DifficultyTier;
      prerequisites: string[];
    }>;
    edges: Array<{
      from: string;
      to: string;
      relationship: string;
      weight: number;
    }>;
  };

  const topicId = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const now = new Date().toISOString();

  const nodes: ConceptNode[] = (parsed.nodes || []).map(n => ({
    id: n.id,
    name: n.name,
    description: n.description,
    domain,
    difficulty: validateDifficulty(n.difficulty),
    prerequisites: n.prerequisites || [],
    mastery: 0,
  }));

  const validNodeIds = new Set(nodes.map(n => n.id));
  const edges: ConceptEdge[] = (parsed.edges || [])
    .filter(e => validNodeIds.has(e.from) && validNodeIds.has(e.to))
    .map(e => ({
      from: e.from,
      to: e.to,
      relationship: validateRelationship(e.relationship),
      weight: Math.min(Math.max(e.weight || 0.5, 0), 1),
    }));

  return {
    topicId,
    topic,
    domain,
    nodes,
    edges,
    generatedAt: now,
  };
}

// ============================================
// GRAPH OPERATIONS
// ============================================

/**
 * Get the next concepts to learn based on current mastery
 */
export function getNextConcepts(graph: ConceptGraph, limit: number = 3): ConceptNode[] {
  // Find concepts where all prerequisites are mastered (mastery >= 0.7)
  // but the concept itself is not yet mastered
  const ready = graph.nodes.filter(node => {
    if (node.mastery >= 0.7) return false; // Already mastered
    return node.prerequisites.every(preId => {
      const pre = graph.nodes.find(n => n.id === preId);
      return pre ? pre.mastery >= 0.7 : true; // If prerequisite missing, allow
    });
  });

  // Sort by difficulty (easier first) and then by number of dependents (more dependents first)
  const dependentCount = new Map<string, number>();
  for (const edge of graph.edges) {
    dependentCount.set(edge.from, (dependentCount.get(edge.from) || 0) + 1);
  }

  return ready
    .sort((a, b) => {
      const diffOrder: Record<DifficultyTier, number> = {
        novice: 0, beginner: 1, intermediate: 2, advanced: 3, expert: 4,
      };
      const diffDiff = diffOrder[a.difficulty] - diffOrder[b.difficulty];
      if (diffDiff !== 0) return diffDiff;
      return (dependentCount.get(b.id) || 0) - (dependentCount.get(a.id) || 0);
    })
    .slice(0, limit);
}

/**
 * Update mastery for a concept in the graph
 */
export function updateConceptMastery(
  graph: ConceptGraph,
  conceptId: string,
  newMastery: number
): ConceptGraph {
  return {
    ...graph,
    nodes: graph.nodes.map(node =>
      node.id === conceptId
        ? { ...node, mastery: Math.min(Math.max(newMastery, 0), 1) }
        : node
    ),
  };
}

/**
 * Calculate overall topic mastery from the concept graph
 */
export function calculateTopicMastery(graph: ConceptGraph): number {
  if (graph.nodes.length === 0) return 0;
  const totalMastery = graph.nodes.reduce((sum, n) => sum + n.mastery, 0);
  return totalMastery / graph.nodes.length;
}

/**
 * Get the learning path (topological sort considering prerequisites)
 */
export function getLearningPath(graph: ConceptGraph): ConceptNode[] {
  const visited = new Set<string>();
  const result: ConceptNode[] = [];
  const nodeMap = new Map(graph.nodes.map(n => [n.id, n]));

  function visit(nodeId: string) {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);

    const node = nodeMap.get(nodeId);
    if (!node) return;

    // Visit prerequisites first
    for (const preId of node.prerequisites) {
      visit(preId);
    }

    result.push(node);
  }

  for (const node of graph.nodes) {
    visit(node.id);
  }

  return result;
}

// ============================================
// HELPERS
// ============================================

function validateDifficulty(d: string): DifficultyTier {
  const valid: DifficultyTier[] = ['novice', 'beginner', 'intermediate', 'advanced', 'expert'];
  return valid.includes(d as DifficultyTier) ? (d as DifficultyTier) : 'beginner';
}

function validateRelationship(r: string): ConceptEdge['relationship'] {
  const valid = ['prerequisite', 'related', 'builds-on', 'applies'] as const;
  return valid.includes(r as any) ? (r as ConceptEdge['relationship']) : 'related';
}

function createFallbackGraph(topic: string, domain: DomainType): ConceptGraph {
  const topicId = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const now = new Date().toISOString();

  const fundamentals: ConceptNode = {
    id: `${topicId}-fundamentals`,
    name: `${topic} Fundamentals`,
    description: `Core concepts and foundations of ${topic}`,
    domain,
    difficulty: 'novice',
    prerequisites: [],
    mastery: 0,
  };

  const intermediate: ConceptNode = {
    id: `${topicId}-intermediate`,
    name: `${topic} Intermediate Concepts`,
    description: `Building on the fundamentals of ${topic}`,
    domain,
    difficulty: 'intermediate',
    prerequisites: [fundamentals.id],
    mastery: 0,
  };

  const advanced: ConceptNode = {
    id: `${topicId}-advanced`,
    name: `${topic} Advanced Topics`,
    description: `Advanced concepts and applications in ${topic}`,
    domain,
    difficulty: 'advanced',
    prerequisites: [intermediate.id],
    mastery: 0,
  };

  return {
    topicId,
    topic,
    domain,
    nodes: [fundamentals, intermediate, advanced],
    edges: [
      { from: fundamentals.id, to: intermediate.id, relationship: 'prerequisite', weight: 1 },
      { from: intermediate.id, to: advanced.id, relationship: 'prerequisite', weight: 1 },
    ],
    generatedAt: now,
  };
}
