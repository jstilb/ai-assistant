#!/usr/bin/env bun
/**
 * BackgroundAgentStarted.hook.ts - Track Background Agent Lifecycle
 *
 * PURPOSE:
 * Registers background subagents in the agent tracker so SubagentStop
 * can determine whether sibling agents are still running.
 *
 * TRIGGER: SubagentStart
 *
 * INPUT:
 * - session_id: Parent session identifier
 * - agent_id: Unique agent identifier
 * - agent_type: Agent type name
 *
 * OUTPUT:
 * - stdout: None
 * - exit(0): Always (non-blocking)
 *
 * SIDE EFFECTS:
 * - Writes to: hooks/lib/.active-agents.json
 */

import { registerAgent } from './lib/agent-tracker';

interface SubagentStartInput {
  session_id: string;
  agent_id: string;
  agent_type: string;
  agent_transcript_path?: string;
}

async function main(): Promise<void> {
  let input: SubagentStartInput;

  try {
    const text = await Promise.race([
      Bun.stdin.text(),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 200)
      ),
    ]);

    if (!text.trim()) {
      process.exit(0);
      return;
    }

    input = JSON.parse(text);
  } catch {
    process.exit(0);
    return;
  }

  if (!input.session_id || !input.agent_id) {
    process.exit(0);
    return;
  }

  // Register this agent. We register all agents — the SubagentStop hook
  // will use the count to decide whether to inject a "wait" reminder.
  registerAgent(
    input.session_id,
    input.agent_id,
    input.agent_type || 'unknown',
    '' // description not available in SubagentStart input
  );

  process.exit(0);
}

if (import.meta.main) {
  main().catch(() => {
    process.exit(0);
  });
}
