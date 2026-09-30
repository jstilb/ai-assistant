#!/usr/bin/env bun
/**
 * AgentOutputCapture.hook.ts - Capture Subagent Results (SubagentStop)
 *
 * PURPOSE:
 * Captures output from completed subagents (Task tool invocations) and persists
 * them to MEMORY/RESEARCH/ for future reference. Also sends push notifications
 * for background agents and observability events.
 *
 * TRIGGER: SubagentStop (fires when a Task tool subagent completes)
 *
 * INPUT:
 * - session_id: Parent session identifier
 * - transcript_path: Path to the transcript JSONL file
 *
 * OUTPUT:
 * - stdout: For background agents, injects a system-reminder guardrail
 *   preventing Kaya from acting on pending proposals without user approval
 * - exit(0): Normal completion
 *
 * SIDE EFFECTS:
 * - Writes to: MEMORY/RESEARCH/<YYYY-MM>/AGENT-<type>_*.md
 * - Writes to: hooks/subagent-stop-debug.log (debug mode)
 * - Sends: Observability event to dashboard server
 * - Sends: Push notification via ntfy for background agents
 *
 * INTER-HOOK RELATIONSHIPS:
 * - DEPENDS ON: None
 * - COORDINATES WITH: Observability dashboard (if running)
 * - MUST RUN BEFORE: None
 * - MUST RUN AFTER: Task tool completion
 *
 * ERROR HANDLING:
 * - Missing transcript: Exits gracefully (exit 0)
 * - Parse errors: Logged to debug file, exits gracefully
 * - External service failures: Silently ignored (fire-and-forget)
 *
 * PERFORMANCE:
 * - Non-blocking: Yes
 * - Typical execution: <500ms
 * - Retry logic: 2 attempts with 200ms delay for transcript availability
 *
 * AGENT OUTPUT (S4 — let the model speak, see docs/decisions/010):
 * The subagent's final message is relayed VERBATIM to every downstream sink
 * (RESEARCH file, observability event). No completion-pattern regex, no
 * greeting/question/status re-derivation — the model's words ARE the
 * output. The one exception is the ntfy push, which byte-truncates long
 * messages to fit ntfy's protocol limit (mechanical cut, never a rewrite).
 * agentType is read from the Task tool_input's `subagent_type` field
 * (objective metadata) — never regexed out of the message text.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync, statSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { kayaPath } from './lib/paths';
import { createAppendLog } from '../lib/core/AppendLog.ts';
import { sendEventToObservability, getCurrentTimestamp, getSourceApp } from './lib/observability';
import { extractAgentInstanceId } from './lib/metadata-extraction';
import { notifyBackgroundAgent } from './lib/notifications';
import { unregisterAgent, markForeground, getAgentEntry } from './lib/agent-tracker';

// ========================================
// Debug Log Rotation (ISC-9)
// ========================================

const DEBUG_LOG_MAX_BYTES = 1_000_000; // 1MB
const DEBUG_LOG_MAX_ROTATIONS = 3;

function rotateDebugLogIfNeeded(debugLog: string): void {
  try {
    if (!existsSync(debugLog)) return;
    const stats = statSync(debugLog);
    if (stats.size > DEBUG_LOG_MAX_BYTES) {
      for (let i = DEBUG_LOG_MAX_ROTATIONS - 1; i >= 1; i--) {
        const from = `${debugLog}.${i}`;
        const to = `${debugLog}.${i + 1}`;
        if (existsSync(from)) renameSync(from, to);
      }
      renameSync(debugLog, `${debugLog}.1`);
    }
  } catch (err) {
    // Rotation failure should not block debug logging
    console.error(`[AgentOutputCapture] debug log rotation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Get current timestamp in PST timezone
 * Format: YYYY-MM-DD HH:MM:SS PST
 */
function getPSTTimestamp(): string {
  const date = new Date();
  const pstDate = new Date(date.toLocaleString('en-US', { timeZone: process.env.TIME_ZONE || 'America/Los_Angeles' }));

  const year = pstDate.getFullYear();
  const month = String(pstDate.getMonth() + 1).padStart(2, '0');
  const day = String(pstDate.getDate()).padStart(2, '0');
  const hours = String(pstDate.getHours()).padStart(2, '0');
  const minutes = String(pstDate.getMinutes()).padStart(2, '0');
  const seconds = String(pstDate.getSeconds()).padStart(2, '0');

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds} PST`;
}

function getPSTDate(): string {
  const date = new Date();
  const pstDate = new Date(date.toLocaleString('en-US', { timeZone: process.env.TIME_ZONE || 'America/Los_Angeles' }));

  const year = pstDate.getFullYear();
  const month = String(pstDate.getMonth() + 1).padStart(2, '0');
  const day = String(pstDate.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ========================================
// ntfy Payload Byte-Truncation (S4)
// ========================================
//
// ntfy.sh's default server enforces a documented message-body byte limit
// (4096 bytes). This is the ONLY place the agent's verbatim completion
// message is ever shortened — a mechanical protocol cut, not content
// filtering. It never rewrites or summarizes; it truncates at a valid
// UTF-8 boundary and appends a plain marker. Every other sink (RESEARCH
// file, observability event) receives the full, untouched message.

const NTFY_MAX_BYTES = 4096;
const NTFY_TRUNCATION_SUFFIX = '\n… [truncated for ntfy]';

export function truncateForNtfy(message: string, maxBytes: number = NTFY_MAX_BYTES): string {
  if (Buffer.byteLength(message, 'utf-8') <= maxBytes) return message;

  const suffixBytes = Buffer.byteLength(NTFY_TRUNCATION_SUFFIX, 'utf-8');
  // Degenerate limit (< suffix length): a bare hard cut is the only way to
  // honor maxBytes — no marker fits.
  if (maxBytes <= suffixBytes) {
    const raw = Buffer.from(message, 'utf-8');
    let hardCut = Math.min(maxBytes, raw.length);
    while (hardCut > 0 && (raw[hardCut] & 0xc0) === 0x80) hardCut--;
    return raw.subarray(0, hardCut).toString('utf-8');
  }
  const budget = Math.max(0, maxBytes - suffixBytes);

  const buf = Buffer.from(message, 'utf-8');
  let cut = Math.min(budget, buf.length);
  // Back off if the cut lands mid-way through a multi-byte UTF-8 sequence
  // (continuation bytes match the 10xxxxxx bit pattern, i.e. 0x80-0xBF).
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) {
    cut--;
  }

  return buf.subarray(0, cut).toString('utf-8') + NTFY_TRUNCATION_SUFFIX;
}

// ========================================
// Subagent tool_use matching (S-25)
// ========================================
//
// Claude Code 2.1.263 renamed the subagent-spawning tool from `Task` to
// `Agent` (confirmed live via a self-report probe, see
// plans/audits/security-audit-2026-09-01/S-06-slice3-probes.md §0d — a
// live parent transcript from THIS session shows 10 `"name":"Agent"`
// tool_use blocks and 0 `"name":"Task"`). `Task` is kept in the set so
// older transcripts (pre-rename) still match.
const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set(['Agent', 'Task']);

// ========================================
// Async/Background Subagent Output Resolution (S-25)
// ========================================
//
// For an async/background subagent, the matched tool_result in the PARENT
// transcript is only the launch stub ("Async agent launched successfully...
// agentId: <id>...") — not the subagent's actual output. The real output
// lives in the subagent's OWN transcript file, written incrementally as it
// works. Path convention confirmed live on 2026-09-08 (session
// 6ee226c4-1118-4ece-ae42-e4fa20be28e3): a subagent transcript sits at
// `<dirname(transcript_path)>/<session_id>/subagents/agent-<agentId>.jsonl`,
// alongside a sibling `agent-<agentId>.meta.json`. The `agentId` there is
// the SAME value the SubagentStop hook payload's own `agent_id` field
// carries (verified: payload `agent_id` for a completed async agent matched
// both the `agentId: …` text embedded in its launch stub AND its
// `subagents/agent-<id>.jsonl` filename) — so the payload's `agent_id` is
// preferred over parsing the stub text, with stub-text parsing kept only as
// a fallback for a payload that omits it.

function looksLikeAsyncLaunchStub(text: string): boolean {
  return text.startsWith('Async agent launched') || text.includes('agentId:');
}

function extractAgentIdFromStubText(text: string): string | null {
  const match = text.match(/agentId:\s*([A-Za-z0-9_-]+)/);
  return match ? match[1] : null;
}

function resolveSubagentTranscriptPath(transcriptPath: string, sessionId: string, agentId: string): string {
  return join(dirname(transcriptPath), sessionId, 'subagents', `agent-${agentId}.jsonl`);
}

/** Reads a string field off an unknown-shaped parsed JSON payload without an unwarranted cast. */
function readStringField(payload: unknown, field: string): string | null {
  if (payload === null || typeof payload !== 'object') return null;
  const value = (payload as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : null;
}

/** Finds the last assistant message's text content (joined) in a raw JSONL transcript string. */
function findLastAssistantText(transcriptContent: string): string | null {
  const lines = transcriptContent.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (entry === null || typeof entry !== 'object') continue;
    const entryObj = entry as Record<string, unknown>;
    if (entryObj.type !== 'assistant') continue;
    const message = entryObj.message;
    if (message === null || typeof message !== 'object') continue;
    const content = (message as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    const texts: string[] = [];
    for (const item of content) {
      if (item !== null && typeof item === 'object') {
        const itemObj = item as Record<string, unknown>;
        if (itemObj.type === 'text' && typeof itemObj.text === 'string') {
          texts.push(itemObj.text);
        }
      }
    }
    if (texts.length > 0) return texts.join('\n');
  }
  return null;
}

// ========================================
// findTaskResult() failure diagnosis (T7-08.4)
// ========================================
//
// A prior version of this function returned an indistinguishable `null`
// whether the transcript genuinely had no subagent invocation, was fully
// unparseable, or simply hadn't received its tool_result yet (a live race:
// confirmed via hooks/subagent-stop-debug.log, 2026-09-19..21, where the
// triggering agent_id never appears anywhere in its own parent transcript at
// hook-fire time — the SubagentStop event fires before the harness finishes
// appending that tool_use/tool_result pair). `diagnostic` names WHICH failure
// happened so a genuine parse failure never silently reads as "nothing to
// find here" — see main()'s handling immediately below this function.
type FindTaskResultDiagnostic =
  | 'ok'
  | 'transcript-missing'
  | 'transcript-unreadable'
  | 'transcript-fully-malformed'
  | 'invocation-found-no-result'
  | 'no-invocation-found';

async function findTaskResult(transcriptPath: string, maxAttempts: number = 2): Promise<{ result: string | null, agentType: string | null, description: string | null, toolInput: any | null, diagnostic: FindTaskResultDiagnostic }> {
  console.error(`📂 Looking for Task result in transcript: ${transcriptPath}`);

  // If the provided transcript path doesn't exist, try to find the most recent agent transcript
  let actualTranscriptPath = transcriptPath;
  let sawFileExist = false;
  let everReadable = false;
  let totalLines = 0;
  let malformedLines = 0;
  let sawInvocation = false;

  // PERFORMANCE FIX: Reduced from 6 attempts (10+ seconds) to 2 attempts (~500ms)
  // The transcript should already exist when SubagentStop fires
  // If it doesn't exist after a quick check, don't block - just exit gracefully
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      // Single short retry - 200ms is enough for filesystem sync
      await delay(200);
    }

    if (!existsSync(actualTranscriptPath)) {
      console.error(`❌ Transcript file doesn't exist: ${actualTranscriptPath} (attempt ${attempt + 1}/${maxAttempts})`);

      // Try to find agent transcript in the same directory
      const dir = require('path').dirname(transcriptPath);
      if (existsSync(dir)) {
        const { readdirSync, statSync } = require('fs');
        const files = readdirSync(dir)
          .filter((f: string) => f.startsWith('agent-') && f.endsWith('.jsonl'))
          .map((f: string) => ({ name: f, mtime: statSync(join(dir, f)).mtime }))
          .sort((a: any, b: any) => b.mtime - a.mtime);

        if (files.length > 0) {
          actualTranscriptPath = join(dir, files[0].name);
          console.error(`🔄 Found recent agent transcript: ${actualTranscriptPath}`);
        }
      }

      if (!existsSync(actualTranscriptPath)) {
        continue;
      }
    }

    sawFileExist = true;

    try {
      const transcript = readFileSync(actualTranscriptPath, 'utf-8');
      everReadable = true;
      const lines = transcript.trim().split('\n');

      // Search from the end of the transcript backwards
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i]) continue;
        totalLines++;
        try {
          const entry = JSON.parse(lines[i]);

          // Look for assistant messages that contain Task tool_use
          if (entry.type === 'assistant' && entry.message?.content) {
            for (const content of entry.message.content) {
              if (content.type === 'tool_use' && SUBAGENT_TOOL_NAMES.has(content.name)) {
                sawInvocation = true;
                const toolInput = content.input;
                const description = toolInput?.description || null;
                console.error(`✅ Found Task invocation with subagent: ${toolInput?.subagent_type}, description: ${description}`);
                // Found a Task invocation, now look for its result
                // The result should be in a subsequent user message
                for (let j = i + 1; j < lines.length; j++) {
                  if (!lines[j]) continue;
                  const resultEntry = JSON.parse(lines[j]);
                  if (resultEntry.type === 'user' && resultEntry.message?.content) {
                    for (const resultContent of resultEntry.message.content) {
                      if (resultContent.type === 'tool_result' && resultContent.tool_use_id === content.id) {
                        // Found the matching Task result
                        // Content can be either a string or an array of objects with text
                        let taskOutput: string;
                        if (typeof resultContent.content === 'string') {
                          taskOutput = resultContent.content;
                        } else if (Array.isArray(resultContent.content)) {
                          // Extract text from array of content objects
                          taskOutput = resultContent.content
                            .filter((item: any) => item.type === 'text')
                            .map((item: any) => item.text)
                            .join('\n');
                        } else {
                          console.error('❌ Unexpected tool_result content type');
                          continue;
                        }

                        // S4: agentType is objective metadata from the Task
                        // tool_input's subagent_type field — never regexed
                        // out of the agent's own spoken output text. Falls
                        // back to null here; main() resolves the final
                        // 'default' fallback alongside instanceMetadata.
                        const agentType: string | null =
                          typeof toolInput?.subagent_type === 'string' ? toolInput.subagent_type : null;

                        return { result: taskOutput, agentType, description, toolInput, diagnostic: 'ok' };
                      }
                    }
                  }
                }
              }
            }
          }
        } catch (e) {
          // Invalid JSON line, skip
          malformedLines++;
          console.error(`[AgentOutputCapture] malformed transcript line skipped while searching for Task result: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } catch (e) {
      // Error reading file, will retry
      console.error(`[AgentOutputCapture] failed to read transcript ${actualTranscriptPath}, will retry: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  let diagnostic: FindTaskResultDiagnostic;
  if (!sawFileExist) {
    diagnostic = 'transcript-missing';
  } else if (!everReadable) {
    diagnostic = 'transcript-unreadable';
  } else if (totalLines > 0 && malformedLines === totalLines) {
    diagnostic = 'transcript-fully-malformed';
  } else if (sawInvocation) {
    diagnostic = 'invocation-found-no-result';
  } else {
    diagnostic = 'no-invocation-found';
  }

  return { result: null, agentType: null, description: null, toolInput: null, diagnostic };
}

async function main() {
  const debugLog = kayaPath('hooks', 'subagent-stop-debug.log');
  // maxSizeBytes disabled — rotation for this file is owned by the existing
  // rotateDebugLogIfNeeded() numbered-suffix scheme (.1/.2/.3) called just
  // below; AppendLog's own ISO-timestamp rotation must never also fire here.
  const debugAppendLog = createAppendLog(debugLog, { maxSizeBytes: Number.MAX_SAFE_INTEGER });

  // File logging is opt-in (KAYA_HOOK_DEBUG=1); it ran unconditionally and
  // accumulated ~3.5 MB of rotated logs nobody read.
  const debugToFile = process.env.KAYA_HOOK_DEBUG === '1';
  function debug(msg: string) {
    if (debugToFile) {
      const timestamp = new Date().toISOString();
      rotateDebugLogIfNeeded(debugLog);
      debugAppendLog.appendRaw(`[${timestamp}] ${msg}\n`);
    }
    console.error(msg);
  }

  debug('🔍 SubagentStop hook started');
  // Read input from stdin with timeout
  let input = '';
  try {
    const decoder = new TextDecoder();
    const reader = Bun.stdin.stream().getReader();

    const timeoutPromise = new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 500);
    });

    const readPromise = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        input += decoder.decode(value, { stream: true });
      }
    })();

    await Promise.race([readPromise, timeoutPromise]);
  } catch (e) {
    debug(`Failed to read input: ${e}`);
    process.exit(0);
  }
  
  if (!input) {
    debug('No input received');
    process.exit(0);
  }

  debug(`Input received: ${input.substring(0, 100)}...`);

  let transcriptPath: string;
  let sessionId: string = '';
  let agentId: string = '';
  // Kept as `unknown` (not re-typed to the parsed payload's actual shape,
  // which is not documented) so the async-stub resolution below can inspect
  // its keys/fields without an unwarranted `any`.
  let parsedInput: unknown = null;
  try {
    const parsed = JSON.parse(input);
    parsedInput = parsed;
    transcriptPath = parsed.transcript_path;
    sessionId = parsed.session_id || '';
    agentId = parsed.agent_id || '';
    debug(`Transcript path: ${transcriptPath}`);
    debug(`Session: ${sessionId}, Agent: ${agentId}`);
  } catch (e) {
    debug(`Invalid input JSON: ${e}`);
    process.exit(0);
  }

  if (!transcriptPath) {
    debug('No transcript path provided');
    process.exit(0);
  }

  // Agent tracking — deferred until after isBackground is determined (see below).
  // We need to know run_in_background before marking/unregistering.
  let remainingAgentCount = 0;
  let remainingAgentDescriptions: string[] = [];

  // Wait for and find the Task result
  debug('Starting findTaskResult...');
  let { result: taskOutput, agentType, description, toolInput, diagnostic } = await findTaskResult(transcriptPath);

  if (!taskOutput) {
    // T7-08.4 repair: the harness's own SubagentStop payload carries the
    // completing subagent's last assistant message directly, in
    // `last_assistant_message` — the same field StopFailure.hook.ts already
    // reads for the main-session Stop event. Falling back to it here
    // repairs the live race `diagnostic` just named (most commonly
    // 'invocation-found-no-result': the tool_use was seen but its
    // tool_result hadn't landed in the PARENT transcript within the 2x200ms
    // retry window) without depending on parent-transcript timing at all,
    // and also rescues a genuinely corrupted/unreadable transcript
    // ('transcript-fully-malformed' / 'transcript-unreadable').
    // `toolInput` stays null in this branch — main() below tolerates that
    // (optional-chained reads) and isBackground is resolved from the
    // agent-tracker's own SubagentStart-time registration instead.
    const payloadLastMessage = readStringField(parsedInput, 'last_assistant_message');
    if (payloadLastMessage && payloadLastMessage.trim()) {
      debug(`findTaskResult found no result in transcript (diagnostic: ${diagnostic}) — falling back to payload last_assistant_message (${payloadLastMessage.length} chars)`);
      taskOutput = payloadLastMessage;
      if (!agentType) {
        agentType = readStringField(parsedInput, 'agent_type');
      }
    } else {
      debug(`No Task result found in transcript after waiting (diagnostic: ${diagnostic}), and no last_assistant_message in payload — exiting`);
      process.exit(0);
    }
  }

  debug(`Task output found, length: ${taskOutput.length}`);
  debug(`Task output preview: ${taskOutput.substring(Math.max(0, taskOutput.length - 300))}`);

  // S-25: for an async/background subagent, the tool_result just matched is
  // only the launch stub — resolve the real output from the subagent's own
  // transcript before treating it as the completion message.
  if (looksLikeAsyncLaunchStub(taskOutput)) {
    debug('Matched tool_result looks like an async launch stub — resolving real output from the subagent transcript');
    const payloadKeys = parsedInput !== null && typeof parsedInput === 'object' ? Object.keys(parsedInput as Record<string, unknown>) : [];
    debug(`SubagentStop payload keys (names only): [${payloadKeys.join(', ')}]`);

    const namedTranscriptPath = readStringField(parsedInput, 'agent_transcript_path');
    const payloadAgentId = readStringField(parsedInput, 'agent_id');
    const resolvedAgentId = payloadAgentId || agentId || extractAgentIdFromStubText(taskOutput);

    const subagentTranscriptPath =
      namedTranscriptPath ??
      (resolvedAgentId && sessionId ? resolveSubagentTranscriptPath(transcriptPath, sessionId, resolvedAgentId) : null);

    if (!subagentTranscriptPath) {
      debug('Async stub detected but no agent_transcript_path/agent_id in payload and no agentId parseable from stub text — cannot locate subagent transcript, exiting');
      process.exit(0);
    }

    if (!existsSync(subagentTranscriptPath)) {
      debug(`Async stub detected — subagent transcript missing at: ${subagentTranscriptPath}`);
      process.exit(0);
    }

    let subagentTranscriptContent: string;
    try {
      subagentTranscriptContent = readFileSync(subagentTranscriptPath, 'utf-8');
    } catch (e) {
      debug(`Async stub detected — failed to read subagent transcript at ${subagentTranscriptPath}: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(0);
    }

    const realOutput = findLastAssistantText(subagentTranscriptContent);
    if (!realOutput) {
      debug(`Async stub detected — subagent transcript at ${subagentTranscriptPath} had no assistant text block, exiting`);
      process.exit(0);
    }

    debug(`Resolved async subagent output from: ${subagentTranscriptPath} (length ${realOutput.length})`);
    taskOutput = realOutput;
  }

  // Extract agent instance metadata from Task tool input
  const instanceMetadata = extractAgentInstanceId(toolInput, description);
  debug(`Instance metadata: ${JSON.stringify(instanceMetadata)}`);

  // S4 — let the model speak: relay the agent's final message VERBATIM
  // (byte-for-byte, no .trim()). No pattern matching, no greeting/question/
  // status re-derivation. If the subagent produced any output at all
  // (checked via `!taskOutput` above), that output IS the completion
  // message. Whitespace-only output is still treated as "nothing to
  // capture" (checked via a separate .trim() below, which does NOT touch
  // the captured value itself).
  const completionMessage = taskOutput;

  if (!completionMessage.trim()) {
    debug('Task output was whitespace-only - nothing to capture');
    process.exit(0);
  }

  debug(`Completion message (verbatim, ${completionMessage.length} chars)`);

  // Rate-limit detection is a distinct system-level guardrail signal (not
  // content filtering) - kept as-is, but now checked independently of
  // verbatim capture so a rate-limited failure still gets its special
  // system-reminder + audit-trail capture instead of flowing through as a
  // normal completion.
  const rateLimitPattern = /You[''\u2019]ve hit your limit|hit your limit.*resets/i;
  const rateLimitMatch = taskOutput.match(rateLimitPattern);
  if (rateLimitMatch) {
    debug(`⚠️ RATE LIMIT DETECTED in agent output: ${rateLimitMatch[0]}`);
    const agentLabel = description || toolInput?.subagent_type || 'unknown';
    const modelLabel = toolInput?.model || 'sonnet';
    console.log(`<system-reminder>
⚠️ Agent "${agentLabel}" failed due to rate limit: ${rateLimitMatch[0]}
The ${modelLabel} model is exhausted. Use model: "opus" for subsequent agent spawns, or wait for the limit to reset.
</system-reminder>`);
    // Still capture the output for audit trail, then exit
    try {
      await captureAgentOutput('rate-limited', `RATE LIMITED: ${rateLimitMatch[0]}`, taskOutput, transcriptPath);
    } catch (err) {
      // best effort
      console.error(`[AgentOutputCapture] rate-limited audit-trail capture failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(0);
  }

  // agentType: objective metadata sourced from the Task tool_input's
  // subagent_type field (via findTaskResult's toolInput read, or
  // instanceMetadata's own toolInput-derived fallback) - never
  // regex-derived from the agent's spoken words.
  const finalAgentType = (agentType || instanceMetadata.agent_type || 'default').toLowerCase();
  debug(`Final agent type: ${finalAgentType}`);

  // NOTE: Voice notifications are now handled by agents themselves
  // The hook only logs completion messages and captures to history
  const agentName = finalAgentType.charAt(0).toUpperCase() + finalAgentType.slice(1);
  debug(`📝 Agent completed: [${agentName}] ${completionMessage}`);

  // Capture agent output to RESEARCH directory
  try {
    await captureAgentOutput(finalAgentType, completionMessage, taskOutput, transcriptPath);
  } catch (e) {
    console.error('Failed to capture agent output:', e);
  }

  // Determine if this was a background agent, then update tracker.
  // toolInput.run_in_background is the primary signal, sourced from the
  // ORIGINAL Task/Agent tool_use when findTaskResult located it. When the
  // completion instead came from the last_assistant_message payload
  // fallback above, toolInput is null — fall back to the agent-tracker's
  // own SubagentStart-time registration (BackgroundAgentStarted.hook.ts),
  // which never depends on transcript parsing and therefore isn't affected
  // by the same race. Its own registration default is `true`
  // (conservative), which is also this fallback's `?? true`: an unknown
  // agent should be treated as background so the siblings-running guardrail
  // errs toward firing, never toward silently skipping.
  const isBackground = toolInput !== null
    ? toolInput?.run_in_background === true
    : (sessionId && agentId ? (getAgentEntry(sessionId, agentId)?.isBackground ?? true) : true);

  // Now that we know isBackground, correct the tracker entry if needed.
  // Agents default to isBackground=true on registration (conservative).
  // Foreground agents correct themselves here before unregistering.
  if (sessionId && agentId) {
    if (!isBackground) {
      markForeground(sessionId, agentId);
    }
    const { remaining, remainingCount } = unregisterAgent(sessionId, agentId);
    remainingAgentCount = remainingCount;
    remainingAgentDescriptions = remaining.map(a => a.type || 'unknown');
    debug(`Remaining background siblings: ${remainingCount} [${remainingAgentDescriptions.join(', ')}]`);
  }

  // Send push notification for background agents
  if (isBackground) {
    debug(`📱 Sending push notification for background agent: ${finalAgentType}`);
    // S4: only the ntfy payload is byte-truncated (protocol limit) — every
    // other sink below (system-reminder, RESEARCH file, observability
    // event) gets the full, untouched completionMessage.
    const ntfyMessage = truncateForNtfy(completionMessage);
    notifyBackgroundAgent(finalAgentType, ntfyMessage).catch(() => {
      // Fire and forget
    });

    // Inject behavioral guardrail into conversation via stdout.
    // Two modes:
    // 1. Siblings still running → MUST wait for all to complete before acting
    // 2. All done → still check for pending user approval before acting
    if (remainingAgentCount > 0) {
      const siblingList = remainingAgentDescriptions.join(', ');
      console.log(`<system-reminder>
Background agent "${agentName}" completed: ${completionMessage}
⚠️ ${remainingAgentCount} other background agent(s) are still running: [${siblingList}].
MANDATORY: Do NOT begin implementing, synthesizing results, or taking action yet. Report this agent's completion as a brief status update and WAIT for all remaining agents to finish. You will be notified when each one completes.
</system-reminder>`);
    } else {
      console.log(`<system-reminder>
Background agent "${agentName}" completed: ${completionMessage}
All background agents for this batch have now completed. If you asked the user a question and are waiting for their response, report results as a status update ONLY — do NOT begin implementing work until the user explicitly approves. Background agent completion is NOT user approval.
</system-reminder>`);
    }
  }

  // Send event to observability dashboard with instance metadata
  try {
    const parsed = JSON.parse(input);
    const event: any = {
      source_app: getSourceApp(),
      session_id: parsed.session_id,
      hook_event_type: 'SubagentStop',
      timestamp: getCurrentTimestamp(),
      transcript_path: transcriptPath,
      agent_type: finalAgentType,
      summary: completionMessage,
    };

    // Add instance metadata if available
    if (instanceMetadata.agent_instance_id) {
      event.agent_instance_id = instanceMetadata.agent_instance_id;
    }
    if (instanceMetadata.instance_number !== undefined) {
      event.instance_number = instanceMetadata.instance_number;
    }
    if (instanceMetadata.parent_session_id) {
      event.parent_session_id = instanceMetadata.parent_session_id;
    }
    if (instanceMetadata.parent_task_id) {
      event.parent_task_id = instanceMetadata.parent_task_id;
    }

    await sendEventToObservability(event);
  } catch (e) {
    // intentionally silent: the observability dashboard (localhost:4000) is an
    // optional dev tool that is absent/not-running on most sessions by design
    // — breadcrumbing here would fire on nearly every normal run, not signal
  }
}

// UOCS: Capture agent output to history directory
async function captureAgentOutput(
  agentType: string,
  completionMessage: string,
  taskOutput: string,
  transcriptPath: string
) {
  const { writeFileSync, mkdirSync, existsSync } = require('fs');
  const { join } = require('path');
  const { homedir } = require('os');

  const MEMORY_DIR = kayaPath('MEMORY');

  // Generate timestamp for filename (PST)
  const pstTimestamp = getPSTTimestamp();
  const timestamp = pstTimestamp
    .replace(/ PST$/, '')
    .replace(/:/g, '')
    .replace(/ /, '-'); // YYYY-MM-DD-HHMMSS

  const yearMonth = timestamp.substring(0, 7); // YYYY-MM

  // Infer capture type from agent type
  // All agent outputs go to RESEARCH for simplicity (consolidated structure)
  let captureType = 'RESEARCH';
  const category = 'RESEARCH';

  if (agentType === 'researcher' || agentType.includes('researcher')) {
    captureType = 'RESEARCH';
  } else if (agentType === 'architect') {
    captureType = 'DECISION';
  } else if (agentType === 'engineer') {
    captureType = 'IMPLEMENTATION';
  } else if (agentType === 'designer') {
    captureType = 'DESIGN';
  } else if (agentType === 'pentester') {
    captureType = 'SECURITY';
  } else if (agentType === 'intern') {
    captureType = 'RESEARCH';
  }

  // Generate description from completion message (kebab-case, max 60 chars)
  const description = completionMessage
    .toLowerCase()
    .replace(/^(architect|engineer|designer|researcher|pentester|intern)\s+completed\s+/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 60);

  // Generate filename
  const filename = `${timestamp}_AGENT-${agentType}_${captureType}_${description}.md`;

  // Ensure directory exists
  const outputDir = join(MEMORY_DIR, category, yearMonth);
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  // Format document
  const fullTimestamp = getPSTTimestamp();
  const document = `---
capture_type: ${captureType}
timestamp: ${fullTimestamp}
executor: ${agentType}
agent_completion: ${completionMessage}
---

# ${captureType}: ${completionMessage}

**Agent:** ${agentType}
**Completed:** ${timestamp.replace(/-/g, ':').substring(0, 19)}

---

## Agent Output

${taskOutput}

---

## Metadata

**Transcript:** \`${transcriptPath}\`
**Captured:** ${fullTimestamp}

---

*This output was automatically captured by UOCS SubagentStop hook.*
`;

  // Write file
  const filePath = join(outputDir, filename);
  writeFileSync(filePath, document);

  console.log(`📝 UOCS: Captured agent output to ${category}/${yearMonth}/${filename}`);
}

if (import.meta.main) {
  main().catch(console.error);
}