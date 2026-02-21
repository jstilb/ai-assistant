/**
 * ContentExtractor Tests
 * =======================
 * Tests for tool-specific output parsing.
 */

import { describe, test, expect } from "bun:test";
import { extractContent, getSourceDescription } from "../../../hooks/lib/pid/ContentExtractor";

describe("ContentExtractor - Tool Parsing", () => {
  test("extracts Read tool content", () => {
    const result = extractContent("Read", { file_path: "/tmp/test.txt" }, "file contents here");
    expect(result).not.toBeNull();
    expect(result!.tool).toBe("Read");
    expect(result!.source_type).toBe("file");
    expect(result!.text).toBe("file contents here");
    expect(result!.metadata.file_path).toBe("/tmp/test.txt");
  });

  test("extracts WebFetch tool content", () => {
    const result = extractContent("WebFetch", { url: "https://example.com" }, "page content");
    expect(result).not.toBeNull();
    expect(result!.source_type).toBe("web");
    expect(result!.metadata.url).toBe("https://example.com");
  });

  test("extracts Bash tool content", () => {
    const result = extractContent("Bash", { command: "ls -la" }, "total 42\ndrwxr-xr-x");
    expect(result).not.toBeNull();
    expect(result!.source_type).toBe("command");
    expect(result!.metadata.command).toBe("ls -la");
  });

  test("extracts WebSearch tool content", () => {
    const result = extractContent("WebSearch", { query: "test query" }, "search results");
    expect(result).not.toBeNull();
    expect(result!.source_type).toBe("search");
  });

  test("extracts MCP tool content", () => {
    const result = extractContent("mcp__gemini__query", {}, "gemini response");
    expect(result).not.toBeNull();
    expect(result!.source_type).toBe("mcp");
    expect(result!.metadata.mcp_server).toBe("gemini");
  });

  test("extracts Grep tool content", () => {
    const result = extractContent("Grep", { pattern: "test", path: "/src" }, "matches found");
    expect(result).not.toBeNull();
    expect(result!.source_type).toBe("file");
    expect(result!.metadata.file_path).toBe("/src");
  });

  test("returns null for empty output", () => {
    const result = extractContent("Read", { file_path: "/tmp/test.txt" }, "");
    expect(result).toBeNull();
  });

  test("truncates long commands in metadata", () => {
    const longCommand = "a".repeat(200);
    const result = extractContent("Bash", { command: longCommand }, "output");
    expect(result!.metadata.command!.length).toBeLessThanOrEqual(80);
    expect(result!.metadata.command!.endsWith("...")).toBe(true);
  });
});

describe("ContentExtractor - Source Description", () => {
  test("describes Read source", () => {
    const content = extractContent("Read", { file_path: "/tmp/test.txt" }, "content");
    const desc = getSourceDescription(content!);
    expect(desc).toBe("/tmp/test.txt");
  });

  test("describes WebFetch source", () => {
    const content = extractContent("WebFetch", { url: "https://example.com" }, "content");
    const desc = getSourceDescription(content!);
    expect(desc).toBe("https://example.com");
  });

  test("describes MCP source", () => {
    const content = extractContent("mcp__gemini__query", {}, "content");
    const desc = getSourceDescription(content!);
    expect(desc).toContain("MCP tool");
    expect(desc).toContain("gemini");
  });

  test("describes Bash source", () => {
    const content = extractContent("Bash", { command: "echo hello" }, "hello");
    const desc = getSourceDescription(content!);
    expect(desc).toContain("command: echo hello");
  });
});
