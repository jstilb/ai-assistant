/**
 * YouTubeIngestHtml.test.ts — verifies HTML watch-history parsing.
 * Takeout occasionally delivers watch-history.html (not .json), depending on
 * the format radio in the export wizard. This fixture mirrors the real shape
 * including non-breaking spaces, HTML entities, and "Viewed" entries on
 * /post/ (which must be excluded).
 */

import { expect, test } from "bun:test";
import { parseWatchHistoryHtml, parseTakeoutHtmlTimestamp } from "../Tools/YouTubeIngest.ts";

// Real Takeout HTML uses U+00A0 (non-breaking space) between the verb and
// the link tag. Build the fixture with that exact byte.
const NBSP = " ";

const FIXTURE = `
<html><head><title>x</title></head><body>
<div class="outer-cell"><div class="mdl-grid"><div class="header-cell"><p class="mdl-typography--title">YouTube<br></p></div>
<div class="content-cell mdl-cell--6-col mdl-typography--body-1">Watched${NBSP}<a href="https://www.youtube.com/watch?v=dQw4w9WgXcQ">Rick Astley - Never Gonna Give You Up</a><br>
<a href="https://www.youtube.com/channel/UCuAXFkgsw1L7xaCfnd5JJOw">Rick Astley</a><br>
May 14, 2026, 5:43:27 PM CDT<br></div></div></div>

<div class="outer-cell"><div class="mdl-grid"><div class="content-cell mdl-cell--6-col mdl-typography--body-1">Watched${NBSP}<a href="https://www.youtube.com/watch?v=abc123XYZ-_">Title with &quot;quotes&quot; &amp; ampersand</a><br>
<a href="https://www.youtube.com/channel/UC_test">Channel &#39;s Name</a><br>
Apr 1, 2024, 11:00:00 AM PDT<br></div></div></div>

<!-- Community post — must be excluded -->
<div class="outer-cell"><div class="mdl-grid"><div class="content-cell mdl-cell--6-col mdl-typography--body-1">Viewed${NBSP}<a href="https://www.youtube.com/post/UgkxScwNqACnnDxwZ3_VM9xFROgkV29P1dWa">A community post</a><br>
<a href="https://www.youtube.com/channel/UCqnbDFdCpuN8CMEg0VuEBqA">NYT</a><br>
May 14, 2026, 7:08:25 PM CDT<br></div></div></div>

<!-- Entry without a channel link (rare; older Takeouts) -->
<div class="outer-cell"><div class="mdl-grid"><div class="content-cell mdl-cell--6-col mdl-typography--body-1">Watched${NBSP}<a href="https://www.youtube.com/watch?v=no_channel">No-channel entry</a><br>
Jan 1, 2023, 12:00:00 AM PST<br></div></div></div>

</body></html>
`;

test("parseWatchHistoryHtml: extracts video_id, title, channel, channelUrl, ts from Watched entries", () => {
  const rows = parseWatchHistoryHtml(FIXTURE);
  expect(rows.length).toBe(3);

  const a = rows[0];
  expect(a.videoId).toBe("dQw4w9WgXcQ");
  expect(a.title).toBe("Rick Astley - Never Gonna Give You Up");
  expect(a.channel).toBe("Rick Astley");
  expect(a.channelUrl).toBe("https://www.youtube.com/channel/UCuAXFkgsw1L7xaCfnd5JJOw");
  // May 14, 2026, 5:43:27 PM CDT = 22:43:27 UTC
  expect(a.ts.toISOString()).toBe("2026-05-14T22:43:27.000Z");

  const b = rows[1];
  expect(b.videoId).toBe("abc123XYZ-_");
  expect(b.title).toBe('Title with "quotes" & ampersand');
  expect(b.channel).toBe("Channel 's Name");
  // Apr 1, 2024, 11:00:00 AM PDT = 18:00:00 UTC
  expect(b.ts.toISOString()).toBe("2024-04-01T18:00:00.000Z");

  const c = rows[2];
  expect(c.videoId).toBe("no_channel");
  expect(c.channel).toBeNull();
  expect(c.channelUrl).toBeNull();
});

test("parseWatchHistoryHtml: consumes 'Watched at HH:MM PM<br>' markers in older Google-Ads-style entries", () => {
  // Real-world shape we missed before: ~27% of entries in Jm's full history
  // exported this way. Multiple replay timestamps but ONE canonical date line.
  // Real Takeout puts NBSP between "Watched" and "<a", but a regular space
  // between "Watched" and "at" in the inner replay markers. Mixed separators
  // are a documented Takeout quirk.
  const ADS = `
<div class="outer-cell"><div class="mdl-grid"><div class="content-cell mdl-cell--6-col mdl-typography--body-1">Watched${NBSP}<a href="https://www.youtube.com/watch?v=cAYPFqc47yI">https://www.youtube.com/watch?v=cAYPFqc47yI</a><br>
Watched at 5:33 PM<br>
Watched at 4:05 PM<br>
Watched at 2:55 PM<br>
Jul 9, 2023, 5:33:48 PM CDT<br></div></div></div>
`;
  const rows = parseWatchHistoryHtml(ADS);
  expect(rows.length).toBe(1);
  expect(rows[0].videoId).toBe("cAYPFqc47yI");
  expect(rows[0].channel).toBeNull();
  expect(rows[0].channelUrl).toBeNull();
  // Jul 9, 2023, 5:33:48 PM CDT → 22:33:48 UTC
  expect(rows[0].ts.toISOString()).toBe("2023-07-09T22:33:48.000Z");
});

test("parseWatchHistoryHtml: skips Viewed (post) entries", () => {
  const rows = parseWatchHistoryHtml(FIXTURE);
  for (const r of rows) {
    expect(r.videoId.length).toBeGreaterThan(0);
    expect(r.videoId.startsWith("Ugkx")).toBe(false); // no post IDs
  }
});

test("parseTakeoutHtmlTimestamp: PDT", () => {
  const d = parseTakeoutHtmlTimestamp("May 14, 2026, 12:00:00 PM PDT");
  expect(d?.toISOString()).toBe("2026-05-14T19:00:00.000Z");
});

test("parseTakeoutHtmlTimestamp: PST (winter)", () => {
  const d = parseTakeoutHtmlTimestamp("Dec 21, 2025, 8:00:00 AM PST");
  expect(d?.toISOString()).toBe("2025-12-21T16:00:00.000Z");
});

test("parseTakeoutHtmlTimestamp: CDT", () => {
  const d = parseTakeoutHtmlTimestamp("Jul 4, 2025, 6:30:15 PM CDT");
  expect(d?.toISOString()).toBe("2025-07-04T23:30:15.000Z");
});

test("parseTakeoutHtmlTimestamp: UTC", () => {
  const d = parseTakeoutHtmlTimestamp("Jan 1, 2024, 0:00:00 AM UTC");
  expect(d?.toISOString()).toBe("2024-01-01T00:00:00.000Z");
});

test("parseTakeoutHtmlTimestamp: 12 AM = midnight", () => {
  const d = parseTakeoutHtmlTimestamp("Jan 1, 2024, 12:00:00 AM PST");
  expect(d?.toISOString()).toBe("2024-01-01T08:00:00.000Z");
});

test("parseTakeoutHtmlTimestamp: 12 PM = noon", () => {
  const d = parseTakeoutHtmlTimestamp("Jan 1, 2024, 12:00:00 PM PST");
  expect(d?.toISOString()).toBe("2024-01-01T20:00:00.000Z");
});

test("parseTakeoutHtmlTimestamp: unknown tz returns null", () => {
  expect(parseTakeoutHtmlTimestamp("May 14, 2026, 5:43:27 PM XXX")).toBeNull();
});

test("parseTakeoutHtmlTimestamp: malformed returns null", () => {
  expect(parseTakeoutHtmlTimestamp("not a date")).toBeNull();
});
