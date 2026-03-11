/**
 * DigitalMaestro Type Definitions
 *
 * Core types for the adaptive learning engine including domain classification,
 * spaced repetition cards, concept graphs, exercises, and session management.
 */

// ============================================
// DOMAIN TYPES
// ============================================

/** The five supported learning domains */
export type DomainType =
  | 'programming'
  | 'language'
  | 'science'
  | 'math'
  | 'humanities';

/** Domain classification result from AI */
export interface DomainClassification {
  domain: DomainType;
  confidence: number; // 0-1
  subDomain: string;  // e.g., "web development", "organic chemistry"
  keywords: string[];
}

// ============================================
// DIFFICULTY TYPES
// ============================================

/** Five adaptive difficulty tiers */
export type DifficultyTier =
  | 'novice'
  | 'beginner'
  | 'intermediate'
  | 'advanced'
  | 'expert';

/** Difficulty assessment for a learner on a topic */
export interface DifficultyAssessment {
  tier: DifficultyTier;
  score: number;        // 0-100 numeric difficulty score
  rationale: string;    // Why this tier was assigned
  adjustedAt: string;   // ISO timestamp of last adjustment
}

// ============================================
// FSRS (SPACED REPETITION) TYPES
// ============================================

/** FSRS v4 card state */
export type CardState = 'new' | 'learning' | 'review' | 'relearning';

/** FSRS rating for a review */
export type FSRSRating = 1 | 2 | 3 | 4; // Again, Hard, Good, Easy

/** FSRS card parameters */
export interface FSRSCard {
  id: string;
  topicId: string;
  front: string;
  back: string;
  state: CardState;
  difficulty: number;   // 0-1, higher = harder
  stability: number;    // days until 90% retention probability
  retrievability: number; // current retention probability 0-1
  lastReview: string;   // ISO timestamp
  nextReview: string;   // ISO timestamp
  reps: number;
  lapses: number;
  createdAt: string;
}

/** Result of an FSRS scheduling operation */
export interface FSRSScheduleResult {
  card: FSRSCard;
  intervalDays: number;
  nextReviewDate: string;
}

// ============================================
// CONCEPT GRAPH TYPES
// ============================================

/** A node in the concept graph */
export interface ConceptNode {
  id: string;
  name: string;
  description: string;
  domain: DomainType;
  difficulty: DifficultyTier;
  prerequisites: string[];  // IDs of prerequisite concepts
  mastery: number;          // 0-1, learner's mastery level
}

/** An edge connecting two concepts */
export interface ConceptEdge {
  from: string;  // ConceptNode ID
  to: string;    // ConceptNode ID
  relationship: 'prerequisite' | 'related' | 'builds-on' | 'applies';
  weight: number; // 0-1 strength of connection
}

/** Complete concept graph for a topic */
export interface ConceptGraph {
  topicId: string;
  topic: string;
  domain: DomainType;
  nodes: ConceptNode[];
  edges: ConceptEdge[];
  generatedAt: string;
}

// ============================================
// EXERCISE TYPES
// ============================================

/** Types of exercises the system can generate */
export type ExerciseType =
  | 'multiple-choice'
  | 'fill-in-the-blank'
  | 'code-challenge'
  | 'essay-prompt'
  | 'translation'
  | 'problem-solve'
  | 'diagram-label'
  | 'short-answer';

/** A generated exercise */
export interface Exercise {
  id: string;
  type: ExerciseType;
  domain: DomainType;
  difficulty: DifficultyTier;
  conceptId: string;
  prompt: string;
  /** For multiple-choice: the options */
  options?: string[];
  /** Reference answer for evaluation */
  referenceAnswer: string;
  /** Hints available (progressive disclosure) */
  hints: string[];
  /** Time limit in seconds (0 = no limit) */
  timeLimit: number;
  /** Tags for categorization */
  tags: string[];
}

// ============================================
// EVALUATION TYPES
// ============================================

/** Result of AI evaluation of a learner's answer */
export interface EvaluationResult {
  exerciseId: string;
  correct: boolean;
  score: number;        // 0-100
  feedback: string;     // Detailed feedback
  explanation: string;  // Why the answer was correct/incorrect
  strengths: string[];  // What the learner did well
  weaknesses: string[]; // Areas for improvement
  suggestedReview: string[]; // Concepts to review
  evaluatedAt: string;  // ISO timestamp
}

// ============================================
// SESSION TYPES
// ============================================

/** Phases of a learning session */
export type SessionPhase =
  | 'warm-up'     // SRS review of due cards
  | 'new-content' // Introduction of new concepts
  | 'practice'    // Exercises on current concepts
  | 'reflection'; // Summary and self-assessment

/** Configuration for a learning session */
export interface SessionConfig {
  topic: string;
  domain?: DomainType;      // Auto-detected if not provided
  maxDurationMinutes: number;
  targetNewConcepts: number; // How many new concepts to introduce
  reviewLimit: number;       // Max cards to review in warm-up
}

/** A complete learning session */
export interface Session {
  id: string;
  config: SessionConfig;
  domain: DomainType;
  difficulty: DifficultyAssessment;
  currentPhase: SessionPhase;
  /** Cards due for review (warm-up phase) */
  reviewCards: FSRSCard[];
  /** New concepts introduced this session */
  newConcepts: ConceptNode[];
  /** Exercises generated for practice */
  exercises: Exercise[];
  /** Evaluations completed */
  evaluations: EvaluationResult[];
  /** Session start time */
  startedAt: string;
  /** Session end time (null if in progress) */
  endedAt: string | null;
  /** Session statistics */
  stats: SessionStats;
}

/** Statistics for a session */
export interface SessionStats {
  cardsReviewed: number;
  cardsCorrect: number;
  exercisesCompleted: number;
  exercisesCorrect: number;
  averageScore: number;
  conceptsIntroduced: number;
  conceptsMastered: number;
  totalTimeMinutes: number;
}

// ============================================
// LEARNER PROGRESS TYPES
// ============================================

/** Overall learner progress for a topic */
export interface TopicProgress {
  topicId: string;
  topic: string;
  domain: DomainType;
  difficulty: DifficultyAssessment;
  conceptGraph: ConceptGraph;
  totalCards: number;
  cardsDue: number;
  masteredConcepts: number;
  totalConcepts: number;
  currentStreak: number;
  longestStreak: number;
  lastStudied: string;
  totalSessions: number;
  totalTimeMinutes: number;
}

/** Streak tracking */
export interface StreakData {
  currentStreak: number;
  longestStreak: number;
  lastStudyDate: string; // YYYY-MM-DD
  studyDates: string[];  // Array of YYYY-MM-DD dates
}

// ============================================
// PERSISTENCE STATE TYPES
// ============================================

/** Complete persisted state for DigitalMaestro */
export interface DigitalMaestroState {
  topics: Record<string, TopicProgress>;
  cards: Record<string, FSRSCard>;
  graphs: Record<string, ConceptGraph>;
  streaks: StreakData;
  sessions: SessionSummary[];
  lastUpdated: string;
}

/** Lightweight session summary for history */
export interface SessionSummary {
  id: string;
  topic: string;
  domain: DomainType;
  date: string;
  stats: SessionStats;
}
