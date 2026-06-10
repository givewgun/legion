// Min resolved forecasts before an agent's reliability is tuned away from neutral.
export const MIN_RESOLVED = 5;
// Most-recent resolved forecasts per agent considered in the reliability window.
export const WINDOW = 50;
// Recency half-life (in resolved forecasts): a forecast this many slots older than
// the newest carries half its weight. Lets ρ/calibration track a regime shift instead
// of being anchored to stale evidence inside the equal-weight WINDOW (ADR 0017).
export const HALF_LIFE = 20;
const DECAY = 0.5 ** (1 / HALF_LIFE);
// Reliability (rho) is clamped to [floor, cap]: 0.5 halves weight, 1.5 boosts it.
const RHO_FLOOR = 0.5;
const RHO_CAP = 1.5;
// Brier score of a coin-flip forecaster — the neutral (rho = 1.0) reference point.
const RANDOM_BRIER = 0.25;
// Asymmetric slopes around RANDOM_BRIER: a poor forecaster loses weight faster than a
// good one gains it, because acting on a bad call costs capital (ADR 0017).
const RHO_GAIN_UP = 2;
const RHO_GAIN_DOWN = 4;

// Calibration (cal) scales the conviction term c_i — distinct from rho, which scales
// the prior w_i. It is clamped to the same [floor, cap] band and stays neutral at 1.0.
const CALIB_FLOOR = 0.5;
const CALIB_CAP = 1.5;
// Gain λ mapping conviction discrimination d ∈ [-1, 1] onto the calibration band.
const CALIB_GAIN = 1.0;

// Bayesian-style shrinkage toward neutral (ADR 0019): every learned edge is
// scaled by ess/(ess + SHRINK_K) before it moves a dial, so a short hot streak
// cannot push an agent to the extremes — only consistent evidence can. At
// ess = SHRINK_K the evidence counts half; the clamp bands become asymptotic
// targets instead of a few-good-weeks destination.
export const SHRINK_K = 10;

// ρ and calibration multiply into effective influence; individually clamped to
// [0.5, 1.5] they still compound to 0.25×–2.25× — enough for one streaky agent
// to dominate the panel. The combined multiplier is bounded by adjusting the
// secondary dial (calibration), never ρ, the primary skill signal (ADR 0019).
const COMBINED_FLOOR = 0.4;
const COMBINED_CAP = 2.0;

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// Recency weights for rows ordered most-recent-first: 1, DECAY, DECAY², …
export function decayWeights(n) {
  return Array.from({ length: n }, (_, i) => DECAY ** i);
}

export function weightedMean(values, weights) {
  let num = 0;
  let den = 0;
  for (let i = 0; i < values.length; i += 1) {
    num += values[i] * weights[i];
    den += weights[i];
  }
  return den === 0 ? 0 : num / den;
}

// Kish effective sample size of a weighted sample: (Σw)² / Σw². Equals n for
// uniform weights and shrinks as recency decay concentrates mass on few rows —
// the honest n for shrinking a decay-weighted estimate.
export function effectiveSampleSize(weights) {
  let sum = 0;
  let sumSq = 0;
  for (const w of weights) {
    sum += w;
    sumSq += w * w;
  }
  return sumSq === 0 ? 0 : (sum * sum) / sumSq;
}

export function forecastProb(stance, conviction) {
  return clamp(0.5 + (stance * conviction) / 4, 0, 1);
}

export function brier(prob, outcome) {
  const d = prob - outcome;
  return d * d;
}

// Alpha (excess return vs SPY) at which a graded outcome saturates: tanh(1) ≈ 0.76,
// so a ±5% alpha lands near 0.88/0.12 and larger moves flatten toward 1/0. Chosen
// to make a "clear" 5-day alpha decisive while basis-point noise stays near 0.5.
export const ALPHA_SCALE = 0.05;

// Magnitude-aware outcome on [0,1]: 0.5 = matched SPY, → 1 the more the call beat
// it, → 0 the more it lagged. Beating SPY by 1bp and by 20% are no longer the same
// outcome, so confident-and-big beats score better than confident-and-barely, and
// large confident misses cost more (the loss-aversion ADR 0017 wants, with
// magnitude). Returns null when either leg is missing (legacy rows fall back to
// the binary outcome).
export function gradedOutcome(forwardReturn, spyReturn, scale = ALPHA_SCALE) {
  if (forwardReturn == null || spyReturn == null) return null;
  return 0.5 + 0.5 * Math.tanh((forwardReturn - spyReturn) / scale);
}

// Maps an agent's mean Brier to ρ via the Brier *skill score* against the
// uninformative p = 0.5 forecaster scored over the SAME outcomes:
//   BSS = 1 − meanBrier / baselineBrier,  edge = 0.25 · BSS
// With binary outcomes baselineBrier is exactly 0.25, so edge reduces to the
// original (0.25 − meanBrier) — boundary behaviour (perfect → 1.5, random → 1.0,
// floor at 0.5) is unchanged. With graded outcomes the baseline shrinks with the
// outcome spread, so an uninformative forecaster still lands exactly at ρ = 1
// instead of looking skilled just because outcomes cluster near 0.5.
// `ess` is the (Kish) effective sample size backing the estimate; the edge is
// shrunk by ess/(ess + SHRINK_K) so low-evidence agents stay near neutral.
export function reliabilityFromBrier(meanBrier, sampleSize, baselineBrier = RANDOM_BRIER, ess = sampleSize) {
  if (sampleSize < MIN_RESOLVED) return 1.0;
  if (baselineBrier <= 0) return 1.0; // zero outcome spread: nothing to discriminate
  const edge = RANDOM_BRIER * (1 - meanBrier / baselineBrier);
  const shrunk = edge * (ess / (ess + SHRINK_K));
  const delta = shrunk >= 0 ? RHO_GAIN_UP * shrunk : RHO_GAIN_DOWN * shrunk;
  return clamp(1 + delta, RHO_FLOOR, RHO_CAP);
}

// Bounds the combined ρ·cal influence multiplier into [COMBINED_FLOOR, COMBINED_CAP]
// by adjusting calibration only. Given ρ ∈ [0.5, 1.5] the adjusted calibration
// always lands back inside its own [0.5, 1.5] band.
export function boundCombined(rho, calibration) {
  const product = rho * calibration;
  if (product > COMBINED_CAP) return { rho, calibration: COMBINED_CAP / rho };
  if (product < COMBINED_FLOOR) return { rho, calibration: COMBINED_FLOOR / rho };
  return { rho, calibration };
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
// than when it turns out wrong? `samples` is [{ conviction, hit, weight? }] with hit ∈ {0,1}
// and an optional recency weight (default 1). The discrimination
// d = meanConviction(hits) − meanConviction(misses) ∈ [-1, 1] is positive for an agent whose
// confidence is informative, ~0 when conviction carries no signal (so a loud-but-uninformative
// voice gets no extra trust), and negative when it is confidently wrong. Stays neutral at 1.0
// until the agent has both hits and misses across at least MIN_RESOLVED directional forecasts
// (discrimination is undefined without both classes).
export function calibrationFromSamples(samples) {
  const hits = samples.filter((s) => s.hit === 1);
  const misses = samples.filter((s) => s.hit === 0);
  if (samples.length < MIN_RESOLVED || hits.length === 0 || misses.length === 0) return 1.0;
  const meanConviction = (xs) =>
    weightedMean(
      xs.map((s) => s.conviction),
      xs.map((s) => s.weight ?? 1),
    );
  const d = meanConviction(hits) - meanConviction(misses);
  // Same shrinkage as ρ: a discriminator estimated from few directional
  // forecasts moves the dial proportionally less (ADR 0019).
  const ess = effectiveSampleSize(samples.map((s) => s.weight ?? 1));
  const shrunk = d * (ess / (ess + SHRINK_K));
  return clamp(1 + CALIB_GAIN * shrunk, CALIB_FLOOR, CALIB_CAP);
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
