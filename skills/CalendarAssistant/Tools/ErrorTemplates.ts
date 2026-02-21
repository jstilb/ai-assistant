#!/usr/bin/env bun
/**
 * ErrorTemplates - User-friendly error messages for CalendarAssistant
 *
 * Maps technical errors to human-readable messages with error codes,
 * remediation steps, and context. Never exposes stack traces to users.
 *
 * Usage:
 *   import { getUserMessage } from './ErrorTemplates.ts';
 *   const msg = getUserMessage(error);
 */

// ============================================================================
// Types
// ============================================================================

export interface UserError {
  code: string;
  message: string;
  remediation: string;
  severity: 'warning' | 'error' | 'fatal';
}

// ============================================================================
// Error Code Registry
// ============================================================================

const ERROR_TEMPLATES: Record<string, UserError> = {
  EAUTH001: {
    code: 'EAUTH001',
    message: 'Calendar access denied.',
    remediation: 'Please re-authenticate with: pai calendar auth',
    severity: 'fatal',
  },
  EAUTH002: {
    code: 'EAUTH002',
    message: 'OAuth token expired.',
    remediation: 'Re-authenticate with: pai calendar auth',
    severity: 'fatal',
  },
  EAUTH003: {
    code: 'EAUTH003',
    message: 'Google Calendar credentials not found.',
    remediation: 'Run initial setup: pai calendar setup',
    severity: 'fatal',
  },
  ENET001: {
    code: 'ENET001',
    message: 'Cannot reach Google Calendar API.',
    remediation: 'Check your internet connection and try again. If persists, Calendar will operate in offline mode.',
    severity: 'error',
  },
  ENET002: {
    code: 'ENET002',
    message: 'Google Calendar API rate limited.',
    remediation: 'Too many requests. Please wait 60 seconds and try again.',
    severity: 'warning',
  },
  ENET003: {
    code: 'ENET003',
    message: 'Request to Calendar API timed out.',
    remediation: 'Network may be slow. Will retry automatically (max 3 attempts).',
    severity: 'warning',
  },
  ECAL001: {
    code: 'ECAL001',
    message: 'Event not found.',
    remediation: 'The event may have been deleted. Check your calendar or provide a different event.',
    severity: 'error',
  },
  ECAL002: {
    code: 'ECAL002',
    message: 'Cannot schedule in the past.',
    remediation: 'Please provide a future date and time.',
    severity: 'warning',
  },
  ECAL003: {
    code: 'ECAL003',
    message: 'Conflicting events detected.',
    remediation: 'Resolve conflicts by modifying or removing one of the overlapping events.',
    severity: 'warning',
  },
  ECAL004: {
    code: 'ECAL004',
    message: 'Invalid event duration.',
    remediation: 'Duration must be between 15 minutes and 12 hours.',
    severity: 'warning',
  },
  ECAL005: {
    code: 'ECAL005',
    message: 'Ambiguous date detected.',
    remediation: 'Please clarify: did you mean this week or next week?',
    severity: 'warning',
  },
  EINF001: {
    code: 'EINF001',
    message: 'AI inference service unavailable.',
    remediation: 'Inference.ts is not responding. Try again in a moment.',
    severity: 'error',
  },
  EINF002: {
    code: 'EINF002',
    message: 'Could not understand your request.',
    remediation: 'Please rephrase. Examples: "schedule a meeting tomorrow at 2pm", "what\'s on my calendar today"',
    severity: 'warning',
  },
  ESTATE001: {
    code: 'ESTATE001',
    message: 'Calendar state file corrupted.',
    remediation: 'Run: pai calendar repair — this will rebuild the state from Google Calendar.',
    severity: 'error',
  },
  ESTATE002: {
    code: 'ESTATE002',
    message: 'Cannot write to state directory.',
    remediation: 'Check disk permissions on ~/.claude/state/calendar-assistant/',
    severity: 'fatal',
  },
  EGOAL001: {
    code: 'EGOAL001',
    message: 'Goal not found.',
    remediation: 'List goals with: pai calendar goal list',
    severity: 'warning',
  },
  EAPPROVAL001: {
    code: 'EAPPROVAL001',
    message: 'Action requires approval.',
    remediation: 'This event has multiple attendees. Please confirm: approve or cancel.',
    severity: 'warning',
  },
  EOFFLINE001: {
    code: 'EOFFLINE001',
    message: 'Operating in offline mode.',
    remediation: 'Calendar API unavailable. Reading from cache. Write operations queued for when connection restores.',
    severity: 'warning',
  },
  EUNKNOWN: {
    code: 'EUNKNOWN',
    message: 'An unexpected error occurred.',
    remediation: 'Check logs at ~/.claude/logs/calendar-assistant.log for details. If persists, try: pai calendar repair',
    severity: 'error',
  },
};

// ============================================================================
// Error Matching
// ============================================================================

function matchError(error: unknown): string {
  const errMsg = error instanceof Error ? error.message : String(error);
  const lc = errMsg.toLowerCase();

  if (lc.includes('403') || lc.includes('forbidden')) return 'EAUTH001';
  if (lc.includes('401') || lc.includes('unauthorized') || lc.includes('token') && lc.includes('expired')) return 'EAUTH002';
  if (lc.includes('credentials') || lc.includes('oauth') && lc.includes('not found')) return 'EAUTH003';
  if (lc.includes('enotfound') || lc.includes('econnrefused') || lc.includes('503')) return 'ENET001';
  if (lc.includes('429') || lc.includes('rate limit')) return 'ENET002';
  if (lc.includes('timeout') || lc.includes('etimedout')) return 'ENET003';
  if (lc.includes('event not found') || lc.includes('404')) return 'ECAL001';
  if (lc.includes('past') && lc.includes('date')) return 'ECAL002';
  if (lc.includes('conflict')) return 'ECAL003';
  if (lc.includes('duration')) return 'ECAL004';
  if (lc.includes('ambiguous')) return 'ECAL005';
  if (lc.includes('inference') && (lc.includes('unavailable') || lc.includes('not responding'))) return 'EINF001';
  if (lc.includes('parse') || lc.includes('understand')) return 'EINF002';
  if (lc.includes('corrupt') || lc.includes('json') && lc.includes('parse')) return 'ESTATE001';
  if (lc.includes('eacces') || lc.includes('permission')) return 'ESTATE002';
  if (lc.includes('goal') && lc.includes('not found')) return 'EGOAL001';
  if (lc.includes('approval') || lc.includes('attendee')) return 'EAPPROVAL001';
  if (lc.includes('offline')) return 'EOFFLINE001';

  return 'EUNKNOWN';
}

// ============================================================================
// Public API
// ============================================================================

export function getUserMessage(error: unknown): UserError {
  const code = matchError(error);
  return ERROR_TEMPLATES[code] || ERROR_TEMPLATES['EUNKNOWN'];
}

export function getErrorTemplate(code: string): UserError | null {
  return ERROR_TEMPLATES[code] || null;
}

export function formatUserError(error: unknown): string {
  const userError = getUserMessage(error);
  return `[${userError.code}] ${userError.message}\n${userError.remediation}`;
}

export function getAllErrorCodes(): string[] {
  return Object.keys(ERROR_TEMPLATES);
}
