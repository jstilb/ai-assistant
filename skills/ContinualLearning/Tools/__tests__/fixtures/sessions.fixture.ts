/**
 * Test fixtures for KnowledgeSynthesizer.loadSessionLearnings()
 *
 * Represents JSONL session transcript data shaped as the real data
 * found in MEMORY/projects/ directories.
 */

/** Valid session JSONL with corrections, errors, and insights */
export const VALID_SESSION_JSONL = [
  JSON.stringify({
    type: "user",
    timestamp: "2026-02-01T10:00:00Z",
    message: { content: "Actually, I meant to use the other approach for this problem" },
  }),
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-02-01T10:01:00Z",
    message: { content: "Error: Command failed with exit code 1 during build step" },
  }),
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-02-01T10:05:00Z",
    message: { content: "I learned that using direct Bun APIs is faster than the Node.js compatibility layer" },
  }),
  JSON.stringify({
    type: "user",
    timestamp: "2026-02-01T10:10:00Z",
    message: { content: "Wait, that is not the right file to edit for this feature" },
  }),
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-02-01T10:15:00Z",
    message: { content: "I realized that the StateManager pattern is cleaner than raw fs operations" },
  }),
].join("\n");

/** Empty session content */
export const EMPTY_SESSION_JSONL = "";

/** Session with only short messages that should be filtered out (< 20 chars) */
export const SHORT_MESSAGES_JSONL = [
  JSON.stringify({ type: "user", timestamp: "2026-02-01T10:00:00Z", message: { content: "ok" } }),
  JSON.stringify({ type: "assistant", timestamp: "2026-02-01T10:01:00Z", message: { content: "done" } }),
  JSON.stringify({ type: "user", timestamp: "2026-02-01T10:02:00Z", message: { content: "thanks" } }),
].join("\n");

/** Session with malformed JSON lines mixed in */
export const MALFORMED_SESSION_JSONL = [
  '{"type": "user", "timestamp": "2026-02-01T10:00:00Z", "message": {"content": "Actually, I wanted a different approach to this problem"}}',
  "this is not valid json at all",
  '{"type": "assistant", "timestamp": "2026-02-01T10:01:00Z", "message": {}}',
  '{"type": "assistant", "timestamp": "2026-02-01T10:02:00Z"}',
  '{"type": "assistant", "timestamp": "2026-02-01T10:03:00Z", "message": {"content": "Key insight: the pattern detection works better with more context"}}',
].join("\n");

/** Session with array-style message content (multi-part messages) */
export const ARRAY_CONTENT_JSONL = [
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-02-01T10:00:00Z",
    message: {
      content: [
        { text: "I discovered that the caching layer " },
        { text: "reduces API calls by 80 percent overall" },
      ],
    },
  }),
  JSON.stringify({
    type: "user",
    timestamp: "2026-02-01T10:01:00Z",
    message: {
      content: [
        { text: "No, I meant to use the " },
        { text: "production endpoint, not staging" },
      ],
    },
  }),
].join("\n");
