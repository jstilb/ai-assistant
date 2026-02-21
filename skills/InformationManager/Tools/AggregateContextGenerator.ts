#!/usr/bin/env bun
/**
 * AggregateContextGenerator - Combine folder contexts into master context file
 *
 * Reusable tool for aggregating multiple folder contexts into a single master
 * context file. Works with Google Drive, Obsidian, local folders, and any other source.
 *
 * Usage:
 *   # CLI with arguments
 *   bun AggregateContextGenerator.ts --title "Google Drive" \
 *     --folders '[{"path":"Documents/","fileCount":45}]' \
 *     --output ~/.claude/context/GoogleDriveContext.md
 *
 *   # CLI with stdin JSON
 *   echo '{"title":"Drive","folders":[...],"output":"path"}' | \
 *     bun AggregateContextGenerator.ts --stdin
 *
 *   # Programmatic usage
 *   import { generateAggregateContext } from './AggregateContextGenerator.ts';
 *   const context = generateAggregateContext(folders, options);
 *
 * Options:
 *   --title <string>       Title for the aggregate context
 *   --folders <json>       JSON array of folder metadata
 *   --output <path>        Output file path
 *   --stdin                Read input from stdin as JSON
 *   --include-hierarchy    Include full folder hierarchy tree
 *   --include-guide        Include navigation guide
 *   --source-type <type>   Source type: drive, obsidian, local (default: drive)
 *   --json                 Output as JSON with metadata
 *   --write                Write to output file (default: stdout only)
 *   --help                 Show this help
 */

import { parseArgs } from "util";
import * as fs from "fs";
import * as path from "path";

// ============================================================================
// Types
// ============================================================================

export interface FolderContext {
  path: string;
  name?: string;
  fileCount: number;
  subfolderCount?: number;
  purpose?: string;
  contextFile?: string;
  lastUpdated?: string;
}

export interface AggregateOptions {
  title: string;
  destination?: string;
  includeHierarchy?: boolean;
  includeNavigationGuide?: boolean;
  sourceType?: "drive" | "obsidian" | "local";
}

export interface GeneratedAggregate {
  content: string;
  metadata: {
    title: string;
    totalFolders: number;
    totalFiles: number;
    foldersWithContext: number;
    generatedAt: string;
    sourceType: string;
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

function buildFolderTree(folders: FolderContext[]): Map<string, FolderContext[]> {
  const tree = new Map<string, FolderContext[]>();

  for (const folder of folders) {
    const parts = folder.path.split("/").filter(Boolean);
    const depth = parts.length;

    if (!tree.has(String(depth))) {
      tree.set(String(depth), []);
    }
    tree.get(String(depth))!.push(folder);
  }

  return tree;
}

function renderFolderTree(folders: FolderContext[]): string {
  // Sort by path for consistent output
  const sorted = [...folders].sort((a, b) => a.path.localeCompare(b.path));

  let tree = "```\n";
  for (const folder of sorted) {
    const depth = folder.path.split("/").filter(Boolean).length;
    const indent = "  ".repeat(depth);
    const name = folder.name || folder.path.split("/").filter(Boolean).pop() || "root";
    const stats = folder.fileCount > 0 ? ` (${folder.fileCount} files)` : "";
    tree += `${indent}${name}/${stats}\n`;
  }
  tree += "```";

  return tree;
}

function categorizeByPurpose(folders: FolderContext[]): Map<string, FolderContext[]> {
  const categories = new Map<string, FolderContext[]>();

  for (const folder of folders) {
    const purpose = folder.purpose || "Other";
    if (!categories.has(purpose)) {
      categories.set(purpose, []);
    }
    categories.get(purpose)!.push(folder);
  }

  return categories;
}

// ============================================================================
// Main Generator Function
// ============================================================================

export function generateAggregateContext(
  folders: FolderContext[],
  options: AggregateOptions
): GeneratedAggregate {
  const {
    title,
    includeHierarchy = true,
    includeNavigationGuide = true,
    sourceType = "drive",
  } = options;

  const timestamp = new Date().toISOString();
  const dateStr = timestamp.split("T")[0];

  // Calculate aggregate stats
  const totalFiles = folders.reduce((sum, f) => sum + f.fileCount, 0);
  const totalSubfolders = folders.reduce((sum, f) => sum + (f.subfolderCount || 0), 0);
  const foldersWithContext = folders.filter((f) => f.contextFile).length;

  // Separate root level vs nested
  const rootFolders = folders.filter((f) => !f.path.includes("/") || f.path.split("/").filter(Boolean).length === 1);

  // Build content
  let content = `---
tags: [context, ${sourceType}, ai-context]
last_updated: ${timestamp}
generated_by: AggregateContextGenerator
total_folders: ${folders.length}
total_files: ${totalFiles}
source_type: ${sourceType}
---

# ${title} Context

AI-navigable map of ${title} structure.

## Quick Reference

| Metric | Value |
|--------|-------|
| **Total Folders** | ${folders.length} |
| **Total Files** | ${totalFiles} |
| **Folders with Context** | ${foldersWithContext} |
| **Last Sync** | ${dateStr} |

`;

  // Root Level Section
  content += `## Root Level Folders

| Folder | Files | Subfolders | Purpose |
|--------|-------|------------|---------|
`;

  for (const folder of rootFolders) {
    const name = folder.name || folder.path.split("/").filter(Boolean).pop() || "root";
    const purpose = folder.purpose || "-";
    const subs = folder.subfolderCount || 0;
    content += `| ${name}/ | ${folder.fileCount} | ${subs} | ${purpose} |\n`;
  }

  content += "\n";

  // Full Hierarchy Section
  if (includeHierarchy) {
    content += `## Full Hierarchy

${renderFolderTree(folders)}

`;
  }

  // Detailed Breakdown Section
  content += `## Folder Details

`;

  for (const folder of folders) {
    const name = folder.name || folder.path.split("/").filter(Boolean).pop() || "root";
    const contextLink = folder.contextFile ? `[context.md](${folder.contextFile})` : "No context file";

    content += `### ${name}
- **Path:** \`${folder.path}\`
- **Files:** ${folder.fileCount}
- **Subfolders:** ${folder.subfolderCount || 0}
- **Context:** ${contextLink}
${folder.purpose ? `- **Purpose:** ${folder.purpose}` : ""}

`;
  }

  // Navigation Guide Section
  if (includeNavigationGuide) {
    content += `## Navigation Guide

For any folder, check its \`context.md\` for:
- Complete file inventory
- Subfolder descriptions
- Inferred purpose

### Quick Commands

`;

    if (sourceType === "drive") {
      content += `| Operation | Command |
|-----------|---------|
| List root | \`kaya-cli drive lsd gdrive:\` |
| List folder | \`kaya-cli drive lsf gdrive:"Folder/"\` |
| Download file | \`kaya-cli drive copy gdrive:"path" local/\` |
| Upload file | \`kaya-cli drive copy local/file gdrive:"path/"\` |
| Check context | \`kaya-cli drive lsf gdrive:"Folder/context.md"\` |

`;
    } else if (sourceType === "obsidian") {
      content += `| Operation | Command |
|-----------|---------|
| Open vault | Open in Obsidian |
| Search notes | Use Obsidian search |
| Check context | Read folder's \`_Context.md\` |

`;
    } else {
      content += `| Operation | Description |
|-----------|-------------|
| List folder | \`ls -la path/\` |
| View context | \`cat path/context.md\` |

`;
    }
  }

  // Categories section (if purposes are available)
  const categories = categorizeByPurpose(folders);
  if (categories.size > 1 || (categories.size === 1 && !categories.has("Other"))) {
    content += `## By Purpose

`;
    for (const [purpose, purposeFolders] of categories) {
      if (purpose !== "Other") {
        content += `### ${purpose}
`;
        for (const f of purposeFolders) {
          const name = f.name || f.path.split("/").filter(Boolean).pop() || "root";
          content += `- ${name}/ (${f.fileCount} files)\n`;
        }
        content += "\n";
      }
    }

    const otherFolders = categories.get("Other");
    if (otherFolders && otherFolders.length > 0) {
      content += `### Other
`;
      for (const f of otherFolders) {
        const name = f.name || f.path.split("/").filter(Boolean).pop() || "root";
        content += `- ${name}/ (${f.fileCount} files)\n`;
      }
      content += "\n";
    }
  }

  // Footer
  content += `---
*Generated by InformationManager/Tools/AggregateContextGenerator.ts on ${dateStr}*
`;

  return {
    content,
    metadata: {
      title,
      totalFolders: folders.length,
      totalFiles,
      foldersWithContext,
      generatedAt: timestamp,
      sourceType,
    },
  };
}

// ============================================================================
// CLI
// ============================================================================

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      title: { type: "string" },
      folders: { type: "string" },
      output: { type: "string" },
      stdin: { type: "boolean" },
      "include-hierarchy": { type: "boolean", default: true },
      "include-guide": { type: "boolean", default: true },
      "source-type": { type: "string", default: "drive" },
      json: { type: "boolean" },
      write: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(`
AggregateContextGenerator - Combine folder contexts into master context file

Usage:
  bun AggregateContextGenerator.ts --title "Google Drive" \\
    --folders '[{"path":"Documents/","fileCount":45}]' \\
    --output ~/.claude/context/GoogleDriveContext.md --write

  echo '{"title":"Drive","folders":[...]}' | \\
    bun AggregateContextGenerator.ts --stdin --write --output path.md

Options:
  --title <string>       Title for the aggregate context
  --folders <json>       JSON array of folder metadata
  --output <path>        Output file path
  --stdin                Read input from stdin as JSON
  --include-hierarchy    Include full folder hierarchy tree (default: true)
  --include-guide        Include navigation guide (default: true)
  --source-type <type>   Source type: drive, obsidian, local (default: drive)
  --json                 Output as JSON with metadata
  --write                Write to output file (default: stdout only)
  --help                 Show this help

Folder object: {
  path: string,           // Required
  name?: string,          // Display name
  fileCount: number,      // Required
  subfolderCount?: number,
  purpose?: string,       // Inferred purpose
  contextFile?: string,   // Path to context.md
  lastUpdated?: string    // ISO timestamp
}

Examples:
  # Generate Drive aggregate context
  bun AggregateContextGenerator.ts --title "Google Drive" \\
    --folders '[
      {"path":"Documents/","fileCount":45,"purpose":"Personal documents"},
      {"path":"Projects/","fileCount":12,"subfolderCount":3,"purpose":"Work projects"}
    ]' \\
    --output ~/.claude/context/GoogleDriveContext.md --write

  # Pipe from folder scanner
  bun ScanFolders.ts | bun AggregateContextGenerator.ts --stdin --title "Drive" --write
`);
    process.exit(0);
  }

  let title: string;
  let folders: FolderContext[];
  let outputPath: string | undefined;

  if (values.stdin) {
    // Read from stdin
    const input = await Bun.stdin.text();
    try {
      const parsed = JSON.parse(input);
      title = parsed.title;
      folders = parsed.folders;
      outputPath = parsed.output || values.output;
    } catch {
      console.error("Error: Invalid JSON from stdin");
      process.exit(1);
    }
  } else {
    // Build from arguments
    if (!values.title) {
      console.error("Error: --title is required (or use --stdin)");
      process.exit(1);
    }

    title = values.title;
    outputPath = values.output;

    if (values.folders) {
      try {
        folders = JSON.parse(values.folders);
      } catch {
        console.error("Error: Invalid JSON for --folders");
        process.exit(1);
      }
    } else {
      folders = [];
    }
  }

  const options: AggregateOptions = {
    title,
    destination: outputPath,
    includeHierarchy: values["include-hierarchy"] !== false,
    includeNavigationGuide: values["include-guide"] !== false,
    sourceType: (values["source-type"] as "drive" | "obsidian" | "local") || "drive",
  };

  const result = generateAggregateContext(folders, options);

  // Write to file if requested
  if (values.write && outputPath) {
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(outputPath, result.content);
    console.error(`Wrote to: ${outputPath}`);
  }

  // Output result
  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!values.write) {
    console.log(result.content);
  } else {
    // If writing, output summary to stderr
    console.error(`Generated aggregate context: ${result.metadata.title}`);
    console.error(`  - Folders: ${result.metadata.totalFolders}`);
    console.error(`  - Files: ${result.metadata.totalFiles}`);
    console.error(`  - With context: ${result.metadata.foldersWithContext}`);
  }
}

// Run if executed directly
if (import.meta.main) {
  main().catch(console.error);
}
