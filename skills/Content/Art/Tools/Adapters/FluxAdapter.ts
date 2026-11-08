import { generateWithReplicate, type GenerateOptions } from "./ReplicateRun.ts";

export type { GenerateOptions };

export async function generate(
  prompt: string,
  size: string,
  outputPath: string,
  options?: GenerateOptions,
): Promise<void> {
  await generateWithReplicate(
    {
      model: "black-forest-labs/flux-1.1-pro",
      adapterName: "Flux",
      displayName: "Flux 1.1 Pro",
      extraInput: { output_quality: 95, prompt_upsampling: false },
    },
    prompt,
    size,
    outputPath,
    options,
  );
}
