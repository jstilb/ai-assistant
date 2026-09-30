import { GoogleGenAI } from "@google/genai";
import { writeFile, readFile } from "node:fs/promises";
import { extname } from "node:path";
import { CLIError } from "../../Lib/cli-utils.ts";

type ReplicateSize = "1:1" | "16:9" | "3:2" | "2:3" | "3:4" | "4:3" | "4:5" | "5:4" | "9:16" | "21:9";
type GeminiSize = "1K" | "2K" | "4K";

export interface GenerateOptions {
  transparent?: boolean;
  referenceImages?: string[];
  aspectRatio?: ReplicateSize;
}

export async function generate(
  prompt: string,
  size: string,
  outputPath: string,
  options?: GenerateOptions
): Promise<void> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new CLIError("Missing environment variable: GOOGLE_API_KEY");
  }

  const ai = new GoogleGenAI({ apiKey });
  const aspectRatio = options?.aspectRatio ?? "16:9";
  const referenceImages = options?.referenceImages;

  if (referenceImages && referenceImages.length > 0) {
    console.log(`Generating with Nano Banana Pro (Gemini 3 Pro) at ${size} ${aspectRatio} with ${referenceImages.length} reference image(s)...`);
  } else {
    console.log(`Generating with Nano Banana Pro (Gemini 3 Pro) at ${size} ${aspectRatio}...`);
  }

  const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];

  if (referenceImages && referenceImages.length > 0) {
    for (const referenceImage of referenceImages) {
      const imageBuffer = await readFile(referenceImage);
      const imageBase64 = imageBuffer.toString("base64");

      const ext = extname(referenceImage).toLowerCase();
      let mimeType: string;
      switch (ext) {
        case ".png":
          mimeType = "image/png";
          break;
        case ".jpg":
        case ".jpeg":
          mimeType = "image/jpeg";
          break;
        case ".webp":
          mimeType = "image/webp";
          break;
        default:
          throw new CLIError(`Unsupported image format: ${ext}. Supported: .png, .jpg, .jpeg, .webp`);
      }

      parts.push({
        inlineData: {
          mimeType,
          data: imageBase64,
        },
      });
    }
  }

  parts.push({ text: prompt });

  const response = await ai.models.generateContent({
    model: "gemini-3-pro-image-preview",
    contents: [{ parts }],
    config: {
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: {
        aspectRatio,
        imageSize: size as GeminiSize,
      },
    },
  });

  let imageData: string | undefined;
  let refusalText: string | undefined;

  if (response.candidates && response.candidates.length > 0) {
    const responseParts = response.candidates[0].content.parts;
    for (const part of responseParts) {
      if (part.inlineData && part.inlineData.data) {
        imageData = part.inlineData.data;
        break;
      }
      if (part.text) {
        // Gemini can return a text-only response (e.g. a safety/content-policy refusal)
        // instead of an image. Capture it so the caller can tell "the model said no"
        // from "the API broke" rather than a flattened generic error.
        refusalText = refusalText ? `${refusalText} ${part.text}` : part.text;
      }
    }
  }

  if (!imageData) {
    throw new CLIError(
      refusalText
        ? `No image data returned from Gemini API — model responded with text instead: "${refusalText}"`
        : "No image data returned from Gemini API"
    );
  }

  const imageBuffer = Buffer.from(imageData, "base64");
  await writeFile(outputPath, imageBuffer);
  console.log(`Image saved to ${outputPath}`);
}
