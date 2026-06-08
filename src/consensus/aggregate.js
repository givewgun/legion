import { sideOf, stanceBand } from './stance.js';

// Σ(W_i · c_i) — the normalizing denominator used everywhere.
function totalWeight(votes) {
  return votes.reduce((sum, vote) => sum + vote.weight * vote.conviction, 0);
}

// S_r = Σ(W_i · c_i · s_i) / Σ(W_i · c_i)
export function weightedStance(votes) {
  const den = totalWeight(votes);
  if (den === 0) return 0;
  const num = votes.reduce((sum, vote) => sum + vote.weight * vote.conviction * vote.stance, 0);
  return num / den;
}

// V_r = Σ(W_i · c_i · (s_i − S)²) / Σ(W_i · c_i)
export function weightedDispersion(votes, meanStance) {
  const den = totalWeight(votes);
  if (den === 0) return 0;
  const num = votes.reduce(
    (sum, vote) => sum + vote.weight * vote.conviction * (vote.stance - meanStance) ** 2,
    0,
  );
  return num / den;
}

// κ_r = redundancy-discounted weighted fraction of votes whose side agrees with
// the aggregate. The target side is sign(S). When the aggregate is near-neutral
// (|S| < holdBand), HOLD voters (side 0) are also counted as agreeing — a near-flat
// consensus should credit the agents sitting at HOLD, not just the marginal lean.
//
// `corr(a, b)` returns the historical co-movement of two agents' votes (ADR 0015).
// Each agreeing vote is divided by the correlation mass it shares with the rest of
// the agreeing coalition (self = 1), so k historically co-moving agents collapse
// toward one independent confirmation instead of counting k times. The default
// lookup is 0 (everyone independent), which reduces κ exactly to the plain weighted
// fraction — so an unconfigured panel behaves as before.
export function directionalQuorum(votes, meanStance, holdBand = 0.5, corr = () => 0) {
  const den = totalWeight(votes);
  if (den === 0) return 0;
  const inBand = Math.abs(meanStance) < holdBand;
  const target = Math.sign(meanStance);
  const agreeing = votes.filter((vote) => {
    const side = sideOf(vote.stance);
    return side === target || (inBand && side === 0);
  });
  let effectiveAgree = 0;
  for (const vote of agreeing) {
    let mass = 1; // self-correlation
    for (const other of agreeing) {
      if (other.agentId === vote.agentId) continue;
      mass += Math.max(0, corr(vote.agentId, other.agentId));
    }
    effectiveAgree += (vote.weight * vote.conviction) / mass;
  }
  return effectiveAgree / den;
}

// Evaluates one round. Converged iff κ ≥ quorum AND V ≤ θ_v.
export function evaluateRound(votes, { thetaV, quorum, holdBand = 0.5, corr } = {}) {
  const S = weightedStance(votes);
  const V = weightedDispersion(votes, S);
  const kappa = directionalQuorum(votes, S, holdBand, corr);
  const converged = kappa >= quorum && V <= thetaV;
  return { S, V, kappa, converged, band: stanceBand(S, holdBand) };
}
