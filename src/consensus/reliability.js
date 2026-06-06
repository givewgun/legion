// Min resolved forecasts before an agent's reliability is tuned away from neutral.
export const MIN_RESOLVED = 5;
// Most-recent resolved forecasts per agent used in the reliability window.
export const WINDOW = 50;
// Reliability (rho) is clamped to [floor, cap]: 0.5 halves weight, 1.5 boosts it.
const RHO_FLOOR = 0.5;
const RHO_CAP = 1.5;
// Brier score of a coin-flip forecaster — the neutral (rho = 1.0) reference point.
const RANDOM_BRIER = 0.25;

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export function forecastProb(stance, conviction) {
  return clamp(0.5 + (stance * conviction) / 4, 0, 1);
}

export function brier(prob, outcome) {
  const d = prob - outcome;
  return d * d;
}

export function reliabilityFromBrier(meanBrier, sampleSize) {
  if (sampleSize < MIN_RESOLVED) return 1.0;
  return clamp(1 + 2 * (RANDOM_BRIER - meanBrier), RHO_FLOOR, RHO_CAP);
}

export function scaleWeights(votes, rhoMap = {}) {
  return votes.map((v) => ({
    ...v,
    weight: v.weight * (rhoMap[v.agentId] ?? 1.0),
  }));
}
