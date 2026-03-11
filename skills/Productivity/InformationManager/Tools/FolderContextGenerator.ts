#!/usr/bin/env bun
/**
 * FolderContextGenerator - Generate standardized context.md from folder contents
 *
 * Reusable tool for generating context.md files from any folder's contents.
 * Works with Google Drive, Obsidian, local folders, and any other source.
 *
 * Usage:
 *   # CLI with arguments
 *   bun FolderContextGenerator.ts --name "Documents" --path "gdrive:Documents/" \
 *     --files '[{"name":"doc.pdf","type":"PDF"}]' \
 *     --subfolders '[{"name":"Archive"}]'
 *
 *   # CLI with stdin JSON
 *   echo '{"name":"Docs","path":"gdrive:","files":[...],"subfolders":[...]}' | \
 *     bun FolderContextGenerator.ts --stdin
 *
 *   # Programmatic usage
 *   import { generateFolderContext } from './FolderContextGenerator.ts';
 *   const context = generateFolderContext(contents, options);
 *
 * Options:
 *   --name <string>        Folder name
 *   --path <string>        Folder path (for context)
 *   --files <json>         JSON array of files
 *   --subfolders <json>    JSON array of subfolders
 *   --stdin                Read contents from stdin as JSON
 *   --include-overview     Include AI-generated overview section
 *   --include-navigation   Include parent/sibling links
 *   --template <type>      Template style: drive, obsidian, local (default: drive)
 *   --json                 Output as JSON with metadata
 *   --help                 Show this help
 */

import { parseArgs } from "util";

// ============================================================================
// Types
// ============================================================================

export interface FileInfo {
  name: string;
  type?: string;
  size?: string;
  modified?: string;
  description?: string;
}

export interface SubfolderInfo {
  name: string;
  description?: string;
  fileCount?: number;
  subfolderCount?: number;
}

export interface FolderContents {
  name: string;
  path: string;
  files: FileInfo[];
  subfolders: SubfolderInfo[];
  parent?: string;
}

export interface ContextOptions {
  includeOverview?: boolean;
  includeNavigation?: boolean;
  inferPurpose?: boolean;
  template?: "drive" | "obsidian" | "local";
}

export interface GeneratedContext {
  content: string;
  metadata: {
    folderName: string;
    path: string;
    fileCount: number;
    subfolderCount: number;
    generatedAt: string;
    template: string;
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

function inferFileType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  const typeMap: Record<string, string> = {
    pdf: "PDF",
    doc: "Word",
    docx: "Word",
    xls: "Excel",
    xlsx: "Excel",
    ppt: "PowerPoint",
    pptx: "PowerPoint",
    txt: "Text",
    md: "Markdown",
    json: "JSON",
    csv: "CSV",
    jpg: "Image",
    jpeg: "Image",
    png: "Image",
    gif: "Image",
    mp4: "Video",
    mov: "Video",
    mp3: "Audio",
    wav: "Audio",
    zip: "Archive",
    tar: "Archive",
    gz: "Archive",
  };
  return typeMap[ext] || ext.toUpperCase() || "File";
}

function inferFolderPurpose(contents: FolderContents): string {
  const { files, subfolders, name } = contents;

  // Check file types
  const fileTypes = files.map((f) => f.type || inferFileType(f.name));
  const typeCount: Record<string, number> = {};
  for (const type of fileTypes) {
    typeCount[type] = (typeCount[type] || 0) + 1;
  }

  // Get dominant type
  const dominantType = Object.entries(typeCount).sort((a, b) => b[1] - a[1])[0];

  // Infer based on patterns
  const nameLower = name.toLowerCase();

  if (nameLower.includes("project") || nameLower.includes("work")) {
    return "Project files and work materials";
  }
  if (nameLower.includes("archive") || nameLower.includes("backup")) {
    return "Archived or backup content";
  }
  if (nameLower.includes("document") || nameLower.includes("docs")) {
    return "Document storage and organization";
  }
  if (nameLower.includes("photo") || nameLower.includes("image") || nameLower.includes("picture")) {
    return "Image and photo storage";
  }
  if (nameLower.includes("video") || nameLower.includes("media")) {
    return "Media files and video content";
  }
  if (nameLower.includes("template")) {
    return "Templates for documents or projects";
  }
  if (nameLower.includes("reference") || nameLower.includes("resource")) {
    return "Reference materials and resources";
  }

  // Fall back to dominant file type
  if (dominantType) {
    return `Storage for ${dominantType[0]} files and related content`;
  }

  if (subfolders.length > files.length) {
    return "Organizational folder containing categorized subfolders";
  }

  return "General content storage";
}

// ============================================================================
// Main Generator Function
// ============================================================================

export function generateFolderContext(
  contents: FolderContents,
  options: ContextOptions = {}
): GeneratedContext {
  const { name, path: folderPath, files, subfolders, parent } = contents;
  const {
    includeOverview = true,
    includeNavigation = true,
    inferPurpose = true,
    template = "drive",
  } = options;

  const timestamp = new Date().toISOString();
  const dateStr = timestamp.split("T")[0];

  // Build content
  let content = `---
last_updated: ${timestamp}
generated_by: FolderContextGenerator
file_count: ${files.length}
subfolder_count: ${subfolders.length}
template: ${template}
---

# ${name} - Context

`;

  // Navigation section
  if (includeNavigation && parent) {
    content += `## Navigation

- **Parent:** \`${parent}\`
- **Path:** \`${folderPath}\`

`;
  }

  // Overview section
  if (includeOverview) {
    const purpose = inferPurpose ? inferFolderPurpose(contents) : "Content storage";
    content += `## Overview

${purpose}

`;
  }

  // Contents section - Files
  content += `## Contents

### Files (${files.length})

`;

  if (files.length === 0) {
    content += `*No files in this folder*

`;
  } else {
    content += `| File | Type | Size | Modified |
|------|------|------|----------|
`;
    for (const file of files) {
      const type = file.type || inferFileType(file.name);
      const size = file.size || "-";
      const modified = file.modified || "-";
      content += `| ${file.name} | ${type} | ${size} | ${modified} |\n`;
    }
    content += "\n";
  }

  // Contents section - Subfolders
  content += `### Subfolders (${subfolders.length})

`;

  if (subfolders.length === 0) {
    content += `*No subfolders*

`;
  } else {
    content += `| Folder | Description |
|--------|-------------|
`;
    for (const subfolder of subfolders) {
      const desc = subfolder.description || "[Check subfolder context.md]";
      content += `| ${subfolder.name}/ | ${desc} |\n`;
    }
    content += "\n";
  }

  // Purpose section (template-specific)
  if (template === "drive") {
    content += `## Drive Info

- **Files:** ${files.length}
- **Subfolders:** ${subfolders.length}
- **Last Sync:** ${dateStr}

`;
  } else if (template === "obsidian") {
    const mdFiles = files.filter((f) => f.name.endsWith(".md")).length;
    content += `## Vault Info

- **Total Notes:** ${mdFiles}
- **Other Files:** ${files.length - mdFiles}
- **Subfolders:** ${subfolders.length}

`;
  } else {
    content += `## Folder Info

- **Path:** \`${folderPath}\`
- **Files:** ${files.length}
- **Subfolders:** ${subfolders.length}

`;
  }

  // Footer
  content += `---
*Generated by InformationManager/Tools/FolderContextGenerator.ts on ${dateStr}*
`;

  return {
    content,
    metadata: {
      folderName: name,
      path: folderPath,
      fileCount: files.length,
      subfolderCount: subfolders.length,
      generatedAt: timestamp,
      template,
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
      name: { type: "string" },
      path: { type: "string" },
      files: { type: "string" },
      subfolders: { type: "string" },
      parent: { type: "string" },
      stdin: { type: "boolean" },
      "include-overview": { type: "boolean", default: true },
      "include-navigation": { type: "boolean", default: true },
      template: { type: "string", default: "drive" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(`
FolderContextGenerator - Generate standardized context.md from folder contents

Usage:
  bun FolderContextGenerator.ts --name "Folder" --path "gdrive:Folder/" \\
    --files '[{"name":"file.pdf"}]' --subfolders '[{"name":"Sub"}]'

  echo '{"name":"Folder","path":"...","files":[...],"subfolders":[...]}' | \\
    bun FolderContextGenerator.ts --stdin

Options:
  --name <string>        Folder name
  --path <string>        Folder path (for context)
  --files <json>         JSON array of file objects
  --subfolders <json>    JSON array of subfolder objects
  --parent <string>      Parent folder path
  --stdin                Read contents from stdin as JSON
  --include-overview     Include purpose overview (default: true)
  --include-navigation   Include navigation links (default: true)
  --template <type>      Template style: drive, obsidian, local (default: drive)
  --json                 Output as JSON with metadata
  --help                 Show this help

File object: { name: string, type?: string, size?: string, modified?: string }
Subfolder object: { name: string, description?: string }

Examples:
  # Generate Drive folder context
  bun FolderContextGenerator.ts --name "Projects" --path "gdrive:Projects/" \\
    --files '[{"name":"plan.pdf","type":"PDF","size":"1.2MB"}]' \\
    --subfolders '[{"name":"2024","description":"2024 projects"}]'

  # Pipe from another tool
  kaya-cli drive ls gdrive:Folder/ --json | \\
    bun FolderContextGenerator.ts --stdin --template drive
`);
    process.exit(0);
  }

  let contents: FolderContents;

  if (values.stdin) {
    // Read from stdin
    const input = await Bun.stdin.text();
    try {
      contents = JSON.parse(input);
    } catch {
      console.error("Error: Invalid JSON from stdin");
      process.exit(1);
    }
  } else {
    // Build from arguments
    if (!values.name || !values.path) {
      console.error("Error: --name and --path are required (or use --stdin)");
      process.exit(1);
    }

    let files: FileInfo[] = [];
    let subfolders: SubfolderInfo[] = [];

    if (values.files) {
      try {
        files = JSON.parse(values.files);
      } catch {
        console.error("Error: Invalid JSON for --files");
        process.exit(1);
      }
    }

    if (values.subfolders) {
      try {
        subfolders = JSON.parse(values.subfolders);
      } catch {
        console.error("Error: Invalid JSON for --subfolders");
        process.exit(1);
      }
    }

    contents = {
      name: values.name,
      path: values.path,
      files,
      subfolders,
      parent: values.parent,
    };
  }

  const options: ContextOptions = {
    includeOverview: values["include-overview"] !== false,
    includeNavigation: values["include-navigation"] !== false,
    inferPurpose: true,
    template: (values.template as "drive" | "obsidian" | "local") || "drive",
  };

  const result = generateFolderContext(contents, options);

  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(result.content);
  }
}

// Run if executed directly
if (import.meta.main) {
  main().catch(console.error);
}
