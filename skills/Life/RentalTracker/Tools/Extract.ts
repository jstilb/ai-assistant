/**
 * Extract.ts — turn a listing's free text into structured features
 * (dishwasher, laundry, A/C, house/yard, kitchen size, scam risk, summary).
 *
 * Reading a listing is content interpretation, so the primary extractor is an
 * LLM (fast tier, schema-constrained, batched, run ONCE per listing+content
 * hash). Source-structured facts (Redfin amenities, Craigslist attributes)
 * override the model where they assert a positive.
 *
 * If inference fails, `keywordFeatures` fills in so the board still works —
 * but those listings are marked extractor:"keywords" on the board, the run
 * summary counts them, and the failure is logged. Never silent.
 *
 * @module RentalTracker/Extract
 */
import { inference } from "../../../../lib/core/Inference.ts";
import type { Features, RawListing } from "./types.ts";

export const FEATURE_SCHEMA = {
  type: "object",
  properties: {
    listings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          dishwasher: { enum: ["yes", "no", "unknown"] },
          laundry: { enum: ["in_unit", "on_site", "none", "unknown"] },
          ac: { enum: ["yes", "no", "unknown"] },
          propertyKind: { enum: ["house", "duplex_cottage", "condo_townhome", "apartment", "unknown"] },
          yard: { enum: ["private", "shared", "none", "unknown"] },
          kitchen: { enum: ["large", "average", "small", "unknown"] },
          scamRisk: { enum: ["low", "medium", "high"] },
          summary: { type: "string" },
          highlights: { type: "array", items: { type: "string" } },
          concerns: { type: "array", items: { type: "string" } },
        },
        required: ["id", "dishwasher", "laundry", "ac", "propertyKind", "yard", "kitchen", "scamRisk", "summary", "highlights", "concerns"],
      },
    },
  },
  required: ["listings"],
} as const;

const SYSTEM_PROMPT = `You read San Diego rental listings for a renter and extract facts. Be literal: only say "yes" when the listing states or clearly shows it; say "no" only when it says so (e.g. "no dishwasher", "laundromat nearby", "no W/D"); otherwise "unknown".

Fields:
- dishwasher: yes/no/unknown.
- laundry: in_unit (W/D or washer/dryer inside the unit, incl. "in-unit", "hookups with W/D provided"), on_site (shared/coin/garage laundry on the property), none (no laundry on the property), unknown.
- ac: yes (A/C, central air, mini-split, wall unit) / no / unknown. Ceiling fans alone are not A/C.
- propertyKind: house (detached single-family home), duplex_cottage (duplex half, cottage, granny flat, ADU, bungalow, small 2-4 unit beach cottages), condo_townhome, apartment (unit in an apartment building/complex), unknown.
- yard: private (private/fenced yard, backyard, private garden — not just a balcony/patio), shared (shared yard/courtyard), none, unknown. A small private patio counts as "none" unless it is described as a yard.
- kitchen: large (described as large/spacious/chef's/open with lots of counter/an island), average (normal full kitchen or remodeled without size cues), small (galley/kitchenette/compact), unknown.
- scamRisk: high if classic rental-scam signals (price far below market for OB, owner "out of the country", wire/Zelle before viewing, email-only, keys mailed), medium if somewhat suspicious or a short-term/vacation/furnished-only/sublet listing, else low.
- summary: <=140 chars, the key facts a renter scans for (type, beds, standout feature, catch). No marketing fluff.
- highlights: <=3 short phrases (e.g. "ocean view", "private backyard", "garage").
- concerns: <=3 short phrases (e.g. "no W/D", "6-mo lease", "utilities extra $200", "furnished only", "move-in promo price").

Judge each listing on its own text only — ignore the other listings in the batch (duplicate reposts are handled elsewhere and are not a scam signal). Return one object per listing, echoing each id exactly.`;

/** Collapse whitespace and cap length so a batch stays small. */
function clip(s: string | undefined, n: number): string {
  return (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
}

export function buildBatchPrompt(batch: RawListing[]): string {
  return batch
    .map((l) => [
      `### id: ${l.id}`,
      `title: ${clip(l.title, 200)}`,
      `price: $${l.price}/mo · beds: ${l.beds ?? "?"}${l.bedsMax && l.bedsMax !== l.beds ? `-${l.bedsMax}` : ""} · baths: ${l.baths ?? "?"} · sqft: ${l.sqft ?? "?"}`,
      `address: ${l.address ?? "?"}`,
      `text: ${clip(l.text, 3500)}`,
    ].join("\n"))
    .join("\n\n");
}

const ENUMS: Record<string, readonly string[]> = {
  dishwasher: ["yes", "no", "unknown"],
  laundry: ["in_unit", "on_site", "none", "unknown"],
  ac: ["yes", "no", "unknown"],
  propertyKind: ["house", "duplex_cottage", "condo_townhome", "apartment", "unknown"],
  yard: ["private", "shared", "none", "unknown"],
  kitchen: ["large", "average", "small", "unknown"],
  scamRisk: ["low", "medium", "high"],
};

/** Validate one model row; returns null when it isn't usable. */
export function coerceFeatures(row: any): Omit<Features, "extractor"> | null {
  if (!row || typeof row !== "object") return null;
  const out: any = {};
  for (const [k, allowed] of Object.entries(ENUMS)) {
    if (!allowed.includes(row[k])) return null;
    out[k] = row[k];
  }
  out.summary = clip(String(row.summary ?? ""), 160);
  out.highlights = Array.isArray(row.highlights) ? row.highlights.map(String).slice(0, 3) : [];
  out.concerns = Array.isArray(row.concerns) ? row.concerns.map(String).slice(0, 3) : [];
  return out;
}

// ----------------------------------------------------------------------------
// Keyword fallback (only when inference is unavailable)
// ----------------------------------------------------------------------------

export function keywordFeatures(l: RawListing): Features {
  const t = `${l.title}\n${l.text ?? ""}`.toLowerCase();
  const dishwasher = /\bno dish ?washer\b/.test(t) ? "no" : /dish ?washer/.test(t) ? "yes" : "unknown";
  const laundry =
    /(w\/d|washer( ?(&|and|\/) ?|\s)dryer|laundry)[^.\n]{0,25}in[- ]?unit|in[- ]?unit (w\/d|washer|laundry)/.test(t) ? "in_unit"
      : /no laundry/.test(t) ? "none"
        : /(on[- ]site|shared|coin|community|common) laundry|laundry (room|on[- ]site|facilit|in (the )?(bldg|building|garage))/.test(t) ? "on_site"
          : "unknown";
  const ac = /\bno (a\/c|ac|air)\b/.test(t) ? "no" : /air condition|\ba\/c\b|central air|mini[- ]split/.test(t) ? "yes" : "unknown";
  const propertyKind =
    /\b(single[- ]family|detached) (home|house)\b|\bhouse for rent\b|\bentire house\b/.test(t) ? "house"
      : /\b(duplex|cottage|bungalow|granny flat|adu|guest house|casita)\b/.test(t) ? "duplex_cottage"
        : /\b(condo|townhome|townhouse)\b/.test(t) ? "condo_townhome"
          : /\b(apartment|unit #|complex|community features)\b/.test(t) ? "apartment" : "unknown";
  const yard = /\b(private|fenced|own|large)\s+(back)?yard\b|\bbackyard\b/.test(t) ? "private" : /\bshared (back)?yard\b/.test(t) ? "shared" : "unknown";
  const kitchen = /\b(large|spacious|big|chef'?s|gourmet|huge) kitchen\b|kitchen island/.test(t) ? "large" : /\b(galley|small|compact) kitchen|kitchenette/.test(t) ? "small" : "unknown";
  const scamRisk = /wire (the )?money|western union|out of the country|keys? (will be )?(mailed|shipped)|zelle .{0,20}before/.test(t) ? "high" : /furnished|short[- ]term|vacation rental|sublet|sublease/.test(t) ? "medium" : "low";
  return {
    dishwasher, laundry, ac, propertyKind, yard, kitchen, scamRisk,
    summary: clip(l.title, 140),
    highlights: [],
    concerns: [],
    extractor: "keywords",
  } as Features;
}

/** Source-structured positives win over the extractor (they're the listing's own checkboxes). */
export function mergeStructured(f: Features, s: Partial<Features> | undefined): Features {
  if (!s) return f;
  const out = { ...f };
  if (s.dishwasher === "yes") out.dishwasher = "yes";
  if (s.laundry && (s.laundry === "in_unit" || out.laundry === "unknown")) out.laundry = s.laundry;
  if (s.ac === "yes") out.ac = "yes";
  if (s.yard === "private") out.yard = "private";
  if (s.propertyKind && out.propertyKind === "unknown") out.propertyKind = s.propertyKind;
  return out;
}

export type InferenceFn = typeof inference;

export interface ExtractResult {
  features: Map<string, Features>;
  fallbacks: number;
  errors: string[];
}

/**
 * Extract features for the given listings via batched LLM calls, `concurrency`
 * batches at a time. Listings the model fails on get keyword features.
 */
export async function extractFeatures(
  listings: RawListing[],
  opts: { batchSize: number; concurrency: number; timeoutMs: number; useLlm: boolean },
  infer: InferenceFn = inference,
): Promise<ExtractResult> {
  const features = new Map<string, Features>();
  const errors: string[] = [];
  const batches: RawListing[][] = [];
  for (let i = 0; i < listings.length; i += opts.batchSize) batches.push(listings.slice(i, i + opts.batchSize));

  if (opts.useLlm) {
    let next = 0;
    const worker = async () => {
      while (next < batches.length) {
        const batch = batches[next++];
        const res = await infer({
          systemPrompt: SYSTEM_PROMPT,
          userPrompt: `Extract features for these ${batch.length} listings.\n\n${buildBatchPrompt(batch)}`,
          level: "fast",
          schema: FEATURE_SCHEMA as unknown as Record<string, unknown>,
          timeout: opts.timeoutMs,
          retries: 1,
        });
        if (!res.success) {
          errors.push(res.error ?? "inference failed");
          continue;
        }
        const rows = (res.parsed as any)?.listings;
        if (!Array.isArray(rows)) {
          errors.push("inference returned no listings[]");
          continue;
        }
        for (const row of rows) {
          const f = coerceFeatures(row);
          if (f && batch.some((l) => l.id === row.id)) features.set(row.id, { ...f, extractor: "llm" });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, worker));
  }

  let fallbacks = 0;
  for (const l of listings) {
    if (!features.has(l.id)) {
      features.set(l.id, keywordFeatures(l));
      fallbacks++;
    }
  }
  return { features, fallbacks, errors };
}
