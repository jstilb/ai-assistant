/**
 * Observability Integration
 * Delegates to UnifiedEventSink for fan-out to canonical logs and dashboard
 *
 * Dashboard: https://github.com/disler/claude-code-hooks-multi-agent-observability
 * Server runs at: localhost:4000
 * Client dashboard: localhost:5173
 */

import { emit } from '../../lib/core/UnifiedEventSink';

export interface ObservabilityEvent {
  source_app: string;
  session_id: string;
  hook_event_type: 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'Notification' | 'Stop' | 'SubagentStop' | 'SessionStart' | 'SessionEnd' | 'PreCompact';
  timestamp: string;
  transcript_path?: string;
  summary?: string;
  tool_name?: string;
  tool_input?: any;
  tool_output?: any;
  agent_type?: string;
  model?: string;
  [key: string]: any;
}

/**
 * Send event to observability dashboard via UnifiedEventSink
 * Never blocks hook execution - events are fire-and-forget
 */
export async function sendEventToObservability(event: ObservabilityEvent): Promise<void> {
  // Map ObservabilityEvent to KayaEvent and emit via UnifiedEventSink
  emit({
    source: 'hook',
    category: event.hook_event_type,
    severity: 'info',
    sessionId: event.session_id,
    payload: {
      source_app: event.source_app,
      timestamp: event.timestamp,
      transcript_path: event.transcript_path,
      summary: event.summary,
      tool_name: event.tool_name,
      tool_input: event.tool_input,
      tool_output: event.tool_output,
      agent_type: event.agent_type,
      model: event.model,
      ...event,
    },
  });
}

/**
 * Helper to get current timestamp in ISO format
 */
export function getCurrentTimestamp(): string {
  return new Date().toISOString();
}

/**
 * Helper to get source app name from environment or default to 'Kaya'
 */
export function getSourceApp(): string {
  return process.env.KAYA_SOURCE_APP || 'Kaya';
}
