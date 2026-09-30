#!/usr/bin/env bun
/**
 * ChromeClassifier.ts — assigns a low-value verdict to each distinct
 * (domain, source) pair in chrome_visits and caches it in
 * chrome_domain_verdicts.
 *
 * Three classification paths, in order:
 *   1. Tier-1 patterns (CONFIG.tier1DomainPatterns, e.g. '%reddit.com%')
 *      → classifier='tier1-domain', is_low_value=true, NO LLM cost.
 *   2. Utility allowlist (CONFIG.chromeUtilityDomains, e.g. mail.google.com)
 *      → classifier='utility-allowlist', is_low_value=false, NO LLM cost.
 *   3. LLM (Inference.standard / Sonnet) — for genuinely unknown domains.
 *
 * The LLM is injected via the `llm` option so tests never spawn `claude -p`.
 *
 * Flags:
 *   --force      reclassify everything (busts the verdict cache)
 *   --dry-run    list what WOULD be classified without writing verdicts or
 *                calling the LLM (cheap survey)
 *   --limit=N    cap LLM calls this run (cost guard); other paths uncapped
 *   --json       JSON summary
 */

import { CONFIG } from "../Config.ts";
import { Db, logFailure } from "./Db.ts";
import { inference } from "~/.claude/lib/core/Inference.ts";

const DEFAULT_LLM_LIMIT = 200;

export interface ClassificationVerdict {
  is_low_value: boolean;
  reason: string;
  confidence: number;
}

export interface LlmClassifierInput {
  domain: string;
  source: string;
  sample_titles: string[];
  visit_count: number;
  total_minutes_estimate: number;
}

export interface LlmClassifierResult {
  verdict: ClassificationVerdict;
  tokensIn: number;
  tokensOut: number;
  estCostUSD: number;
}

export type LlmClassifier = (input: LlmClassifierInput) => Promise<LlmClassifierResult>;

export interface ChromeClassifyOpts {
  db: Db;
  llm?: LlmClassifier;
  limit?: number;
  force?: boolean;
  dryRun?: boolean;
}

export interface ChromeClassifySummary {
  candidate_domains: number;
  classified_by_tier1: number;
  classified_by_utility: number;
  classified_by_llm: number;
  would_call_llm: number;
  skipped_already: number;
  errors: number;
  tokens_in: number;
  tokens_out: number;
  est_cost_usd: number;
  dry_run: boolean;
}

interface DomainRow {
  domain: string;
  source: string;
  visit_count: number;
  total_sec: number;
  sample_titles: string[];
  already_classified: boolean;
}

const LLM_CLASSIFIER_NAME = "llm-sonnet";

const SYSTEM_PROMPT = `You classify a web domain into low-value vs not-low-value for a focused engineer trying to reduce passive entertainment.

Definitions:
- "low-value" = entertainment, infinite-scroll feeds, mindless distraction, celebrity gossip, gaming streams, drama channels, reaction videos, comedy shorts, doomscrolling-style sites.
- "not low-value" = work tools, technical reference, documentation, productivity SaaS, banking, navigation, language learning, news/journalism with substance.

When unsure, prefer "not low-value" (false negative is cheaper than false positive — we don't want to penalize work).

The sample_titles provided are a small sample from this domain — do not infer Jm's overall browsing habits, character, or focus patterns from them; judge only whether this domain is low-value based on what it is.

Respond ONLY with a single JSON object (no prose, no markdown fence) of this exact shape:
{ "is_low_value": <bool>, "reason": "<one short sentence>", "confidence": <number 0-1> }`;

function matchesTier1Domain(domain: string): boolean {
  // CONFIG.tier1DomainPatterns are SQL LIKE patterns ('%reddit.com%'). We
  // translate to plain substring matches against the lowercased domain.
  const lc = domain.toLowerCase();
  for (const pat of CONFIG.tier1DomainPatterns) {
    const needle = pat.replace(/%/g, "").toLowerCase();
    if (needle.length === 0) continue;
    if (lc.includes(needle)) return true;
  }
  return false;
}

function matchesUtility(domain: string): boolean {
  const lc = domain.toLowerCase();
  return CONFIG.chromeUtilityDomains.some(d => d.toLowerCase() === lc);
}

/** Aggregate distinct (domain, source) keys with sample titles + duration.
 *  Returns ALL distinct pairs, tagged with `already_classified` based on the
 *  verdict cache — the caller decides what to do with them (force overrides
 *  the skip; otherwise we count them in `skipped_already`). */
async function loadCandidates(db: Db): Promise<DomainRow[]> {
  // Skip null/empty domains (javascript:, chrome://, etc.) — can't classify
  // them meaningfully.
  const sql = `
    SELECT cv.domain                                   AS domain,
           cv.source                                   AS source,
           COUNT(*)                                    AS visit_count,
           COALESCE(SUM(cv.visit_duration_sec), 0)     AS total_sec,
           EXISTS (
             SELECT 1 FROM chrome_domain_verdicts v
             WHERE v.domain = cv.domain AND v.source = cv.source
           )                                           AS already_classified
      FROM chrome_visits cv
     WHERE cv.domain IS NOT NULL AND length(cv.domain) > 0
     GROUP BY cv.domain, cv.source
     ORDER BY visit_count DESC
  `;
  const rows = await db.queryAll<{ domain: string; source: string; visit_count: number | bigint; total_sec: number | bigint; already_classified: boolean }>(sql);

  // Fetch up to 5 sample titles per (domain, source) — separate query so the
  // GROUP BY above stays cheap. Use ROW_NUMBER to take first-5 per group.
  const titles = await db.queryAll<{ domain: string; source: string; title: string }>(`
    WITH ranked AS (
      SELECT cv.domain AS domain,
             cv.source AS source,
             cv.title  AS title,
             ROW_NUMBER() OVER (PARTITION BY cv.domain, cv.source ORDER BY cv.visit_time DESC) AS rn
        FROM chrome_visits cv
       WHERE cv.title IS NOT NULL AND length(cv.title) > 0
    )
    SELECT domain, source, title FROM ranked WHERE rn <= 5
  `);
  const titleMap = new Map<string, string[]>();
  for (const t of titles) {
    const key = `${t.domain}|${t.source}`;
    const list = titleMap.get(key) ?? [];
    list.push(t.title);
    titleMap.set(key, list);
  }

  return rows.map(r => ({
    domain: r.domain,
    source: r.source,
    visit_count: Number(r.visit_count),
    total_sec: Number(r.total_sec),
    sample_titles: titleMap.get(`${r.domain}|${r.source}`) ?? [],
    already_classified: Boolean(r.already_classified),
  }));
}

async function upsertVerdict(
  db: Db,
  domain: string,
  source: string,
  verdict: ClassificationVerdict,
  classifier: string,
): Promise<void> {
  await db.run(
    `INSERT OR REPLACE INTO chrome_domain_verdicts
       (domain, source, is_low_value, reason, confidence, classifier, classified_at)
     VALUES ($domain, $source, $low, $reason, $conf, $cls, $now::TIMESTAMP)`,
    {
      domain, source,
      low: verdict.is_low_value,
      reason: verdict.reason,
      conf: verdict.confidence,
      cls: classifier,
      now: new Date().toISOString(),
    },
  );
}

/** Production LLM classifier. Uses Inference.standard (Sonnet). */
export const defaultLlmClassifier: LlmClassifier = async (input) => {
  const userPrompt = JSON.stringify({
    domain: input.domain,
    source: input.source,
    sample_titles: input.sample_titles.slice(0, 5),
    visit_count: input.visit_count,
    total_minutes_estimate: Math.round(input.total_minutes_estimate),
  });
  const result = await inference({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    level: "standard",
    expectJson: true,
  });
  if (!result.success || result.parsed == null) {
    throw new Error(`inference failed: ${result.error ?? "no parsed output"}`);
  }
  const raw = result.parsed as Record<string, unknown>;
  if (typeof raw.is_low_value !== "boolean") {
    throw new Error("classifier response missing is_low_value bool");
  }
  const reason = typeof raw.reason === "string" ? raw.reason : "";
  let confidence = typeof raw.confidence === "number" ? raw.confidence : 0;
  if (!Number.isFinite(confidence)) confidence = 0;
  if (confidence < 0) confidence = 0;
  if (confidence > 1) confidence = 1;
  return {
    verdict: { is_low_value: raw.is_low_value, reason, confidence },
    tokensIn: result.estimatedTokens.input,
    tokensOut: result.estimatedTokens.output,
    estCostUSD: result.estimatedCostUSD,
  };
};

export async function classifyChromeDomains(opts: ChromeClassifyOpts): Promise<ChromeClassifySummary> {
  const llm = opts.llm ?? defaultLlmClassifier;
  const limit = opts.limit ?? DEFAULT_LLM_LIMIT;
  const force = opts.force ?? false;
  const dryRun = opts.dryRun ?? false;

  await opts.db.initSchema();
  const candidates = await loadCandidates(opts.db);

  const summary: ChromeClassifySummary = {
    candidate_domains: candidates.length,
    classified_by_tier1: 0,
    classified_by_utility: 0,
    classified_by_llm: 0,
    would_call_llm: 0,
    skipped_already: 0,
    errors: 0,
    tokens_in: 0,
    tokens_out: 0,
    est_cost_usd: 0,
    dry_run: dryRun,
  };

  for (const row of candidates) {
    if (row.already_classified && !force) {
      summary.skipped_already++;
      continue;
    }
    // Tier-1: known low-value domain pattern.
    if (matchesTier1Domain(row.domain)) {
      const verdict: ClassificationVerdict = {
        is_low_value: true,
        reason: `tier-1 domain pattern matched`,
        confidence: 1,
      };
      if (!dryRun) await upsertVerdict(opts.db, row.domain, row.source, verdict, "tier1-domain");
      summary.classified_by_tier1++;
      continue;
    }
    // Utility-allowlist: known work tool.
    if (matchesUtility(row.domain)) {
      const verdict: ClassificationVerdict = {
        is_low_value: false,
        reason: `utility-allowlist hit`,
        confidence: 1,
      };
      if (!dryRun) await upsertVerdict(opts.db, row.domain, row.source, verdict, "utility-allowlist");
      summary.classified_by_utility++;
      continue;
    }
    // LLM path — respect dry-run and the cost limit. (Hitting the cap is NOT
    // "already classified"; we just leave the remainder for the next run.)
    if (summary.classified_by_llm >= limit) {
      continue;
    }
    if (dryRun) {
      summary.would_call_llm++;
      continue;
    }
    try {
      const r = await llm({
        domain: row.domain,
        source: row.source,
        sample_titles: row.sample_titles,
        visit_count: row.visit_count,
        total_minutes_estimate: row.total_sec / 60,
      });
      await upsertVerdict(opts.db, row.domain, row.source, r.verdict, LLM_CLASSIFIER_NAME);
      summary.classified_by_llm++;
      summary.tokens_in += r.tokensIn;
      summary.tokens_out += r.tokensOut;
      summary.est_cost_usd += r.estCostUSD;
    } catch (err) {
      summary.errors++;
      await logFailure("ChromeClassifier", err, { domain: row.domain, source: row.source });
    }
  }

  return summary;
}

async function main(argv: string[]): Promise<void> {
  const force = argv.includes("--force");
  const json = argv.includes("--json");
  const dryRun = argv.includes("--dry-run");
  const limitFlag = argv.find(a => a.startsWith("--limit="))?.slice("--limit=".length);
  const limit = limitFlag ? parseInt(limitFlag, 10) : undefined;

  const db = await Db.open();
  try {
    await db.initSchema();
    const summary = await classifyChromeDomains({ db, limit, force, dryRun });
    if (json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      const tag = dryRun ? "DRY-RUN " : "";
      console.log(`${tag}ChromeClassifier: ${summary.candidate_domains} candidate domains`);
      console.log(`  tier1=${summary.classified_by_tier1}  utility=${summary.classified_by_utility}  llm=${summary.classified_by_llm}  errors=${summary.errors}`);
      if (dryRun) console.log(`  would_call_llm=${summary.would_call_llm}`);
      if (!dryRun) console.log(`  tokens in=${summary.tokens_in} out=${summary.tokens_out}  est_cost=$${summary.est_cost_usd.toFixed(4)}`);
    }
  } finally {
    db.close();
  }
}

if (import.meta.main) main(process.argv.slice(2)).catch(err => {
  console.error(err);
  process.exit(1);
});
