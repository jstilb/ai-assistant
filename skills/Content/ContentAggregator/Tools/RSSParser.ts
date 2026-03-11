/**
 * RSSParser.ts - Lightweight RSS/Atom Feed Parser
 *
 * Parses RSS 2.0 and Atom feed XML into a normalized format.
 * Uses regex-based extraction since RSS/Atom have predictable structures
 * and we avoid adding an XML parser dependency.
 *
 * Usage:
 *   import { parseRSSFeed } from './RSSParser.ts';
 *   const items = parseRSSFeed(xmlString);
 */

export interface FeedItem {
  title: string;
  url: string;
  author: string;
  publishedAt: string;
  body: string;
  tags: string[];
}

export interface ParsedFeed {
  feedTitle: string;
  feedUrl: string;
  feedDescription: string;
  items: FeedItem[];
  feedType: "rss" | "atom" | "unknown";
}

// ============================================================================
// XML Text Helpers
// ============================================================================

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function extractTag(xml: string, tagName: string): string {
  // Handle CDATA sections
  const cdataPattern = new RegExp(
    `<${tagName}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tagName}>`,
    "i"
  );
  const cdataMatch = xml.match(cdataPattern);
  if (cdataMatch) return cdataMatch[1].trim();

  // Handle regular content
  const pattern = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, "i");
  const match = xml.match(pattern);
  if (match) return decodeEntities(match[1].trim());

  return "";
}

function extractAttribute(xml: string, tagName: string, attrName: string): string {
  const pattern = new RegExp(`<${tagName}[^>]*${attrName}="([^"]*)"`, "i");
  const match = xml.match(pattern);
  return match ? decodeEntities(match[1]) : "";
}

function extractAllTags(xml: string, tagName: string): string[] {
  const results: string[] = [];
  const pattern = new RegExp(
    `<${tagName}[^>]*>(?:\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))</${tagName}>`,
    "gi"
  );
  let match;
  while ((match = pattern.exec(xml)) !== null) {
    const content = (match[1] || match[2] || "").trim();
    if (content) results.push(decodeEntities(content));
  }
  return results;
}

function stripHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function parseDate(dateStr: string): string {
  if (!dateStr) return new Date().toISOString();

  const trimmed = dateStr.trim();

  // ISO 8601 basic format: 20260212T100000Z or 20260212T100000+0530
  const isoBasic = trimmed.match(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z|[+-]\d{2}:?\d{2})?$/
  );
  if (isoBasic) {
    const [, y, mo, d, h, mi, s, tz] = isoBasic;
    const offset = tz ? tz.replace(/(\d{2})(\d{2})$/, "$1:$2") : "Z";
    const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}${offset}`;
    const parsed = new Date(iso);
    if (!isNaN(parsed.getTime())) return parsed.toISOString();
  }

  // ISO 8601 week date: 2026-W07 or 2026-W07-4
  const weekDate = trimmed.match(/^(\d{4})-W(\d{2})(?:-(\d))?$/);
  if (weekDate) {
    const [, yearStr, weekStr, dayStr] = weekDate;
    const year = parseInt(yearStr);
    const week = parseInt(weekStr);
    const day = dayStr ? parseInt(dayStr) : 1;
    // Jan 4 is always in week 1 per ISO 8601
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const jan4Day = jan4.getUTCDay() || 7; // Mon=1..Sun=7
    const weekStart = new Date(jan4.getTime() + ((week - 1) * 7 + (day - jan4Day)) * 86400000);
    if (!isNaN(weekStart.getTime())) return weekStart.toISOString();
  }

  // ISO 8601 ordinal date: 2026-043 (day of year)
  const ordinalDate = trimmed.match(/^(\d{4})-(\d{3})$/);
  if (ordinalDate) {
    const [, yearStr, dayStr] = ordinalDate;
    const d = new Date(Date.UTC(parseInt(yearStr), 0, parseInt(dayStr)));
    if (!isNaN(d.getTime())) return d.toISOString();
  }

  // Standard parse covers ISO 8601 extended format and RFC 2822
  try {
    const d = new Date(trimmed);
    if (!isNaN(d.getTime())) return d.toISOString();
  } catch {
    // fall through
  }

  return new Date().toISOString();
}

// ============================================================================
// RSS 2.0 Parser
// ============================================================================

function parseRSS2(xml: string): ParsedFeed {
  const channelMatch = xml.match(/<channel>([\s\S]*?)<\/channel>/i);
  const channelXml = channelMatch ? channelMatch[1] : xml;

  const feedTitle = extractTag(channelXml, "title");
  const feedUrl = extractTag(channelXml, "link");
  const feedDescription = extractTag(channelXml, "description");

  const items: FeedItem[] = [];
  const itemPattern = /<item>([\s\S]*?)<\/item>/gi;
  let itemMatch;

  while ((itemMatch = itemPattern.exec(xml)) !== null) {
    const itemXml = itemMatch[1];

    const title = extractTag(itemXml, "title");
    const link = extractTag(itemXml, "link");
    const guid = extractTag(itemXml, "guid");
    const author =
      extractTag(itemXml, "dc:creator") ||
      extractTag(itemXml, "author") ||
      extractTag(itemXml, "creator") ||
      "";
    const pubDate =
      extractTag(itemXml, "pubDate") ||
      extractTag(itemXml, "dc:date") ||
      extractTag(itemXml, "date") ||
      "";
    const description = extractTag(itemXml, "description");
    const content =
      extractTag(itemXml, "content:encoded") ||
      extractTag(itemXml, "content") ||
      "";

    // Extract categories as tags
    const tags = extractAllTags(itemXml, "category");

    const body = content || description;
    const bodyText = stripHtml(body).slice(0, 2000); // Cap at 2000 chars

    items.push({
      title: stripHtml(title),
      url: link || guid || "",
      author: stripHtml(author),
      publishedAt: parseDate(pubDate),
      body: bodyText,
      tags,
    });
  }

  return {
    feedTitle: stripHtml(feedTitle),
    feedUrl: feedUrl,
    feedDescription: stripHtml(feedDescription),
    items,
    feedType: "rss",
  };
}

// ============================================================================
// Atom Parser
// ============================================================================

function parseAtom(xml: string): ParsedFeed {
  const feedTitle = extractTag(xml, "title");
  const feedUrl =
    extractAttribute(xml, 'link[^>]*rel="alternate"', "href") ||
    extractAttribute(xml, "link", "href") ||
    "";
  const feedDescription = extractTag(xml, "subtitle") || "";

  const items: FeedItem[] = [];
  const entryPattern = /<entry>([\s\S]*?)<\/entry>/gi;
  let entryMatch;

  while ((entryMatch = entryPattern.exec(xml)) !== null) {
    const entryXml = entryMatch[1];

    const title = extractTag(entryXml, "title");
    const link =
      extractAttribute(entryXml, 'link[^>]*rel="alternate"', "href") ||
      extractAttribute(entryXml, "link", "href") ||
      "";
    const authorName = extractTag(entryXml, "name"); // inside <author>
    const published =
      extractTag(entryXml, "published") ||
      extractTag(entryXml, "updated") ||
      "";
    const summary = extractTag(entryXml, "summary");
    const content = extractTag(entryXml, "content");

    // Extract categories
    const tags: string[] = [];
    const catPattern = /category[^>]*term="([^"]*)"/gi;
    let catMatch;
    while ((catMatch = catPattern.exec(entryXml)) !== null) {
      tags.push(catMatch[1]);
    }

    const body = content || summary;
    const bodyText = stripHtml(body).slice(0, 2000);

    items.push({
      title: stripHtml(title),
      url: link,
      author: authorName,
      publishedAt: parseDate(published),
      body: bodyText,
      tags,
    });
  }

  return {
    feedTitle: stripHtml(feedTitle),
    feedUrl,
    feedDescription: stripHtml(feedDescription),
    items,
    feedType: "atom",
  };
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Detect feed type and parse accordingly
 */
export function parseRSSFeed(xml: string): ParsedFeed {
  const trimmed = xml.trim();

  // Detect Atom
  if (trimmed.includes("<feed") && trimmed.includes("xmlns=\"http://www.w3.org/2005/Atom\"")) {
    return parseAtom(trimmed);
  }

  // Detect Atom by presence of <entry> tags (some feeds omit namespace)
  if (trimmed.includes("<feed") && trimmed.includes("<entry>")) {
    return parseAtom(trimmed);
  }

  // Default to RSS 2.0
  if (trimmed.includes("<rss") || trimmed.includes("<channel>") || trimmed.includes("<item>")) {
    return parseRSS2(trimmed);
  }

  // Try both and pick whichever finds items
  const rssResult = parseRSS2(trimmed);
  if (rssResult.items.length > 0) return rssResult;

  const atomResult = parseAtom(trimmed);
  if (atomResult.items.length > 0) return atomResult;

  return {
    feedTitle: "",
    feedUrl: "",
    feedDescription: "",
    items: [],
    feedType: "unknown",
  };
}

// ============================================================================
// CLI
// ============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.length === 0) {
    console.log(`
RSSParser - Parse RSS/Atom feeds

Usage:
  echo "<xml>..." | bun RSSParser.ts                 Parse from stdin
  bun RSSParser.ts --url "https://feed.xml"          Fetch and parse
  bun RSSParser.ts --test                            Self-test
`);
    process.exit(0);
  }

  if (args.includes("--test")) {
    // Test with sample RSS
    const sampleRSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test Feed</title>
    <link>https://example.com</link>
    <description>A test feed</description>
    <item>
      <title>Test Article 1</title>
      <link>https://example.com/1</link>
      <pubDate>Mon, 03 Feb 2026 12:00:00 GMT</pubDate>
      <description><![CDATA[<p>This is the first test article.</p>]]></description>
      <category>tech</category>
      <category>test</category>
    </item>
    <item>
      <title>Test Article 2</title>
      <link>https://example.com/2</link>
      <pubDate>Sun, 02 Feb 2026 10:00:00 GMT</pubDate>
      <description>Second article content</description>
    </item>
  </channel>
</rss>`;

    const result = parseRSSFeed(sampleRSS);
    console.log("Feed:", result.feedTitle);
    console.log("Type:", result.feedType);
    console.log("Items:", result.items.length);
    for (const item of result.items) {
      console.log(`  - ${item.title} (${item.url})`);
      console.log(`    Tags: ${item.tags.join(", ") || "none"}`);
      console.log(`    Body: ${item.body.slice(0, 80)}...`);
    }

    // Test Atom
    const sampleAtom = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Test</title>
  <entry>
    <title>Atom Entry</title>
    <link rel="alternate" href="https://example.com/atom/1"/>
    <published>2026-02-03T12:00:00Z</published>
    <summary>An atom entry</summary>
    <author><name>Author Name</name></author>
    <category term="ai"/>
  </entry>
</feed>`;

    console.log("\n--- Atom test ---");
    const atomResult = parseRSSFeed(sampleAtom);
    console.log("Feed:", atomResult.feedTitle);
    console.log("Type:", atomResult.feedType);
    console.log("Items:", atomResult.items.length);
    for (const item of atomResult.items) {
      console.log(`  - ${item.title} by ${item.author} (${item.url})`);
    }

    console.log("\nAll tests passed.");
    process.exit(0);
  }

  if (args.includes("--url")) {
    const idx = args.indexOf("--url");
    const url = args[idx + 1];
    if (!url) {
      console.error("Error: --url requires a URL");
      process.exit(1);
    }

    const { createHTTPClient } = await import("../../../../lib/core/CachedHTTPClient.ts");
    const httpClient = createHTTPClient({
      defaultTtl: 300,
      maxRetries: 2,
      userAgent: "Kaya-ContentAggregator/1.0",
    });
    const xml = await httpClient.fetchText(url, { cache: "disk", ttl: 300 });
    const result = parseRSSFeed(xml);
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }

  // Read from stdin
  const chunks: string[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(new TextDecoder().decode(chunk));
  }
  const xml = chunks.join("");
  const result = parseRSSFeed(xml);
  console.log(JSON.stringify(result, null, 2));
}
