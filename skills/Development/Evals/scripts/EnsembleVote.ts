/**
 * EnsembleVote.ts — shared 3-level majority-vote labeler for the golden-set
 * label-*-golden.ts scripts.
 *
 * Runs one prompt at the fast, standard and smart levels in parallel, reads one
 * string field from each JSON answer, and returns the label only when more than
 * half of the valid voters agree. Otherwise the result is divergent (label null).
 */
import { type InferenceOptions, type InferenceResult, inference } from "../../../../lib/core/Inference.ts";

export const ENSEMBLE_LEVELS = ["fast", "standard", "smart"] as const;

interface VoteOutcome {
  label: string | null;
  divergent: boolean;
  votes: Record<string, number>;
}

/** Tally the votes in `results` and apply the strict-majority rule. */
export function tallyMajority(
  results: ReadonlyArray<Pick<InferenceResult, "success" | "parsed">>,
  candidateField: string,
  validLabels: ReadonlySet<string>,
): VoteOutcome {
  const votes: Record<string, number> = {};
  let voterCount = 0;

  for (const result of results) {
    const raw =
      result.success && result.parsed != null ? (result.parsed as Record<string, unknown>)[candidateField] : undefined;

    if (typeof raw === "string" && validLabels.has(raw)) {
      votes[raw] = (votes[raw] ?? 0) + 1;
      voterCount++;
    }
  }

  if (voterCount === 0) {
    return { label: null, divergent: true, votes };
  }

  // Simple majority: top vote must have >50% of voter count
  let topLabel: string | undefined;
  let topCount = 0;
  for (const [label, count] of Object.entries(votes)) {
    if (count > topCount) {
      topCount = count;
      topLabel = label;
    }
  }

  if (topLabel !== undefined && topCount * 2 > voterCount) {
    return { label: topLabel, divergent: false, votes };
  }

  return { label: null, divergent: true, votes };
}

interface EnsembleVoteInput {
  systemPrompt: string;
  userPrompt: string;
  candidateField: string;
  validLabels: ReadonlySet<string>;
}

/** Run the prompt at all ensemble levels and tally the answers. */
export async function ensembleVote(
  input: EnsembleVoteInput,
  infer: (options: InferenceOptions) => Promise<InferenceResult> = inference,
): Promise<VoteOutcome> {
  const results = await Promise.all(
    ENSEMBLE_LEVELS.map((level) =>
      infer({
        systemPrompt: input.systemPrompt,
        userPrompt: input.userPrompt,
        level,
        expectJson: true,
        retries: 2,
      }),
    ),
  );
  return tallyMajority(results, input.candidateField, input.validLabels);
}
