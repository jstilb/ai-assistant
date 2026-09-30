/**
 * Dedup.ts — EventScout deduplication + merge engine.
 *
 * Algorithm (mirrors SPEC §2 decision 4):
 *   1. Bucket events by calendar day (YYYY-MM-DD derived from startDatetime).
 *   2. Within each bucket, two events are duplicates iff ALL three hold:
 *      (a) Same calendar day (bucket guarantee).
 *      (b) Venue-compatible: normalized venues are equal, one contains the other,
 *          OR venue-only Jaccard >= 0.6. Special cases: if BOTH lack a venue,
 *          skip venue check and apply stricter title rule (>= 0.8 or containment);
 *          if exactly ONE lacks a venue, they are NOT compatible → no merge.
 *      (c) Title similar: title-only Jaccard (venue tokens excluded) >= 0.6, OR
 *          one normalized title string contains the other.
 *   3. On a match: MERGE — keep the record with the most populated optional fields
 *      ("richest"), UNION the sources[] arrays (dedup by sourceId), and union
 *      ticket links.
 *   4. Distinct events (different title/venue/day) are NEVER merged.
 *
 * Rationale for splitting title and venue checks:
 *   The prior combined-token Jaccard at 0.5 caused false merges when short,
 *   distinct titles shared venue tokens. E.g. "Jazz Night" vs "Open Mic Night"
 *   both at "The Comedy Store" → combined Jaccard 0.57 (venue tokens dominate).
 *   Evaluating title and venue separately prevents venue tokens from inflating
 *   title similarity.
 *
 * api-tier exemption (2026-07-10, root-caused during the MemberLifeAdapter build,
 * option (a) chosen over loosening the fuzzy thresholds):
 *   Structured `api`-tier sources (PadresAdapter, SdfcAdapter, MemberLifeAdapter)
 *   emit collision-resistant stableIds (hash of canonical title + exact start +
 *   venue), so two genuinely distinct events they produce can legitimately share
 *   short/near-identical titles at the same venue on the same day — e.g.
 *   Majesty in Motion's "Level 1 Salsa" and "Level 2 Salsa", same room, same
 *   instructor, back-to-back. The fuzzy heuristics above are tuned for scraped
 *   prose sources (concert listicles, RSS feeds) where they are correct and
 *   load-bearing — see dedup.test.ts's threshold regression tests — so they are
 *   NOT relaxed globally. Instead, callers pass `apiTierSourceIds` (looked up
 *   from sources.json's `fetchTier`, never hardcoded here): any event carrying a
 *   source in that set is exempt from every fuzzy check — never merged with each
 *   other, and never absorbed into/by a non-api event. Its only dedup is exact
 *   `id` equality (mirrors Cache.ts's upsertEvents "incoming wins" semantics).
 *
 * Exports:
 *   dedupeAndMerge(events: EventItem[], apiTierSourceIds?: ReadonlySet<string>): EventItem[]
 */

import type { EventItem } from "./types.ts";

// ============================================================================
// Jaccard similarity — replicates ContentDeduplicator approach, tuned for events
// ============================================================================

/**
 * Strip diacritics so accented spellings compare equal to their ASCII form
 * ("Négociant" → "negociant"). Sources spell the same venue both ways, which
 * otherwise defeats both the containment and Jaccard checks below.
 */
function stripDiacritics(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * Tokenize text into a normalised word set.
 * Mirrors ContentDeduplicator.tokenize: lowercase, strip diacritics + non-
 * alphanumeric, split on whitespace, skip tokens <= 2 chars (noise words).
 */
function tokenize(text: string): Set<string> {
  return new Set(
    stripDiacritics(text.toLowerCase())
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 2)
  );
}

/**
 * Jaccard similarity coefficient: |A ∩ B| / |A ∪ B|
 * Returns 0.0 (no overlap) to 1.0 (identical sets).
 * Mirrors ContentDeduplicator.jaccardSimilarity.
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1.0;
  if (a.size === 0 || b.size === 0) return 0.0;
  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Thresholds for the split title/venue predicate.
 *
 * TITLE_THRESHOLD: title-only Jaccard required when venue is present.
 *   0.6 catches "Tycho @ Observatory" vs "Tycho at The Observatory North Park"
 *   (title tokens: {tycho} vs {tycho, observatory, north, park} → Jaccard 0.2,
 *   but containment fires because "tycho" is in both normalized forms).
 *
 * TITLE_STRICT_THRESHOLD: used when BOTH events lack a venue, so venue can't
 *   disambiguate. 0.8 is tight enough that incidentally similar news items
 *   (e.g. "Padres game" vs "Press Club awards") are kept separate.
 *
 * VENUE_THRESHOLD: venue-only Jaccard. 0.6 allows minor wording differences
 *   ("The Observatory" vs "The Observatory North Park" fires containment first
 *   so Jaccard is a fallback for more divergent spellings).
 */
const TITLE_THRESHOLD = 0.6;
const TITLE_STRICT_THRESHOLD = 0.8; // when both events lack a venue
const VENUE_THRESHOLD = 0.6;

// ============================================================================
// Calendar-day bucketing
// ============================================================================

/**
 * Extract YYYY-MM-DD from an ISO 8601 datetime string.
 * Handles both "Z" and offset-aware timestamps by taking the date part of the
 * local time representation where the offset is embedded in the string.
 *
 * Strategy: parse the ISO string, then pull the date segment that appears
 * before the "T" — this is correct when the datetime already carries a local
 * offset (as PadresAdapter and RSSAdapter both produce).
 */
function calendarDay(isoDatetime: string): string {
  // Bucket by America/Los_Angeles calendar day so the SAME instant expressed in
  // different representations lands in ONE bucket. Adapters emit a mix of UTC
  // ("2026-06-05T03:30:00Z") and offset-local ("2026-06-04T20:30:00-07:00")
  // timestamps; the naive slice(0,10) split these into Jun-05 vs Jun-04 and never
  // compared them, so cross-source twins escaped dedup. Date-only / unparseable
  // strings fall back to the raw date prefix (adapters already store all-day
  // events as LA-midnight-in-UTC, which converts back to the correct LA day).
  if (!isoDatetime.includes("T")) return isoDatetime.slice(0, 10);
  const d = new Date(isoDatetime);
  if (Number.isNaN(d.getTime())) return isoDatetime.slice(0, 10);
  // en-CA renders as YYYY-MM-DD; timeZone converts the instant to the LA local day.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

// ============================================================================
// Separate title and venue similarity checks
// ============================================================================

/**
 * Normalize a venue string for containment comparison:
 * lowercase, collapse whitespace, strip leading "the ".
 */
function normalizeVenue(venue: string): string {
  return stripDiacritics(venue.toLowerCase())
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^the\s+/, "");
}

/**
 * The venue NAME, before any appended postal address. Sources commonly tack
 * the full address onto the venue ("House of Blues, 1055 5th Avenue, San Diego,
 * CA 92101"), which dilutes both containment and Jaccard against the bare name
 * ("House of Blues San Diego"). The text before the first comma is the name.
 */
function venueCore(venue: string): string {
  return normalizeVenue(venue.split(",")[0] ?? venue);
}

/**
 * Returns true if two venue strings are compatible (same or near-same venue).
 *
 * Cases:
 *   - Exact normalized match.
 *   - One normalized string contains the other (handles "The Observatory" vs
 *     "The Observatory North Park").
 *   - Address-stripped cores match (handles "<Venue>" vs "<Venue>, <address>").
 *   - Venue-token Jaccard >= VENUE_THRESHOLD.
 *
 * Permissiveness here is safe: a merge ALSO requires the title/performer check
 * (areDuplicates), so a looser venue match never merges two genuinely different
 * shows at the same place — the title gate stops that.
 */
function venueCompatible(a: string, b: string): boolean {
  const na = normalizeVenue(a);
  const nb = normalizeVenue(b);
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  const ca = venueCore(a);
  const cb = venueCore(b);
  if (ca.length > 0 && cb.length > 0 && (ca === cb || ca.includes(cb) || cb.includes(ca))) return true;
  return jaccardSimilarity(tokenize(a), tokenize(b)) >= VENUE_THRESHOLD;
}

/**
 * Returns true if two title strings are considered similar.
 *
 * Cases (evaluated in order):
 *   1. One normalized title string contains the other as a substring
 *      (e.g. "Tycho" ⊂ "Tycho Live").
 *   2. All tokens of the shorter title are a subset of the longer title's
 *      token set — catches "Tycho @ Observatory" vs "Tycho at The Observatory
 *      North Park" where the shorter set {tycho, observatory} ⊆ {tycho, the,
 *      observatory, north, park}.
 *   3. Title-only token Jaccard >= threshold.
 */
function titleSimilar(a: string, b: string, threshold: number): boolean {
  const na = stripDiacritics(a.toLowerCase()).replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
  const nb = stripDiacritics(b.toLowerCase()).replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
  if (na.includes(nb) || nb.includes(na)) return true;

  const ta = tokenize(a);
  const tb = tokenize(b);

  // Subset check: all tokens of the smaller set appear in the larger set
  const [smaller, larger] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  if (smaller.size > 0) {
    let allPresent = true;
    for (const tok of smaller) {
      if (!larger.has(tok)) {
        allPresent = false;
        break;
      }
    }
    if (allPresent) return true;
  }

  return jaccardSimilarity(ta, tb) >= threshold;
}

/**
 * Parse the comma-separated `performersOrTeams` string into a normalized set of
 * names (lowercase, alphanumeric-only, drop tokens <= 3 chars to avoid noise).
 */
function performerSet(perf: string | undefined): Set<string> {
  if (!perf) return new Set();
  return new Set(
    perf
      .split(",")
      .map((s) => s.toLowerCase().replace(/[^a-z0-9]/g, ""))
      .filter((s) => s.length > 3)
  );
}

/**
 * Returns true if two events share at least one performer/team.
 *
 * Used as a same-show signal when titles diverge across (or within) sources:
 * Songkick lists one concert as "Quintron", "Quintron at Casbah", and
 * "Quintron @ Casbah", and Bandsintown as "Quintron & Miss Pussycat" — all
 * carrying the same headliner. Combined with a compatible venue + same LA day,
 * a shared performer is strong evidence of one event.
 */
function sharePerformer(a: EventItem, b: EventItem): boolean {
  const pa = performerSet(a.performersOrTeams);
  if (pa.size === 0) return false;
  const pb = performerSet(b.performersOrTeams);
  if (pb.size === 0) return false;
  for (const name of pa) {
    if (pb.has(name)) return true;
  }
  return false;
}

/**
 * Returns true if two events are considered duplicates.
 *
 * Predicate: same calendar day AND venue-compatible AND (title-similar OR
 * shared performer).
 * Title and venue are evaluated SEPARATELY so venue tokens cannot inflate
 * title similarity and cause false merges (e.g. "Jazz Night" vs "Open Mic Night"
 * at the same venue).
 *
 * Missing-venue rules:
 *   - Both lack venue → skip venue check, apply stricter title threshold (0.8).
 *   - Exactly one lacks venue → venue is incompatible → no merge.
 */
function areDuplicates(a: EventItem, b: EventItem): boolean {
  if (calendarDay(a.startDatetime) !== calendarDay(b.startDatetime)) {
    return false;
  }

  const aHasVenue = Boolean(a.venue);
  const bHasVenue = Boolean(b.venue);

  if (aHasVenue && bHasVenue) {
    // Both have venue: require venue-compatible AND (title-similar OR a shared
    // performer/team). The performer signal collapses cross-source twins whose
    // titles diverge but who share a headliner at the same venue on the same day.
    return (
      venueCompatible(a.venue as string, b.venue as string) &&
      (titleSimilar(a.title, b.title, TITLE_THRESHOLD) || sharePerformer(a, b))
    );
  }

  if (!aHasVenue && !bHasVenue) {
    // Neither has venue: skip venue check, require stricter title similarity
    return titleSimilar(a.title, b.title, TITLE_STRICT_THRESHOLD);
  }

  // Exactly one has venue → cannot confirm same location → not duplicates
  return false;
}

// ============================================================================
// Richness score — count non-empty optional fields
// ============================================================================

function richnessScore(event: EventItem): number {
  let score = 0;
  if (event.endDatetime) score++;
  if (event.venue) score++;
  if (event.address) score++;
  if (event.lat != null) score++;
  if (event.lng != null) score++;
  if (event.ticketUrl) score++;
  if (event.description && event.description.length > 0) score++;
  if (event.imageUrl) score++;
  if (event.performersOrTeams) score++;
  if (event.priceMin != null) score++;
  if (event.priceMax != null) score++;
  if (event.tags.length > 0) score++;
  return score;
}

// ============================================================================
// Merge two duplicate events — richest fields win, sources[] unioned
// ============================================================================

function mergeEvents(a: EventItem, b: EventItem): EventItem {
  // Pick the base from the richer record
  const [richer, leaner] = richnessScore(a) >= richnessScore(b) ? [a, b] : [b, a];

  // Union sources[], deduplicated by sourceId
  const seenSourceIds = new Set<string>();
  const mergedSources: EventItem["sources"] = [];
  for (const src of [...richer.sources, ...leaner.sources]) {
    if (!seenSourceIds.has(src.sourceId)) {
      seenSourceIds.add(src.sourceId);
      mergedSources.push(src);
    }
  }

  // Merge optional fields: prefer richer's value, fall back to leaner's
  return {
    ...richer,
    sources: mergedSources,
    // Overlay any fields the leaner has that the richer lacks
    endDatetime: richer.endDatetime ?? leaner.endDatetime,
    venue: richer.venue ?? leaner.venue,
    address: richer.address ?? leaner.address,
    lat: richer.lat ?? leaner.lat,
    lng: richer.lng ?? leaner.lng,
    ticketUrl: richer.ticketUrl ?? leaner.ticketUrl,
    description: richer.description ?? leaner.description,
    imageUrl: richer.imageUrl ?? leaner.imageUrl,
    performersOrTeams: richer.performersOrTeams ?? leaner.performersOrTeams,
    priceMin: richer.priceMin ?? leaner.priceMin,
    priceMax: richer.priceMax ?? leaner.priceMax,
    // Union tags
    tags: Array.from(new Set([...richer.tags, ...leaner.tags])),
  };
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Deduplicate and merge a flat list of EventItems.
 *
 * Two events merge iff same calendar day AND venue-compatible AND title-similar
 * (title and venue evaluated separately — see areDuplicates for full rules).
 * Merged record keeps the richest fields; sources[] are unioned.
 *
 * @param events           - Any mix of EventItems (from one or more adapters).
 * @param apiTierSourceIds - Optional set of source ids whose `fetchTier` is
 *                           "api" (caller resolves this from sources.json —
 *                           see SourceManager.loadApiTierSourceIds). Any event
 *                           carrying one of these source ids is exempt from
 *                           every fuzzy check below: it is never merged with
 *                           another api-tier event, and never absorbed
 *                           into/by a non-api event. Duplicates among
 *                           api-tier events are collapsed by exact `id`
 *                           equality only (last occurrence wins). Omit (or
 *                           pass an empty set) to preserve the original
 *                           all-fuzzy behavior exactly.
 * @returns                 - Deduplicated, merged EventItem[].
 */
export function dedupeAndMerge(
  events: EventItem[],
  apiTierSourceIds?: ReadonlySet<string>
): EventItem[] {
  if (events.length === 0) return [];

  // Partition off api-tier events — see the "api-tier exemption" note above
  // the module header. They skip the fuzzy pipeline entirely; their only
  // dedup is exact id equality (last occurrence wins, matching Cache.ts's
  // upsertEvents "incoming wins" semantics).
  const fuzzyInput: EventItem[] = [];
  const apiEventsById = new Map<string, EventItem>();
  for (const event of events) {
    const isApiTier =
      apiTierSourceIds != null &&
      apiTierSourceIds.size > 0 &&
      event.sources.some((s) => apiTierSourceIds.has(s.sourceId));
    if (isApiTier) {
      apiEventsById.set(event.id, event);
    } else {
      fuzzyInput.push(event);
    }
  }

  // Bucket by calendar day
  const buckets = new Map<string, EventItem[]>();
  for (const event of fuzzyInput) {
    const day = calendarDay(event.startDatetime);
    const bucket = buckets.get(day);
    if (bucket) {
      bucket.push(event);
    } else {
      buckets.set(day, [event]);
    }
  }

  const result: EventItem[] = [];

  // Within each bucket, do pairwise merge
  for (const bucket of buckets.values()) {
    // Build a working list; iterate and greedily merge duplicates
    const merged: EventItem[] = [];

    for (const candidate of bucket) {
      let didMerge = false;
      for (let i = 0; i < merged.length; i++) {
        if (areDuplicates(merged[i], candidate)) {
          merged[i] = mergeEvents(merged[i], candidate);
          didMerge = true;
          break;
        }
      }
      if (!didMerge) {
        merged.push(candidate);
      }
    }

    result.push(...merged);
  }

  result.push(...apiEventsById.values());

  return result;
}
