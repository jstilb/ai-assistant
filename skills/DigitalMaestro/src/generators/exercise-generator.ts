/**
 * Exercise Generator
 *
 * Generates domain-appropriate exercises using AI inference.
 * Each domain has preferred exercise types and formatting rules.
 */

import { inference } from '../../../CORE/Tools/Inference.ts';
import type {
  Exercise,
  ExerciseType,
  DomainType,
  DifficultyTier,
  ConceptNode,
} from '../types/index.ts';

// ============================================
// DOMAIN EXERCISE PREFERENCES
// ============================================

/** Preferred exercise types per domain */
const DOMAIN_EXERCISE_TYPES: Record<DomainType, ExerciseType[]> = {
  programming: ['code-challenge', 'multiple-choice', 'short-answer', 'fill-in-the-blank'],
  language: ['translation', 'fill-in-the-blank', 'multiple-choice', 'short-answer'],
  science: ['multiple-choice', 'short-answer', 'problem-solve', 'diagram-label'],
  math: ['problem-solve', 'fill-in-the-blank', 'multiple-choice', 'short-answer'],
  humanities: ['essay-prompt', 'multiple-choice', 'short-answer', 'fill-in-the-blank'],
};

/** Time limits in seconds by difficulty */
const TIME_LIMITS: Record<DifficultyTier, number> = {
  novice: 120,
  beginner: 90,
  intermediate: 60,
  advanced: 45,
  expert: 30,
};

// ============================================
// EXERCISE GENERATION
// ============================================

/**
 * Generate exercises for a concept using AI
 */
export async function generateExercises(
  concept: ConceptNode,
  count: number = 3,
  preferredTypes?: ExerciseType[]
): Promise<Exercise[]> {
  const types = preferredTypes || DOMAIN_EXERCISE_TYPES[concept.domain];
  const selectedTypes = selectExerciseTypes(types, count);

  const systemPrompt = `You are an expert educator creating exercises for a learning system.
Generate exactly ${count} exercises for the given concept.

Return ONLY valid JSON array:
[
  {
    "type": "${selectedTypes[0]}",
    "prompt": "The exercise prompt/question",
    "options": ["A", "B", "C", "D"],
    "referenceAnswer": "The correct answer with explanation",
    "hints": ["First hint", "Second hint"],
    "tags": ["relevant", "tags"]
  }
]

Exercise type rules:
- multiple-choice: Include exactly 4 options. referenceAnswer should be the correct option letter and explanation.
- fill-in-the-blank: Use ___ for blanks in the prompt. referenceAnswer is what fills the blank.
- code-challenge: Prompt describes what code to write. referenceAnswer is a working solution.
- essay-prompt: Open-ended question. referenceAnswer is key points to cover.
- translation: Provide text to translate. referenceAnswer is the correct translation.
- problem-solve: Present a problem. referenceAnswer shows the solution steps.
- short-answer: Brief factual question. referenceAnswer is the concise correct answer.
- diagram-label: Describe what to label. referenceAnswer lists correct labels.

Difficulty: ${concept.difficulty}
Domain: ${concept.domain}
Use ${count} exercises with types: ${selectedTypes.join(', ')}`;

  const userPrompt = `Create ${count} ${concept.difficulty}-level exercises for the concept: "${concept.name}"
Description: ${concept.description}
Domain: ${concept.domain}`;

  try {
    const result = await inference({
      systemPrompt,
      userPrompt,
      level: 'standard',
      expectJson: true,
      timeout: 45000,
    });

    if (result.success && result.parsed && Array.isArray(result.parsed)) {
      return (result.parsed as any[]).map((ex, i) => ({
        id: `ex-${concept.id}-${Date.now()}-${i}`,
        type: validateExerciseType(ex.type) || selectedTypes[i % selectedTypes.length],
        domain: concept.domain,
        difficulty: concept.difficulty,
        conceptId: concept.id,
        prompt: ex.prompt || `Practice exercise for ${concept.name}`,
        options: ex.options,
        referenceAnswer: ex.referenceAnswer || '',
        hints: ex.hints || [],
        timeLimit: TIME_LIMITS[concept.difficulty],
        tags: ex.tags || [concept.name],
      }));
    }
  } catch {
    // Fall through to fallback
  }

  // Fallback: generate simple exercises without AI
  return generateFallbackExercises(concept, count, selectedTypes);
}

/**
 * Generate a single exercise for a specific type
 */
export async function generateSingleExercise(
  concept: ConceptNode,
  type: ExerciseType
): Promise<Exercise> {
  const exercises = await generateExercises(concept, 1, [type]);
  return exercises[0];
}

/**
 * Get the preferred exercise types for a domain
 */
export function getExerciseTypesForDomain(domain: DomainType): ExerciseType[] {
  return DOMAIN_EXERCISE_TYPES[domain];
}

// ============================================
// HELPERS
// ============================================

/**
 * Select exercise types to generate, distributing across preferred types
 */
function selectExerciseTypes(preferred: ExerciseType[], count: number): ExerciseType[] {
  const selected: ExerciseType[] = [];
  for (let i = 0; i < count; i++) {
    selected.push(preferred[i % preferred.length]);
  }
  return selected;
}

function validateExerciseType(type: string): ExerciseType | null {
  const valid: ExerciseType[] = [
    'multiple-choice', 'fill-in-the-blank', 'code-challenge',
    'essay-prompt', 'translation', 'problem-solve',
    'diagram-label', 'short-answer',
  ];
  return valid.includes(type as ExerciseType) ? (type as ExerciseType) : null;
}

function generateFallbackExercises(
  concept: ConceptNode,
  count: number,
  types: ExerciseType[]
): Exercise[] {
  return types.slice(0, count).map((type, i) => ({
    id: `ex-${concept.id}-${Date.now()}-${i}`,
    type,
    domain: concept.domain,
    difficulty: concept.difficulty,
    conceptId: concept.id,
    prompt: generateFallbackPrompt(concept, type),
    options: type === 'multiple-choice' ? ['A', 'B', 'C', 'D'] : undefined,
    referenceAnswer: `Review the concept: ${concept.name} - ${concept.description}`,
    hints: [`Think about the core principles of ${concept.name}`],
    timeLimit: TIME_LIMITS[concept.difficulty],
    tags: [concept.name, concept.domain],
  }));
}

function generateFallbackPrompt(concept: ConceptNode, type: ExerciseType): string {
  switch (type) {
    case 'multiple-choice':
      return `Which of the following best describes ${concept.name}?`;
    case 'fill-in-the-blank':
      return `${concept.name} is defined as ___.`;
    case 'code-challenge':
      return `Write code that demonstrates ${concept.name}.`;
    case 'essay-prompt':
      return `Explain the significance of ${concept.name} and how it relates to the broader topic.`;
    case 'translation':
      return `Translate the following concept into your target language: ${concept.name}`;
    case 'problem-solve':
      return `Using ${concept.name}, solve the following problem: [describe the problem]`;
    case 'short-answer':
      return `In 1-2 sentences, define ${concept.name}.`;
    case 'diagram-label':
      return `Identify and label the key components related to ${concept.name}.`;
    default:
      return `Explain ${concept.name} in your own words.`;
  }
}
