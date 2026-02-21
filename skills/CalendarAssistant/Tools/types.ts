/**
 * types.ts - Shared type definitions for CalendarAssistant
 *
 * All cross-component communication uses these typed interfaces.
 * Uses Result<T,E> pattern for all fallible operations.
 *
 * @module types
 */

// ============================================
// RESULT TYPE
// ============================================

export type Result<T, E = CalendarError> =
  | { success: true; data: T }
  | { success: false; error: E };

// ============================================
// ERROR TYPES
// ============================================

export interface CalendarError {
  code:
    | "API_UNAVAILABLE"
    | "AUTH_EXPIRED"
    | "RATE_LIMITED"
    | "CONFLICT"
    | "VALIDATION"
    | "PARSE_ERROR"
    | "APPROVAL_REQUIRED"
    | "SAFETY_BLOCKED"
    | "TIMEOUT"
    | "UNKNOWN";
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
}

// ============================================
// INTENT TYPES
// ============================================

export enum IntentType {
  Create = "create",
  Modify = "modify",
  Delete = "delete",
  Move = "move",
  Query = "query",
  Optimize = "optimize",
  Analyze = "analyze",
}

export interface ParsedIntent {
  type: IntentType;
  confidence: number;
  entities: IntentEntities;
  rawInput: string;
}

export interface IntentEntities {
  title?: string;
  time?: string;
  endTime?: string;
  duration?: number;
  attendees?: string[];
  location?: string;
  recurrence?: string;
  description?: string;
  eventId?: string;
  timeRange?: { start: string; end: string };
}

// ============================================
// TEMPORAL TYPES
// ============================================

export interface ResolvedTime {
  start: string;
  end: string;
  timezone: string;
  confidence: number;
  originalExpression: string;
}

export interface ClarificationRequest {
  type: "clarification";
  question: string;
  options?: string[];
  originalExpression: string;
}

export type TemporalResult = ResolvedTime | ClarificationRequest;

// ============================================
// CALENDAR TYPES
// ============================================

export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  location?: string;
  description?: string;
  attendees?: string[];
  isAllDay: boolean;
  isRecurring: boolean;
  calendarName?: string;
}

export interface NewEvent {
  title: string;
  start: string;
  end: string;
  location?: string;
  description?: string;
  attendees?: string[];
  isAllDay?: boolean;
}

export interface EventUpdate {
  eventId: string;
  title?: string;
  start?: string;
  end?: string;
  location?: string;
  description?: string;
  attendees?: string[];
}

// ============================================
// GOAL TYPES
// ============================================

export enum GoalLevel {
  Yearly = "yearly",
  Quarterly = "quarterly",
  Weekly = "weekly",
}

export interface Goal {
  id: string;
  title: string;
  level: GoalLevel;
  parentId?: string;
  status: "active" | "completed" | "paused";
  keywords: string[];
  targetHoursPerWeek?: number;
  createdAt: string;
  updatedAt: string;
}

export interface GoalAlignment {
  goalId: string;
  goalTitle: string;
  score: number;
  matchedKeywords: string[];
}

export interface EventAlignment {
  event: CalendarEvent;
  alignments: GoalAlignment[];
  overallScore: number;
}

// ============================================
// BREAK TYPES
// ============================================

export enum BreakFramework {
  Pomodoro = "pomodoro",
  FiftyTwoSeventeen = "52-17",
  Custom = "custom",
}

export interface BreakConfig {
  framework: BreakFramework;
  workMinutes: number;
  breakMinutes: number;
  longBreakMinutes?: number;
  longBreakInterval?: number;
}

export interface BreakSuggestion {
  start: string;
  end: string;
  type: "short" | "long";
  reason: string;
}

export interface BreakAnalysis {
  coverage: number;
  suggestions: BreakSuggestion[];
  removedBreaks: string[];
  warning?: string;
}

// ============================================
// CONFLICT TYPES
// ============================================

export enum ConflictType {
  FullOverlap = "full_overlap",
  PartialOverlap = "partial_overlap",
  AdjacentNoGap = "adjacent_no_gap",
  AllDayVsTimed = "allday_vs_timed",
  RecurringOverlap = "recurring_overlap",
}

export interface Conflict {
  type: ConflictType;
  eventA: CalendarEvent;
  eventB: CalendarEvent;
  overlapMinutes: number;
  resolutionOptions: ResolutionOption[];
}

export interface ResolutionOption {
  description: string;
  action: "move" | "shorten" | "delete" | "ask_user";
  targetEvent: string;
  suggestedTime?: string;
  suggestedDuration?: number;
}

// ============================================
// OPTIMIZATION TYPES
// ============================================

export interface SlotScore {
  goalAlignment: number;
  timeOfDayPreference: number;
  breakCoverageImpact: number;
  calendarDensity: number;
  composite: number;
}

export interface ScoredSlot {
  start: string;
  end: string;
  score: SlotScore;
  rationale: string;
}

export interface OptimizationWeights {
  goalAlignment: number;
  timeOfDayPreference: number;
  breakCoverageImpact: number;
  calendarDensity: number;
}

export interface OptimizationSuggestion {
  type: "insert_break" | "move_event" | "resolve_conflict" | "reorder";
  description: string;
  impact: string;
  rationale: string;
  priority: "high" | "medium" | "low";
}

// ============================================
// APPROVAL TYPES
// ============================================

export enum ApprovalTrigger {
  ExternalAttendees = "external_attendees",
  RecurringDeletion = "recurring_deletion",
  ProtectedTime = "protected_time",
  LowConfidence = "low_confidence",
}

export interface ApprovalRequest {
  action: string;
  reason: ApprovalTrigger;
  impact: string;
  options: string[];
  event?: CalendarEvent | NewEvent;
  intent?: ParsedIntent;
}

// ============================================
// PREFERENCE TYPES
// ============================================

export interface UserPreferences {
  workingHours: { start: string; end: string };
  protectedBlocks: ProtectedBlock[];
  breakFramework: BreakConfig;
  optimizationWeights: OptimizationWeights;
  preferredFocusTime: "morning" | "afternoon" | "evening";
  defaultEventDuration: number;
  bufferMinutesBetweenEvents: number;
  overrides: OverrideRecord[];
  lastUpdated: string;
}

export interface ProtectedBlock {
  label: string;
  dayOfWeek?: number[];
  start: string;
  end: string;
}

export interface OverrideRecord {
  type: string;
  originalValue: string;
  newValue: string;
  timestamp: string;
  count: number;
}

// ============================================
// AUDIT TYPES
// ============================================

export interface AuditEntry {
  timestamp: string;
  actionType: IntentType | "approval" | "break_insert" | "optimization";
  eventId?: string;
  confidence: number;
  rationalePreview: string;
  approvalStatus: "auto" | "approved" | "denied" | "pending";
  dryRun: boolean;
  details?: Record<string, unknown>;
}

// ============================================
// RATIONALE TYPES
// ============================================

export interface Rationale {
  summary: string;
  dimensions: RationaleDimension[];
  recommendation?: string;
}

export interface RationaleDimension {
  name: string;
  score: number;
  explanation: string;
}

// ============================================
// ORCHESTRATOR TYPES
// ============================================

export interface OrchestratorResponse {
  action: string;
  success: boolean;
  rationale: Rationale;
  event?: CalendarEvent;
  events?: CalendarEvent[];
  conflicts?: Conflict[];
  suggestions?: OptimizationSuggestion[];
  alignments?: EventAlignment[];
  breakAnalysis?: BreakAnalysis;
  approvalRequired?: ApprovalRequest;
  dryRun: boolean;
}

export interface OrchestratorConfig {
  dryRun: boolean;
  timezone: string;
  kayaDir: string;
}
