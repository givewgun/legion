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

// κ_r = weighted fraction of votes whose side matches the target side.
// Target side is sign(S): naturally 0 when S=0 (pure neutral), +1 or -1 otherwise.
// holdBand is accepted for API symmetry but does not alter the target computation —
// the dominant direction always wins even when |S| < holdBand (e.g. outlier-dragged mean).
export function directionalQuorum(votes, meanStance, holdBand = 0.5) {
  const den = totalWeight(votes);
  if (den === 0) return 0;
  const target = Math.sign(meanStance);
  const agree = votes.reduce(
    (sum, vote) => (sideOf(vote.stance) === target ? sum + vote.weight * vote.conviction : sum),
    0,
  );
  return agree / den;
}

// Evaluates one round. Converged iff κ ≥ quorum AND V ≤ θ_v.
export function evaluateRound(votes, { thetaV, quorum, holdBand = 0.5 }) {
  const S = weightedStance(votes);
  const V = weightedDispersion(votes, S);
  const kappa = directionalQuorum(votes, S, holdBand);
  const converged = kappa >= quorum && V <= thetaV;
  return { S, V, kappa, converged, band: stanceBand(S, holdBand) };
}
