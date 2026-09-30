/**
 * concurrency.ts — shared bounded-concurrency worker pool.
 *
 * Extracted from Query.ts (where it was private to queryHybrid) so Ingest.ts
 * can reuse it for prefetch parallelism without duplicating the implementation.
 *
 * runWithConcurrency<T>(items, limit, worker)
 *   Runs `worker` over every element of `items` with at most `limit` tasks
 *   in flight simultaneously. Workers pull from the shared index atomically
 *   (JS single-threaded event loop — no true race on `idx`).
 *
 * Mutations the worker makes to shared arrays/objects between awaits are safe;
 * the JS event loop ensures only one microtask runs at a time.
 */

/**
 * Run `worker` over `items` with at most `limit` in flight.
 *
 * A worker-pool: each lane pulls the next index until the list drains.
 * Mutations the worker makes to shared arrays/objects between awaits are safe
 * (single-threaded event loop).
 *
 * @param items  - The list of items to process.
 * @param limit  - Max concurrent workers (clamped to items.length).
 * @param worker - Async function to run per item.
 */
export async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;
  let idx = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      await worker(items[i]!);
    }
  });
  await Promise.all(lanes);
}
