#!/usr/bin/env bun
/**
 * qualityBar.ts — The quality bar the executor's builder and verifier share.
 *
 * Incident 2026-10-21 (task t-mvfkuj9e-1v6obq): the builder shipped a /learn page that met the
 * rewritten DONE WHEN ("one page, per skill, the next thing with a link") but failed Jm's own
 * words ("frictionless", "simple", "easy to pick up and go", an agent side with "as much thought
 * paid to it"). The verifier checked code and tests only, never saw a rendered screen (the
 * dashboard answered 401), said "pass", and the pass auto-merged. Two gaps, one per section:
 *   - nobody judged the result against Jm's original words (INTENT_RULE), and
 *   - nobody judged a rendered screen against a design standard (UI_DESIGN_BAR).
 *
 * The two deterministic helpers are the facts executorVerify.ts's evidence gate needs: is this a
 * UI change (from the diff's paths), and did the verifier save the desktop + phone screenshots.
 */

import { readdirSync, statSync } from "fs";
import { join } from "path";

// ============================================================================
// Shared prompt text
// ============================================================================

export const INTENT_RULE = `## JM'S WORDS ARE THE SPEC

The task description is often another agent's rewrite of what Jm said. If it quotes Jm (a line
like \`Original: '...'\`, a Scratch Pad, Telegram or voice capture), **Jm's words are the spec**.
WHAT / HOW / DONE WHEN are a summary and a minimum, never the whole bar.

- List every requirement in Jm's words. His quality words are requirements too: "simple",
  "frictionless", "seamless", "easy", "clean", "fast", "as much thought as ...". Each one needs
  evidence, the same as a function does.
- If DONE WHEN dropped or changed something Jm asked for, Jm's words win.
- If there is no quote from Jm, the title and description are the spec.`;

export const UI_DESIGN_BAR = `## UI BAR (any change a person sees in a browser)

Judge the RENDERED page, not the code: screenshots at desktop (1280 px wide) and phone (390 px wide).

1. One job per screen. The first thing Jm sees is the one action the page exists for. One primary
   button per view.
2. Show each fact once. The same item, step or number must not repeat in several places.
3. Plain words only. No internal names, codes, config keys, enum values or rule text on screen.
4. Progressive disclosure. Secondary detail sits behind one click. Count the buttons, links and
   inputs in the first view: if there are far more than the job needs, the page is crowded.
5. Phone width: nothing is cut off, no sideways scroll, tap targets are usable.
6. Clear hierarchy and whitespace; it reads at a glance; empty and error states say what to do.
7. If the task asks for an agent or chat interface, it meets this bar too: a real conversation
   (follow-ups, history) and actions, not one input box.

A page that works but fails this bar is not done.`;

// ============================================================================
// UI change detection
// ============================================================================

const TEST_PATH_RE = /(^|\/)__tests__\/|\.test\.[a-z]+$|\.spec\.[a-z]+$/i;
const MARKUP_EXT_RE = /\.(html?|css|scss|tsx|jsx|vue|svelte)$/i;
const SCRIPT_EXT_RE = /\.(ts|js|mjs)$/i;
const UI_SCRIPT_PATH_RE = /dashboard|(^|\/)(ui|web|components|pages|views)\/|page\.(ts|js|mjs)$/i;

/**
 * True when a changed path renders something a person sees in a browser. Test files never count.
 * Pure — exported for tests.
 */
export function isUiPath(path: string): boolean {
  if (TEST_PATH_RE.test(path)) return false;
  if (MARKUP_EXT_RE.test(path)) return true;
  return SCRIPT_EXT_RE.test(path) && UI_SCRIPT_PATH_RE.test(path);
}

/** The changed paths a unified diff names (the `b/` side of each `diff --git` header). */
export function changedPathsFromDiff(diff: string): string[] {
  const paths = new Set<string>();
  for (const m of diff.matchAll(/^diff --git a\/.+? b\/(.+)$/gm)) paths.add(m[1]);
  return [...paths];
}

// ============================================================================
// Screenshot evidence
// ============================================================================

export interface ReviewScreenshots {
  desktop: string[];
  phone: string[];
}

/**
 * The non-empty `desktop*.png` and `phone*.png` files in the verifier's screenshot folder.
 * A missing or unreadable folder means no screenshots.
 */
export function findReviewScreenshots(dir: string): ReviewScreenshots {
  const found: ReviewScreenshots = { desktop: [], phone: [] };
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return found;
  }
  for (const name of names.sort()) {
    const kind = /^desktop.*\.png$/i.test(name) ? "desktop" : /^phone.*\.png$/i.test(name) ? "phone" : null;
    if (!kind) continue;
    const full = join(dir, name);
    try {
      if (statSync(full).size > 0) found[kind].push(full);
    } catch {
      // vanished between readdir and stat — not evidence
    }
  }
  return found;
}
