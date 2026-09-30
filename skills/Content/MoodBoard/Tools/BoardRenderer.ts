#!/usr/bin/env bun
/**
 * BoardRenderer.ts - Render a board as a self-contained HTML collage
 *
 * Produces a Pinterest-style masonry collage (CSS columns, dark gallery
 * aesthetic) with full attribution on every image. Output lives OUTSIDE the
 * repo at ~/.kaya/moodboards/<slug>/index.html so large image files never get
 * auto-committed.
 *
 * Usage:
 *   bun Tools/BoardRenderer.ts <slug> [--out <dir>] [--download] [--open] [--state <path>]
 *
 * Flags:
 *   --download   Fetch each image into <out>/images/ and reference locally
 *                (enables offline viewing AND lets Claude look at the images
 *                with the Read tool to curate). Failures fall back to hotlink.
 *   --open       Open the rendered collage in the default browser (macOS).
 *
 * @module MoodBoard/BoardRenderer
 */

import { homedir } from "os";
import { join } from "path";
import { existsSync, mkdirSync } from "fs";
import { httpClient } from "../../../../lib/core/CachedHTTPClient.ts";
import { boardsStatePath, createBoardStore, getBoard } from "./BoardStore.ts";
import type { Board, Pin } from "./Types.ts";

// ---------------------------------------------------------------------------
// HTML rendering (pure — unit tested)
// ---------------------------------------------------------------------------

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const SOURCE_LABELS: Record<Pin["source"], string> = {
  openverse: "Openverse",
  wikimedia: "Wikimedia",
  met: "The Met",
  manual: "Pinned",
};

function renderPin(pin: Pin, localImages: Record<string, string>): string {
  const src = localImages[pin.id] ?? pin.thumbUrl ?? pin.imageUrl;
  const title = escapeHtml(pin.title || "Untitled");
  const metaParts = [SOURCE_LABELS[pin.source], pin.creator, pin.license]
    .filter((p): p is string => Boolean(p))
    .map(escapeHtml);
  const img = `<img src="${escapeHtml(src)}" alt="${title}" loading="lazy">`;
  const linkedImg = pin.pageUrl
    ? `<a href="${escapeHtml(pin.pageUrl)}" target="_blank" rel="noopener">${img}</a>`
    : img;
  const note = pin.note ? `<p class="note">${escapeHtml(pin.note)}</p>` : "";
  return `<figure data-pin-id="${escapeHtml(pin.id)}">
  ${linkedImg}
  <figcaption>
    <span class="title">${title}</span>
    <span class="meta">${metaParts.join(" · ")}</span>
    ${note}
  </figcaption>
</figure>`;
}

export function renderBoardHTML(
  board: Board,
  options: { localImages?: Record<string, string> } = {}
): string {
  const localImages = options.localImages ?? {};
  const figures = board.pins.map((p) => renderPin(p, localImages)).join("\n");
  const tags = board.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join(" ");
  const generated = new Date().toISOString().slice(0, 10);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(board.title)} — Mood Board</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #101014; color: #e8e6e1; font-family: -apple-system, "Helvetica Neue", sans-serif; padding: 2rem; }
  header { max-width: 1400px; margin: 0 auto 2rem; }
  h1 { font-family: Georgia, "Times New Roman", serif; font-size: 2.4rem; font-weight: 500; letter-spacing: 0.02em; }
  .theme { color: #b5b0a6; font-style: italic; margin-top: 0.4rem; font-size: 1.05rem; }
  .facts { color: #6f6a62; font-size: 0.8rem; margin-top: 0.6rem; }
  .tag { display: inline-block; border: 1px solid #3a3a42; border-radius: 999px; padding: 0.1rem 0.6rem; margin-right: 0.3rem; font-size: 0.75rem; color: #b5b0a6; }
  .board { max-width: 1400px; margin: 0 auto; columns: 4 280px; column-gap: 14px; }
  figure { break-inside: avoid; margin: 0 0 14px; background: #17171c; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 10px rgba(0,0,0,0.4); }
  figure img { width: 100%; display: block; }
  figcaption { padding: 0.6rem 0.75rem 0.75rem; }
  .title { display: block; font-size: 0.85rem; line-height: 1.3; }
  .meta { display: block; font-size: 0.7rem; color: #6f6a62; margin-top: 0.25rem; }
  .note { font-size: 0.78rem; color: #d8b46a; margin-top: 0.35rem; font-style: italic; }
  a { color: inherit; text-decoration: none; }
  .empty { color: #6f6a62; text-align: center; padding: 4rem 0; font-style: italic; }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(board.title)}</h1>
  ${board.theme ? `<p class="theme">${escapeHtml(board.theme)}</p>` : ""}
  <p class="facts">${board.pins.length} pins · generated ${generated} ${tags ? "· " + tags : ""}</p>
</header>
<main class="board">
${figures || '<p class="empty">No pins yet — add some inspiration.</p>'}
</main>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Image download (for offline viewing + Claude vision curation)
// ---------------------------------------------------------------------------

function extensionFor(url: string, contentType: string | null): string {
  const fromType: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
  };
  if (contentType && fromType[contentType.split(";")[0].trim()]) {
    return fromType[contentType.split(";")[0].trim()];
  }
  const match = url.match(/\.(jpe?g|png|webp|gif)(\?|$)/i);
  return match ? match[1].toLowerCase().replace("jpeg", "jpg") : "jpg";
}

export async function downloadImages(
  board: Board,
  outDir: string
): Promise<{ localImages: Record<string, string>; failures: string[] }> {
  const imagesDir = join(outDir, "images");
  mkdirSync(imagesDir, { recursive: true });
  const localImages: Record<string, string> = {};
  const failures: string[] = [];

  for (const pin of board.pins) {
    const url = pin.thumbUrl ?? pin.imageUrl;
    // Re-renders must not re-fetch: Wikimedia 429s bursts of repeat downloads,
    // silently degrading previously-local pins back to fragile hotlinks.
    const existing = ["jpg", "png", "webp", "gif"]
      .map((ext) => `${pin.id}.${ext}`)
      .find((name) => existsSync(join(imagesDir, name)));
    if (existing) {
      localImages[pin.id] = `images/${existing}`;
      continue;
    }
    try {
      const response = await httpClient.fetch(url, {
        cache: "none",
        timeout: 20000,
        retry: 1,
        headers: { "User-Agent": "KayaMoodBoard/1.0 (personal mood-board tool)" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const ext = extensionFor(url, response.headers.get("content-type"));
      const fileName = `${pin.id}.${ext}`;
      await Bun.write(join(imagesDir, fileName), await response.arrayBuffer());
      localImages[pin.id] = `images/${fileName}`;
    } catch (err) {
      failures.push(`${pin.id} (${url}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { localImages, failures };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function defaultOutputDir(slug: string): string {
  return join(homedir(), ".kaya", "moodboards", slug);
}

function getFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const slug = args[0];

  if (!slug || slug.startsWith("--") || args.includes("--help")) {
    console.log("Usage: bun Tools/BoardRenderer.ts <slug> [--out <dir>] [--download] [--open] [--state <path>]");
    process.exit(slug && !slug.startsWith("--") ? 0 : 1);
  }

  try {
    const store = createBoardStore(getFlag(args, "--state") ?? boardsStatePath());
    const board = await getBoard(store, slug);
    const outDir = getFlag(args, "--out") ?? defaultOutputDir(slug);
    mkdirSync(outDir, { recursive: true });

    let localImages: Record<string, string> = {};
    if (args.includes("--download")) {
      const result = await downloadImages(board, outDir);
      localImages = result.localImages;
      console.log(`Downloaded ${Object.keys(localImages).length}/${board.pins.length} images to ${join(outDir, "images")}`);
      for (const failure of result.failures) console.error(`  download failed, hotlinking: ${failure}`);
    }

    const htmlPath = join(outDir, "index.html");
    await Bun.write(htmlPath, renderBoardHTML(board, { localImages }));
    console.log(`Rendered ${board.pins.length}-pin collage: ${htmlPath}`);

    if (args.includes("--open")) {
      Bun.spawnSync(["open", htmlPath]);
      console.log("Opened in browser.");
    } else {
      console.log(`View it: open "${htmlPath}"`);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
