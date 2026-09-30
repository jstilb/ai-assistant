/**
 * links.ts — shared "best link" resolution for an EventItem.
 *
 * Render and Actions (calendar/save) both need to turn an event into a single
 * clickable URL. The rule is the same everywhere, so it lives here once:
 *
 *   1. ticketUrl, if present and navigable (a real event/ticket page).
 *   2. else sourceUrl, if navigable.
 *   3. else — the only link we have is a machine feed (an .ics export, an API
 *      endpoint, an RSS/XML feed) that a human can't open. Rather than hand the
 *      user a broken `calendar/ical/…` blob, fall back to a Google search scoped
 *      to the event title + venue, which reliably lands on the real listing.
 *
 * ~13% of cached events (a Google-Calendar ICS aggregator with no per-event
 * URLs) hit case 3 — without this they rendered an un-openable ical link.
 */

import type { EventItem } from "../types.ts";

/**
 * Links that a person cannot open in a browser to find the event: calendar
 * feeds, ICS exports, stats/JSON APIs, and raw RSS/Atom/XML feeds.
 */
const NON_NAVIGABLE = /\.ics(\?|$)|\/calendar\/ical\/|calendar\.google\.com|statsapi\.|\/feed\/?(\?|$)|format=ical|\.xml(\?|$)/i;

/** True if `url` is an http(s) link a human can actually open to see the event. */
function isNavigable(url: string | undefined): url is string {
  if (!url) return false;
  if (!/^https?:\/\//i.test(url)) return false;
  return !NON_NAVIGABLE.test(url);
}

/** Build a Google search that lands on the event's real listing page. */
export function searchFallbackUrl(e: EventItem): string {
  const terms = [e.title, e.venue, "San Diego"].filter(Boolean).join(" ");
  return `https://www.google.com/search?q=${encodeURIComponent(terms)}`;
}

/**
 * The single best clickable link for an event. Never returns a non-navigable
 * feed URL — see module docstring for the resolution order.
 */
export function bestLink(e: EventItem): string {
  if (isNavigable(e.ticketUrl)) return e.ticketUrl;
  if (isNavigable(e.sourceUrl)) return e.sourceUrl;
  return searchFallbackUrl(e);
}
