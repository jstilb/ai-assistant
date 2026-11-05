/**
 * session-origin.ts — Was this Claude Code session one Jm actually took part in?
 *
 * SessionRatingRecord rates "Jm's satisfaction with the session". A headless
 * `claude -p` call (form-doc's coach, cron jobs, probes, voice tests) has no Jm
 * in it, so rating it only adds a false neutral row ("Transcript contains only
 * tool schemas…", rating 5) to ratings.jsonl. Found 2026-10-31: every one of
 * the 299 implicit rows from `sdk-cli` sessions was noise of this kind.
 *
 * Signals, in order:
 *   1. The transcript's `entrypoint` field. Claude Code stamps every record:
 *      "cli" = the interactive terminal app; "sdk-cli" = `claude -p`;
 *      "sdk-ts" / "sdk-py" = the Agent SDKs. Any `sdk-*` is headless.
 *   2. The CLAUDE_CODE_ENTRYPOINT env var the CLI passes to hooks, used only
 *      when the transcript carries no entrypoint.
 *   3. No user turn: no non-meta `user` record with typed text (tool results
 *      and system-injected meta records do not count).
 *
 * Shared by the SessionRatingRecord hook (skip at SessionEnd) and
 * bin/purge-headless-ratings.ts (move the existing false rows out).
 */

/** Read at most this many lines when looking for the entrypoint stamp. */
const ENTRYPOINT_SCAN_LINES = 200;

/** True for entrypoints that mean "no human at a terminal". */
function isHeadlessEntrypoint(entrypoint: string | null | undefined): boolean {
  return typeof entrypoint === "string" && entrypoint.startsWith("sdk-");
}

function parseLines(transcript: string, limit?: number): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const lines = transcript.split("\n");
  for (let i = 0; i < lines.length && (limit === undefined || i < limit); i++) {
    const line = (lines[i] ?? "").trim();
    if (!line) continue;
    try {
      const rec = JSON.parse(line);
      if (rec && typeof rec === "object") out.push(rec as Record<string, unknown>);
    } catch {
      // intentionally silent: a truncated last line (session still writing)
      // or a non-JSON fixture line is normal and carries no origin signal
    }
  }
  return out;
}

/** The first `entrypoint` stamp in the transcript JSONL, or null if none. */
function readEntrypoint(transcript: string): string | null {
  for (const rec of parseLines(transcript, ENTRYPOINT_SCAN_LINES)) {
    if (typeof rec.entrypoint === "string" && rec.entrypoint) return rec.entrypoint;
  }
  return null;
}

/**
 * True if the transcript has at least one turn a person typed: a non-meta
 * `user` record whose content is a non-empty string or holds a text block.
 */
function hasUserTurn(transcript: string): boolean {
  for (const rec of parseLines(transcript)) {
    if (rec.type !== "user" || rec.isMeta === true) continue;
    const message = rec.message as { content?: unknown } | undefined;
    const content = message?.content;
    if (typeof content === "string" && content.trim()) return true;
    if (Array.isArray(content)) {
      for (const block of content) {
        const b = block as { type?: unknown; text?: unknown };
        if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) return true;
      }
    }
  }
  return false;
}

/**
 * Why this session must not be rated, or null if it should be.
 * The "no user turn" check applies only to a JSONL transcript: text that holds
 * no JSON records at all is an unknown format, not proof of an empty session.
 */
export function headlessSkipReason(transcript: string, envEntrypoint?: string | null): string | null {
  const entrypoint = readEntrypoint(transcript) ?? envEntrypoint ?? null;
  if (isHeadlessEntrypoint(entrypoint)) return `headless session (entrypoint ${entrypoint})`;
  if (parseLines(transcript, ENTRYPOINT_SCAN_LINES).length > 0 && !hasUserTurn(transcript)) {
    return "no user turn";
  }
  return null;
}
