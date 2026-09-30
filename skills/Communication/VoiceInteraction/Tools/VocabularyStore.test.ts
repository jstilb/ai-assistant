#!/usr/bin/env bun
/**
 * VocabularyStore.test.ts - Unit tests for the personal voice vocabulary
 *
 * All file-touching tests pass explicit temp paths — no KAYA_HOME pinning
 * needed (loadVocabulary/saveVocabulary accept a path parameter).
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  loadVocabulary,
  saveVocabulary,
  buildWhisperPrompt,
  buildPolishVocabSection,
  type Vocabulary,
} from "./VocabularyStore.ts";

let tempDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "vocab-test-"));
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("loadVocabulary", () => {
  it("returns empty vocabulary for a missing file", () => {
    const vocab = loadVocabulary(join(tempDir, "does-not-exist.json"));
    expect(vocab.terms).toEqual([]);
    expect(vocab.phrases).toEqual([]);
  });

  it("returns empty vocabulary for malformed JSON", () => {
    const path = join(tempDir, "malformed.json");
    writeFileSync(path, "{not json");
    const vocab = loadVocabulary(path);
    expect(vocab.terms).toEqual([]);
    expect(vocab.phrases).toEqual([]);
  });

  it("round-trips through saveVocabulary", () => {
    const path = join(tempDir, "roundtrip.json");
    const vocab: Vocabulary = {
      terms: ["Kaya", "TELOS"],
      phrases: ["daily briefing"],
    };
    saveVocabulary(vocab, path);
    expect(loadVocabulary(path)).toEqual(vocab);
  });

  it("defaults missing keys to empty arrays", () => {
    const path = join(tempDir, "partial.json");
    writeFileSync(path, JSON.stringify({ terms: ["Kaya"] }));
    const vocab = loadVocabulary(path);
    expect(vocab.terms).toEqual(["Kaya"]);
    expect(vocab.phrases).toEqual([]);
  });
});

describe("buildWhisperPrompt", () => {
  it("returns empty string for empty vocabulary", () => {
    expect(buildWhisperPrompt({ terms: [], phrases: [] })).toBe("");
  });

  it("builds a vocabulary sentence from terms and phrases", () => {
    const prompt = buildWhisperPrompt({
      terms: ["Kaya", "TELOS"],
      phrases: ["daily briefing"],
    });
    expect(prompt).toBe("Vocabulary: Kaya, TELOS, daily briefing.");
  });

  it("caps the prompt length under the Whisper token budget", () => {
    const terms = Array.from({ length: 500 }, (_, i) => `LongDomainTerm${i}`);
    const prompt = buildWhisperPrompt({ terms, phrases: [] });
    expect(prompt.length).toBeLessThanOrEqual(720);
    expect(prompt.startsWith("Vocabulary: ")).toBe(true);
    expect(prompt.endsWith(".")).toBe(true);
  });
});

describe("buildPolishVocabSection", () => {
  it("returns empty string for empty vocabulary", () => {
    expect(buildPolishVocabSection({ terms: [], phrases: [] })).toBe("");
  });

  it("lists all terms and phrases", () => {
    const section = buildPolishVocabSection({
      terms: ["Kaya"],
      phrases: ["Ocean Beach"],
    });
    expect(section).toContain("[VOCABULARY]");
    expect(section).toContain("Kaya, Ocean Beach");
    expect(section.endsWith("\n")).toBe(true);
  });
});
