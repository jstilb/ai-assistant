/**
 * Concept Graph Tests
 *
 * Tests graph operations (next concepts, mastery tracking, learning path).
 * AI graph generation is tested in integration tests.
 */

import { describe, it, expect } from 'vitest';
import {
  getNextConcepts,
  updateConceptMastery,
  calculateTopicMastery,
  getLearningPath,
} from '../src/algorithms/concept-graph.ts';
import type { ConceptGraph, ConceptNode } from '../src/types/index.ts';

function makeGraph(): ConceptGraph {
  return {
    topicId: 'test-topic',
    topic: 'Test Topic',
    domain: 'programming',
    nodes: [
      {
        id: 'basics',
        name: 'Basics',
        description: 'Fundamental concepts',
        domain: 'programming',
        difficulty: 'novice',
        prerequisites: [],
        mastery: 0,
      },
      {
        id: 'intermediate',
        name: 'Intermediate',
        description: 'Building on basics',
        domain: 'programming',
        difficulty: 'intermediate',
        prerequisites: ['basics'],
        mastery: 0,
      },
      {
        id: 'advanced',
        name: 'Advanced',
        description: 'Advanced concepts',
        domain: 'programming',
        difficulty: 'advanced',
        prerequisites: ['intermediate'],
        mastery: 0,
      },
    ],
    edges: [
      { from: 'basics', to: 'intermediate', relationship: 'prerequisite', weight: 1 },
      { from: 'intermediate', to: 'advanced', relationship: 'prerequisite', weight: 1 },
    ],
    generatedAt: new Date().toISOString(),
  };
}

describe('Concept Graph', () => {
  describe('getNextConcepts', () => {
    it('should return foundational concepts when nothing is mastered', () => {
      const graph = makeGraph();
      const next = getNextConcepts(graph);
      expect(next).toHaveLength(1);
      expect(next[0].id).toBe('basics');
    });

    it('should return next tier after basics are mastered', () => {
      const graph = makeGraph();
      graph.nodes[0].mastery = 0.8; // basics mastered
      const next = getNextConcepts(graph);
      expect(next).toHaveLength(1);
      expect(next[0].id).toBe('intermediate');
    });

    it('should not return already mastered concepts', () => {
      const graph = makeGraph();
      graph.nodes[0].mastery = 0.9;
      graph.nodes[1].mastery = 0.8;
      const next = getNextConcepts(graph);
      expect(next.find(n => n.id === 'basics')).toBeUndefined();
      expect(next.find(n => n.id === 'intermediate')).toBeUndefined();
      expect(next[0].id).toBe('advanced');
    });

    it('should respect the limit parameter', () => {
      const graph = makeGraph();
      // All prerequisites met for all concepts (no prerequisites for basics)
      graph.nodes[0].mastery = 0.8;
      graph.nodes[1].mastery = 0.8;
      const next = getNextConcepts(graph, 1);
      expect(next.length).toBeLessThanOrEqual(1);
    });

    it('should return empty when all concepts are mastered', () => {
      const graph = makeGraph();
      graph.nodes.forEach(n => n.mastery = 0.9);
      const next = getNextConcepts(graph);
      expect(next).toHaveLength(0);
    });
  });

  describe('updateConceptMastery', () => {
    it('should update the mastery of the specified concept', () => {
      const graph = makeGraph();
      const updated = updateConceptMastery(graph, 'basics', 0.75);
      const node = updated.nodes.find(n => n.id === 'basics');
      expect(node?.mastery).toBe(0.75);
    });

    it('should not affect other concepts', () => {
      const graph = makeGraph();
      const updated = updateConceptMastery(graph, 'basics', 0.75);
      const other = updated.nodes.find(n => n.id === 'intermediate');
      expect(other?.mastery).toBe(0);
    });

    it('should clamp mastery to 0-1 range', () => {
      const graph = makeGraph();
      const high = updateConceptMastery(graph, 'basics', 1.5);
      expect(high.nodes.find(n => n.id === 'basics')?.mastery).toBe(1);

      const low = updateConceptMastery(graph, 'basics', -0.5);
      expect(low.nodes.find(n => n.id === 'basics')?.mastery).toBe(0);
    });
  });

  describe('calculateTopicMastery', () => {
    it('should return 0 for no mastery', () => {
      const graph = makeGraph();
      expect(calculateTopicMastery(graph)).toBe(0);
    });

    it('should return average mastery across all concepts', () => {
      const graph = makeGraph();
      graph.nodes[0].mastery = 0.9;
      graph.nodes[1].mastery = 0.6;
      graph.nodes[2].mastery = 0.3;
      const mastery = calculateTopicMastery(graph);
      expect(mastery).toBeCloseTo(0.6, 1);
    });

    it('should return 0 for empty graph', () => {
      const graph: ConceptGraph = {
        topicId: 'empty',
        topic: 'Empty',
        domain: 'programming',
        nodes: [],
        edges: [],
        generatedAt: new Date().toISOString(),
      };
      expect(calculateTopicMastery(graph)).toBe(0);
    });
  });

  describe('getLearningPath', () => {
    it('should return concepts in topological order', () => {
      const graph = makeGraph();
      const path = getLearningPath(graph);
      expect(path).toHaveLength(3);
      expect(path[0].id).toBe('basics');
      expect(path[1].id).toBe('intermediate');
      expect(path[2].id).toBe('advanced');
    });

    it('should handle graphs with no edges', () => {
      const graph: ConceptGraph = {
        topicId: 'flat',
        topic: 'Flat',
        domain: 'programming',
        nodes: [
          { id: 'a', name: 'A', description: '', domain: 'programming', difficulty: 'novice', prerequisites: [], mastery: 0 },
          { id: 'b', name: 'B', description: '', domain: 'programming', difficulty: 'novice', prerequisites: [], mastery: 0 },
        ],
        edges: [],
        generatedAt: new Date().toISOString(),
      };
      const path = getLearningPath(graph);
      expect(path).toHaveLength(2);
    });
  });
});
