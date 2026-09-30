#!/usr/bin/env bun
/**
 * DictationTrainer.ts - build/refresh the local dictation polish model (free)
 *
 * STTPolishPipeline tries `dictation:latest` first, but nothing ever created
 * that model — this tool does. "Training" here is an Ollama Modelfile build:
 * base qwen2.5:1.5b + a dictation system prompt embedding the personal
 * vocabulary (VocabularyStore) + few-shot raw->polished examples drawn from
 * data/pairs.jsonl (accumulated automatically by STTPolishPipeline on every
 * accepted polish). Re-run `train` any time to fold in new pairs/vocabulary.
 *
 * Upgrade path: once pairs.jsonl holds hundreds of examples, replace the
 * Modelfile build with a real LoRA fine-tune — the CLI surface stays the same.
 *
 * Usage:
 *   bun DictationTrainer.ts status            # pairs/vocab/model inventory
 *   bun DictationTrainer.ts build-modelfile   # print the generated Modelfile
 *   bun DictationTrainer.ts train             # ollama create dictation:latest
 *   bun DictationTrainer.ts eval [model]      # score model against pairs.jsonl
 *   bun DictationTrainer.ts compare           # eval base vs dictation:latest
 *
 * Reversal: `ollama rm dictation:latest` (polish falls back to the base model).
 */

import { spawnSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { httpClient } from "../../../../lib/core/CachedHTTPClient.ts";
import { kayaHomePath } from "../../../../lib/core/KayaHome.ts";
import { loadVocabulary, type Vocabulary } from "./VocabularyStore.ts";
import { buildPolishPrompt, getPolishStats } from "./STTPolishPipeline.ts";

const DICTATION_MODEL = "dictation:latest";
const BASE_MODEL = "qwen2.5:1.5b";
const OLLAMA_URL = "http://localhost:11434";
const FEW_SHOT_COUNT = 6;
const EVAL_TIMEOUT_MS = 30000;

export interface TrainingPair {
  timestamp: string;
  raw: string;
  polished: string;
  model?: string;
}

function pairsPath(): string {
  return kayaHomePath("data", "pairs.jsonl");
}

/** Curated seed pairs shipped with the skill — always included as few-shot. */
function seedPairsPath(): string {
  return join(import.meta.dir, "..", "Config", "dictation-seed-pairs.jsonl");
}

/** Load raw->polished pairs from pairs.jsonl (newest last), skipping junk rows. */
export function loadPairs(path: string = pairsPath()): TrainingPair[] {
  if (!existsSync(path)) return [];
  const pairs: TrainingPair[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<TrainingPair>;
      if (
        typeof parsed.raw === "string" && parsed.raw.length > 0 &&
        typeof parsed.polished === "string" && parsed.polished.length > 0
      ) {
        pairs.push({
          timestamp: parsed.timestamp ?? "",
          raw: parsed.raw,
          polished: parsed.polished,
          model: parsed.model,
        });
      }
    } catch {
      // skip malformed lines
    }
  }
  return pairs;
}

/**
 * A pair is a usable teaching example only if the polish followed the rules:
 * mostly the same words (no rewrite) and no de-capitalizing the first letter.
 * Historical pairs predate the word-overlap guard, so some are rewrites.
 */
export function isQualityPair(pair: TrainingPair): boolean {
  if (pair.raw === pair.polished) return false; // teaches nothing
  // Polished dictation must start with a capital — a lowercase start teaches
  // the model to skip the most basic fix.
  const polishedFirst = pair.polished.trim()[0] ?? "";
  if (/[a-z]/.test(polishedFirst)) return false;
  return wordF1(pair.raw, pair.polished) >= 0.7;
}

/**
 * Select few-shot examples: newest quality pairs first, deduplicated by raw
 * text, returned in chronological order.
 */
export function selectFewShot(
  pairs: TrainingPair[],
  count: number = FEW_SHOT_COUNT
): TrainingPair[] {
  const seen = new Set<string>();
  const selected: TrainingPair[] = [];
  for (let i = pairs.length - 1; i >= 0 && selected.length < count; i--) {
    const pair = pairs[i];
    const key = pair.raw.toLowerCase();
    if (seen.has(key) || !isQualityPair(pair)) continue;
    seen.add(key);
    selected.push(pair);
  }
  return selected.reverse(); // chronological order in the Modelfile
}

/** Ollama Modelfile triple-quoted blocks can't contain `"""`. */
function escapeModelfileText(text: string): string {
  return text.replace(/"""/g, '"');
}

/**
 * Generate the dictation Modelfile: base model + system prompt embedding the
 * vocabulary + few-shot MESSAGE pairs. Pure — testable without Ollama.
 */
export function buildModelfile(opts?: {
  baseModel?: string;
  vocab?: Vocabulary;
  pairs?: TrainingPair[];
  fewShotCount?: number;
}): string {
  const baseModel = opts?.baseModel ?? BASE_MODEL;
  const vocab = opts?.vocab ?? loadVocabulary();
  const pairs = opts?.pairs ?? loadPairs();
  const seedPairs = opts?.pairs ? [] : loadPairs(seedPairsPath());
  const fewShot = [
    ...seedPairs,
    ...selectFewShot(pairs, opts?.fewShotCount ?? FEW_SHOT_COUNT),
  ];

  const vocabItems = [...vocab.terms, ...vocab.phrases].filter(Boolean);
  const vocabLine = vocabItems.length > 0
    ? `\nKnown domain terms — prefer these exact spellings when a similar-sounding word appears: ${vocabItems.join(", ")}.`
    : "";

  const system = escapeModelfileText(
    "You clean up speech-to-text dictation output. Fix ONLY spelling, " +
    "punctuation, and capitalization. Keep the same words; never rephrase, " +
    "reword, or add commentary. Use straight apostrophes. Output only the " +
    "corrected text." + vocabLine
  );

  const lines: string[] = [
    `FROM ${baseModel}`,
    "PARAMETER temperature 0.1",
    "PARAMETER num_predict 512",
    `SYSTEM """${system}"""`,
  ];

  for (const pair of fewShot) {
    lines.push(`MESSAGE user """${escapeModelfileText(pair.raw)}"""`);
    lines.push(`MESSAGE assistant """${escapeModelfileText(pair.polished)}"""`);
  }

  return lines.join("\n") + "\n";
}

/**
 * Word-level F1 between expected and actual text (case/punctuation
 * insensitive). Symmetric-ish quality score for eval — higher is better.
 */
export function wordF1(expected: string, actual: string): number {
  const tokenize = (text: string): string[] =>
    text.toLowerCase().replace(/[^a-z0-9\s']/g, "").split(/\s+/).filter(Boolean);

  const expectedWords = tokenize(expected);
  const actualWords = tokenize(actual);
  if (expectedWords.length === 0 || actualWords.length === 0) return 0;

  const expectedCounts = new Map<string, number>();
  for (const word of expectedWords) {
    expectedCounts.set(word, (expectedCounts.get(word) ?? 0) + 1);
  }
  let overlap = 0;
  for (const word of actualWords) {
    const remaining = expectedCounts.get(word) ?? 0;
    if (remaining > 0) {
      overlap++;
      expectedCounts.set(word, remaining - 1);
    }
  }

  const precision = overlap / actualWords.length;
  const recall = overlap / expectedWords.length;
  if (precision + recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

async function generateViaOllama(
  model: string,
  prompt: string
): Promise<string | null> {
  try {
    const response = await httpClient.fetch(`${OLLAMA_URL}/api/generate`, {
      cache: "none",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: { temperature: 0.1, num_predict: 512 },
      }),
      timeout: EVAL_TIMEOUT_MS,
    });
    if (!response.ok) return null;
    const data = await response.json() as { response?: string };
    return data?.response?.trim() || null;
  } catch {
    return null;
  }
}

interface EvalResult {
  model: string;
  evaluated: number;
  failed: number;
  avgF1: number;
}

/**
 * Score a model against pairs.jsonl: for each pair, run the polish prompt on
 * the raw text and compare the output to the stored polished target.
 */
async function evalModel(
  model: string,
  pairs: TrainingPair[]
): Promise<EvalResult> {
  const prompt = buildPolishPrompt();
  let failed = 0;
  let totalF1 = 0;
  let evaluated = 0;

  for (const pair of pairs) {
    const output = await generateViaOllama(model, prompt + pair.raw);
    if (output === null) {
      failed++;
      continue;
    }
    totalF1 += wordF1(pair.polished, output);
    evaluated++;
  }

  return {
    model,
    evaluated,
    failed,
    avgF1: evaluated > 0 ? Math.round((totalF1 / evaluated) * 1000) / 1000 : 0,
  };
}

function ollamaModelExists(model: string): boolean {
  const result = spawnSync("ollama", ["list"], { encoding: "utf-8", timeout: 10000 });
  if (result.status !== 0) return false;
  const name = model.replace(/:latest$/, "");
  return result.stdout.split("\n").some((line) => {
    const first = line.split(/\s+/)[0] ?? "";
    return first === model || first === name || first === `${name}:latest`;
  });
}

function train(): void {
  const modelfile = buildModelfile();
  const modelfilePath = join("/tmp", `dictation-modelfile-${Date.now()}`);
  writeFileSync(modelfilePath, modelfile);

  console.log(`Building ${DICTATION_MODEL} from ${modelfilePath}...`);
  const result = spawnSync(
    "ollama",
    ["create", DICTATION_MODEL, "-f", modelfilePath],
    { encoding: "utf-8", timeout: 120000 }
  );

  if (result.status !== 0) {
    throw new Error(`ollama create failed: ${result.stderr || result.stdout}`);
  }
  console.log(`Created ${DICTATION_MODEL}. Reverse with: ollama rm ${DICTATION_MODEL}`);
}

// --- CLI ---

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case "status": {
      const pairs = loadPairs();
      const vocab = loadVocabulary();
      const stats = await getPolishStats();
      console.log(JSON.stringify({
        pairs: pairs.length,
        fewShotUsed: selectFewShot(pairs).length,
        vocabTerms: vocab.terms.length,
        vocabPhrases: vocab.phrases.length,
        dictationModelExists: ollamaModelExists(DICTATION_MODEL),
        baseModelExists: ollamaModelExists(BASE_MODEL),
        polishStats: {
          totalPolished: stats.totalPolished,
          totalRejected: stats.totalRejected,
          totalRaw: stats.totalRaw,
        },
      }, null, 2));
      break;
    }

    case "build-modelfile": {
      console.log(buildModelfile());
      break;
    }

    case "train": {
      train();
      break;
    }

    case "eval": {
      const model = args[0] ?? DICTATION_MODEL;
      const pairs = loadPairs();
      if (pairs.length === 0) {
        console.error("No pairs in pairs.jsonl — nothing to evaluate.");
        process.exit(1);
      }
      console.log(JSON.stringify(await evalModel(model, pairs), null, 2));
      break;
    }

    case "compare": {
      const pairs = loadPairs();
      if (pairs.length === 0) {
        console.error("No pairs in pairs.jsonl — nothing to evaluate.");
        process.exit(1);
      }
      const base = await evalModel(BASE_MODEL, pairs);
      const dictation = ollamaModelExists(DICTATION_MODEL)
        ? await evalModel(DICTATION_MODEL, pairs)
        : null;
      console.log(JSON.stringify({ base, dictation }, null, 2));
      break;
    }

    default:
      console.log(`DictationTrainer - build the free local dictation polish model

Commands:
  status             Show pairs/vocabulary/model inventory
  build-modelfile    Print the generated Modelfile (no side effects)
  train              ollama create ${DICTATION_MODEL} from vocabulary + pairs
  eval [model]       Score a model against pairs.jsonl (default ${DICTATION_MODEL})
  compare            Eval ${BASE_MODEL} vs ${DICTATION_MODEL}`);
      break;
  }
}

if (import.meta.main) {
  main().catch((err: Error) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}
