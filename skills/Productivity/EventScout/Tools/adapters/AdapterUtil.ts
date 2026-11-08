/**
 * AdapterUtil.ts — helpers every EventScout source adapter shares.
 *
 * Formerly copied into each of 15 adapters (canonical + stableId) and 2
 * adapters (stripHtml). IDs are persisted as cache keys, so the hash recipe
 * here must not change: same inputs → same 16-hex id as the old copies.
 */

import { createHash } from "node:crypto";

/** Trim, lowercase and collapse whitespace — the id-hashing normal form. */
export function canonical(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Stable event id (SPEC §4.1): sha256(canonical(title) | startDatetime |
 * canonical(venue)), first 16 hex chars. `venue` is the venue name, or the
 * event/source URL for adapters with no venue.
 *
 * `normalizeUtc` (JsonLd, SPAAdapter): parse startDatetime and hash its UTC
 * ISO form, so an offset-aware string ("-07:00") and a naive string for the
 * same LA wall-clock produce the same id. Unparseable strings hash as-is.
 */
export function stableId(
  title: string,
  startDatetime: string,
  venue: string,
  { normalizeUtc = false }: { normalizeUtc?: boolean } = {},
): string {
  let start = startDatetime;
  if (normalizeUtc) {
    const ms = Date.parse(startDatetime);
    start = Number.isNaN(ms) ? startDatetime : new Date(ms).toISOString();
  }
  const raw = `${canonical(title)}|${start}|${canonical(venue)}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

/**
 * Collapse rich-text HTML into a plain one-liner: tags → space; &nbsp; &amp;
 * &lt; &gt; &quot; &#39; decoded; any other entity → space; whitespace
 * collapsed. Shared by ActiveNet, Pike13, Evvnt and WordPressTec.
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#?[a-z0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}
