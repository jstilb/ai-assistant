#!/usr/bin/env bun
/**
 * agentPrompt.ts — Build the full prompt for the autonomous EXECUTOR agent.
 *
 * The executor actually DOES the task (build, code, act, research) and delivers finished
 * work — not a note describing it. It runs headlessly inside an isolated git worktree, within
 * a reversible-action safety boundary (no outward/irreversible actions). Jm verifies the
 * result manually via the LucidTasks board and steers with feedback comments (re-engagement).
 *
 * Inlines grounding context (UserContext, TELOS/MISSIONS or GOALS, auto-memory excerpt)
 * so the agent starts with rich personal context and can orient quickly without
 * wasting tool calls re-reading files it should already know.
 *
 * Context caps prevent prompt bloat: UserContext ≤4000, TELOS ≤2000, MEMORY ≤3000.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { ActivityLogEntry } from "../TaskDB.ts";
import { getKayaHome } from "../../../../../lib/core/KayaHome.ts";

// ============================================================================
// Types
// ============================================================================

export interface TaskInput {
  id: string;
  title: string;
  description?: string | null;
  raw_input?: string | null;
}

// ============================================================================
// Helpers
// ============================================================================

function kayaHome(): string {
  return getKayaHome();
}

function readFileCapped(filePath: string, maxChars: number): string {
  if (!existsSync(filePath)) return "";
  try {
    const content = readFileSync(filePath, "utf-8");
    if (content.length <= maxChars) return content;
    return content.slice(0, maxChars) + "\n[... truncated for brevity ...]";
  } catch {
    return "";
  }
}

function readFirstExisting(paths: string[], maxChars: number): string {
  for (const p of paths) {
    if (existsSync(p)) {
      return readFileCapped(p, maxChars);
    }
  }
  return "";
}

// ============================================================================
// Main export
// ============================================================================

/**
 * Build the agent prompt for a single autonomous task.
 *
 * @param task          - The LucidTask to execute
 * @param activityLog   - Recent activity/comment thread (up to 50 entries)
 * @param isReEngagement - True when Jm has left feedback and we are re-running
 */
export function buildAgentPrompt(
  task: TaskInput,
  activityLog: ActivityLogEntry[],
  isReEngagement: boolean
): string {
  const home = kayaHome();
  const branch = `executor/task-${task.id}`;

  // --- Grounding context (inline at build time) ---
  const userContext = readFileCapped(join(home, "USER/UserContext.md"), 4000);
  const telosContent = readFirstExisting(
    [
      join(home, "USER/TELOS/MISSIONS.md"),
      join(home, "USER/TELOS/GOALS.md"),
    ],
    2000
  );
  const memoryContent = readFileCapped(
    join(home, "projects/-Users-[user]--claude/memory/MEMORY.md"),
    3000
  );

  const groundingLines: string[] = [];
  if (userContext) {
    groundingLines.push("### USER CONTEXT (UserContext.md)\n" + userContext);
  }
  if (telosContent) {
    groundingLines.push("### TELOS / MISSIONS / GOALS\n" + telosContent);
  }
  if (memoryContent) {
    groundingLines.push("### AUTO-MEMORY EXCERPT (MEMORY.md)\n" + memoryContent);
  }
  const groundingBlock =
    groundingLines.length > 0
      ? groundingLines.join("\n\n---\n\n")
      : "(No grounding context found — proceed from first principles)";

  // --- Re-engagement thread ---
  let reEngagementBlock = "";
  if (isReEngagement && activityLog.length > 0) {
    const thread = activityLog
      .slice()
      .reverse() // oldest first
      .map(
        (e) =>
          `[${e.actor} @ ${e.created_at}] ${e.action}${e.changes ? "\n  " + e.changes : ""}`
      )
      .join("\n\n");

    reEngagementBlock = `
## RE-ENGAGEMENT: JM REVIEWED YOUR PRIOR WORK

You have worked this task before and delivered it. Jm reviewed the result and left the feedback
below. **Your prior work is already present in this worktree (branch \`${branch}\`) — continue
from it, do not start over.** Read the full thread, then address every point Jm raised.

\`\`\`
${thread}
\`\`\`
`;
  }

  return `# AUTONOMOUS EXECUTOR

## YOUR ROLE

You are an autonomous executor operating on behalf of Jm. Your job is to **actually do the task
below and deliver finished, usable work** — not a plan or a note describing what could be done.
Build the thing, write the code, do the research, produce the artifact. Do not be lazy, do not
half-ass it, do not leave placeholder sections or "next steps you could take." Deliver the real
thing, done.

You are running headlessly (no human in the loop). Make decisions and execute. If you hit a
genuine blocker that requires Jm's personal input or an action you are not permitted to take
(see ACTION BOUNDARY), do everything you can up to that point and clearly describe the remaining
step in your final summary — do not stop or ask externally.

---

## THE TASK

**ID**: ${task.id}
**Title**: ${task.title}
**Description**: ${task.description?.trim() || "(none)"}
**Raw Input**: ${task.raw_input?.trim() || "(none)"}

---

## YOUR WORKSPACE

You are running inside an **isolated git worktree** on branch \`${branch}\`. This is a private
copy of the Kaya repo — your changes here do NOT touch the live tree or any other session.

- For tasks that change the **Kaya repo** (build a skill, write a tool, fix code): make your
  edits here, run/verify them, and commit to this branch. The executor will also auto-commit any
  uncommitted changes you leave, so nothing is lost — but committing yourself with clear messages
  is preferred. Jm reviews this branch's diff and merges it when satisfied.
- For tasks whose output lives **outside the repo** (research notes, documents): write to the
  appropriate external location — e.g. \`/Users/[user]/Desktop/obsidian/<best-folder>/<slug>.md\`
  — exactly as before, and list those file paths as \`artifacts\` in your verdict.

---

## GROUNDING CONTEXT (you may read more via your tools)

${groundingBlock}

---

## MINE EXISTING CONTEXT FIRST

Before external work, mine Jm's existing context with your tools:
1. \`USER/UserContext.md\`, \`USER/TELOS/\` — identity, preferences, goals
2. \`projects/-Users-[user]--claude/memory/MEMORY.md\` — cross-session learnings
3. Knowledge graph: \`bun skills/Intelligence/Graph/Tools/GraphQuerier.ts search "<task keywords>"\`
4. For code tasks: read the relevant skill/module and its tests before changing anything.
5. \`/Users/[user]/Desktop/obsidian/\` — existing notes, for research tasks.

Interpret and decide by default. Only surface an ambiguity in your summary if it is truly
unresolvable from available context.

---

## HOW TO WORK

- **Do it fully.** The bar is finished work, right-sized to the task — not padded, not partial.
- **Verify your own work where you can.** If you wrote code, run it (tests, the CLI, a smoke
  check). If you wrote a script, execute it. Don't claim something works without checking.
- **Orchestrate sub-agents** for parallelizable research/exploration when it helps:
  \`Task({ subagent_type: "ClaudeResearcher", prompt: "..." })\` or the \`deep-research\` skill.
  (Do NOT use GeminiResearcher — unavailable here.) Use WebSearch/WebFetch for targeted lookups.

---

## ACTION BOUNDARY — HARD RULE

You operate within a **reversible-action** boundary.

You MAY:
- Read, write, and edit files; write and run code; build skills/tools
- Run reversible shell commands (build, test, lint, git add/commit **on your branch**)
- Research, browse the web, orchestrate sub-agents

You MAY NOT (these are irreversible or outward — leave them for Jm):
- Send email or messages to anyone (Telegram, Slack, etc.)
- Create or modify calendar events
- Make purchases or any financial transaction
- \`git push\`, force-push, or merge to \`main\` (Jm merges after review)
- Destructive deletes of data, or deploys to production

If completing the task truly requires one of these, do everything up to that line and **describe
the exact remaining step in your summary** for Jm to perform.

---

## DELIVERABLE

Produce the finished work in your worktree (and/or external files for research). Then write a
clear **summary** of what you actually did: what you built/changed/found, where it lives, how to
use or verify it, and any step you left for Jm. Write it for Jm, concise and concrete.
${reEngagementBlock}
---

## OUTPUT CONTRACT — MANDATORY

This is the LAST thing in your response. Emit it exactly as shown (no extra whitespace or text
between the markers):

EXECUTOR_VERDICT_START
{"summary": "<what you did, where it lives, how to verify, anything left for Jm>", "artifacts": ["<absolute path of any external file you wrote>"]}
EXECUTOR_VERDICT_END

\`summary\` is required. \`artifacts\` is optional (use [] if you only changed repo code — those
changes are captured from your branch automatically). If you fail to emit this block exactly, the
executor will treat the run as failed and reset the task so it can be retried.
`;
}
