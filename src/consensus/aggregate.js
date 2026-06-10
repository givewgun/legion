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

// Effective number of independent voices in a coalition (ADR 0020): the
// participation ratio (Σλ)²/Σλ² of the coalition's correlation-matrix eigenvalues.
// For a symmetric matrix Σλ = trace = n and Σλ² = ‖R‖²_F = Σᵢⱼ r²ᵢⱼ, so no
// eigendecomposition is needed. Negative correlation is not redundancy and is
// clamped to 0. Identity (all independent) → n; k perfect echoes → 1.
export function effectiveVoices(agentIds, corr) {
  const n = agentIds.length;
  if (n === 0) return 0;
  let frobSq = 0;
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      const r = i === j ? 1 : Math.max(0, corr(agentIds[i], agentIds[j]));
      frobSq += r * r;
    }
  }
  return (n * n) / frobSq;
}

// κ_r = redundancy-discounted weighted fraction of votes whose side agrees with
// the aggregate. The target side is sign(S). When the aggregate is near-neutral
// (|S| < holdBand), HOLD voters (side 0) are also counted as agreeing — a near-flat
// consensus should credit the agents sitting at HOLD, not just the marginal lean.
//
// `corr(a, b)` returns the historical co-movement of two agents' votes (ADR 0015).
// The agreeing coalition's weight is scaled by effectiveVoices/n (ADR 0020), so k
// historically co-moving agents collapse toward one independent confirmation
// instead of counting k times. The default lookup is 0 (everyone independent),
// which reduces κ exactly to the plain weighted fraction — so an unconfigured
// panel behaves as before.
export function directionalQuorum(votes, meanStance, holdBand = 0.5, corr = () => 0) {
  const den = totalWeight(votes);
  if (den === 0) return 0;
  const inBand = Math.abs(meanStance) < holdBand;
  const target = Math.sign(meanStance);
  const agreeing = votes.filter((vote) => {
    const side = sideOf(vote.stance);
    return side === target || (inBand && side === 0);
  });
  if (agreeing.length === 0) return 0;
  const agreeWeight = agreeing.reduce((sum, vote) => sum + vote.weight * vote.conviction, 0);
  const discount = effectiveVoices(agreeing.map((v) => v.agentId), corr) / agreeing.length;
  return (agreeWeight * discount) / den;
}

// Weighted fraction of (round-1) votes whose side already matched `targetSide` —
// the *independent* backing for a direction, before any peer dissent was shown.
// Used by the anti-herding guard (ADR 0016): a consensus reached only in revision
// rounds must still rest on independent agreement, not social pressure.
export function independentBacking(votes, targetSide) {
  const den = totalWeight(votes);
  if (den === 0) return 0;
  const backing = votes.reduce(
    (sum, vote) => (sideOf(vote.stance) === targetSide ? sum + vote.weight * vote.conviction : sum),
    0,
  );
  return backing / den;
}

// Minimum carrying votes for the BFT-style "one outlier can neither force nor
// block" guarantee to hold. With N = 4 and f = ⌊(N−1)/3⌋ = 1, an abstention
// (conviction 0 ⇒ W·c = 0) shrinks the effective panel to 3 where f = 0 — the
// guarantee is gone even though the fraction-based κ still computes. Rounds below
// this floor are tagged `degraded` so consumers can see the weakened guarantee.
const MIN_PANEL = 3;

// Effective panel size: votes that actually carry weight (W·c > 0). Abstentions
// and zero-conviction votes drop out of every aggregate sum, so they must not
// count toward the panel the robustness guarantee is stated for.
export function effectivePanel(votes) {
  return votes.filter((vote) => vote.weight * vote.conviction > 0).length;
}

// Evaluates one round. Converged iff κ ≥ quorum AND V ≤ θ_v. `degraded` flags a
// round whose effective panel fell below minPanel — the signal still emits, but
// the single-outlier tolerance documented in ADR 0001 no longer holds for it.
export function evaluateRound(votes, { thetaV, quorum, holdBand = 0.5, corr, minPanel = MIN_PANEL } = {}) {
  const S = weightedStance(votes);
  const V = weightedDispersion(votes, S);
  const kappa = directionalQuorum(votes, S, holdBand, corr);
  const converged = kappa >= quorum && V <= thetaV;
  const nEff = effectivePanel(votes);
  const degraded = nEff < minPanel;
  return { S, V, kappa, converged, nEff, degraded, band: stanceBand(S, holdBand) };
}
