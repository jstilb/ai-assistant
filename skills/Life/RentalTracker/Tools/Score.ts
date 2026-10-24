/**
 * Score.ts — rank a listing 0–100 against Jm's stated criteria.
 *
 * The weights are Jm's own priorities from the capture (config `scoring`),
 * applied transparently: every part is shown on the board so a score can be
 * argued with. Hard requirements (beds, budget, dishwasher-not-absent,
 * in-area) gate `eligible`; an UNKNOWN dishwasher stays eligible but takes a
 * penalty and can never alert.
 *
 * @module RentalTracker/Score
 */
import { inArea, proximity } from "./Geo.ts";
import type { Features, RawListing, ScoreBreakdown, TrackerConfig } from "./types.ts";

/** Linear ramp: full points at <= full, zero at >= zero. */
export function ramp(x: number, full: number, zero: number, pts: number): number {
  if (x <= full) return pts;
  if (x >= zero) return 0;
  return pts * (1 - (x - full) / (zero - full));
}

export function priceScore(price: number, c: TrackerConfig["criteria"], pts: number): number {
  if (price <= c.idealPriceMax) return pts; // at or under the ideal band is full marks
  if (price > c.maxPrice) return 0;
  // ideal max → max price falls from 100% to 30%
  return pts * (1 - 0.7 * ((price - c.idealPriceMax) / (c.maxPrice - c.idealPriceMax)));
}

export function scoreListing(l: RawListing, f: Features, cfg: TrackerConfig): ScoreBreakdown {
  const w = cfg.scoring;
  const c = cfg.criteria;
  const prox = proximity(l.lat, l.lon, cfg.geo);
  const parts: Record<string, number> = {};

  parts.price = priceScore(l.price, c, w.price);
  parts.beach = ramp(prox.beachMi, w.beachFullMi, w.beachZeroMi, w.beach);
  parts.walk = ramp(prox.walkMi, w.walkFullMi, w.walkZeroMi, w.walk);
  parts.laundry = f.laundry === "in_unit" ? w.laundryInUnit : f.laundry === "on_site" ? w.laundryOnSite : f.laundry === "unknown" ? w.laundryUnknown : 0;

  const isHouse = f.propertyKind === "house" || f.propertyKind === "duplex_cottage";
  parts.houseYard = isHouse && f.yard === "private" ? w.houseWithYard
    : f.yard === "private" ? w.privateYardOnly
      : isHouse ? w.houseNoYard
        : f.yard === "shared" ? w.sharedYard : 0;

  parts.kitchen = f.kitchen === "large" ? w.kitchenLarge : f.kitchen === "average" ? w.kitchenAverage : f.kitchen === "unknown" ? w.kitchenUnknown : 0;
  parts.ac = f.ac === "yes" ? w.ac : 0;
  if (f.dishwasher === "unknown") parts.dishwasher = -w.dishwasherUnknownPenalty;
  if (f.scamRisk === "medium") parts.scam = -w.scamPenaltyMedium;
  if (f.scamRisk === "high") parts.scam = -w.scamPenaltyHigh;

  const reasons: string[] = [];
  if (l.price > c.maxPrice) reasons.push(`over budget ($${l.price})`);
  if (l.beds !== null && ((l.bedsMax ?? l.beds) < c.minBeds || l.beds > c.maxBeds)) reasons.push(`${l.beds} BR`);
  if (c.dishwasherRequired && f.dishwasher === "no") reasons.push("no dishwasher");
  if (!inArea(l.lat, l.lon, cfg.geo)) reasons.push("outside Ocean Beach");

  for (const k of Object.keys(parts)) parts[k] = Math.round(parts[k] * 10) / 10;
  const total = Math.max(0, Math.min(100, Math.round(Object.values(parts).reduce((a, b) => a + b, 0))));
  return {
    total,
    eligible: reasons.length === 0,
    ineligibleReasons: reasons,
    parts,
    beachMi: round2(prox.beachMi),
    newportMi: round2(prox.newportMi),
    voltaireMi: round2(prox.voltaireMi),
    walkMi: round2(prox.walkMi),
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** An alert-worthy listing: eligible, high score, dishwasher CONFIRMED, not a likely scam. */
export function isExceptional(score: ScoreBreakdown, f: Features, cfg: TrackerConfig): boolean {
  return score.eligible && score.total >= cfg.alerts.minScore && f.dishwasher === "yes" && f.scamRisk === "low";
}
