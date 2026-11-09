import { expect, test } from "bun:test";
import { dedupeAndMerge } from "../Tools/Dedup.ts";
import type { EventItem } from "../Tools/types.ts";
import { defined } from "../../../../lib/test/defined.ts";

function performance(id: string, start: string, end?: string): EventItem {
  return {
    id, title: "Black Nativity", startDatetime: start, endDatetime: end,
    allDay: false, venue: "Morse High School New Theater", category: "arts",
    tags: [], isFree: false, status: "scheduled",
    sourceUrl: `https://example.com/${id}`,
    sources: [{ sourceId: id, url: `https://example.com/${id}` }],
    fetchedAt: "2025-12-12T07:59:59.999Z",
  };
}

const afternoon = performance("afternoon", "2025-12-13T15:00:00-08:00", "2025-12-13T17:00:00-08:00");
const evening = performance("evening", "2025-12-13T18:00:00-08:00", "2025-12-13T20:00:00-08:00");

for (const rows of [[afternoon, evening], [evening, afternoon]]) {
  test(`disjoint timed performances survive in ${defined(rows[0]).id} order`, () => {
    expect(dedupeAndMerge(rows)).toHaveLength(2);
  });
}

test("touching timed intervals remain separate", () => {
  expect(dedupeAndMerge([afternoon, { ...evening, startDatetime: "2025-12-13T17:00:00-08:00" }])).toHaveLength(2);
});

test("equivalent UTC and offset occurrences merge with source union", () => {
  const twin = { ...afternoon, id: "twin", startDatetime: "2025-12-13T23:00:00Z", endDatetime: "2025-12-14T01:00:00Z", sources: evening.sources };
  const result = dedupeAndMerge([afternoon, twin]);
  expect(result).toHaveLength(1);
  expect(defined(result[0]).sources).toHaveLength(2);
});

test("overlapping timed intervals retain duplicate merge", () => {
  expect(dedupeAndMerge([afternoon, { ...evening, startDatetime: "2025-12-13T16:00:00-08:00" }])).toHaveLength(1);
});

for (const endDatetime of [undefined, "invalid", "2025-12-13T14:00:00-08:00", afternoon.startDatetime]) {
  test(`incomplete or invalid interval retains duplicate rule: ${endDatetime}`, () => {
    expect(dedupeAndMerge([{ ...afternoon, endDatetime }, evening])).toHaveLength(1);
  });
}

for (const rows of [[{ ...afternoon, allDay: true }, evening], [{ ...afternoon, allDay: true }, { ...evening, allDay: true }]]) {
  test(`all-day interval retains duplicate rule: ${defined(rows[1]).allDay}`, () => {
    expect(dedupeAndMerge(rows)).toHaveLength(1);
  });
}

test("four dated performances survive with an exact true duplicate", () => {
  const friday = performance("friday", "2025-12-12T18:00:00-08:00", "2025-12-12T20:00:00-08:00");
  const sunday = performance("sunday", "2025-12-14T15:00:00-08:00", "2025-12-14T17:00:00-08:00");
  expect(dedupeAndMerge([friday, afternoon, evening, sunday, { ...afternoon }])).toHaveLength(4);
});
