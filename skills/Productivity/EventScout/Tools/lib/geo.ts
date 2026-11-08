/**
 * geo.ts — great-circle distance for EventScout.
 *
 * Shared by Filter.ts (radius filter) and Ranker.ts (distance signal and
 * nearer-wins tiebreak), which used to carry three copies between them.
 */

const EARTH_RADIUS_MILES = 3958.8;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Haversine great-circle distance in miles between two lat/lng points. */
export function haversineMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_MILES * 2 * Math.asin(Math.sqrt(a));
}
