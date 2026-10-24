/**
 * Sources.ts — listing fetchers for Craigslist and Redfin rentals.
 *
 * Both are keyless public endpoints (verified 2026-10-22):
 *   - Craigslist: sapi.craigslist.org/web/v8 search JSON (the same call the
 *     craigslist.org search page makes) gives price/beds/sqft/lat/lon per hit;
 *     the posting page gives the body text + structured attributes
 *     (laundry, A/C, housing type).
 *   - Redfin: stingray/api/v1/search/rentals for zip 92107 (region 38107),
 *     plus per-rental /amenities (dishwasher, W/D, A/C, private yard) and
 *     /floorPlans (unit-level prices for multi-unit buildings).
 * Zillow/Apartments.com are bot-walled (403) — Redfin already aggregates
 * their RentPath/Zillow-fed inventory, so it covers that ground.
 *
 * Parsers are pure and exported for tests; network calls go through
 * `fetchText` so tests can inject fixtures.
 *
 * @module RentalTracker/Sources
 */
import type { Features, Laundry, PropertyKind, RawListing, TrackerConfig } from "./types.ts";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

export type Fetcher = (url: string) => Promise<{ status: number; text: string }>;

export const defaultFetcher: Fetcher = async (url) => {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html,application/json;q=0.9,*/*;q=0.8", Referer: "https://www.craigslist.org/" },
    redirect: "follow",
    signal: AbortSignal.timeout(25_000),
  });
  return { status: res.status, text: await res.text() };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Redfin's stingray API prefixes JSON with `{}&&` on some routes. */
function parseJsonLoose(text: string): any {
  return JSON.parse(text.replace(/^\s*\{\}&&/, ""));
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&nbsp;/g, " ");
}

function htmlToText(html: string): string {
  return decodeEntities(html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

// ============================================================================
// Craigslist
// ============================================================================

export function craigslistSearchUrl(cfg: TrackerConfig, offset = 0): string {
  const c = cfg.sources.craigslist;
  const q = new URLSearchParams({
    batch: `8-${offset}-360-0-0`,
    cc: "US",
    lang: "en",
    searchPath: "apa",
    postal: c.postal,
    search_distance: String(c.searchDistanceMi),
    max_price: String(cfg.criteria.maxPrice),
    min_bedrooms: String(cfg.criteria.minBeds),
    max_bedrooms: String(cfg.criteria.maxBeds),
  });
  return `https://sapi.craigslist.org/web/v8/postings/search/full?${q}`;
}

/**
 * Decode the compact sapi item arrays. Item layout (v8):
 *   [postingIdOffset, postedOffset, ?, price, "area:locIdx~lat~lon", hash, ...tagged]
 * Tagged sub-arrays: [13, uuid] [6, slug] [4, ...imageIds] [5, beds, sqft] [10, "$price"].
 * The title is the one bare string after index 5.
 */
export function parseCraigslistSearch(json: any): { listings: RawListing[]; total: number } {
  const data = json?.data;
  if (!data || !Array.isArray(data.items)) throw new Error("craigslist: unexpected search payload (no data.items)");
  const minId = Number(data.decode?.minPostingId ?? 0);
  const minPosted = Number(data.decode?.minPostedDate ?? 0);
  const locDesc: unknown[] = data.decode?.locationDescriptions ?? [];
  const out: RawListing[] = [];
  for (const it of data.items as unknown[][]) {
    const geo = typeof it[4] === "string" ? (it[4] as string).split("~") : [];
    if (geo.length < 3) continue; // no coordinates → can't place it in OB
    const lat = Number(geo[1]), lon = Number(geo[2]);
    const locIdx = Number(geo[0].split(":")[1]);
    const tag = (n: number) => it.find((x) => Array.isArray(x) && x[0] === n) as unknown[] | undefined;
    const uuid = tag(13)?.[1] as string | undefined;
    const slug = tag(6)?.[1] as string | undefined;
    if (!uuid || !slug) continue;
    const bs = tag(5);
    const imgs = (tag(4) ?? []).slice(1) as string[];
    const title = (it.slice(6).find((x) => typeof x === "string") as string | undefined) ?? "";
    const postingId = minId + Number(it[0]);
    const loc = typeof locDesc[locIdx] === "string" ? (locDesc[locIdx] as string) : undefined;
    out.push({
      id: `craigslist:${postingId}`,
      source: "craigslist",
      url: `https://www.craigslist.org/view/d/${slug}/${uuid}`,
      title: decodeEntities(title.trim()),
      price: Number(it[3]),
      beds: bs && typeof bs[1] === "number" ? (bs[1] as number) : null,
      sqft: bs && typeof bs[2] === "number" ? (bs[2] as number) : null,
      lat,
      lon,
      address: loc,
      postedAt: minPosted ? new Date((minPosted + Number(it[1])) * 1000).toISOString() : undefined,
      photo: imgs[0] ? `https://images.craigslist.org/${imgs[0].replace(/^\d+:/, "")}_300x300.jpg` : undefined,
    });
  }
  return { listings: out, total: Number(data.totalResultCount ?? out.length) };
}

export interface CraigslistDetail {
  gone: boolean;
  text: string;
  attrs: string[];
  address?: string;
  baths?: number | null;
  postedAt?: string;
  structured: Partial<Features>;
}

const CL_GONE = /This posting has been (deleted|flagged for removal)|This posting has expired|posting has been removed/i;

export function parseCraigslistDetail(status: number, html: string): CraigslistDetail {
  if (status === 404 || status === 410 || CL_GONE.test(html)) return { gone: true, text: "", attrs: [], structured: {} };
  // The attribute block sits between the first .attrgroup and the posting body;
  // each attribute renders on its own line once tags are stripped.
  const aStart = html.indexOf('class="attrgroup"');
  const aEnd = html.indexOf('<section id="postingbody"');
  const attrs = aStart >= 0 && aEnd > aStart
    ? htmlToText(html.slice(html.indexOf(">", aStart) + 1, aEnd).replace(/<\/(div|span)>/g, "</$1>\n"))
      .split("\n").map((s) => s.trim().toLowerCase()).filter(Boolean)
    : [];
  const bodyMatch = html.match(/<section id="postingbody">([\s\S]*?)<\/section>/);
  const body = bodyMatch ? htmlToText(bodyMatch[1].replace(/<div class="print-information[\s\S]*?<\/div>\s*<\/div>/, "")) : "";
  let address: string | undefined;
  let baths: number | null | undefined;
  const ld = html.match(/<script type="application\/ld\+json" id="ld_posting_data"\s*>([\s\S]*?)<\/script>/);
  if (ld) {
    try {
      const j = JSON.parse(ld[1]);
      const a = j.address ?? {};
      if (a.streetAddress) address = [a.streetAddress, a.addressLocality, a.postalCode].filter(Boolean).join(", ");
      if (typeof j.numberOfBathroomsTotal === "number") baths = j.numberOfBathroomsTotal;
    } catch {
      // malformed ld+json is common on craigslist; the attrs/body still carry the facts
    }
  }
  const posted = html.match(/class="date timeago" datetime="([^"]+)"/) ?? html.match(/<time[^>]*datetime="([^"]+)"/);
  const joined = attrs.join(" | ");
  const structured: Partial<Features> = {};
  const laundry: Laundry | undefined =
    /w\/d in unit/.test(joined) ? "in_unit"
      : /no laundry on site/.test(joined) ? "none"
        : /laundry (in bldg|on site)/.test(joined) ? "on_site" : undefined;
  if (laundry) structured.laundry = laundry;
  if (/air conditioning/.test(joined)) structured.ac = "yes";
  const kind: PropertyKind | undefined =
    /\bhouse\b/.test(joined) ? "house"
      : /\b(duplex|cottage\/cabin|in-law)\b/.test(joined) ? "duplex_cottage"
        : /\b(condo|townhouse)\b/.test(joined) ? "condo_townhome"
          : /\b(apartment|flat|loft)\b/.test(joined) ? "apartment" : undefined;
  if (kind) structured.propertyKind = kind;
  return {
    gone: false,
    text: `${body}\n\n[craigslist attributes] ${joined}`.trim(),
    attrs,
    address,
    baths,
    postedAt: posted ? new Date(posted[1].replace(/([+-]\d\d)(\d\d)$/, "$1:$2")).toISOString() : undefined,
    structured,
  };
}

export async function searchCraigslist(cfg: TrackerConfig, fetcher: Fetcher = defaultFetcher): Promise<RawListing[]> {
  const all: RawListing[] = [];
  for (let page = 0; page < 3; page++) {
    const { status, text } = await fetcher(craigslistSearchUrl(cfg, page * 360));
    if (status !== 200) throw new Error(`craigslist search HTTP ${status}`);
    const { listings, total } = parseCraigslistSearch(JSON.parse(text));
    all.push(...listings);
    if (listings.length === 0 || all.length >= total) break;
  }
  return all;
}

export async function enrichCraigslist(l: RawListing, fetcher: Fetcher = defaultFetcher): Promise<CraigslistDetail> {
  const { status, text } = await fetcher(l.url);
  if (status >= 500) throw new Error(`craigslist detail HTTP ${status}`);
  return parseCraigslistDetail(status, text);
}

// ============================================================================
// Redfin
// ============================================================================

export function redfinSearchUrl(cfg: TrackerConfig): string {
  const r = cfg.sources.redfin;
  const q = new URLSearchParams({
    al: "1", isRentals: "true", market: r.market, num_homes: "350", ord: "redfin-recommended-asc",
    page_number: "1", region_id: String(r.regionId), region_type: String(r.regionType),
    sf: "1,2,3,5,6,7", start: "0", status: "9", uipt: "1,2,3,4", v: "8",
  });
  return `https://www.redfin.com/stingray/api/v1/search/rentals?${q}`;
}

const REDFIN_TYPE: Record<number, string> = { 1: "house", 3: "condo", 4: "townhouse", 5: "apartment building", 6: "single-family / small multi-unit" };

/** Keep homes whose bed/price RANGE overlaps the criteria (multi-unit buildings get narrowed via floorPlans). */
export function parseRedfinSearch(json: any, cfg: TrackerConfig): RawListing[] {
  if (!json || !Array.isArray(json.homes)) throw new Error("redfin: unexpected search payload (no homes[])");
  const { minBeds, maxBeds, maxPrice } = cfg.criteria;
  const out: RawListing[] = [];
  for (const h of json.homes) {
    const hd = h.homeData ?? {}, rx = h.rentalExtension ?? {};
    const c = hd.addressInfo?.centroid?.centroid;
    if (!c || !rx.rentalId) continue;
    const bMin = rx.bedRange?.min ?? null, bMax = rx.bedRange?.max ?? bMin;
    const pMin = rx.rentPriceRange?.min, pMax = rx.rentPriceRange?.max ?? pMin;
    if (typeof pMin !== "number" || pMin > maxPrice) continue;
    if (bMax !== null && (bMax < minBeds || (bMin ?? 0) > maxBeds)) continue;
    const addr = hd.addressInfo ?? {};
    const street = [addr.formattedStreetLine, addr.unitNumber ? `#${addr.unitNumber}` : ""].filter(Boolean).join(" ");
    out.push({
      id: `redfin:${rx.rentalId}`,
      source: "redfin",
      url: `https://www.redfin.com${hd.url ?? ""}`,
      title: rx.propertyName || street || "Redfin rental",
      price: pMin,
      beds: bMin,
      bedsMax: bMax,
      baths: rx.bathRange?.min ?? null,
      sqft: rx.sqftRange?.min ?? null,
      lat: c.latitude,
      lon: c.longitude,
      address: [street, addr.city, addr.zip].filter(Boolean).join(", "),
      postedAt: rx.freshnessTimestamp ?? rx.lastUpdated,
      text: `${rx.description ?? ""}\n[redfin property type] ${REDFIN_TYPE[hd.propertyType] ?? "unknown"}`,
      meta: { rentalId: rx.rentalId, multi: (bMin !== bMax || pMin !== pMax) ? 1 : 0, units: rx.numAvailableUnits ?? 1 },
    });
  }
  return out;
}

export function parseRedfinAmenities(json: any): { structured: Partial<Features>; text: string } {
  const all: string[] = [
    ...(json?.unitAmenities ?? []), ...(json?.communityAmenities ?? []),
    ...(json?.standardizedAmenities ?? []), ...(json?.otherAmenities ?? []),
  ];
  const has = (re: RegExp) => all.some((a) => re.test(a));
  const s: Partial<Features> = {};
  if (has(/^dishwasher$/i)) s.dishwasher = "yes";
  if (has(/W\/DInUnit|Washer&DryerInUnit/i)) s.laundry = "in_unit";
  else if (has(/LaundryFacility|Laundry ?Facilit/i)) s.laundry = "on_site";
  if (has(/^A\/C$|AirConditioning/i)) s.ac = "yes";
  if (has(/PrivateYard/i)) s.yard = "private";
  return { structured: s, text: all.length ? `[redfin amenities] ${[...new Set(all)].join(", ")}` : "" };
}

/** Narrow a multi-unit building to its cheapest 1–2BR unit type within budget. */
export function pickRedfinFloorPlan(json: any, cfg: TrackerConfig): { price: number; beds: number; baths: number | null; label: string } | null {
  const { minBeds, maxBeds, maxPrice } = cfg.criteria;
  const types = (json?.unitTypesByBedroom ?? []).flatMap((g: any) => g.availableUnitTypes ?? []);
  const ok = types
    .filter((t: any) => t.bedrooms >= minBeds && t.bedrooms <= maxBeds && typeof t.rentPriceMin === "number" && t.rentPriceMin > 0 && t.rentPriceMin <= maxPrice)
    .sort((a: any, b: any) => b.bedrooms - a.bedrooms || a.rentPriceMin - b.rentPriceMin);
  if (!ok.length) return null;
  // Prefer the biggest unit that fits the budget, then the cheapest of those.
  const t = ok[0];
  return { price: t.rentPriceMin, beds: t.bedrooms, baths: t.fullBaths != null ? t.fullBaths + (t.halfBaths ?? 0) * 0.5 : null, label: t.name ?? t.style ?? "" };
}

export async function searchRedfin(cfg: TrackerConfig, fetcher: Fetcher = defaultFetcher): Promise<RawListing[]> {
  const { status, text } = await fetcher(redfinSearchUrl(cfg));
  if (status !== 200) throw new Error(`redfin search HTTP ${status}`);
  return parseRedfinSearch(parseJsonLoose(text), cfg);
}

export interface RedfinDetail {
  structured: Partial<Features>;
  text: string;
  /** null = multi-unit building with no unit type fitting the criteria. */
  plan?: { price: number; beds: number; baths: number | null; label: string } | null;
}

export async function enrichRedfin(l: RawListing, cfg: TrackerConfig, fetcher: Fetcher = defaultFetcher, delayMs = 0): Promise<RedfinDetail> {
  const id = String(l.meta?.rentalId ?? l.id.replace(/^redfin:/, ""));
  const am = await fetcher(`https://www.redfin.com/stingray/api/v1/rentals/${id}/amenities`);
  if (am.status !== 200) throw new Error(`redfin amenities HTTP ${am.status}`);
  const { structured, text } = parseRedfinAmenities(parseJsonLoose(am.text));
  const out: RedfinDetail = { structured, text };
  if (l.meta?.multi) {
    if (delayMs) await sleep(delayMs);
    const fp = await fetcher(`https://www.redfin.com/stingray/api/v1/rentals/${id}/floorPlans`);
    if (fp.status === 200) out.plan = pickRedfinFloorPlan(parseJsonLoose(fp.text), cfg);
  }
  return out;
}

export { sleep };
