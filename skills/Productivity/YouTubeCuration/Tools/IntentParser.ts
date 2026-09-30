#!/usr/bin/env bun
/**
 * IntentParser.ts — free prose → parsed topic list (`/youtube steer <prose>`,
 * parse half only).
 *
 * PARSE-ONLY, by construction: this module has no filesystem write anywhere
 * in it — no `writeFileSync`, no import of `IntentWriter.ts` — and takes no
 * path argument to write to. It cannot persist anything even by mistake.
 * That is the structural half of spec.md §7's confirm-echo contract: the
 * parsed topics must be echoed back to Jm and confirmed BEFORE
 * `USER/YouTubeIntent.yaml` is touched. `IntentWriter.ts` is the other half
 * — it accepts only an already-confirmed `topics: string[]`, never prose,
 * and never imports the inference seam — so no single tool invocation can
 * both parse prose AND write the file. The caller (the `/youtube steer`
 * command flow) is what sequences parse → echo → Jm's confirmation → write;
 * this file only ever does the first step.
 *
 * Uses `inference({schema})` (lib/core/Inference.ts's schema-constrained
 * structured-output path — never a direct API call, per repo convention)
 * so the topic list comes back API-validated rather than regex-scraped from
 * free text.
 */

import { inference, type InferenceOptions, type InferenceResult } from "../../../../lib/core/Inference.ts";

/** JSON Schema for the structured-output call — topics only, no channel
 *  lists, no mix percentages (spec.md §7). */
const TOPIC_LIST_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    topics: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["topics"],
  additionalProperties: false,
};

const TOPIC_PARSE_SYSTEM_PROMPT = `You extract a YouTube curation "intent" topic list from Jm's free-form prose.

A topic is a short free-text interest string used to build a per-topic playlist Jm will watch from (e.g. "woodworking", "jazz guitar", "TypeScript performance"). Topics represent things Jm wants MORE of — there is no mechanism in this schema for exclusions or negative signal, so:
- Extract only the affirmative interests ("more X", "I want to see Y", a bare topic mention).
- Do NOT turn negative/exclusion phrasing ("less politics", "stop showing me Z", "no more W") into a topic — drop it entirely. It has no representation here; it is not the same as a topic Jm wants to watch.
- Do not invent topics that are not stated or clearly implied.
- Keep each topic short and close to Jm's own phrasing (2-4 words is typical) — do not merge distinct topics into one string, do not split one topic into several.
- Deduplicate near-identical restatements of the same topic.

Respond with the structured topics array only.`;

export interface ParseIntentTopicsResult {
  topics: string[];
}

function extractTopics(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("IntentParser: structured response was not an object");
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.topics)) {
    throw new Error("IntentParser: structured response missing a topics array");
  }
  const topics = obj.topics
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (topics.length === 0) {
    throw new Error("IntentParser: no affirmative topics found in that prose — nothing to declare");
  }
  return topics;
}

/**
 * Parse prose into a topic list via schema-constrained inference. Never
 * writes anything — the caller must echo `topics` back to Jm for
 * confirmation before calling `writeIntent()` in `IntentWriter.ts`.
 *
 * `inferenceFn` is injectable so tests can stub the inference seam instead
 * of making a live LLM call (mirrors the `inferenceFn` DI idiom used by
 * JobScanner.ts / EnsembleValidator.ts / RegressionAlert.ts).
 */
export async function parseIntentTopics(
  prose: string,
  inferenceFn: (opts: InferenceOptions) => Promise<InferenceResult> = inference,
): Promise<ParseIntentTopicsResult> {
  const trimmed = prose.trim();
  if (trimmed.length === 0) {
    throw new Error("IntentParser: empty prose — nothing to parse");
  }

  const result = await inferenceFn({
    systemPrompt: TOPIC_PARSE_SYSTEM_PROMPT,
    userPrompt: trimmed,
    level: "standard",
    schema: TOPIC_LIST_SCHEMA,
  });

  if (!result.success || result.parsed === undefined || result.parsed === null) {
    throw new Error(`IntentParser: inference failed — ${result.error ?? "no structured output"}`);
  }

  return { topics: extractTopics(result.parsed) };
}

async function main(): Promise<void> {
  const prose = process.argv.slice(2).join(" ").trim();
  if (!prose) {
    console.error('Usage: bun IntentParser.ts "<prose intent>"');
    process.exit(1);
  }
  const { topics } = await parseIntentTopics(prose);
  console.log(JSON.stringify({ topics }, null, 2));
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error("Fatal:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
