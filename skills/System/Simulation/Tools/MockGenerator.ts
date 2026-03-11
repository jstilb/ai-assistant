#!/usr/bin/env bun
/**
 * MockGenerator.ts - Synthetic data generation for simulation scenarios
 *
 * Generates mock data for testing agent behavior:
 * - User prompt variants (synonyms, rephrasing)
 * - File system states (mock files and directories)
 * - Tool responses (success, failure, partial)
 * - API responses (various HTTP status codes)
 *
 * Usage:
 *   bun MockGenerator.ts prompts "Check the website" --count=5
 *   bun MockGenerator.ts tool-response Read --mode=success
 *   bun MockGenerator.ts tool-response Read --mode=fail
 *   bun MockGenerator.ts file-state --template=project
 *   bun MockGenerator.ts api-response --status=200 --body="mock content"
 */

import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";

const KAYA_HOME = process.env.HOME + "/.claude";
const INFERENCE_TOOL = join(KAYA_HOME, "lib/core/Inference.ts");

interface PromptVariant {
  original: string;
  variant: string;
  mutation: string; // What was changed
}

interface MockToolResponse {
  tool: string;
  mode: "success" | "fail" | "timeout" | "partial" | "corrupt";
  response: Record<string, unknown>;
}

interface MockFileState {
  files: Array<{
    path: string;
    content: string;
    type: "file" | "directory";
  }>;
}

/**
 * Generate prompt variants using Inference
 */
async function generatePromptVariants(
  originalPrompt: string,
  count: number = 5,
  seed?: number
): Promise<PromptVariant[]> {
  const result = spawnSync("bun", [INFERENCE_TOOL, "fast"], {
    input: `Generate ${count} alternative phrasings of this user prompt. Each should convey the same intent but use different words or sentence structures.

Original: "${originalPrompt}"

Return as a JSON array of objects with "variant" and "mutation" (what was changed) fields. Return ONLY the JSON array.`,
    encoding: "utf-8",
    timeout: 15000,
  });

  if (result.status !== 0) {
    // Fallback to simple variations
    return Array.from({ length: count }, (_, i) => ({
      original: originalPrompt,
      variant: `${originalPrompt} (variation ${i + 1})`,
      mutation: "simple_suffix",
    }));
  }

  try {
    const output = result.stdout.trim();
    const jsonMatch = output.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error("No JSON array");

    const variants = JSON.parse(jsonMatch[0]) as Array<{ variant: string; mutation: string }>;
    return variants.map((v) => ({
      original: originalPrompt,
      ...v,
    }));
  } catch {
    return [{ original: originalPrompt, variant: originalPrompt, mutation: "none" }];
  }
}

/**
 * Generate a mock tool response
 */
function generateToolResponse(
  tool: string,
  mode: "success" | "fail" | "timeout" | "partial" | "corrupt"
): MockToolResponse {
  switch (mode) {
    case "success":
      return {
        tool, mode,
        response: getSuccessResponse(tool),
      };
    case "fail":
      return {
        tool, mode,
        response: { error: `${tool} operation failed: Permission denied`, code: "EPERM" },
      };
    case "timeout":
      return {
        tool, mode,
        response: { error: `${tool} operation timed out after 30000ms`, code: "ETIMEDOUT" },
      };
    case "partial":
      return {
        tool, mode,
        response: getPartialResponse(tool),
      };
    case "corrupt":
      return {
        tool, mode,
        response: getCorruptResponse(tool),
      };
  }
}

function getSuccessResponse(tool: string): Record<string, unknown> {
  const responses: Record<string, Record<string, unknown>> = {
    Read: { content: "File contents here\nLine 2\nLine 3", lines: 3 },
    Write: { success: true, path: "/sandbox/output.txt" },
    Edit: { success: true, replacements: 1 },
    Bash: { stdout: "command output", stderr: "", exitCode: 0 },
    Glob: { matches: ["file1.ts", "file2.ts", "file3.ts"] },
    Grep: { matches: [{ file: "src/index.ts", line: 42, content: "matched line" }] },
    WebFetch: { status: 200, body: "<html><body>Success</body></html>" },
  };
  return responses[tool] || { success: true };
}

function getPartialResponse(tool: string): Record<string, unknown> {
  const responses: Record<string, Record<string, unknown>> = {
    Read: { content: "File contents here\n[truncated]", lines: 1, truncated: true },
    Bash: { stdout: "partial out", stderr: "warning: incomplete", exitCode: 0 },
    Glob: { matches: ["file1.ts"], truncated: true },
    WebFetch: { status: 206, body: "<html><body>Part" }, // Truncated HTML
  };
  return responses[tool] || { success: true, partial: true };
}

function getCorruptResponse(tool: string): Record<string, unknown> {
  const responses: Record<string, Record<string, unknown>> = {
    Read: { content: "\x00\x01\x02binary garbage\xff\xfe", lines: -1 },
    Bash: { stdout: "{\ninvalid json here\n", stderr: "", exitCode: 0 },
    WebFetch: { status: 200, body: "<!DOCTYPE h" }, // Truncated
    Grep: { matches: null }, // Null where array expected
  };
  return responses[tool] || { corrupt: true, data: "\x00\x01" };
}

/**
 * Generate a mock file system state
 */
function generateFileState(template: string = "project"): MockFileState {
  const templates: Record<string, MockFileState> = {
    project: {
      files: [
        { path: "src/index.ts", content: 'export function main() { console.log("hello"); }', type: "file" },
        { path: "src/utils.ts", content: "export function add(a: number, b: number) { return a + b; }", type: "file" },
        { path: "package.json", content: '{"name":"test","version":"1.0.0","dependencies":{}}', type: "file" },
        { path: "tsconfig.json", content: '{"compilerOptions":{"target":"ES2022"}}', type: "file" },
        { path: "README.md", content: "# Test Project\n\nA test project for simulation.", type: "file" },
        { path: "src", content: "", type: "directory" },
        { path: "tests", content: "", type: "directory" },
      ],
    },
    website: {
      files: [
        { path: "index.html", content: "<html><body><h1>Test Site</h1></body></html>", type: "file" },
        { path: "styles.css", content: "body { margin: 0; font-family: sans-serif; }", type: "file" },
        { path: "script.js", content: 'console.log("loaded");', type: "file" },
      ],
    },
    empty: {
      files: [],
    },
  };

  return templates[template] || templates.project;
}

// --- CLI ---

async function main() {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case "prompts": {
      const prompt = args[0];
      const countArg = args.find((a) => a.startsWith("--count="));
      const count = countArg ? parseInt(countArg.split("=")[1]) : 5;

      if (!prompt) {
        console.error("Usage: prompts <original-prompt> [--count=5]");
        process.exit(1);
      }

      const variants = await generatePromptVariants(prompt, count);
      console.log(JSON.stringify(variants, null, 2));
      break;
    }

    case "tool-response": {
      const tool = args[0];
      const modeArg = args.find((a) => a.startsWith("--mode="));
      const mode = (modeArg?.split("=")[1] || "success") as any;

      if (!tool) {
        console.error("Usage: tool-response <ToolName> [--mode=success|fail|timeout|partial|corrupt]");
        process.exit(1);
      }

      const response = generateToolResponse(tool, mode);
      console.log(JSON.stringify(response, null, 2));
      break;
    }

    case "file-state": {
      const templateArg = args.find((a) => a.startsWith("--template="));
      const template = templateArg?.split("=")[1] || "project";
      const state = generateFileState(template);
      console.log(JSON.stringify(state, null, 2));
      break;
    }

    case "api-response": {
      const statusArg = args.find((a) => a.startsWith("--status="));
      const bodyArg = args.find((a) => a.startsWith("--body="));
      const status = statusArg ? parseInt(statusArg.split("=")[1]) : 200;
      const body = bodyArg?.split("=")[1] || "OK";

      console.log(JSON.stringify({
        status,
        headers: { "content-type": "text/html" },
        body,
      }, null, 2));
      break;
    }

    default:
      console.log(`MockGenerator - Synthetic data generation

Commands:
  prompts <text> [--count=5]                  Generate prompt variants
  tool-response <Tool> [--mode=success]       Generate mock tool response
  file-state [--template=project]             Generate mock file system
  api-response [--status=200] [--body=text]   Generate mock API response`);
      break;
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});

export { generatePromptVariants, generateToolResponse, generateFileState };
export type { PromptVariant, MockToolResponse, MockFileState };
