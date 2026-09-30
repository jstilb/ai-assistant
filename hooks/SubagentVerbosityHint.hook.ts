#!/usr/bin/env bun
/**
 * SubagentVerbosityHint.hook.ts - Response Brevity Nudge (SubagentStart)
 *
 * PURPOSE:
 * Injects a <system-reminder> into each subagent's context reminding it
 * to keep its final response concise. Verbose multi-page agent returns
 * inflate the parent session's context window. This hook is a soft nudge —
 * explicit caps in the spawning prompt are stronger, but this provides a
 * universal baseline.
 *
 * TRIGGER: SubagentStart
 *
 * INPUT:
 * - stdin: SubagentStart hook JSON (session_id, agent_id, agent_type, ...)
 *
 * OUTPUT:
 * - stdout: <system-reminder> block injected into subagent context
 * - exit(0): Always
 *
 * SKIP CONDITIONS:
 * - KAYA_VERBOSITY_HINT_DISABLED=1
 *
 * PERFORMANCE:
 * - Non-blocking: Yes
 * - Typical execution: <5ms
 */

import { readObservabilityHookInputSync } from '../lib/hook-utils.ts';

const HINT = `<system-reminder>
## Response Brevity
Your final response to the parent agent enters its context window. Keep it concise:
- Default to under 500 words unless the parent prompt explicitly asks for more.
- Lead with results/decisions; details below if asked.
- Tables and code blocks beat narrative prose.
- Do not echo back the parent's prompt or restate the task.
</system-reminder>`;

function main(): void {
  if (process.env.KAYA_VERBOSITY_HINT_DISABLED === '1') {
    process.exit(0);
  }

  // Drain stdin via the canonical observability path. We do not use the
  // payload — this hook only injects the brevity reminder — but Claude Code
  // still pipes input that must be consumed. Fail-open semantics match the
  // legacy try/catch drain.
  readObservabilityHookInputSync<unknown>();

  process.stdout.write(HINT + '\n');
  process.exit(0);
}

if (import.meta.main) {
  main();
}
