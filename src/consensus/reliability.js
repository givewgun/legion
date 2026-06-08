// Min resolved forecasts before an agent's reliability is tuned away from neutral.
export const MIN_RESOLVED = 5;
// Most-recent resolved forecasts per agent used in the reliability window.
export const WINDOW = 50;
// Reliability (rho) is clamped to [floor, cap]: 0.5 halves weight, 1.5 boosts it.
const RHO_FLOOR = 0.5;
const RHO_CAP = 1.5;
// Brier score of a coin-flip forecaster — the neutral (rho = 1.0) reference point.
const RANDOM_BRIER = 0.25;

// Calibration (cal) scales the conviction term c_i — distinct from rho, which scales
// the prior w_i. It is clamped to the same [floor, cap] band and stays neutral at 1.0.
const CALIB_FLOOR = 0.5;
const CALIB_CAP = 1.5;
// Gain λ mapping conviction discrimination d ∈ [-1, 1] onto the calibration band.
const CALIB_GAIN = 1.0;

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

// Directional hit for a resolved forecast: did the agent's side match the benchmark
// outcome? Bullish (stance > 0) hits when it beat SPY (outcome 1); bearish when it
// lagged (outcome 0). HOLD makes no directional claim and returns null (excluded from
// calibration — a confident HOLD says nothing about whether conviction predicts being right).
export function directionalHit(stance, outcome) {
  if (stance > 0) return outcome;
  if (stance < 0) return 1 - outcome;
  return null;
}

// Conviction calibration: does an agent state higher conviction when it turns out right
// than when it turns out wrong? `samples` is [{ conviction, hit }] with hit ∈ {0,1}. The
// discrimination d = meanConviction(hits) − meanConviction(misses) ∈ [-1, 1] is positive
// for an agent whose confidence is informative, ~0 when conviction carries no signal (so a
// loud-but-uninformative voice gets no extra trust), and negative when it is confidently
// wrong. Stays neutral at 1.0 until the agent has both hits and misses across at least
// MIN_RESOLVED directional forecasts (discrimination is undefined without both classes).
export function calibrationFromSamples(samples) {
  const hits = samples.filter((s) => s.hit === 1);
  const misses = samples.filter((s) => s.hit === 0);
  if (samples.length < MIN_RESOLVED || hits.length === 0 || misses.length === 0) return 1.0;
  const meanConviction = (xs) => xs.reduce((sum, s) => sum + s.conviction, 0) / xs.length;
  const d = meanConviction(hits) - meanConviction(misses);
  return clamp(1 + CALIB_GAIN * d, CALIB_FLOOR, CALIB_CAP);
}

// Applies each agent's calibration to its conviction term (clamped back into [0,1]).
// The learning loop scores RAW self-reported conviction, so only aggregation inputs are
// calibrated — never the persisted forecast snapshot (which would create a feedback loop).
export function scaleConviction(votes, calibMap = {}) {
  return votes.map((v) => ({
    ...v,
    conviction: clamp(v.conviction * (calibMap[v.agentId] ?? 1.0), 0, 1),
  }));
}
