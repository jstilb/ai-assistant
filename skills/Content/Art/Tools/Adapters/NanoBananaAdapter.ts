import { generateWithReplicate, type GenerateOptions } from "./ReplicateRun.ts";

export type { GenerateOptions };

export async function generate(
  prompt: string,
  size: string,
  outputPath: string,
  options?: GenerateOptions,
): Promise<void> {
  await generateWithReplicate(
    { model: "google/nano-banana", adapterName: "Nano Banana", displayName: "Nano Banana" },
    prompt,
    size,
    outputPath,
    options,
  );
}
