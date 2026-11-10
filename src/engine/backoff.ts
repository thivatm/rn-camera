// Retry backoff (spec §5.4): exponential from 1 s, capped at 30 s, with jitter.

export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_CAP_MS = 30_000;

/**
 * Delay before retry number `attempt` (0 for the first retry). The nominal
 * step `min(30 s, 1 s · 2^attempt)` is scaled by a jitter factor in
 * `[0.5, 1.5)` drawn from `random()` (a value in `[0, 1)`), so delays average
 * the nominal step, spread out across devices, and never exceed 30 s.
 */
export function backoffDelay(attempt: number, random: () => number): number {
  const step = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return Math.min(BACKOFF_CAP_MS, Math.round(step * (0.5 + random())));
}
