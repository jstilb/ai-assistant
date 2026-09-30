#!/usr/bin/env bun
/**
 * DanceStudioProAdapter.ts — DanceStudio-Pro (GoStudioPro) studio schedule → EventItem.
 *
 * The Dancehouse (2180 Chatsworth Blvd, Point Loma) publishes its class
 * schedule on thedancehouse.com/schedule/ as a DanceStudio-Pro iframe
 * (dancestudio-pro.com/apps/api_classes.php?id=…&s=…). That iframe is a JS
 * shell: the class table arrives via an in-page AJAX POST to
 * /apps/api_classes-ajax.php. Three constraints force this adapter instead of
 * the spa tier:
 *
 *   1. The outer /schedule/ page holds the table in a CROSS-ORIGIN iframe, so
 *      even a real browser render of it captures no schedule.
 *   2. The spa tier's "Playwright escalation" cannot render the iframe URL
 *      either — BrightDataTool tier 3 has no browser implementation (it falls
 *      through to tier-2 curl), so escalation refetches the same 6.5KB shell.
 *   3. The AJAX endpoint reads $_POST only: GET with the same params returns
 *      an empty 200, and dancestudio-pro.com 301s the POST to
 *      app.gostudiopro.com (dropping the body), so we POST the final host
 *      directly.
 *
 * The POST response is a small HTML fragment (~12KB, "Adult Classes" table:
 * one row per weekly class with name, instructor, ages, weekday + time range).
 * It runs through the shared extractEventsFromContent kernel, whose LLM
 * extraction dates each recurring class to its next occurrence — the same
 * treatment tangodelrey-com-weekly-events gets. NOT the "api" tier: api-tier
 * sources are exempt from fuzzy dedup, and LLM-extracted events need it.
 *
 * Exports:
 *   parseStudioParams(url): PURE — pulls the studio `id`/`s` params from the
 *       source url. Throws loudly if either is missing.
 *   buildClassesPostBody(id, s): PURE — the form-encoded POST body, blank
 *       filters (= "all classes"), mirroring the widget's own getClasses().
 *   fetchDanceStudioProEvents(source): POST → shared extraction. Returns
 *       EventItem[]; does NOT write to cache. Throws on non-200 or empty body.
 *
 * A second DanceStudio-Pro studio can reuse this adapter as-is by adding a
 * source whose url carries its own id/s params.
 */

import { extractEventsFromContent } from "./SPAAdapter.ts";
import type { EventItem, EventSource } from "../types.ts";

// ============================================================================
// Endpoint
// ============================================================================

/**
 * Final POST host. dancestudio-pro.com 301s here and the redirect drops the
 * POST body (curl and fetch both resend as body-less), yielding an empty 200 —
 * so the adapter targets the final host directly.
 */
export const DSP_AJAX_ENDPOINT =
  "https://app.gostudiopro.com/apps/api_classes-ajax.php";

/** Fetch timeout — generous for a ~12KB response, far under Ingest's per-source cap. */
const FETCH_TIMEOUT_MS = 30_000;

// ============================================================================
// Pure helpers (unit-testable, no network)
// ============================================================================

/**
 * Extract the studio `id` and site `s` params from the source's iframe URL
 * (dancestudio-pro.com/apps/api_classes.php?id=…&s=…). Throws if either is
 * missing — a source misconfiguration that must fail loudly, not fetch junk.
 */
export function parseStudioParams(url: string): { id: string; s: string } {
  const parsed = new URL(url);
  const id = parsed.searchParams.get("id");
  const s = parsed.searchParams.get("s");
  if (!id || !s) {
    throw new Error(
      `[DanceStudioPro] source url is missing the id/s query params: ${url}`
    );
  }
  return { id, s };
}

/**
 * Form-encoded body for the classes AJAX call. Blank filter fields mean
 * "all classes" — the same request the widget's own getClasses() fires on load.
 */
export function buildClassesPostBody(id: string, s: string): string {
  return new URLSearchParams({
    action: "get_classes",
    id,
    l: "0",
    s,
    tsearch: "",
    f_wday: "",
    f_age: "",
    f_loc: "",
    f_type: "",
  }).toString();
}

// ============================================================================
// Fetch runner
// ============================================================================

/**
 * Fetch the studio's class table and extract events via the shared
 * JSON-LD → LLM kernel. Throws on transport failure, non-200, or an empty
 * body (the endpoint's signature response to a mis-shaped request).
 */
export async function fetchDanceStudioProEvents(
  source: EventSource
): Promise<EventItem[]> {
  const { id, s } = parseStudioParams(source.url);

  const res = await fetch(DSP_AJAX_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: buildClassesPostBody(id, s),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(
      `[DanceStudioPro] ${DSP_AJAX_ENDPOINT} returned ${res.status} for ${source.id}`
    );
  }

  const html = await res.text();
  if (html.trim().length === 0) {
    throw new Error(
      `[DanceStudioPro] empty response body for ${source.id} — the endpoint ` +
        `returns empty 200s to non-POST/mis-shaped requests; has the API changed?`
    );
  }

  console.log(
    `[DanceStudioPro] Fetched ${html.length} chars of schedule HTML for ${source.id}`
  );
  return extractEventsFromContent(html, source);
}
