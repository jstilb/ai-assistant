#!/usr/bin/env bun
/**
 * FormatEnforcer.hook.ts - Response Format Refresh (UserPromptSubmit)
 *
 * PURPOSE:
 * Ensures consistent response formatting by injecting the response format
 * specification as a <system-reminder> when format rules may have drifted
 * out of context (long conversations).
 *
 * When ContextManager is active, CLAUDE.md already contains format
 * rules. This hook only injects a refresh when the conversation is long
 * enough that the original rules may be compressed away.
 *
 * TRIGGER: UserPromptSubmit
 *
 * INPUT:
 * - Environment: KAYA_DIR, CLAUDE_PROJECT_DIR
 * - stdin: { userMessage, conversationTurnCount }
 *
 * OUTPUT:
 * - stdout: <system-reminder> with condensed format specification (long conversations only)
 * - stderr: Error messages
 * - exit(0): Always (non-blocking)
 *
 * INTER-HOOK RELATIONSHIPS:
 * - DEPENDS ON: LoadContext (identity must be loaded for placeholder replacement)
 * - COORDINATES WITH: CLAUDE.md (format rules source of truth)
 * - MUST RUN AFTER: LoadContext (needs identity configuration)
 *
 * SELF-HEALING MECHANISM:
 * Unlike the initial context load, FormatEnforcer runs on every prompt.
 * With ContextManager active, it only injects on long conversations where
 * format drift is likely. Without ContextManager, it injects every time.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getIdentity } from './lib/identity';

function main() {
  try {
    // Check if this is a subagent session
    const claudeProjectDir = process.env.CLAUDE_PROJECT_DIR || '';
    const isSubagent = claudeProjectDir.includes('/.claude/Agents/') ||
                      process.env.CLAUDE_AGENT_TYPE !== undefined;

    if (isSubagent) {
      process.exit(0);
    }

    // Check if ContextManager is enabled
    const kayaDir = process.env.KAYA_DIR || join(process.env.HOME || '', '.claude');
    const settingsPath = join(kayaDir, 'settings.json');
    let contextManagerEnabled = false;

    if (existsSync(settingsPath)) {
      try {
        const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        contextManagerEnabled = settings?.contextManager?.enabled === true;
      } catch {
        // Fall through to legacy behavior
      }
    }

    if (contextManagerEnabled) {
      // ContextManager is active — CLAUDE.md has format rules.
      // Only inject refresh on long conversations.
      // Read turn count from stdin if available.
      let turnCount = 0;
      try {
        const input = readFileSync('/dev/stdin', 'utf-8');
        if (input) {
          const parsed = JSON.parse(input);
          turnCount = parsed.conversationTurnCount || 0;
        }
      } catch {
        // No stdin or parse error — assume early in conversation
      }

      // Skip injection for first ~20 turns (format rules are fresh from CORE-ESSENTIAL)
      if (turnCount < 20) {
        process.exit(0);
      }

      // Long conversation — inject format reminder
      console.error('[FormatEnforcer] Long conversation detected, injecting format refresh');
    }

    // Either legacy mode (no ContextManager) or long conversation — inject format rules
    const identity = getIdentity();

    const essentialFormat = `
## RESPONSE FORMAT REMINDER

**You MUST follow this format for EVERY response.**

### Voice Line (REQUIRED)
🗣️ ${identity.name}: [16 words max - factual summary of what was done]

This line is spoken aloud. Without it, your response is SILENT.

### Full Format (for tasks)
📋 SUMMARY: [One sentence]
🔍 ANALYSIS: [Key findings]
⚡ ACTIONS: [Steps taken]
✅ RESULTS: [Outcomes]
📊 STATUS: [Current state]
📁 CAPTURE: [Context to preserve]
➡️ NEXT: [Next steps]
📖 STORY EXPLANATION:
1-8. [Numbered list, never paragraph]
⭐ RATE (1-10): [LEAVE BLANK — user rates, AI never self-rates]
🗣️ ${identity.name}: [16 words max - factual, not conversational]

### Minimal Format (for simple responses)
📋 SUMMARY: [Brief summary]
🗣️ ${identity.name}: [Your response]

### Voice Line Rules
- WRONG: "Done." / "Ready." / "Happy to help!"
- RIGHT: "Fixed auth bug by adding null check. All 47 tests passing."
- STORY EXPLANATION must be numbered list (1-8). Never a paragraph.
- RATE: Always leave blank. User rates. AI never self-rates.
`;

    console.log(`<system-reminder>
${essentialFormat}
</system-reminder>`);

    process.exit(0);
  } catch (error) {
    console.error('[FormatEnforcer] Error:', error);
    process.exit(0);
  }
}

main();
