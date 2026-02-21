#!/usr/bin/env bun
/**
 * ProcessScratchPad.ts - Direct implementation of scratch pad triage
 *
 * Reads the scratch pad, categorizes items, routes to destinations,
 * and returns structured metrics for AutoInfoManager.
 *
 * Usage:
 *   bun ProcessScratchPad.ts              # Process normally
 *   bun ProcessScratchPad.ts --dry-run    # Preview without executing
 *   bun ProcessScratchPad.ts --json       # Output JSON for automation
 */

import { parseArgs } from "util";
import * as fs from "fs";
import * as path from "path";
import { inference } from "../../CORE/Tools/Inference.ts";
import { getTaskDB } from "../../LucidTasks/Tools/TaskDB.ts";

// ============================================================================
// Configuration
// ============================================================================

const HOME = process.env.HOME || "/Users/your-username";
const KAYA_DIR = process.env.KAYA_DIR || path.join(HOME, ".claude");
const SCRATCH_PAD_PATH = path.join(HOME, "Desktop/obsidian/Scratch Pad.md");
const VAULT_CONTEXT_PATH = path.join(HOME, "Desktop/obsidian/VaultContext.md");
const VAULT_ROOT = path.join(HOME, "Desktop/obsidian");
const CONTACTS_PATH = path.join(KAYA_DIR, "skills/CORE/USER/Contacts.md");

// ============================================================================
// Types
// ============================================================================

type ItemCategory = "calendar" | "task" | "note" | "existing-note" | "unclear";

interface ScratchPadItem {
  raw: string;
  content: string;
  category: ItemCategory;
  confidence: number;
  reason: string;
}

interface ProcessResult {
  success: boolean;
  itemsProcessed: number;
  tasksCreated: number;
  eventsCreated: number;
  notesCreated: number;
  needsReview: number;
  errors: string[];
  items: ScratchPadItem[];
}

// ============================================================================
// Parsing
// ============================================================================

function parseScratchPad(content: string): string[] {
  const lines = content.split("\n");
  const items: string[] = [];
  let inItemsSection = false;
  let inNeedsReview = false;
  let inFrontmatter = false;

  for (const line of lines) {
    // Handle frontmatter
    if (line.trim() === "---") {
      inFrontmatter = !inFrontmatter;
      continue;
    }
    if (inFrontmatter) continue;

    // Detect sections
    if (line.startsWith("## Items")) {
      inItemsSection = true;
      inNeedsReview = false;
      continue;
    }
    if (line.startsWith("## Needs Review")) {
      inItemsSection = false;
      inNeedsReview = true;
      continue;
    }
    if (line.startsWith("## ") && !line.startsWith("## Items")) {
      inItemsSection = false;
      continue;
    }

    // Skip non-items section content
    if (!inItemsSection || inNeedsReview) continue;

    // Skip comments and empty lines
    if (line.trim().startsWith("<!--") || line.trim() === "") continue;

    // Extract list items (- or numbered)
    const trimmed = line.trim();
    if (trimmed.startsWith("- ") || /^\d+\.\s/.test(trimmed)) {
      const itemContent = trimmed.replace(/^[-\d.]+\s*/, "").trim();
      if (itemContent) {
        items.push(itemContent);
      }
    } else if (trimmed && !trimmed.startsWith("#")) {
      // Also capture non-list items that aren't headings
      items.push(trimmed);
    }
  }

  return items;
}

// ============================================================================
// Categorization (via Sonnet inference)
// ============================================================================

const CLASSIFICATION_SYSTEM_PROMPT = `You are a scratch pad item classifier. Classify each item into exactly one category.

Categories:
- "calendar": Events with time/date references, meetings, appointments, calls with people at specific times
- "task": Actionable items - things to do, buy, create, build, send, fix, set up, errands, chores, lists of items to get
- "note": Knowledge-oriented items - ideas, research topics, concepts to explore, things to learn about, reference info
- "existing-note": Explicitly references adding/appending to an existing note (e.g. "add to my cooking notes")
- "unclear": Truly ambiguous fragments that cannot be reasonably classified

Guidelines:
- Prefer "task" for anything with an implied action, even without explicit action verbs (e.g. "valentines day recipe guide" is a task to prepare)
- Prefer "note" for knowledge capture, ideas, or things to think about
- Only use "unclear" as a last resort for genuinely uninterpretable fragments
- Confidence should be 0.0-1.0 where 0.7+ means high confidence

Respond with ONLY a JSON array. Each element: {"index": <number>, "category": "<category>", "confidence": <number>, "reason": "<brief reason>"}`;

async function categorizeItems(contents: string[]): Promise<ScratchPadItem[]> {
  if (contents.length === 0) return [];

  const itemList = contents.map((c, i) => `${i}: ${c}`).join("\n");
  const userPrompt = `Classify these scratch pad items:\n\n${itemList}`;

  const result = await inference({
    systemPrompt: CLASSIFICATION_SYSTEM_PROMPT,
    userPrompt,
    level: "standard",
    expectJson: true,
    timeout: 120000,
  });

  if (!result.success || !result.parsed) {
    console.error("Inference failed, marking all items unclear:", result.error);
    return contents.map((content) => ({
      raw: content,
      content,
      category: "unclear" as ItemCategory,
      confidence: 0.3,
      reason: `Inference failed: ${result.error}`,
    }));
  }

  const classifications = result.parsed as Array<{
    index: number;
    category: string;
    confidence: number;
    reason: string;
  }>;

  if (!Array.isArray(classifications)) {
    console.error("Inference response was not an array");
    return contents.map((content) => ({
      raw: content,
      content,
      category: "unclear" as ItemCategory,
      confidence: 0.3,
      reason: "Inference returned non-array response",
    }));
  }

  const validCategories: ItemCategory[] = ["calendar", "task", "note", "existing-note", "unclear"];

  return contents.map((content, i) => {
    const match = classifications.find((c) => c.index === i);
    if (!match) {
      return {
        raw: content,
        content,
        category: "unclear" as ItemCategory,
        confidence: 0.3,
        reason: "No classification returned for this item",
      };
    }

    const category = validCategories.includes(match.category as ItemCategory)
      ? (match.category as ItemCategory)
      : "unclear";

    return {
      raw: content,
      content,
      category,
      confidence: Math.max(0, Math.min(1, match.confidence)),
      reason: match.reason,
    };
  });
}

// ============================================================================
// Processing
// ============================================================================

function determineFolderForNote(content: string): string {
  const lower = content.toLowerCase();

  // Check for common topic patterns
  if (/\b(ai|machine learning|model|neural|llm|agent)\b/i.test(content)) {
    return "AI";
  }
  if (/\b(code|programming|typescript|python|javascript|rust)\b/i.test(content)) {
    return "Programming";
  }
  if (/\b(data|analytics|statistics|visualization)\b/i.test(content)) {
    return "Data Science";
  }
  if (/\b(recipe|cook|food|meal)\b/i.test(content)) {
    return "Cooking";
  }
  if (/\b(security|hacking|pentest|vulnerability)\b/i.test(content)) {
    return "Security";
  }
  if (/\b(health|exercise|workout|nutrition)\b/i.test(content)) {
    return "Health";
  }
  if (/\b(book|reading|author)\b/i.test(content)) {
    return "Books";
  }
  if (/\b(project|startup|business|company)\b/i.test(content)) {
    return "Projects";
  }

  // Default to Ideas for general notes
  return "Ideas";
}

function generateNoteTitle(content: string): string {
  // Take first 50 chars, trim to last word boundary
  let title = content.slice(0, 50);
  if (content.length > 50) {
    const lastSpace = title.lastIndexOf(" ");
    if (lastSpace > 20) {
      title = title.slice(0, lastSpace);
    }
  }

  // Clean up for filename
  title = title
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return title || "Untitled Note";
}

async function createNote(item: ScratchPadItem): Promise<{ success: boolean; path?: string; error?: string }> {
  try {
    const folder = determineFolderForNote(item.content);
    const title = generateNoteTitle(item.content);
    const folderPath = path.join(VAULT_ROOT, folder);
    const notePath = path.join(folderPath, `${title}.md`);

    // Ensure folder exists
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
    }

    // Don't overwrite existing notes
    if (fs.existsSync(notePath)) {
      return {
        success: false,
        error: `Note already exists: ${notePath}`,
      };
    }

    const date = new Date().toISOString().split("T")[0];
    const noteContent = `---
created: ${date}
tags: [scratch-pad-import]
source: scratch-pad
---

# ${title}

${item.content}

---
*Imported from Scratch Pad on ${date}*
`;

    fs.writeFileSync(notePath, noteContent);

    return {
      success: true,
      path: notePath,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function updateScratchPad(
  originalContent: string,
  processedItems: string[],
  needsReviewItems: ScratchPadItem[]
): string {
  const lines = originalContent.split("\n");
  const newLines: string[] = [];
  let inItemsSection = false;
  let inNeedsReview = false;
  let inFrontmatter = false;
  let frontmatterUpdated = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Handle frontmatter
    if (line.trim() === "---") {
      if (!inFrontmatter) {
        inFrontmatter = true;
        newLines.push(line);
        continue;
      } else {
        // End of frontmatter - update last_processed if not done
        if (!frontmatterUpdated) {
          // Check if last_processed exists
          const hasLastProcessed = newLines.some((l) => l.startsWith("last_processed:"));
          if (!hasLastProcessed) {
            newLines.push(`last_processed: ${new Date().toISOString().split("T")[0]}`);
          }
        }
        inFrontmatter = false;
        newLines.push(line);
        continue;
      }
    }

    if (inFrontmatter) {
      if (line.startsWith("last_processed:")) {
        newLines.push(`last_processed: ${new Date().toISOString().split("T")[0]}`);
        frontmatterUpdated = true;
      } else {
        newLines.push(line);
      }
      continue;
    }

    // Detect sections
    if (line.startsWith("## Items")) {
      inItemsSection = true;
      inNeedsReview = false;
      newLines.push(line);
      newLines.push("");
      newLines.push("<!-- Add items here -->");
      newLines.push("");
      continue;
    }

    if (line.startsWith("## Needs Review")) {
      inItemsSection = false;
      inNeedsReview = true;
      newLines.push(line);
      newLines.push("");
      newLines.push("<!-- Items with unclear intent moved here during processing -->");
      newLines.push("");

      // Add new needs review items
      for (const item of needsReviewItems) {
        newLines.push(`- ${item.content}`);
        newLines.push(`  - *[Unclear: ${item.reason}]*`);
      }
      newLines.push("");
      continue;
    }

    // Skip content in Items section (we cleared it)
    if (inItemsSection) {
      // Skip original items - they've been processed
      continue;
    }

    // Skip old Needs Review content (we're replacing it)
    if (inNeedsReview) {
      // Skip until next section or end
      if (line.startsWith("## ")) {
        inNeedsReview = false;
        newLines.push(line);
      }
      continue;
    }

    newLines.push(line);
  }

  return newLines.join("\n");
}

// ============================================================================
// Main Execution
// ============================================================================

async function processScratchPad(dryRun: boolean = false): Promise<ProcessResult> {
  const result: ProcessResult = {
    success: false,
    itemsProcessed: 0,
    tasksCreated: 0,
    eventsCreated: 0,
    notesCreated: 0,
    needsReview: 0,
    errors: [],
    items: [],
  };

  // Check if scratch pad exists
  if (!fs.existsSync(SCRATCH_PAD_PATH)) {
    result.errors.push(`Scratch pad not found: ${SCRATCH_PAD_PATH}`);
    return result;
  }

  // Read scratch pad
  const content = fs.readFileSync(SCRATCH_PAD_PATH, "utf-8");

  // Parse items
  const rawItems = parseScratchPad(content);

  if (rawItems.length === 0) {
    result.success = true;
    result.itemsProcessed = 0;
    return result;
  }

  // Categorize items via Sonnet inference
  const categorizedItems = await categorizeItems(rawItems);
  result.items = categorizedItems;

  // Process each item by category
  const processedItems: string[] = [];
  const needsReviewItems: ScratchPadItem[] = [];

  for (const item of categorizedItems) {
    // Low confidence items go to Needs Review
    if (item.confidence < 0.5) {
      needsReviewItems.push(item);
      result.needsReview++;
      continue;
    }

    switch (item.category) {
      case "calendar":
        // Calendar events require MCP - queue for later or mark needs review
        {
          // Move to needs review with annotation
          item.reason = "Calendar MCP unavailable - needs manual entry";
          needsReviewItems.push(item);
          result.needsReview++;
        }
        break;

      case "task":
        // Tasks go directly into LucidTasks DB
        if (dryRun) {
          result.tasksCreated++;
          processedItems.push(item.raw);
        } else {
          try {
            const db = getTaskDB();
            db.createTask({ title: item.content, status: "inbox", raw_input: item.content });
            db.close();
            result.tasksCreated++;
            processedItems.push(item.raw);
          } catch (error) {
            item.reason = `LucidTasks task creation failed: ${error instanceof Error ? error.message : String(error)}`;
            needsReviewItems.push(item);
            result.needsReview++;
          }
        }
        break;

      case "note":
        if (!dryRun) {
          const noteResult = await createNote(item);
          if (noteResult.success) {
            result.notesCreated++;
            processedItems.push(item.raw);
          } else {
            result.errors.push(noteResult.error || "Unknown error creating note");
            needsReviewItems.push(item);
            result.needsReview++;
          }
        } else {
          result.notesCreated++;
          processedItems.push(item.raw);
        }
        break;

      case "existing-note":
        // Would append to existing note - needs implementation
        item.reason = "Existing note append not yet implemented";
        needsReviewItems.push(item);
        result.needsReview++;
        break;

      case "unclear":
      default:
        needsReviewItems.push(item);
        result.needsReview++;
        break;
    }
  }

  result.itemsProcessed = categorizedItems.length;

  // Update scratch pad
  if (!dryRun && (processedItems.length > 0 || needsReviewItems.length > 0)) {
    const updatedContent = updateScratchPad(content, processedItems, needsReviewItems);
    fs.writeFileSync(SCRATCH_PAD_PATH, updatedContent);
  }

  result.success = result.errors.length === 0;
  return result;
}

// ============================================================================
// CLI Entry Point
// ============================================================================

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      "dry-run": { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(`
ProcessScratchPad - Triage scratch pad items

USAGE:
  bun ProcessScratchPad.ts [options]

OPTIONS:
  --dry-run    Preview categorization without executing
  --json       Output as JSON for automation
  -h, --help   Show this help

CATEGORIES:
  calendar    - Time/date references, meetings, appointments
  task        - Action verbs, deadlines, errands
  note        - Research, ideas, knowledge items
  unclear     - Ambiguous items moved to Needs Review
`);
    return;
  }

  const dryRun = values["dry-run"] || false;
  const result = await processScratchPad(dryRun);

  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\n=== Scratch Pad Processing ${dryRun ? "(DRY RUN)" : ""} ===\n`);
    console.log(`Items Found: ${result.itemsProcessed}`);
    console.log(`Notes Created: ${result.notesCreated}`);
    console.log(`Tasks Created: ${result.tasksCreated}`);
    console.log(`Events Created: ${result.eventsCreated}`);
    console.log(`Needs Review: ${result.needsReview}`);

    if (result.items.length > 0) {
      console.log(`\n--- Item Details ---\n`);
      for (const item of result.items) {
        const icon =
          item.category === "note"
            ? "📝"
            : item.category === "task"
              ? "✅"
              : item.category === "calendar"
                ? "📅"
                : "❓";
        console.log(
          `${icon} [${item.category}] (${Math.round(item.confidence * 100)}%) ${item.content.slice(0, 60)}...`
        );
        console.log(`   Reason: ${item.reason}`);
      }
    }

    if (result.errors.length > 0) {
      console.log(`\n--- Errors ---\n`);
      for (const error of result.errors) {
        console.log(`  ✗ ${error}`);
      }
    }

    console.log(`\nSuccess: ${result.success}`);
  }

  process.exit(result.success ? 0 : 1);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}

// Export for testing
export { processScratchPad, parseScratchPad, categorizeItems, type ProcessResult, type ScratchPadItem };
