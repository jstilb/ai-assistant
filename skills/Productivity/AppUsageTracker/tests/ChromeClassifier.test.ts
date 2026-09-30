/**
 * ChromeClassifier.test.ts — verifies that distinct (domain, source) pairs from
 * chrome_visits get classified into chrome_domain_verdicts via three paths:
 *   1. tier1-domain (reddit etc.) — no LLM
 *   2. utility-allowlist (gmail etc.) — no LLM
 *   3. llm — only when neither short-circuit fires
 *
 * The LLM is dependency-injected so these tests never spawn `claude -p`.
 */

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../Tools/Db.ts";
import {
  classifyChromeDomains,
  type LlmClassifier,
} from "../Tools/ChromeClassifier.ts";

const TMP = mkdtempSync(join(tmpdir(), "aw-chrome-classifier-"));
const DB_PATH = join(TMP, "events.db");

let db: Db;

beforeAll(async () => {
  db = await Db.open(DB_PATH);
  await db.initSchema();
});

afterAll(() => {
  if (db) db.close();
  rmSync(TMP, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.run("DELETE FROM chrome_visits");
  await db.run("DELETE FROM chrome_domain_verdicts");
});

async function insertVisit(row: {
  id: string;
  source: string;
  url: string;
  domain: string | null;
  title: string;
  ts: string;
  durSec: number;
}): Promise<void> {
  await db.run(
    `INSERT OR REPLACE INTO chrome_visits
       (id, source, url, domain, title, visit_time, visit_duration_sec,
        transition, from_visit_id, originator_cache_guid)
     VALUES ($id, $source, $url, $domain, $title, $ts::TIMESTAMP, $dur, 0, 0, '')`,
    {
      id: row.id, source: row.source, url: row.url, domain: row.domain,
      title: row.title, ts: row.ts, dur: row.durSec,
    },
  );
}

/** A stub LLM that returns a fixed verdict tagged with the domain it saw. */
function makeStubLlm(verdicts: Record<string, boolean>): LlmClassifier {
  return async (input) => {
    const isLow = verdicts[input.domain] ?? false;
    return {
      verdict: { is_low_value: isLow, reason: `stub:${input.domain}`, confidence: 0.85 },
      tokensIn: 200,
      tokensOut: 60,
      estCostUSD: 0.001,
    };
  };
}

test("tier-1 domain (reddit.com) classified without LLM", async () => {
  await insertVisit({
    id: "chrome:1", source: "mac",
    url: "https://www.reddit.com/r/all", domain: "reddit.com",
    title: "r/all", ts: "2026-05-10T15:00:00Z", durSec: 60,
  });
  let llmCalls = 0;
  const stub: LlmClassifier = async () => {
    llmCalls++;
    return { verdict: { is_low_value: false, reason: "should not be called", confidence: 0 }, tokensIn: 0, tokensOut: 0, estCostUSD: 0 };
  };

  const summary = await classifyChromeDomains({ db, llm: stub });
  expect(summary.classified_by_tier1).toBe(1);
  expect(summary.classified_by_llm).toBe(0);
  expect(llmCalls).toBe(0);

  const row = await db.queryRow<{ classifier: string; is_low_value: boolean }>(
    `SELECT classifier, is_low_value FROM chrome_domain_verdicts WHERE domain='reddit.com'`,
  );
  expect(row!.classifier).toBe("tier1-domain");
  expect(row!.is_low_value).toBe(true);
});

test("utility-allowlist domain (mail.google.com) classified without LLM", async () => {
  await insertVisit({
    id: "chrome:2", source: "mac",
    url: "https://mail.google.com/mail/u/0/", domain: "mail.google.com",
    title: "Inbox", ts: "2026-05-10T15:00:00Z", durSec: 60,
  });
  let llmCalls = 0;
  const stub: LlmClassifier = async () => { llmCalls++; return {
    verdict: { is_low_value: true, reason: "stub", confidence: 0 }, tokensIn: 0, tokensOut: 0, estCostUSD: 0,
  }; };
  const summary = await classifyChromeDomains({ db, llm: stub });
  expect(summary.classified_by_utility).toBe(1);
  expect(llmCalls).toBe(0);
  const row = await db.queryRow<{ classifier: string; is_low_value: boolean }>(
    `SELECT classifier, is_low_value FROM chrome_domain_verdicts WHERE domain='mail.google.com'`,
  );
  expect(row!.classifier).toBe("utility-allowlist");
  expect(row!.is_low_value).toBe(false);
});

test("unknown domain dispatched to LLM (stub) and stored", async () => {
  await insertVisit({
    id: "chrome:3", source: "mac",
    url: "https://example.weird/page", domain: "example.weird",
    title: "weird example", ts: "2026-05-10T15:00:00Z", durSec: 60,
  });
  const summary = await classifyChromeDomains({
    db,
    llm: makeStubLlm({ "example.weird": true }),
  });
  expect(summary.classified_by_llm).toBe(1);
  expect(summary.tokens_in).toBeGreaterThan(0);
  const row = await db.queryRow<{ classifier: string; is_low_value: boolean; reason: string }>(
    `SELECT classifier, is_low_value, reason FROM chrome_domain_verdicts WHERE domain='example.weird'`,
  );
  expect(row!.classifier).toBe("llm-sonnet");
  expect(row!.is_low_value).toBe(true);
  expect(row!.reason).toContain("example.weird");
});

test("idempotent — re-running skips already-classified domains", async () => {
  await insertVisit({
    id: "chrome:4", source: "mac",
    url: "https://example.weird/page", domain: "example.weird",
    title: "weird", ts: "2026-05-10T15:00:00Z", durSec: 60,
  });
  let llmCalls = 0;
  const stub: LlmClassifier = async (input) => {
    llmCalls++;
    return { verdict: { is_low_value: true, reason: input.domain, confidence: 0.7 }, tokensIn: 50, tokensOut: 20, estCostUSD: 0.0005 };
  };

  await classifyChromeDomains({ db, llm: stub });
  expect(llmCalls).toBe(1);

  const summary2 = await classifyChromeDomains({ db, llm: stub });
  expect(llmCalls).toBe(1); // not called again
  expect(summary2.skipped_already).toBe(1);
  expect(summary2.classified_by_llm).toBe(0);
});

test("force=true re-classifies everything (LLM called again)", async () => {
  await insertVisit({
    id: "chrome:5", source: "mac",
    url: "https://example.weird/page", domain: "example.weird",
    title: "weird", ts: "2026-05-10T15:00:00Z", durSec: 60,
  });
  let llmCalls = 0;
  const stub: LlmClassifier = async () => {
    llmCalls++;
    return { verdict: { is_low_value: false, reason: "x", confidence: 0.5 }, tokensIn: 1, tokensOut: 1, estCostUSD: 0 };
  };

  await classifyChromeDomains({ db, llm: stub });
  await classifyChromeDomains({ db, llm: stub, force: true });
  expect(llmCalls).toBe(2);
});

test("dry-run does not write verdicts", async () => {
  await insertVisit({
    id: "chrome:6", source: "mac",
    url: "https://example.weird/page", domain: "example.weird",
    title: "weird", ts: "2026-05-10T15:00:00Z", durSec: 60,
  });
  let llmCalls = 0;
  const stub: LlmClassifier = async () => { llmCalls++; return {
    verdict: { is_low_value: true, reason: "x", confidence: 0.7 }, tokensIn: 0, tokensOut: 0, estCostUSD: 0,
  }; };

  const summary = await classifyChromeDomains({ db, llm: stub, dryRun: true });
  expect(llmCalls).toBe(0);
  expect(summary.dry_run).toBe(true);
  // Tier-1 / utility match decisions still resolve (they don't cost money)
  // but unknown domains are reported as "would_call_llm".
  expect(summary.would_call_llm).toBe(1);
  const cnt = await db.queryRow<{ n: number | bigint }>(
    `SELECT COUNT(*) AS n FROM chrome_domain_verdicts`,
  );
  expect(Number(cnt!.n)).toBe(0);
});

test("limit caps LLM calls per run", async () => {
  for (let i = 0; i < 5; i++) {
    await insertVisit({
      id: `chrome:limit:${i}`, source: "mac",
      url: `https://weird${i}.example/`, domain: `weird${i}.example`,
      title: `t${i}`, ts: "2026-05-10T15:00:00Z", durSec: 60,
    });
  }
  let llmCalls = 0;
  const stub: LlmClassifier = async () => {
    llmCalls++;
    return { verdict: { is_low_value: false, reason: "x", confidence: 0.5 }, tokensIn: 1, tokensOut: 1, estCostUSD: 0 };
  };
  const summary = await classifyChromeDomains({ db, llm: stub, limit: 2 });
  expect(llmCalls).toBe(2);
  expect(summary.classified_by_llm).toBe(2);
});

test("same domain on different sources gets independent verdicts", async () => {
  await insertVisit({
    id: "chrome:multi-1", source: "mac",
    url: "https://example.weird/", domain: "example.weird",
    title: "x", ts: "2026-05-10T15:00:00Z", durSec: 60,
  });
  await insertVisit({
    id: "chrome:multi-2", source: "sync",
    url: "https://example.weird/", domain: "example.weird",
    title: "y", ts: "2026-05-10T15:00:00Z", durSec: 60,
  });
  const calls: string[] = [];
  const stub: LlmClassifier = async (input) => {
    calls.push(`${input.domain}@${input.source}`);
    return { verdict: { is_low_value: input.source === "sync", reason: "x", confidence: 0.6 }, tokensIn: 1, tokensOut: 1, estCostUSD: 0 };
  };
  await classifyChromeDomains({ db, llm: stub });
  expect(calls.sort()).toEqual(["example.weird@mac", "example.weird@sync"]);

  const rows = await db.queryAll<{ source: string; is_low_value: boolean }>(
    `SELECT source, is_low_value FROM chrome_domain_verdicts ORDER BY source`,
  );
  expect(rows.length).toBe(2);
  expect(rows[0].source).toBe("mac");
  expect(rows[0].is_low_value).toBe(false);
  expect(rows[1].source).toBe("sync");
  expect(rows[1].is_low_value).toBe(true);
});

test("domains with null/empty are skipped silently", async () => {
  await insertVisit({
    id: "chrome:null-1", source: "mac",
    url: "javascript:void(0)", domain: null,
    title: "", ts: "2026-05-10T15:00:00Z", durSec: 0,
  });
  let llmCalls = 0;
  const stub: LlmClassifier = async () => { llmCalls++; return { verdict: { is_low_value: false, reason: "x", confidence: 0 }, tokensIn: 0, tokensOut: 0, estCostUSD: 0 }; };
  const summary = await classifyChromeDomains({ db, llm: stub });
  expect(llmCalls).toBe(0);
  expect(summary.candidate_domains).toBe(0);
});
