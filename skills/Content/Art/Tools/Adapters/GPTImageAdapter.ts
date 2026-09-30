import OpenAI from "openai";
import { writeFile } from "node:fs/promises";
import { CLIError } from "../../Lib/cli-utils.ts";

type OpenAISize = "1024x1024" | "1536x1024" | "1024x1536";

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
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new CLIError("Missing environment variable: OPENAI_API_KEY");
  }

  if (options?.transparent) {
    console.warn(
      "⚠️  --transparent was requested but the GPT-Image-1 adapter does not support alpha-channel " +
      "output — the prompt was prefixed with a transparency instruction, but the model has no " +
      "way to honor it. Output will NOT have a transparent background."
    );
  }

  const openai = new OpenAI({ apiKey });

  console.log("Generating with GPT-image-1...");

  const response = await openai.images.generate({
    model: "gpt-image-1",
    prompt,
    size: size as OpenAISize,
    n: 1,
  });

  if (!response.data || response.data.length === 0) {
    throw new CLIError("No image data returned from OpenAI API (empty response.data array)");
  }

  const imageData = response.data[0].b64_json;
  if (!imageData) {
    throw new CLIError("No image data returned from OpenAI API");
  }

  const imageBuffer = Buffer.from(imageData, "base64");
  await writeFile(outputPath, imageBuffer);
  console.log(`Image saved to ${outputPath}`);
}
