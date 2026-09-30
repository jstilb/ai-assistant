/**
 * NetworkPrecondition — reachability probe for job.precondition.network
 * (see JobSpec.ts's PreconditionSchema — schema existed since S2, this is
 * the first behavior wiring, item 1 of S3's remaining work).
 *
 * Deliberately injectable: `isNetworkReachable` takes a `probeFn` so tests
 * never touch a real socket/DNS. Production default does a lightweight
 * HTTPS HEAD-equivalent fetch against a well-known always-up endpoint with a
 * short timeout.
 *
 * Fail-closed: if the probe throws or rejects for ANY reason (DNS failure,
 * timeout, connection refused, unexpected exception), reachability is
 * reported as false ("offline"). run-cron-job.ts's caller treats "offline"
 * as "defer the run" rather than "run anyway" — for jobs that explicitly
 * declared they need network, silently proceeding at spawn-time and letting
 * the job itself fail mid-run is strictly worse than deferring up front
 * (wastes a claude-semaphore slot + wake-lock + retry budget on a run that
 * was never going to succeed).
 */

const DEFAULT_PROBE_TIMEOUT_MS = 5000;
const DEFAULT_PROBE_URL = 'https://www.google.com/generate_204';

export type ProbeFn = () => Promise<boolean>;

const defaultProbe: ProbeFn = async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(DEFAULT_PROBE_URL, { method: 'HEAD', signal: controller.signal });
    return res.ok || (res.status >= 200 && res.status < 500);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Resolve network reachability via the (injectable) probeFn. Fail-closed:
 * any throw/rejection from probeFn is treated as "not reachable" rather than
 * propagating — a broken probe must never crash the caller, and "unknown"
 * is safest treated as "offline" for a job that declared it needs network.
 */
export async function isNetworkReachable(probeFn: ProbeFn = defaultProbe): Promise<boolean> {
  try {
    return await probeFn();
  } catch {
    return false;
  }
}
