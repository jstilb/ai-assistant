/**
 * defined.ts — a checked replacement for the non-null assertion (`x!`) in tests.
 *
 * `rows[0]!.id` tells TypeScript "trust me" and, when the row is missing, fails
 * later with "undefined is not an object". `defined(rows[0]).id` narrows the
 * type the same way but throws at once with a message that names the problem.
 */

/** Return `value` unchanged, or throw if it is `null` or `undefined`. */
export function defined<T>(value: T | null | undefined, what = "value"): T {
  if (value === null || value === undefined) {
    throw new Error(`Expected ${what} to be defined, got ${value === null ? "null" : "undefined"}`);
  }
  return value;
}
