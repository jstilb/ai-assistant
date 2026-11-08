/**
 * TextSimilarity — word-set tokenizing and Jaccard similarity for fuzzy
 * title matching.
 *
 * Shared by ContentAggregator's ContentDeduplicator and EventScout's Dedup,
 * which used to carry two copies of tokenize() + jaccardSimilarity().
 */

/** Strip combining diacritical marks ("Café" → "Cafe"). */
export function stripDiacritics(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/**
 * Tokenize text into a normalised word set: lowercase, strip diacritics and
 * non-alphanumerics, split on whitespace, drop tokens of 2 chars or fewer
 * (noise words like "a", "of", "@").
 */
export function tokenizeWords(text: string): Set<string> {
  return new Set(
    stripDiacritics(text.toLowerCase())
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}

/**
 * Jaccard similarity coefficient: |A ∩ B| / |A ∪ B|.
 * Returns 0.0 (no overlap) to 1.0 (identical sets); two empty sets are 1.0.
 */
export function jaccardSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1.0;
  if (a.size === 0 || b.size === 0) return 0.0;

  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection++;
  }

  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
