#!/usr/bin/env bun
/**
 * DictationTrainer.test.ts - Unit tests for the dictation model builder
 *
 * Covers the pure parts (Modelfile generation, few-shot selection, scoring,
 * pairs parsing via explicit paths). Ollama-touching commands (train/eval)
 * are exercised manually — they require a live Ollama server.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  loadPairs,
  selectFewShot,
  isQualityPair,
  buildModelfile,
  wordF1,
  type TrainingPair,
} from "./DictationTrainer.ts";

let tempDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "dictation-test-"));
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function pair(raw: string, polished: string, timestamp = "2026-01-01"): TrainingPair {
  return { timestamp, raw, polished };
}

describe("loadPairs", () => {
  it("returns empty array for missing file", () => {
    expect(loadPairs(join(tempDir, "missing.jsonl"))).toEqual([]);
  });

  it("parses valid lines and skips junk", () => {
    const path = join(tempDir, "pairs.jsonl");
    writeFileSync(path, [
      JSON.stringify({ timestamp: "t1", raw: "helo world", polished: "Hello world." }),
      "not json",
      JSON.stringify({ raw: "", polished: "empty raw skipped" }),
      JSON.stringify({ timestamp: "t2", raw: "ok", polished: "OK." }),
      "",
    ].join("\n"));
    const pairs = loadPairs(path);
    expect(pairs.length).toBe(2);
    expect(pairs[0].raw).toBe("helo world");
    expect(pairs[1].polished).toBe("OK.");
  });
});

describe("isQualityPair", () => {
  it("rejects no-op pairs", () => {
    expect(isQualityPair(pair("same text here", "same text here"))).toBe(false);
  });

  it("rejects pairs whose polished text starts lowercase", () => {
    expect(isQualityPair(pair("Investigate.", "investigate."))).toBe(false);
    expect(
      isQualityPair(pair("hello kaya how are you", "hello kaya, how are you?"))
    ).toBe(false);
  });

  it("rejects heavy rewrites (low word overlap)", () => {
    expect(
      isQualityPair(
        pair(
          "nothing should be run twice that isn't meant to run twice",
          "Nothing should run more than once unless intentionally repeated."
        )
      )
    ).toBe(false);
  });

  it("accepts rule-following casing and punctuation fixes", () => {
    expect(
      isQualityPair(
        pair(
          "check the daemon environment issue so future runs work",
          "Check the daemon environment issue so future runs work."
        )
      )
    ).toBe(true);
  });
});

describe("selectFewShot", () => {
  it("prefers newest pairs, deduplicates, skips low-quality pairs", () => {
    const pairs = [
      pair("the oldest sentence in the file", "The oldest sentence in the file."),
      pair("same text here", "same text here"), // no-op — teaches nothing
      pair("a duplicated raw sentence here", "A duplicated raw sentence here!"),
      pair("a duplicated raw sentence here", "A duplicated raw sentence here."),
      pair("the newest sentence in the file", "The newest sentence in the file."),
    ];
    const selected = selectFewShot(pairs, 3);
    expect(selected.map((p) => p.raw)).toEqual([
      "the oldest sentence in the file",
      "a duplicated raw sentence here",
      "the newest sentence in the file",
    ]);
    // dedupe kept the NEWEST occurrence of the duplicated raw
    expect(selected[1].polished).toBe("A duplicated raw sentence here.");
  });

  it("respects the count limit", () => {
    const pairs = Array.from({ length: 10 }, (_, i) =>
      pair(`raw sentence number ${i} here`, `Raw sentence number ${i} here.`)
    );
    expect(selectFewShot(pairs, 4).length).toBe(4);
  });
});

describe("buildModelfile", () => {
  it("embeds base model, parameters, vocabulary, and few-shot messages", () => {
    const modelfile = buildModelfile({
      baseModel: "qwen2.5:1.5b",
      vocab: { terms: ["Kaya"], phrases: ["daily briefing"] },
      pairs: [pair("helo kya please review the pull request", "Hello Kaya, please review the pull request.")],
    });
    expect(modelfile).toContain("FROM qwen2.5:1.5b");
    expect(modelfile).toContain("PARAMETER temperature 0.1");
    expect(modelfile).toContain("Kaya, daily briefing");
    expect(modelfile).toContain('MESSAGE user """helo kya please review the pull request"""');
    expect(modelfile).toContain('MESSAGE assistant """Hello Kaya, please review the pull request."""');
  });

  it("omits the vocabulary line when vocabulary is empty", () => {
    const modelfile = buildModelfile({
      vocab: { terms: [], phrases: [] },
      pairs: [],
    });
    expect(modelfile).not.toContain("Known domain terms");
    expect(modelfile).not.toContain("MESSAGE");
  });

  it("escapes triple quotes so the Modelfile stays parseable", () => {
    const modelfile = buildModelfile({
      vocab: { terms: [], phrases: [] },
      pairs: [pair('say """this"""', 'Say "this".')],
    });
    expect(modelfile).not.toContain('"""this"""');
  });
});

describe("wordF1", () => {
  it("returns 1 for identical text", () => {
    expect(wordF1("hello world", "hello world")).toBe(1);
  });

  it("ignores case and punctuation", () => {
    expect(wordF1("Hello, world!", "hello world")).toBe(1);
  });

  it("returns 0 for disjoint text", () => {
    expect(wordF1("hello world", "foo bar")).toBe(0);
  });

  it("returns 0 for empty inputs", () => {
    expect(wordF1("", "hello")).toBe(0);
    expect(wordF1("hello", "")).toBe(0);
  });

  it("scores partial overlap between 0 and 1", () => {
    const score = wordF1("hello world foo", "hello world bar");
    expect(score).toBeGreaterThan(0.5);
    expect(score).toBeLessThan(1);
  });
});
