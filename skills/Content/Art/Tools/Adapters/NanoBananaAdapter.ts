import Replicate from "replicate";
import { writeFile } from "node:fs/promises";
import { CLIError } from "../../Lib/cli-utils.ts";

type ReplicateSize = "1:1" | "16:9" | "3:2" | "2:3" | "3:4" | "4:3" | "4:5" | "5:4" | "9:16" | "21:9";

export interface GenerateOptions {
  transparent?: boolean;
  referenceImages?: string[];
}

export async function generate(
  prompt: string,
  size: string,
  outputPath: string,
  options?: GenerateOptions
): Promise<void> {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) {
    throw new CLIError("Missing environment variable: REPLICATE_API_TOKEN");
  }

  if (options?.transparent) {
    console.warn(
      "⚠️  --transparent was requested but the Nano Banana adapter does not support alpha-channel " +
      "output — the prompt was prefixed with a transparency instruction, but the model has no " +
      "way to honor it. Output will NOT have a transparent background."
    );
  }

  const replicate = new Replicate({ auth: token });

  console.log("Generating with Nano Banana...");

  const result = await replicate.run("google/nano-banana", {
    input: {
      prompt,
      aspect_ratio: size as ReplicateSize,
      output_format: "png",
    },
  });

  await writeFile(outputPath, result as Parameters<typeof writeFile>[1]);
  console.log(`Image saved to ${outputPath}`);
}
