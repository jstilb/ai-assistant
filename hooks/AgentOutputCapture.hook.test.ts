/**
 * AgentOutputCapture.hook.test.ts — S4 "let the model speak" verbatim capture
 *
 * AgentOutputCapture.hook.ts has no exported pure handler for its main flow —
 * all orchestration lives in main(), guarded by `if (import.meta.main)` — so
 * this uses the subprocess harness pattern from
 * ExplicitRatingCapture.hook.test.ts / hooks/__tests__/smoke-critical-hooks.test.ts:
 * spawn `bun run` with KAYA_DIR/KAYA_HOME pointed at a per-test scratch dir
 * (the hook's own kayaPath() calls honor either name).
 *
 * KAYA_MEMORY_ROOT is ALSO pinned into that same scratch dir: the
 * observability sink (lib/core/UnifiedEventSink.ts's emit()) reads a
 * DIFFERENT env var than KAYA_HOME/KAYA_DIR and defaults to the LIVE
 * ~/.claude/MEMORY tree when unset — omitting it here would leak
 * observability test events into Jm's real MEMORY/MONITORING/events/.
 *
 * A `hooks/` subdirectory is pre-created in the scratch dir because the
 * hook's debug-log writer (`fsAppendFileSync(kayaPath('hooks',
 * 'subagent-stop-debug.log'), ...)`) does not create its parent directory —
 * in production `~/.claude/hooks/` already exists, but a bare mkdtemp
 * sandbox does not, and the write would otherwise throw ENOENT before the
 * hook does anything else.
 *
 * `truncateForNtfy` is a genuinely exported pure helper (same
 * export-alongside-`if (import.meta.main)` pattern already used by
 * SessionRatingCapture.hook.ts), so its UTF-8 byte-boundary edge case is
 * also unit-tested directly below, in addition to the end-to-end subprocess
 * coverage.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { execSync } from "child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { truncateForNtfy } from "./AgentOutputCapture.hook.ts";
// T7-08.4 seam: agent-tracker.ts's state file now honors a KAYA_HOME/KAYA_DIR
// override (resolveStateFilePath() in hooks/lib/agent-tracker.ts), defaulting
// to its prior hardcoded, source-relative path when unset — production
// behavior is unchanged. Setting process.env.KAYA_HOME = kayaDir below (the
// SAME scratch dir runHook() already passes to the subprocess) means BOTH
// direct in-process registerAgent/unregisterAgent calls here AND the hook
// subprocess's own tracker reads/writes land in kayaDir/hooks/lib/
// .active-agents.json — never the real, git-tracked file. Before this seam
// existed, an earlier version of these tests wrote directly to that real
// file (which doubles as the live sibling-agent registry for any session
// whose hooks execute against this checkout) and nearly clobbered live state
// — see the T7-08.4 handback report for the incident.
import { registerAgent } from "./lib/agent-tracker.ts";

const HOOK_PATH = join(import.meta.dir, "AgentOutputCapture.hook.ts");

let kayaDir: string;
let transcriptPath: string;
const originalKayaHome = process.env.KAYA_HOME;

function uniqueId(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Registers a sibling fixture — scratch-scoped via process.env.KAYA_HOME (set below). */
function registerSibling(sessionId: string, agentId: string, agentType: string, isBackground = true): void {
  registerAgent(sessionId, agentId, agentType, "", isBackground);
}

beforeEach(() => {
  kayaDir = mkdtempSync(join(tmpdir(), "agent-output-capture-test-"));
  // Pre-create hooks/ so the hook's debug-log appendFileSync doesn't ENOENT
  // (production ~/.claude/hooks/ already exists; a bare sandbox doesn't).
  mkdirSync(join(kayaDir, "hooks"), { recursive: true });
  transcriptPath = join(kayaDir, "transcript.jsonl");
  // Scopes THIS test process's own agent-tracker.ts calls (registerSibling)
  // to the same scratch dir the subprocess harness (runHook) already uses.
  process.env.KAYA_HOME = kayaDir;
});

afterEach(() => {
  try { rmSync(kayaDir, { recursive: true, force: true }); } catch { /* ignore */ }
  if (originalKayaHome === undefined) {
    delete process.env.KAYA_HOME;
  } else {
    process.env.KAYA_HOME = originalKayaHome;
  }
});

// ── fixture builder ──────────────────────────────────────────────────────

interface TaskFixtureOptions {
  toolUseId?: string;
  subagentType?: string; // omit to exercise the "field genuinely absent" fallback
  description?: string;
  runInBackground?: boolean;
  resultText: string;
  // S-25: Claude Code 2.1.263 renamed the subagent tool from "Task" to
  // "Agent" — defaults to "Task" so every pre-existing fixture call above
  // keeps exercising the legacy name unchanged.
  toolName?: "Task" | "Agent";
}

/** Writes a minimal transcript JSONL: one assistant Task/Agent tool_use + its matching user tool_result. */
function writeTranscriptFixture(opts: TaskFixtureOptions): void {
  const toolUseId = opts.toolUseId ?? "toolu_test_1";
  const toolInput: Record<string, unknown> = {
    description: opts.description ?? "Test agent task",
  };
  if (opts.subagentType !== undefined) toolInput.subagent_type = opts.subagentType;
  if (opts.runInBackground !== undefined) toolInput.run_in_background = opts.runInBackground;

  const assistantEntry = {
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id: toolUseId, name: opts.toolName ?? "Task", input: toolInput }],
    },
  };

  const userEntry = {
    type: "user",
    message: {
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: opts.resultText }],
    },
  };

  writeFileSync(transcriptPath, JSON.stringify(assistantEntry) + "\n" + JSON.stringify(userEntry) + "\n");
}

/**
 * Writes a transcript with a real Task/Agent tool_use block but NO matching
 * tool_result anywhere after it — the live race this slice repairs
 * (`diagnostic: 'invocation-found-no-result'`): the harness's SubagentStop
 * event fires before it finishes appending the completed tool_use's
 * tool_result to the PARENT transcript.
 */
function writeUnresolvedInvocationFixture(opts: { subagentType?: string; runInBackground?: boolean } = {}): void {
  const toolInput: Record<string, unknown> = { description: "Test agent task" };
  if (opts.subagentType !== undefined) toolInput.subagent_type = opts.subagentType;
  if (opts.runInBackground !== undefined) toolInput.run_in_background = opts.runInBackground;

  const assistantEntry = {
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id: "toolu_unresolved_1", name: "Agent", input: toolInput }],
    },
  };
  writeFileSync(transcriptPath, JSON.stringify(assistantEntry) + "\n");
}

/**
 * Writes a transcript that is fully unparseable (every line fails
 * JSON.parse) — `diagnostic: 'transcript-fully-malformed'`, distinct from
 * "readable but genuinely has no invocation" (`'no-invocation-found'`).
 */
function writeFullyMalformedTranscriptFixture(): void {
  writeFileSync(transcriptPath, "{not valid json\nalso not json}}}\n");
}

/**
 * Writes a subagent's OWN transcript file, at the path convention confirmed
 * live (S-25 slice report): `<dirname(parent transcript)>/<sessionId>/subagents/agent-<agentId>.jsonl`.
 * Only the final line matters for findLastAssistantText — a preceding
 * unrelated "user" line proves the search walks backward past non-assistant
 * entries rather than assuming the last line is always the one wanted.
 */
function writeSubagentTranscriptFixture(sessionId: string, agentId: string, finalAssistantText: string): string {
  const subagentDir = join(kayaDir, sessionId, "subagents");
  mkdirSync(subagentDir, { recursive: true });
  const subagentTranscriptPath = join(subagentDir, `agent-${agentId}.jsonl`);
  const lines = [
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "go" }] } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: finalAssistantText }] } }),
  ];
  writeFileSync(subagentTranscriptPath, lines.join("\n") + "\n");
  return subagentTranscriptPath;
}

/** The literal launch-stub text Claude Code 2.1.263 puts in an async Agent tool_result (agentId inlined). */
function asyncLaunchStub(agentId: string): string {
  return `Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)\nagentId: ${agentId} (internal ID - do not mention to user. Use SendMessage with to: '${agentId}' to check on it later.)`;
}

function runHook(stdinJson: object, timeoutMs = 8000): { stdout: string; stderr: string; exitCode: number } {
  const ts = Date.now() + "_" + Math.random().toString(36).slice(2);
  const tmpInput = join(kayaDir, `in_${ts}.json`);
  const tmpStdout = join(kayaDir, `out_${ts}.txt`);
  const tmpStderr = join(kayaDir, `err_${ts}.txt`);
  writeFileSync(tmpInput, JSON.stringify(stdinJson));

  let exitCode = 0;
  try {
    execSync(
      `cat ${tmpInput} | bun run ${HOOK_PATH} 1>${tmpStdout} 2>${tmpStderr}`,
      {
        timeout: timeoutMs,
        env: {
          ...process.env,
          // Both names: the hook reads KAYA_DIR/KAYA_HOME via kayaPath();
          // pinning only one lets live main-tree state gate the hook.
          KAYA_DIR: kayaDir,
          KAYA_HOME: kayaDir,
          // UnifiedEventSink.emit() reads this SEPARATE env var and
          // defaults to the live ~/.claude/MEMORY tree when unset.
          KAYA_MEMORY_ROOT: join(kayaDir, "MEMORY"),
          // Debug-log assertions below need the opt-in file log.
          KAYA_HOOK_DEBUG: "1",
        },
      }
    );
  } catch (err: unknown) {
    exitCode = (err as { status?: number }).status ?? 1;
  }

  const stdout = existsSync(tmpStdout) ? readFileSync(tmpStdout, "utf-8") : "";
  const stderr = existsSync(tmpStderr) ? readFileSync(tmpStderr, "utf-8") : "";
  return { stdout, stderr, exitCode };
}

// ── read-back helpers ─────────────────────────────────────────────────────

function findResearchFiles(): string[] {
  const researchDir = join(kayaDir, "MEMORY", "RESEARCH");
  if (!existsSync(researchDir)) return [];
  const files: string[] = [];
  for (const yearMonth of readdirSync(researchDir)) {
    const dir = join(researchDir, yearMonth);
    for (const f of readdirSync(dir)) {
      if (f.endsWith(".md")) files.push(join(dir, f));
    }
  }
  return files;
}

function readDigestSpool(): Array<Record<string, unknown>> {
  const spoolPath = join(kayaDir, "MEMORY", "NOTIFICATIONS", "digest-spool.jsonl");
  if (!existsSync(spoolPath)) return [];
  return readFileSync(spoolPath, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

/**
 * Reads the canonical observability log and returns each entry's `payload`
 * (not the outer envelope) — UnifiedEventSink.emit() nests summary/agent_type/
 * etc. under `event.payload`, it does not put them at the top level.
 */
function readObservabilityEvents(): Array<Record<string, unknown>> {
  const today = new Date().toISOString().slice(0, 10);
  const eventsFile = join(kayaDir, "MEMORY", "MONITORING", "events", `${today}.jsonl`);
  if (!existsSync(eventsFile)) return [];
  return readFileSync(eventsFile, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map(line => (JSON.parse(line) as { payload: Record<string, unknown> }).payload);
}

/** Reads the per-test scratch debug log (kayaDir/hooks/subagent-stop-debug.log). */
function readDebugLog(): string {
  const debugLogPath = join(kayaDir, "hooks", "subagent-stop-debug.log");
  return existsSync(debugLogPath) ? readFileSync(debugLogPath, "utf-8") : "";
}

// ── unit tests: truncateForNtfy byte-boundary safety ──────────────────────

describe("truncateForNtfy", () => {
  it("returns the message unchanged when under the byte limit", () => {
    const msg = "short message, well under 4096 bytes";
    expect(truncateForNtfy(msg)).toBe(msg);
  });

  it("truncates a long ASCII message to at most maxBytes total bytes, keeping an unmodified prefix", () => {
    const msg = "x".repeat(5000);
    const result = truncateForNtfy(msg, 100);
    expect(Buffer.byteLength(result, "utf-8")).toBeLessThanOrEqual(100);
    expect(result.endsWith("[truncated for ntfy]")).toBe(true);
    const cutIdx = result.indexOf("\n… [truncated for ntfy]");
    // The kept portion must be an exact, unmodified prefix of the original —
    // truncation cuts bytes, it never rewrites or substitutes content.
    expect(msg.startsWith(result.slice(0, cutIdx))).toBe(true);
  });

  it("never splits a multi-byte UTF-8 character at the truncation boundary", () => {
    // Each 'é' is 2 bytes in UTF-8 — an odd byte budget forces a boundary
    // decision that a byte-naive slice would get wrong.
    const msg = "é".repeat(200); // 400 bytes
    const result = truncateForNtfy(msg, 51);
    const kept = result.replace("\n… [truncated for ntfy]", "");
    // A mid-sequence cut decoded back to a string would surface U+FFFD
    // (replacement character); a correct boundary never does.
    expect(kept.includes("�")).toBe(false);
    expect(Buffer.byteLength(result, "utf-8")).toBeLessThanOrEqual(51);
  });
});

// ── (a) normal completion: verbatim capture across all three sinks ────────

describe("verbatim capture — normal completion message", () => {
  it("relays the full message untouched to the RESEARCH file, ntfy spool, and observability event", () => {
    const message = "🗣️ Engineer: Fixed the auth bug by adding a null check. All 47 tests passing.";
    writeTranscriptFixture({
      subagentType: "engineer",
      runInBackground: true,
      resultText: message,
    });

    const r = runHook({ session_id: "verbatim-test-1", transcript_path: transcriptPath });
    expect(r.exitCode).toBe(0);

    const files = findResearchFiles();
    expect(files).toHaveLength(1);
    const content = readFileSync(files[0], "utf-8");
    // Verbatim: the ORIGINAL text (including the "🗣️ Engineer:" prefix) is
    // present unmodified. The deleted regex parser would have rewritten
    // this to "Engineer completed Fixed the auth bug..." and dropped the
    // prefix entirely — that mangled form must NOT appear.
    expect(content).toContain(message);
    expect(content).not.toContain("Engineer completed Fixed the auth bug");

    const spool = readDigestSpool();
    expect(spool).toHaveLength(1);
    expect(spool[0].message).toBe(message);

    const events = readObservabilityEvents();
    const ourEvent = events.find(e => e.summary === message);
    expect(ourEvent).toBeDefined();
    expect(ourEvent!.agent_type).toBe("engineer");
  });
});

// ── (b) anti-gaming: messages matching NONE of the old completion patterns ─

describe("anti-gaming: message matching none of the old completion-pattern regexes", () => {
  it("captures a raw JSON dump with no completion phrasing intact — the old regex parser would have dropped it silently", () => {
    const message = '{"status":"ok","recordsProcessed":42,"warnings":[],"note":"mid-run data dump, not a completion sentence"}';
    writeTranscriptFixture({
      subagentType: "researcher",
      runInBackground: true,
      resultText: message,
    });

    const r = runHook({ session_id: "anti-gaming-test-1", transcript_path: transcriptPath });
    expect(r.exitCode).toBe(0);

    // The deleted regex-based completion-pattern matcher found no match
    // here (no 🗣️, no COMPLETED, no "Sub-agent X completed") and returned
    // null, which made the hook exit silently WITHOUT ever writing a
    // RESEARCH file for the normal-completion path. The new code has no
    // such gate — any non-empty output is captured.
    const files = findResearchFiles();
    expect(files).toHaveLength(1);
    expect(readFileSync(files[0], "utf-8")).toContain(message);

    const spool = readDigestSpool();
    expect(spool).toHaveLength(1);
    expect(spool[0].message).toBe(message);

    const events = readObservabilityEvents();
    expect(events.find(e => e.summary === message)).toBeDefined();
  });

  it("captures a message starting mid-sentence with no completion phrasing", () => {
    const message = "...and that's why the migration needed a second pass before the index rebuild finished cleanly.";
    writeTranscriptFixture({
      subagentType: "engineer",
      runInBackground: false,
      resultText: message,
    });

    const r = runHook({ session_id: "anti-gaming-test-2", transcript_path: transcriptPath });
    expect(r.exitCode).toBe(0);

    const files = findResearchFiles();
    expect(files).toHaveLength(1);
    expect(readFileSync(files[0], "utf-8")).toContain(message);
  });
});

// ── whitespace-only output: still treated as "nothing to capture" ────────

describe("whitespace-only completion output", () => {
  it("writes nothing and exits 0 for a whitespace-only message, without trimming a real message's content", () => {
    writeTranscriptFixture({
      subagentType: "engineer",
      runInBackground: false,
      resultText: "   \n\t  ",
    });

    const r = runHook({ session_id: "whitespace-test-1", transcript_path: transcriptPath });
    expect(r.exitCode).toBe(0);
    expect(findResearchFiles()).toHaveLength(0);
    expect(readDigestSpool()).toHaveLength(0);
  });

  it("preserves a real message's exact leading/trailing whitespace verbatim (no .trim() on the captured value)", () => {
    // The emptiness GUARD uses .trim() internally, but the CAPTURED value
    // must stay byte-for-byte identical to what the subagent produced.
    const message = "  padded on both sides with real content in between  ";
    writeTranscriptFixture({
      subagentType: "engineer",
      runInBackground: true,
      resultText: message,
    });

    const r = runHook({ session_id: "whitespace-test-2", transcript_path: transcriptPath });
    expect(r.exitCode).toBe(0);

    const spool = readDigestSpool();
    expect(spool).toHaveLength(1);
    expect(spool[0].message).toBe(message);
  });
});

// ── (c) agentType — objective tool_input metadata only ────────────────────

describe("agentType — objective tool_input.subagent_type only, never regexed from message text", () => {
  it("uses tool_input.subagent_type even when the message text contains a spoofed 'Sub-agent X completed' phrase", () => {
    const message = "Sub-agent HAXXOR completed a totally different task than what subagent_type says.";
    writeTranscriptFixture({
      subagentType: "engineer",
      runInBackground: false,
      resultText: message,
    });

    const r = runHook({ session_id: "agenttype-test-1", transcript_path: transcriptPath });
    expect(r.exitCode).toBe(0);

    const files = findResearchFiles();
    expect(files).toHaveLength(1);
    // Old code's `taskOutput.match(/Sub-agent\s+(\w+)\s+completed/i)` would
    // have produced agentType "haxxor" from the message text. The filename's
    // `_AGENT-<type>_` TOKEN encodes the resolved type — extracted precisely
    // here because the filename's separate description slug is built from
    // the (verbatim) message text, so it legitimately contains the word
    // "haxxor" too; that's expected and not what this assertion is about.
    const agentTypeToken = files[0].match(/_AGENT-([a-z0-9-]+?)_(?:RESEARCH|DECISION|IMPLEMENTATION|DESIGN|SECURITY)_/)?.[1];
    expect(agentTypeToken).toBe("engineer");

    const events = readObservabilityEvents();
    const ourEvent = events.find(e => e.summary === message);
    expect(ourEvent?.agent_type).toBe("engineer");
  });

  it("falls back to 'default' when subagent_type is genuinely absent from tool_input", () => {
    const message = "A plain completion message with no subagent_type field at all.";
    writeTranscriptFixture({
      // subagentType intentionally omitted — field is genuinely absent.
      description: "No type field here",
      runInBackground: false,
      resultText: message,
    });

    const r = runHook({ session_id: "agenttype-test-2", transcript_path: transcriptPath });
    expect(r.exitCode).toBe(0);

    const files = findResearchFiles();
    expect(files).toHaveLength(1);
    expect(files[0]).toContain("_AGENT-default_");
  });
});

// ── (d) ntfy byte-truncation: mechanical protocol cut, not a rewrite ──────

describe("ntfy byte-truncation — mechanical protocol cut, not a rewrite", () => {
  it("truncates only the ntfy payload; the RESEARCH file and observability event stay full-length", () => {
    const longMessage = "Completed a very long migration report. ".repeat(150);
    expect(Buffer.byteLength(longMessage, "utf-8")).toBeGreaterThan(4096);

    writeTranscriptFixture({
      subagentType: "researcher",
      runInBackground: true,
      resultText: longMessage,
    });

    const r = runHook({ session_id: "truncation-test-1", transcript_path: transcriptPath });
    expect(r.exitCode).toBe(0);

    const files = findResearchFiles();
    expect(files).toHaveLength(1);
    expect(readFileSync(files[0], "utf-8")).toContain(longMessage);

    const events = readObservabilityEvents();
    expect(events.find(e => e.summary === longMessage)).toBeDefined();

    const spool = readDigestSpool();
    expect(spool).toHaveLength(1);
    const spooledMessage = spool[0].message as string;
    expect(Buffer.byteLength(spooledMessage, "utf-8")).toBeLessThanOrEqual(4096);
    expect(spooledMessage.length).toBeLessThan(longMessage.length);
    expect(spooledMessage).toContain("[truncated for ntfy]");

    // The kept portion is an unmodified prefix of the original — the cut is
    // mechanical (bytes only), never a rewrite or substitution of content.
    const cutIdx = spooledMessage.indexOf("\n… [truncated for ntfy]");
    expect(longMessage.startsWith(spooledMessage.slice(0, cutIdx))).toBe(true);
  });
});

// ── (e) S-25: subagent tool renamed Task → Agent ──────────────────────────

describe("S-25: subagent tool_use named 'Agent' (Claude Code 2.1.263 rename)", () => {
  it("matches an 'Agent'-named tool_use the same way 'Task' is matched — sync result written to RESEARCH", () => {
    const message = "🗣️ Engineer: Renamed the tool matcher, all tests passing.";
    writeTranscriptFixture({
      toolName: "Agent",
      subagentType: "engineer",
      runInBackground: false,
      resultText: message,
    });

    const r = runHook({ session_id: "agent-name-test-1", transcript_path: transcriptPath });
    expect(r.exitCode).toBe(0);

    const files = findResearchFiles();
    expect(files).toHaveLength(1);
    expect(readFileSync(files[0], "utf-8")).toContain(message);
  });

  it("still matches a legacy 'Task'-named tool_use (backward compatibility for old transcripts)", () => {
    const message = "Legacy Task-tool completion message.";
    writeTranscriptFixture({
      toolName: "Task",
      subagentType: "engineer",
      runInBackground: false,
      resultText: message,
    });

    const r = runHook({ session_id: "task-name-test-1", transcript_path: transcriptPath });
    expect(r.exitCode).toBe(0);

    const files = findResearchFiles();
    expect(files).toHaveLength(1);
    expect(readFileSync(files[0], "utf-8")).toContain(message);
  });
});

// ── (f) S-25: async/background — parent transcript holds only a launch stub ─

describe("S-25: async/background subagent — real output resolved from its own transcript", () => {
  it("ignores the parent transcript's launch-stub tool_result and captures the subagent's own final assistant text instead", () => {
    const agentId = "testasyncagent123";
    const sessionId = "async-stub-test-1";
    const realOutput = "📋 SUMMARY: Async agent finished the real work.\n🗣️ Engineer: Async result captured correctly, not the launch stub.";

    // Parent transcript: the Agent tool_use's tool_result is ONLY the
    // launch stub (what Claude Code actually writes for a backgrounded
    // agent) — never the agent's real output.
    writeTranscriptFixture({
      toolName: "Agent",
      subagentType: "engineer",
      resultText: asyncLaunchStub(agentId),
    });

    // The subagent's own transcript, at the confirmed path convention,
    // holds the real final assistant message.
    writeSubagentTranscriptFixture(sessionId, agentId, realOutput);

    // The SubagentStop payload's own `agent_id` field (confirmed present
    // live) names the completed agent.
    const r = runHook({ session_id: sessionId, transcript_path: transcriptPath, agent_id: agentId });
    expect(r.exitCode).toBe(0);

    const files = findResearchFiles();
    expect(files).toHaveLength(1);
    const content = readFileSync(files[0], "utf-8");
    // The real, resolved output is captured...
    expect(content).toContain(realOutput);
    // ...and the launch stub text is NOT what got written as the capture.
    expect(content).not.toContain("Async agent launched successfully");
  });

  it("exits gracefully (no RESEARCH file) when the stub is detected but no subagent transcript exists at the resolved path", () => {
    const agentId = "missingagentxyz";
    const sessionId = "async-stub-missing-test-1";

    writeTranscriptFixture({
      toolName: "Agent",
      subagentType: "engineer",
      resultText: asyncLaunchStub(agentId),
    });
    // Deliberately do NOT write a subagents/agent-<id>.jsonl file.

    const r = runHook({ session_id: sessionId, transcript_path: transcriptPath, agent_id: agentId });
    expect(r.exitCode).toBe(0);
    expect(findResearchFiles()).toHaveLength(0);
  });
});

// ── (g) T7-08.4: last_assistant_message payload fallback repairs the ──────
//      transcript-timing race, and distinguishes parse failure from absence

describe("T7-08.4: last_assistant_message payload fallback", () => {
  it("captures via the payload fallback when the tool_use's result never landed in the parent transcript (race), tagged 'invocation-found-no-result'", () => {
    writeUnresolvedInvocationFixture({ subagentType: "engineer", runInBackground: false });
    const message = "🗣️ Engineer: Recovered via payload fallback after a transcript-timing race.";

    const r = runHook({
      session_id: uniqueId("race"),
      transcript_path: transcriptPath,
      last_assistant_message: message,
    });
    expect(r.exitCode).toBe(0);

    const files = findResearchFiles();
    expect(files).toHaveLength(1);
    expect(readFileSync(files[0], "utf-8")).toContain(message);

    const debugLog = readDebugLog();
    expect(debugLog).toContain("invocation-found-no-result");
    expect(debugLog).toContain("falling back to payload last_assistant_message");
  });

  it("recovers via the payload fallback from a fully-malformed transcript, tagged 'transcript-fully-malformed' — distinct from a genuine absence", () => {
    writeFullyMalformedTranscriptFixture();
    const message = "🗣️ Engineer: Recovered from a fully malformed transcript.";

    const r = runHook({
      session_id: uniqueId("malformed"),
      transcript_path: transcriptPath,
      last_assistant_message: message,
    });
    expect(r.exitCode).toBe(0);

    const files = findResearchFiles();
    expect(files).toHaveLength(1);
    expect(readFileSync(files[0], "utf-8")).toContain(message);

    const debugLog = readDebugLog();
    expect(debugLog).toContain("transcript-fully-malformed");
  });

  it("exits without capturing — and logs 'no-invocation-found', never mislabeled as a parse failure — when the transcript genuinely has no subagent invocation and the payload has no last_assistant_message", () => {
    // Valid JSON, parses cleanly, but contains no Task/Agent tool_use at all —
    // this must NOT be tagged 'transcript-fully-malformed' (that tag is
    // reserved for lines that fail JSON.parse, not lines that parse fine but
    // aren't a subagent invocation).
    writeFileSync(transcriptPath, JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "hello" }] } }) + "\n");

    const r = runHook({
      session_id: uniqueId("no-invocation"),
      transcript_path: transcriptPath,
      // Deliberately no last_assistant_message.
    });
    expect(r.exitCode).toBe(0);
    expect(findResearchFiles()).toHaveLength(0);

    const debugLog = readDebugLog();
    expect(debugLog).toContain("no-invocation-found");
    expect(debugLog).not.toContain("transcript-fully-malformed");
    expect(debugLog).toContain("no last_assistant_message in payload");
  });

  it("exits without capturing when the invocation-found-no-result race occurs and the payload ALSO has no last_assistant_message (fallback is best-effort, not magic)", () => {
    writeUnresolvedInvocationFixture({ subagentType: "engineer", runInBackground: false });

    const r = runHook({
      session_id: uniqueId("race-no-fallback"),
      transcript_path: transcriptPath,
      // Deliberately no last_assistant_message.
    });
    expect(r.exitCode).toBe(0);
    expect(findResearchFiles()).toHaveLength(0);

    const debugLog = readDebugLog();
    expect(debugLog).toContain("invocation-found-no-result");
  });
});

// ── (h) T7-08.4: siblings-running safety guardrail ─────────────────────────
//      Dark since ~June per the source audit — restored by the fallback
//      above resolving isBackground from the agent-tracker (not toolInput)
//      whenever the original tool_use metadata can't be located. Made
//      hermetic by the resolveStateFilePath() seam in
//      hooks/lib/agent-tracker.ts: process.env.KAYA_HOME is pinned to this
//      test's own scratch kayaDir in beforeEach above, so registerSibling()
//      (direct, in-process) and the runHook() subprocess (which already
//      passed KAYA_HOME as an explicit env override) both read/write the
//      SAME scratch file — never hooks/lib/.active-agents.json for real.

describe("T7-08.4: siblings-running safety guardrail", () => {
  it("injects the MANDATORY wait reminder, naming each sibling, when other background siblings are still running (normal path)", () => {
    const sessionId = uniqueId("siblings-normal");
    registerSibling(sessionId, uniqueId("sib"), "researcher");
    registerSibling(sessionId, uniqueId("sib"), "architect");

    writeTranscriptFixture({
      subagentType: "engineer",
      runInBackground: true,
      resultText: "🗣️ Engineer: Done, but siblings are still running.",
    });

    const r = runHook({ session_id: sessionId, transcript_path: transcriptPath, agent_id: uniqueId("stopping") });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("2 other background agent(s) are still running");
    expect(r.stdout).toContain("researcher");
    expect(r.stdout).toContain("architect");
    expect(r.stdout).toContain("MANDATORY: Do NOT begin implementing, synthesizing results, or taking action yet");
  });

  it("does NOT inject the wait reminder — reports plain completion instead — when zero siblings remain (normal path)", () => {
    const sessionId = uniqueId("siblings-normal-empty");

    writeTranscriptFixture({
      subagentType: "engineer",
      runInBackground: true,
      resultText: "🗣️ Engineer: Done, no other agents running.",
    });

    const r = runHook({ session_id: sessionId, transcript_path: transcriptPath, agent_id: uniqueId("stopping") });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("All background agents for this batch have now completed");
    expect(r.stdout).not.toContain("MANDATORY: Do NOT begin implementing");
  });

  it("still correctly reports a running sibling via the payload fallback, where toolInput is null and isBackground must resolve from the agent-tracker instead", () => {
    const sessionId = uniqueId("siblings-fallback");
    const agentId = uniqueId("stopping");
    // Simulates BackgroundAgentStarted.hook.ts having registered THIS agent
    // as background at SubagentStart, before its own SubagentStop fires.
    registerSibling(sessionId, agentId, "engineer", true);
    registerSibling(sessionId, uniqueId("sib"), "researcher", true);

    // toolInput exists as invocation metadata, but its tool_result is never
    // found — the exact race the fallback exists for — so main() receives
    // toolInput === null and must fall back to the tracker for isBackground.
    writeUnresolvedInvocationFixture({ subagentType: "engineer", runInBackground: true });
    const message = "🗣️ Engineer: Finished via fallback with a sibling still running.";

    const r = runHook({ session_id: sessionId, transcript_path: transcriptPath, agent_id: agentId, last_assistant_message: message, agent_type: "engineer" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("1 other background agent(s) are still running");
    expect(r.stdout).toContain("researcher");
    expect(r.stdout).toContain("MANDATORY: Do NOT begin implementing");
  });

  it("via the payload fallback, correctly reports 'all completed' (not wait) when it was the last remaining background agent", () => {
    const sessionId = uniqueId("siblings-fallback-empty");
    const agentId = uniqueId("stopping-alone");
    registerSibling(sessionId, agentId, "engineer", true);
    // No other siblings registered for this sessionId.

    writeUnresolvedInvocationFixture({ subagentType: "engineer", runInBackground: true });
    const message = "🗣️ Engineer: Finished via fallback, no siblings left.";

    const r = runHook({ session_id: sessionId, transcript_path: transcriptPath, agent_id: agentId, last_assistant_message: message, agent_type: "engineer" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("All background agents for this batch have now completed");
    expect(r.stdout).not.toContain("MANDATORY: Do NOT begin implementing");
  });
});
