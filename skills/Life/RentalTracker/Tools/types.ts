/**
 * types.ts — shared shapes for the RentalTracker (config, raw listings,
 * extracted features, persisted state).
 *
 * @module RentalTracker/types
 */

export type LatLon = [number, number];

export interface TrackerConfig {
  name: string;
  criteria: {
    minBeds: number;
    maxBeds: number;
    maxPrice: number;
    idealPriceMin: number;
    idealPriceMax: number;
    dishwasherRequired: boolean;
  };
  geo: {
    coast: LatLon[];
    newport: LatLon[];
    voltaire: LatLon[];
    maxBeachMi: number;
    minLat: number;
    maxLat: number;
  };
  scoring: Record<string, number>;
  alerts: { minScore: number; maxPerMessage: number };
  expiry: { missedScans: number; maxAgeDays: Record<string, number>; keepExpiredDays: number };
  sources: {
    craigslist: { enabled: boolean; postal: string; searchDistanceMi: number; maxDetailFetchesPerRun: number; detailDelayMs: number };
    redfin: { enabled: boolean; regionId: number; regionType: number; market: string; maxDetailFetchesPerRun: number; detailDelayMs: number };
  };
  extraction: { batchSize: number; concurrency: number; maxListingsPerRun: number; timeoutMs: number };
}

export type SourceName = "craigslist" | "redfin";

/** One search hit, before detail enrichment. */
export interface RawListing {
  id: string;            // "<source>:<native id>"
  source: SourceName;
  url: string;
  title: string;
  price: number;         // lowest eligible monthly rent
  beds: number | null;   // lowest eligible bed count
  bedsMax?: number | null;
  baths?: number | null;
  sqft?: number | null;
  lat: number;
  lon: number;
  address?: string;
  postedAt?: string;     // ISO
  photo?: string;
  /** Free text the extractor reads (description + attributes + amenities). */
  text?: string;
  /** Source-structured facts that override the extractor when present. */
  structured?: Partial<Features>;
  /** Native ids needed for detail fetches. */
  meta?: Record<string, string | number>;
}

export type YesNoUnknown = "yes" | "no" | "unknown";
export type Laundry = "in_unit" | "on_site" | "none" | "unknown";
export type PropertyKind = "house" | "duplex_cottage" | "condo_townhome" | "apartment" | "unknown";
export type Yard = "private" | "shared" | "none" | "unknown";
export type Kitchen = "large" | "average" | "small" | "unknown";
export type ScamRisk = "low" | "medium" | "high";

export interface Features {
  dishwasher: YesNoUnknown;
  laundry: Laundry;
  ac: YesNoUnknown;
  propertyKind: PropertyKind;
  yard: Yard;
  kitchen: Kitchen;
  scamRisk: ScamRisk;
  summary: string;
  highlights: string[];
  concerns: string[];
  /** Which extractor produced these: llm | keywords. */
  extractor: "llm" | "keywords";
}

export interface ScoreBreakdown {
  total: number;
  eligible: boolean;
  ineligibleReasons: string[];
  parts: Record<string, number>;
  beachMi: number;
  newportMi: number;
  voltaireMi: number;
  walkMi: number;
}

export type Decision = "new" | "shortlist" | "contacted" | "toured" | "rejected";

export interface StoredListing extends RawListing {
  firstSeenAt: string;
  lastSeenAt: string;
  missedScans: number;
  status: "active" | "expired";
  expiredAt?: string;
  expiredReason?: string;
  priceHistory: { at: string; price: number }[];
  detailFetchedAt?: string;
  contentHash?: string;
  features?: Features;
  score?: ScoreBreakdown;
  alertedAt?: string;
  decision: Decision;
  decidedAt?: string;
  note?: string;
}

export interface RunSummary {
  at: string;
  ok: boolean;
  sources: Record<string, { ok: boolean; hits: number; inArea: number; error?: string }>;
  newListings: number;
  expired: number;
  extracted: number;
  extractionFallbacks: number;
  alerted: string[];
  alertResult?: string;
  durationMs: number;
}

export interface TrackerState {
  version: 1;
  listings: Record<string, StoredListing>;
  runs: RunSummary[];
}
