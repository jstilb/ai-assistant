#!/usr/bin/env bun
/**
 * ScreenshotGate — wraps the Browser skill's `/screenshot` endpoint
 * so any presentation surface (Obsidian canvas, Vite dashboard, etc.)
 * gets a visual artifact saved to disk that Jm can `open` immediately.
 *
 * The gate is the structural defense against "code looks complete, UI
 * doesn't render" — every commit touching a presentation surface must
 * produce a screenshot.
 */

import { existsSync, mkdirSync, writeFileSync, copyFileSync } from "fs";
import { join, dirname, isAbsolute } from "path";
import { spawnSync } from "child_process";

const DOGFOOD_DIR = "~/.claude/dogfood-screenshots";
const BROWSER_SESSION_PORT = 9876; // matches BrowserSession default
const BROWSE_CLI = "~/.claude/skills/Development/Browser/Tools/Browse.ts";

export interface ScreenshotResult {
  ok: boolean;
  path: string;
  label: string;
  url: string;
  error?: string;
}

/**
 * Take a screenshot of `url` and save to `${DOGFOOD_DIR}/<ISO>-<label>.png`.
 * Returns the absolute path to the saved file. Never throws — failures
 * are surfaced via `result.ok = false` so a hook can decide policy.
 */
export async function screenshotAndSurface(
  label: string,
  url: string
): Promise<ScreenshotResult> {
  ensureDir(DOGFOOD_DIR);
  const stamp = isoStamp();
  const safeLabel = label.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80);
  const finalPath = join(DOGFOOD_DIR, `${stamp}-${safeLabel}.png`);

  // Try the persistent BrowserSession first via /screenshot.
  const viaSession = await viaBrowserSession(url, finalPath);
  if (viaSession.ok) {
    return { ok: true, path: finalPath, label, url };
  }

  // Fallback: Browse.ts CLI (auto-starts a session if needed).
  const cli = viaBrowseCLI(url, finalPath);
  if (cli.ok) {
    return { ok: true, path: finalPath, label, url };
  }

  return {
    ok: false,
    path: finalPath,
    label,
    url,
    error: `BrowserSession: ${viaSession.error}; CLI: ${cli.error}`,
  };
}

async function viaBrowserSession(
  url: string,
  destPath: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    // Navigate first so the URL we screenshot matches.
    const navResp = await fetch(`http://localhost:${BROWSER_SESSION_PORT}/navigate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    if (!navResp.ok) {
      return { ok: false, error: `navigate ${navResp.status}` };
    }
    const shotResp = await fetch(`http://localhost:${BROWSER_SESSION_PORT}/screenshot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: destPath, fullPage: true }),
    });
    if (!shotResp.ok) {
      return { ok: false, error: `screenshot ${shotResp.status}` };
    }
    return { ok: existsSync(destPath) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function viaBrowseCLI(
  url: string,
  destPath: string
): { ok: boolean; error?: string } {
  try {
    // First navigate; ignore failures (auto-starts session).
    spawnSync("bun", ["run", BROWSE_CLI, "navigate", url], {
      stdio: "pipe",
      timeout: 30_000,
    });
    const result = spawnSync("bun", ["run", BROWSE_CLI, "screenshot", destPath], {
      stdio: "pipe",
      timeout: 30_000,
    });
    if (result.status !== 0) {
      return {
        ok: false,
        error: result.stderr?.toString().slice(0, 200) ?? `exit ${result.status}`,
      };
    }
    // Browse.ts may save to /tmp and then we copy — handle both shapes.
    if (existsSync(destPath)) return { ok: true };
    const stdout = result.stdout?.toString() ?? "";
    const match = stdout.match(/Screenshot saved to (\/[^\s]+\.png)/);
    if (match && existsSync(match[1])) {
      copyFileSync(match[1], destPath);
      return { ok: true };
    }
    return { ok: false, error: "screenshot file not produced" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function isoStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ---------- CLI ----------

if (import.meta.main) {
  const [label, url] = process.argv.slice(2);
  if (!label || !url) {
    console.error("Usage: bun ScreenshotGate.ts <label> <url>");
    process.exit(1);
  }
  const result = await screenshotAndSurface(label, url);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
