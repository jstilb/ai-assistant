/**
 * Store Matcher - Fuzzy matching for store names
 *
 * Matches user input against a known store list using Levenshtein distance.
 * Handles typos, case differences, and provides ranked suggestions on miss.
 */

export type StoreMatchResult =
  | { matched: true; store: string; distance: number }
  | { matched: false; suggestions: string[] };

/**
 * Levenshtein distance between two strings.
 * Returns the minimum number of single-character edits needed
 * to change one string into the other.
 */
function levenshtein(a: string, b: string): number {
  const aLen = a.length;
  const bLen = b.length;

  if (aLen === 0) return bLen;
  if (bLen === 0) return aLen;

  // Use two rows instead of full matrix for memory efficiency
  let prevRow = new Array<number>(bLen + 1);
  let currRow = new Array<number>(bLen + 1);

  for (let j = 0; j <= bLen; j++) {
    prevRow[j] = j;
  }

  for (let i = 1; i <= aLen; i++) {
    currRow[0] = i;

    for (let j = 1; j <= bLen; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      currRow[j] = Math.min(
        currRow[j - 1] + 1,       // insertion
        prevRow[j] + 1,           // deletion
        prevRow[j - 1] + cost     // substitution
      );
    }

    [prevRow, currRow] = [currRow, prevRow];
  }

  return prevRow[bLen];
}

/**
 * Normalized similarity score between 0 and 1.
 * 1 = identical, 0 = completely different.
 */
function similarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

/**
 * Match a user-provided store name against a list of known stores.
 *
 * Matching rules:
 * 1. Exact match (case-insensitive) -> immediate return
 * 2. Fuzzy match with similarity >= threshold -> return best match
 * 3. No match -> return top 3 suggestions sorted by similarity
 *
 * @param input - User-provided store name
 * @param knownStores - List of known store names
 * @param threshold - Minimum similarity for a match (default 0.6)
 */
export function matchStore(
  input: string,
  knownStores: string[],
  threshold: number = 0.6
): StoreMatchResult {
  if (!input.trim() || knownStores.length === 0) {
    return { matched: false, suggestions: [] };
  }

  const normalizedInput = input.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();

  // Score all stores
  const scored = knownStores.map(store => {
    const normalizedStore = store.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
    const sim = similarity(normalizedInput, normalizedStore);
    return { store, similarity: sim };
  });

  // Sort by similarity descending
  scored.sort((a, b) => b.similarity - a.similarity);

  const best = scored[0];

  // Check if best match meets threshold
  if (best && best.similarity >= threshold) {
    return {
      matched: true,
      store: best.store,
      distance: levenshtein(
        normalizedInput,
        best.store.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim()
      ),
    };
  }

  // Return top 3 suggestions
  return {
    matched: false,
    suggestions: scored.slice(0, 3).map(s => s.store),
  };
}
