/**
 * CliStdin — shared stdin reader for command-line tools.
 *
 * Use this when a CLI (not a hook) reads piped input to end of stream.
 * Hooks must use the readers in lib/hook-utils.ts (they add the fail-open or
 * fail-closed contract). Credentials must use lib/core/SecretInput.ts.
 *
 * Behavior:
 *   - If stdin is a terminal (nothing is piped), return '' at once instead of
 *     waiting for the user to press Ctrl-D.
 *   - Without `timeoutMs`, wait for end of stream.
 *   - With `timeoutMs`, return what was read so far when the time ends.
 */

interface ReadStdinOptions {
  /** Trim the result. Default: true. */
  trim?: boolean;
  /** Stop reading after this many milliseconds. Default: no timeout. */
  timeoutMs?: number;
}

/** Read all of stdin as UTF-8 text. */
export async function readStdinText(options: ReadStdinOptions = {}): Promise<string> {
  const { trim = true, timeoutMs } = options;

  if (process.stdin.isTTY) return "";

  const chunks: string[] = [];
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();

  let timer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs !== undefined) {
    timer = setTimeout(() => {
      reader.cancel().catch((err) => {
        console.error("[CliStdin] stdin cancel after timeout failed:", err);
      });
    }, timeoutMs);
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    if (timer) clearTimeout(timer);
  }

  const text = chunks.join("");
  return trim ? text.trim() : text;
}
