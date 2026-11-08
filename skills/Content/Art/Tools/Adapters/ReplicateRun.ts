import Replicate from "replicate";
import { writeFile } from "node:fs/promises";
import { CLIError } from "../../Lib/cli-utils.ts";

/**
 * Shared body of the simple Replicate text-to-image adapters (Flux,
 * Nano Banana), which used to be two near-identical files. Each adapter
 * supplies its model id, display names and any extra model inputs.
 */

type ReplicateSize = "1:1" | "16:9" | "3:2" | "2:3" | "3:4" | "4:3" | "4:5" | "5:4" | "9:16" | "21:9";

export interface GenerateOptions {
  transparent?: boolean;
  referenceImages?: string[];
}

export interface ReplicateModelSpec {
  /** Replicate model id, e.g. "black-forest-labs/flux-1.1-pro". */
  model: `${string}/${string}`;
  /** Name in the --transparent warning, e.g. "Flux". */
  adapterName: string;
  /** Name in the progress line, e.g. "Flux 1.1 Pro". */
  displayName: string;
  /** Extra model inputs beyond prompt/aspect_ratio/output_format. */
  extraInput?: Record<string, unknown>;
}

export async function generateWithReplicate(
  spec: ReplicateModelSpec,
  prompt: string,
  size: string,
  outputPath: string,
  options?: GenerateOptions,
): Promise<void> {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) {
    throw new CLIError("Missing environment variable: REPLICATE_API_TOKEN");
  }

  if (options?.transparent) {
    console.warn(
      `⚠️  --transparent was requested but the ${spec.adapterName} adapter does not support alpha-channel ` +
        "output — the prompt was prefixed with a transparency instruction, but the model has no " +
        "way to honor it. Output will NOT have a transparent background.",
    );
  }

  const replicate = new Replicate({ auth: token });

  console.log(`Generating with ${spec.displayName}...`);

  const result = await replicate.run(spec.model, {
    input: {
      prompt,
      aspect_ratio: size as ReplicateSize,
      output_format: "png",
      ...spec.extraInput,
    },
  });

  await writeFile(outputPath, result as Parameters<typeof writeFile>[1]);
  console.log(`Image saved to ${outputPath}`);
}
