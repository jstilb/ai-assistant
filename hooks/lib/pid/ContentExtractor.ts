/**
 * Content Extractor - Tool-Specific Output Parsing
 * ==================================================
 *
 * Extracts scannable text from each tool's unique output format.
 * Each tool returns data differently; this normalizes it for scanning.
 */

import type { ExtractedContent } from "./types";

/**
 * Extract scannable content from a tool's output.
 * Returns normalized ExtractedContent ready for the scanning pipeline.
 */
export function extractContent(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolOutput: string
): ExtractedContent | null {
  // Fast path: empty or very short output
  if (!toolOutput || toolOutput.length === 0) {
    return null;
  }

  const sourceType = getSourceType(toolName);
  const metadata = extractMetadata(toolName, toolInput, toolOutput);

  return {
    tool: toolName,
    source_type: sourceType,
    text: toolOutput,
    metadata,
  };
}

/**
 * Map tool names to source types for categorization.
 */
function getSourceType(toolName: string): ExtractedContent["source_type"] {
  if (toolName === "Read" || toolName === "Glob" || toolName === "Grep") {
    return "file";
  }
  if (toolName === "WebFetch") {
    return "web";
  }
  if (toolName === "WebSearch") {
    return "search";
  }
  if (toolName === "Bash") {
    return "command";
  }
  if (toolName.startsWith("mcp__") || toolName.startsWith("mcp_")) {
    return "mcp";
  }
  return "command"; // default fallback
}

/**
 * Extract tool-specific metadata for logging and context.
 */
function extractMetadata(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolOutput: string
): ExtractedContent["metadata"] {
  const base = { content_length: toolOutput.length };

  switch (toolName) {
    case "Read":
      return { ...base, file_path: String(toolInput.file_path || "") };

    case "WebFetch":
      return { ...base, url: String(toolInput.url || "") };

    case "WebSearch":
      return { ...base, url: String(toolInput.query || "") };

    case "Bash":
      return { ...base, command: truncateCommand(String(toolInput.command || "")) };

    case "Grep":
      return {
        ...base,
        file_path: String(toolInput.path || toolInput.glob || ""),
      };

    case "Glob":
      return { ...base, file_path: String(toolInput.pattern || "") };

    case "Task":
      return { ...base, command: String(toolInput.description || "").slice(0, 80) };

    default:
      // MCP tools
      if (toolName.startsWith("mcp__") || toolName.startsWith("mcp_")) {
        const parts = toolName.split("__");
        return { ...base, mcp_server: parts[1] || "unknown" };
      }
      return base;
  }
}

/**
 * Truncate long commands for logging.
 */
function truncateCommand(command: string): string {
  if (command.length <= 80) return command;
  return command.slice(0, 77) + "...";
}

/**
 * Get a human-readable source description for warnings.
 */
export function getSourceDescription(content: ExtractedContent): string {
  const m = content.metadata;
  switch (content.tool) {
    case "Read":
      return m.file_path || "unknown file";
    case "WebFetch":
      return m.url || "unknown URL";
    case "WebSearch":
      return `search: ${m.url || "unknown query"}`;
    case "Bash":
      return `command: ${m.command || "unknown"}`;
    case "Grep":
      return `grep in ${m.file_path || "unknown"}`;
    case "Glob":
      return `glob: ${m.file_path || "unknown"}`;
    case "Task":
      return `agent task: ${m.command || "unknown"}`;
    default:
      if (content.source_type === "mcp") {
        return `MCP tool: ${content.tool} (server: ${m.mcp_server || "unknown"})`;
      }
      return `${content.tool} output`;
  }
}
