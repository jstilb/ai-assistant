#!/usr/bin/env bun
/**
 * VocabularyStore.ts - Personal vocabulary for the free voice stack
 *
 * One user-editable word list that "trains" every free STT surface:
 *   - Whisper decoding bias via --initial-prompt (VoiceInputProcessor)
 *   - Polish prompt vocabulary section (STTPolishPipeline)
 *   - Dictation model system prompt (DictationTrainer)
 *
 * Source of truth: USER/SKILLCUSTOMIZATIONS/VoiceInteraction/vocabulary.json
 *   { "terms": ["Kaya", ...], "phrases": ["daily briefing", ...] }
 *
 * Usage:
 *   bun VocabularyStore.ts list
 *   bun VocabularyStore.ts add <term> [term...]
 *   bun VocabularyStore.ts remove <term>
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { z } from "zod";
import { kayaHomePath } from "../../../../lib/core/KayaHome.ts";

export const VocabularySchema = z.object({
  terms: z.array(z.string()).default([]),
  phrases: z.array(z.string()).default([]),
});

export type Vocabulary = z.infer<typeof VocabularySchema>;

const EMPTY_VOCABULARY: Vocabulary = { terms: [], phrases: [] };

/** Resolved at call time (never a module-scope const) so tests can pin KAYA_HOME. */
export function vocabularyPath(): string {
  return kayaHomePath(
    "USER/SKILLCUSTOMIZATIONS/VoiceInteraction/vocabulary.json"
  );
}

/**
 * Load the personal vocabulary. Missing or malformed files degrade to an
 * empty vocabulary (every consumer treats that as "no priming").
 */
export function loadVocabulary(path: string = vocabularyPath()): Vocabulary {
  if (!existsSync(path)) return EMPTY_VOCABULARY;
  try {
    return VocabularySchema.parse(JSON.parse(readFileSync(path, "utf-8")));
  } catch (err) {
    console.warn(
      `[VocabularyStore] ${path} is malformed — vocabulary not applied.`,
      err instanceof Error ? err.message : String(err)
    );
    return EMPTY_VOCABULARY;
  }
}

export function saveVocabulary(
  vocab: Vocabulary,
  path: string = vocabularyPath()
): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(vocab, null, 2) + "\n");
}

/**
 * Whisper's initial_prompt is capped at 224 tokens; stay well under so the
 * prompt never crowds out actual decoding context.
 */
const WHISPER_PROMPT_MAX_CHARS = 700;

/**
 * Build the Whisper initial_prompt that biases decoding toward the personal
 * vocabulary. Returns "" when there is nothing to prime with.
 */
export function buildWhisperPrompt(
  vocab: Vocabulary = loadVocabulary()
): string {
  const items = [...vocab.terms, ...vocab.phrases].filter(Boolean);
  if (items.length === 0) return "";

  const prefix = "Vocabulary: ";
  const included: string[] = [];
  let length = prefix.length;
  for (const item of items) {
    const cost = item.length + 2; // ", " separator
    if (length + cost > WHISPER_PROMPT_MAX_CHARS) break;
    included.push(item);
    length += cost;
  }
  if (included.length === 0) return "";
  return `${prefix}${included.join(", ")}.`;
}

/**
 * Build the vocabulary section injected into the STT polish prompt so the
 * local model corrects mis-heard proper nouns toward known spellings.
 * Returns "" when the vocabulary is empty.
 */
export function buildPolishVocabSection(
  vocab: Vocabulary = loadVocabulary()
): string {
  const items = [...vocab.terms, ...vocab.phrases].filter(Boolean);
  if (items.length === 0) return "";
  return (
    "[VOCABULARY]\n" +
    "Domain terms with correct spellings — when a similar-sounding word " +
    `appears, use these spellings: ${items.join(", ")}\n`
  );
}

// --- CLI ---

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case "list": {
      console.log(JSON.stringify(loadVocabulary(), null, 2));
      break;
    }

    case "add": {
      if (args.length === 0) {
        console.error("Usage: add <term> [term...]");
        process.exit(1);
      }
      const vocab = loadVocabulary();
      const existing = new Set(
        [...vocab.terms, ...vocab.phrases].map((t) => t.toLowerCase())
      );
      for (const term of args) {
        if (existing.has(term.toLowerCase())) continue;
        if (term.includes(" ")) vocab.phrases.push(term);
        else vocab.terms.push(term);
        existing.add(term.toLowerCase());
      }
      saveVocabulary(vocab);
      console.log(
        JSON.stringify({ terms: vocab.terms.length, phrases: vocab.phrases.length })
      );
      break;
    }

    case "remove": {
      const term = args.join(" ");
      if (!term) {
        console.error("Usage: remove <term>");
        process.exit(1);
      }
      const vocab = loadVocabulary();
      const lower = term.toLowerCase();
      vocab.terms = vocab.terms.filter((t) => t.toLowerCase() !== lower);
      vocab.phrases = vocab.phrases.filter((t) => t.toLowerCase() !== lower);
      saveVocabulary(vocab);
      console.log(
        JSON.stringify({ terms: vocab.terms.length, phrases: vocab.phrases.length })
      );
      break;
    }

    default:
      console.log(`VocabularyStore - personal vocabulary for the free voice stack

Commands:
  list                 Show the current vocabulary
  add <term> [...]     Add terms (multi-word args become phrases)
  remove <term>        Remove a term or phrase`);
      break;
  }
}

if (import.meta.main) {
  main().catch((err: Error) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}
