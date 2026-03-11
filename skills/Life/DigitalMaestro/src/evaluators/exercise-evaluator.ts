/**
 * Exercise Evaluator
 *
 * AI-powered evaluation of learner answers with detailed feedback,
 * correctness assessment, explanation, and improvement suggestions.
 * Uses the Kaya Inference tool at standard level for balanced reasoning.
 */

import { inference } from '../../../../../lib/core/Inference.ts';
import type { Exercise, EvaluationResult } from '../types/index.ts';

// ============================================
// EVALUATION
// ============================================

/**
 * Evaluate a learner's answer to an exercise using AI
 */
export async function evaluateAnswer(
  exercise: Exercise,
  learnerAnswer: string
): Promise<EvaluationResult> {
  const systemPrompt = `You are an expert educator evaluating a student's answer.
Be encouraging but honest. Provide specific, actionable feedback.

Return ONLY valid JSON:
{
  "correct": true,
  "score": 85,
  "feedback": "Detailed feedback on the answer",
  "explanation": "Why the answer is correct/incorrect with the right answer",
  "strengths": ["What the student did well"],
  "weaknesses": ["Areas for improvement"],
  "suggestedReview": ["Concepts to review"]
}

Scoring guide:
- 90-100: Excellent, thorough understanding
- 75-89: Good, mostly correct with minor gaps
- 60-74: Adequate, correct core idea but missing details
- 40-59: Partial, some understanding but significant gaps
- 0-39: Needs review, fundamental misunderstanding

Exercise type: ${exercise.type}
Domain: ${exercise.domain}
Difficulty: ${exercise.difficulty}`;

  const userPrompt = `Exercise: ${exercise.prompt}
${exercise.options ? `Options: ${exercise.options.join(', ')}` : ''}
Reference Answer: ${exercise.referenceAnswer}

Student's Answer: ${learnerAnswer}

Evaluate the student's answer against the reference answer.`;

  try {
    const result = await inference({
      systemPrompt,
      userPrompt,
      level: 'standard',
      expectJson: true,
      timeout: 30000,
    });

    if (result.success && result.parsed) {
      const parsed = result.parsed as {
        correct: boolean;
        score: number;
        feedback: string;
        explanation: string;
        strengths: string[];
        weaknesses: string[];
        suggestedReview: string[];
      };

      return {
        exerciseId: exercise.id,
        correct: parsed.correct ?? false,
        score: clampScore(parsed.score),
        feedback: parsed.feedback || 'No feedback available.',
        explanation: parsed.explanation || '',
        strengths: parsed.strengths || [],
        weaknesses: parsed.weaknesses || [],
        suggestedReview: parsed.suggestedReview || [],
        evaluatedAt: new Date().toISOString(),
      };
    }
  } catch {
    // Fall through to heuristic evaluation
  }

  // Heuristic fallback when AI is unavailable
  return evaluateWithHeuristics(exercise, learnerAnswer);
}

/**
 * Batch evaluate multiple answers
 */
export async function evaluateAnswers(
  pairs: Array<{ exercise: Exercise; answer: string }>
): Promise<EvaluationResult[]> {
  // Process sequentially to avoid overwhelming the inference service
  const results: EvaluationResult[] = [];
  for (const pair of pairs) {
    const result = await evaluateAnswer(pair.exercise, pair.answer);
    results.push(result);
  }
  return results;
}

// ============================================
// HEURISTIC EVALUATION
// ============================================

/**
 * Simple heuristic evaluation when AI is unavailable.
 * Uses string similarity and keyword matching.
 */
export function evaluateWithHeuristics(
  exercise: Exercise,
  learnerAnswer: string
): EvaluationResult {
  const reference = exercise.referenceAnswer.toLowerCase().trim();
  const answer = learnerAnswer.toLowerCase().trim();

  // Empty answer check (allow single-char answers for multiple choice)
  const minLength = exercise.type === 'multiple-choice' ? 1 : 2;
  if (!answer || answer.length < minLength) {
    return {
      exerciseId: exercise.id,
      correct: false,
      score: 0,
      feedback: 'No answer was provided. Please try again.',
      explanation: `The expected answer was: ${exercise.referenceAnswer}`,
      strengths: [],
      weaknesses: ['No answer provided'],
      suggestedReview: [exercise.conceptId],
      evaluatedAt: new Date().toISOString(),
    };
  }

  // For multiple choice, exact match on option letter
  if (exercise.type === 'multiple-choice') {
    const answerLetter = answer.charAt(0).toUpperCase();
    const refLetter = reference.charAt(0).toUpperCase();
    const isCorrect = answerLetter === refLetter;

    return {
      exerciseId: exercise.id,
      correct: isCorrect,
      score: isCorrect ? 100 : 0,
      feedback: isCorrect
        ? 'Correct!'
        : `Incorrect. The correct answer was ${refLetter}.`,
      explanation: exercise.referenceAnswer,
      strengths: isCorrect ? ['Correct answer selected'] : [],
      weaknesses: isCorrect ? [] : ['Incorrect option selected'],
      suggestedReview: isCorrect ? [] : [exercise.conceptId],
      evaluatedAt: new Date().toISOString(),
    };
  }

  // Keyword overlap scoring for other types
  const refWords = extractKeywords(reference);
  const ansWords = extractKeywords(answer);
  const overlap = refWords.filter(w => ansWords.includes(w)).length;
  const coverage = refWords.length > 0 ? overlap / refWords.length : 0;

  // Similarity score (0-100)
  const similarityScore = Math.round(coverage * 100);
  const isCorrect = similarityScore >= 60;

  const strengths: string[] = [];
  const weaknesses: string[] = [];

  if (coverage >= 0.8) strengths.push('Comprehensive answer covering key points');
  else if (coverage >= 0.5) strengths.push('Some key concepts addressed');

  if (coverage < 0.5) weaknesses.push('Missing several key concepts from the reference answer');
  if (answer.length < reference.length * 0.3) weaknesses.push('Answer could be more detailed');

  return {
    exerciseId: exercise.id,
    correct: isCorrect,
    score: similarityScore,
    feedback: isCorrect
      ? `Good answer! You covered ${Math.round(coverage * 100)}% of the key concepts.`
      : `Your answer covers ${Math.round(coverage * 100)}% of the key concepts. Review the reference answer for missing details.`,
    explanation: `Reference answer: ${exercise.referenceAnswer}`,
    strengths,
    weaknesses,
    suggestedReview: isCorrect ? [] : [exercise.conceptId],
    evaluatedAt: new Date().toISOString(),
  };
}

// ============================================
// HELPERS
// ============================================

function clampScore(score: number): number {
  if (typeof score !== 'number' || isNaN(score)) return 0;
  return Math.min(Math.max(Math.round(score), 0), 100);
}

function extractKeywords(text: string): string[] {
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
    'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
    'before', 'after', 'above', 'below', 'between', 'but', 'and', 'or',
    'not', 'no', 'nor', 'so', 'if', 'then', 'than', 'too', 'very',
    'just', 'about', 'also', 'this', 'that', 'these', 'those', 'it',
    'its', 'my', 'your', 'our', 'their', 'we', 'you', 'they', 'he',
    'she', 'him', 'her', 'them', 'i', 'me', 'us',
  ]);

  return text
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));
}
