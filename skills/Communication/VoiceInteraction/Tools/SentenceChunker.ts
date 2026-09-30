/**
 * SentenceChunker.ts - Streaming sentence boundary detection for TTS
 *
 * Buffers streaming tokens from Claude API and emits complete sentences
 * at natural boundaries for text-to-speech processing. This enables
 * low-latency streaming: TTS can begin on the first sentence while
 * Claude is still generating subsequent sentences.
 *
 * Boundary detection rules:
 *   - Primary: ". ", "! ", "? " (punctuation + space)
 *   - Newline: ".\n", "!\n", "?\n"
 *   - Min chunk: 30 chars (small sentences merge into next)
 *   - Max chunk: 200 chars (force flush at next word boundary)
 *   - Stream end: flush whatever remains
 *
 * Usage:
 *   const chunker = new SentenceChunker();
 *   for await (const token of claudeStream) {
 *     const sentence = chunker.addToken(token);
 *     if (sentence) await tts.speak(sentence);
 *   }
 *   const remaining = chunker.flush();
 *   if (remaining) await tts.speak(remaining);
 */

interface SentenceChunkerOptions {
  /** Minimum characters before emitting a chunk (default: 30) */
  minChunkSize?: number;
  /** Maximum characters before force-flushing (default: 200) */
  maxChunkSize?: number;
}

const SENTENCE_END_PATTERN = /[.!?][\s\n]/;
const DEFAULT_MIN_CHUNK = 30;
const DEFAULT_MAX_CHUNK = 200;

class SentenceChunker {
  private buffer: string = "";
  private minChunkSize: number;
  private maxChunkSize: number;

  constructor(options?: SentenceChunkerOptions) {
    this.minChunkSize = options?.minChunkSize ?? DEFAULT_MIN_CHUNK;
    this.maxChunkSize = options?.maxChunkSize ?? DEFAULT_MAX_CHUNK;
  }

  /**
   * Add a token to the buffer. Returns a flushed sentence if a boundary
   * is detected and the accumulated text meets the minimum chunk size.
   * Returns null if no sentence is ready yet.
   */
  addToken(token: string): string | null {
    if (token.length === 0) return null;

    this.buffer += token;

    // Check for sentence boundaries in the buffer
    const emitted = this.tryEmitSentence();
    if (emitted) return emitted;

    // Force flush if buffer exceeds maxChunkSize
    if (this.buffer.length > this.maxChunkSize) {
      return this.forceFlush();
    }

    return null;
  }

  /**
   * Flush any remaining content in the buffer. Call this when the
   * stream ends to emit the final partial sentence.
   * Returns null if buffer is empty.
   */
  flush(): string | null {
    if (this.buffer.trim().length === 0) {
      this.buffer = "";
      return null;
    }

    const content = this.buffer.trim();
    this.buffer = "";
    return content;
  }

  /**
   * Reset the chunker, clearing all buffered content.
   */
  reset(): void {
    this.buffer = "";
  }

  /**
   * Get the current buffer contents (for debugging/inspection).
   */
  getBuffer(): string {
    return this.buffer;
  }

  /**
   * Scan the buffer for a sentence boundary. If found and the text
   * before it meets minChunkSize, emit it.
   */
  private tryEmitSentence(): string | null {
    // Search for sentence-ending punctuation followed by space or newline
    // We need to find a boundary where: [.!?] followed by [ \n]
    let lastBoundary = -1;

    for (let i = 0; i < this.buffer.length - 1; i++) {
      const char = this.buffer[i];
      const nextChar = this.buffer[i + 1];

      if (
        (char === "." || char === "!" || char === "?") &&
        (nextChar === " " || nextChar === "\n")
      ) {
        // Found a boundary at position i (the punctuation character)
        const candidate = this.buffer.slice(0, i + 1).trim();

        if (candidate.length >= this.minChunkSize) {
          // Emit this sentence
          const remainder = this.buffer.slice(i + 1);
          this.buffer = remainder.startsWith(" ") || remainder.startsWith("\n")
            ? remainder.slice(1)
            : remainder;
          return candidate;
        }

        // Track the boundary even if too short -- we may need it
        lastBoundary = i;
      }
    }

    return null;
  }

  /**
   * Force flush when buffer exceeds maxChunkSize.
   * Tries to break at the last word boundary. If no word boundary,
   * flushes the entire buffer.
   */
  private forceFlush(): string | null {
    // Find last space within buffer for word boundary
    const lastSpace = this.buffer.lastIndexOf(" ");

    if (lastSpace > 0) {
      const content = this.buffer.slice(0, lastSpace).trim();
      this.buffer = this.buffer.slice(lastSpace + 1);
      return content;
    }

    // No word boundary -- flush everything
    const content = this.buffer.trim();
    this.buffer = "";
    return content;
  }
}

export { SentenceChunker };
export type { SentenceChunkerOptions };
