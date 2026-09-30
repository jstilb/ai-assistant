/**
 * edmtrain.test.ts — EdmtrainAdapter pure-mapper tests (no network, no key).
 *
 * Run: bun test ~/.claude/skills/Productivity/EventScout/tests/edmtrain.test.ts
 */

import { describe, test, expect } from "bun:test";
import {
  mapEdmtrainEventToItem,
  edmtrainTimeToLaIso,
  type EdmtrainEvent,
} from "../Tools/adapters/EdmtrainAdapter.ts";

const FETCHED_AT = "2026-08-20T12:00:00.000Z";

function baseEvent(overrides: Partial<EdmtrainEvent> = {}): EdmtrainEvent {
  return {
    id: 1,
    link: "https://edmtrain.com/e/1",
    name: null,
    ages: "21+",
    festivalInd: false,
    date: "2026-08-21",
    startTime: "22:00:00",
    endTime: null,
    venue: {
      name: "Spin Nightclub",
      location: "San Diego, CA",
      address: "2028 Hancock St, San Diego, CA",
      latitude: 32.7386,
      longitude: -117.2034,
    },
    artistList: [{ name: "Nitefreak" }, { name: "Local Support" }],
    ...overrides,
  };
}

describe("edmtrainTimeToLaIso", () => {
  test("date + HH:MM:SS → LA-offset ISO", () => {
    expect(edmtrainTimeToLaIso("2026-08-21", "22:00:00")).toBe("2026-08-21T22:00:00-07:00");
  });
  test("null / malformed time → null", () => {
    expect(edmtrainTimeToLaIso("2026-08-21", null)).toBeNull();
    expect(edmtrainTimeToLaIso("2026-08-21", "late")).toBeNull();
  });
});

describe("mapEdmtrainEventToItem", () => {
  test("null name falls back to the artist lineup as title", () => {
    const item = mapEdmtrainEventToItem(baseEvent(), FETCHED_AT)!;
    expect(item.title).toBe("Nitefreak, Local Support");
    expect(item.performersOrTeams).toBe("Nitefreak, Local Support");
    expect(item.startDatetime).toBe("2026-08-21T22:00:00-07:00");
    expect(item.allDay).toBe(false);
    expect(item.venue).toBe("Spin Nightclub");
    expect(item.category).toBe("music");
    expect(item.tags).toContain("21+");
  });

  test("venue lat/lng pass through so the geocoder is skipped", () => {
    const item = mapEdmtrainEventToItem(baseEvent(), FETCHED_AT)!;
    expect(item.lat).toBe(32.7386);
    expect(item.lng).toBe(-117.2034);
  });

  test("no price data → isFree false with no price (unknown ≠ free)", () => {
    const item = mapEdmtrainEventToItem(baseEvent(), FETCHED_AT)!;
    expect(item.isFree).toBe(false);
    expect(item.priceMin).toBeUndefined();
  });

  test("festivalInd → festival category + tag", () => {
    const item = mapEdmtrainEventToItem(
      baseEvent({ name: "CRSSD Festival", festivalInd: true }),
      FETCHED_AT
    )!;
    expect(item.category).toBe("festival");
    expect(item.tags).toContain("festival");
    expect(item.title).toBe("CRSSD Festival");
  });

  test("missing startTime → all-day at LA midnight", () => {
    const item = mapEdmtrainEventToItem(baseEvent({ startTime: null }), FETCHED_AT)!;
    expect(item.allDay).toBe(true);
    expect(item.startDatetime).toBe("2026-08-21T00:00:00-07:00");
  });

  test("no name AND no artists → null", () => {
    expect(mapEdmtrainEventToItem(baseEvent({ artistList: [] }), FETCHED_AT)).toBeNull();
  });

  test("malformed date → null", () => {
    expect(mapEdmtrainEventToItem(baseEvent({ date: "soon" }), FETCHED_AT)).toBeNull();
  });
});
