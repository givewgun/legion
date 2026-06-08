import { pairwiseCorrelations } from '../consensus/correlation.js';

// How many recent signals' votes feed the co-movement estimate. Wider than the
// reliability WINDOW because correlation needs pairs of co-rated signals to be
// meaningful, and stale co-movement decays slowly.
export const CORR_SIGNAL_HISTORY = 200;

// Recompute every agent pair's historical vote correlation from recent signal
// snapshots and persist it (ADR 0015), fully replacing the previous set so pairs
// that no longer co-move in the recent window revert to independent. Returns the
// persisted pairs.
export async function recomputeCorrelations(repo) {
  const rows = await repo.getVoteHistory(CORR_SIGNAL_HISTORY);
  const pairs = pairwiseCorrelations(rows);
  await repo.replaceCorrelations(pairs);
  return pairs;
}
