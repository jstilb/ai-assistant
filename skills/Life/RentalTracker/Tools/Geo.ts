/**
 * Geo.ts — distance math for "how close to the beach / Newport / Voltaire".
 *
 * Straight-line (haversine) miles to the nearest point on a polyline. Walking
 * time on the board is derived as straight-line × 1.25 detour at 20 min/mi.
 *
 * @module RentalTracker/Geo
 */
import type { LatLon, TrackerConfig } from "./types.ts";

const EARTH_MI = 3958.8;
const rad = (d: number) => (d * Math.PI) / 180;

export function haversineMi(a: LatLon, b: LatLon): number {
  const dLat = rad(b[0] - a[0]);
  const dLon = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_MI * Math.asin(Math.sqrt(h));
}

/** Distance in miles from p to segment ab (local equirectangular projection — fine at neighborhood scale). */
export function pointToSegmentMi(p: LatLon, a: LatLon, b: LatLon): number {
  const kx = Math.cos(rad(p[0]));
  const ax = (a[1] - p[1]) * kx, ay = a[0] - p[0];
  const bx = (b[1] - p[1]) * kx, by = b[0] - p[0];
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : -(ax * dx + ay * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  // convert the projected offset back to a lat/lon and measure exactly
  return haversineMi(p, [p[0] + cy, p[1] + cx / kx]);
}

export function distanceToPolylineMi(p: LatLon, line: LatLon[]): number {
  if (line.length === 1) return haversineMi(p, line[0]);
  let best = Infinity;
  for (let i = 0; i < line.length - 1; i++) best = Math.min(best, pointToSegmentMi(p, line[i], line[i + 1]));
  return best;
}

export interface Proximity {
  beachMi: number;
  newportMi: number;
  voltaireMi: number;
  walkMi: number; // nearer of Newport / Voltaire
}

export function proximity(lat: number, lon: number, geo: TrackerConfig["geo"]): Proximity {
  const p: LatLon = [lat, lon];
  const beachMi = distanceToPolylineMi(p, geo.coast);
  const newportMi = distanceToPolylineMi(p, geo.newport);
  const voltaireMi = distanceToPolylineMi(p, geo.voltaire);
  return { beachMi, newportMi, voltaireMi, walkMi: Math.min(newportMi, voltaireMi) };
}

/** Is this point "Ocean Beach" for our purposes (near the OB coast, not across the channel)? */
export function inArea(lat: number, lon: number, geo: TrackerConfig["geo"]): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (lat < geo.minLat || lat > geo.maxLat) return false;
  return distanceToPolylineMi([lat, lon], geo.coast) <= geo.maxBeachMi;
}

/** Minutes on foot: straight-line × 1.25 detour factor at 3 mph. */
export function walkMinutes(mi: number): number {
  return Math.max(1, Math.round(mi * 1.25 * 20));
}
