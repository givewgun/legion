// Pure company-quality scoring. Four sub-scores, each normalized to [0,1], blend
// to a multiplier in [0.5, 1.5] that scales signal conviction in the sizing
// engine. No I/O — all inputs are passed in (gunvest fundamentals object, a moat
// score, and the live price for analyst target upside). A missing factor degrades
// to a neutral 0.5 and raises a flag rather than blocking the score (mirrors the
// risk-manager fallback).

const QualityFloor = 0.5; // qualityMult range is [0.5, 1.5]
const NeutralSub = 0.5; // a missing sub-score contributes this to the blend
const DefaultWeights = { fundamentals: 0.25, valuation: 0.25, analyst: 0.25, moat: 0.25 };

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

// Map a value linearly from [lo, hi] onto [0, 1] (hi may be < lo to invert).
function ramp(v, lo, hi) {
  if (v == null || Number.isNaN(v)) return null;
  return clamp01((v - lo) / (hi - lo));
}

export function scoreFundamentals(f) {
  if (!f) return null;
  const parts = [
    ramp(f.profitMargins, 0, 0.3),
    ramp(f.returnOnEquity, 0, 0.3),
    ramp(f.revenueGrowth, 0, 0.3),
    ramp(f.debtToEquity, 200, 0), // lower debt → higher score (inverted ramp)
    f.freeCashflow == null ? null : (f.freeCashflow > 0 ? 1 : 0),
  ].filter((x) => x != null);
  return parts.length ? avg(parts) : null;
}

export function scoreValuation(f) {
  if (!f) return null;
  // No positive earnings (PE <= 0) is a valuation risk, not a freebie: neutral-low.
  const peScore = f.trailingPE == null ? null : (f.trailingPE <= 0 ? 0.3 : ramp(f.trailingPE, 60, 5));
  const pegScore = ramp(f.pegRatio, 3, 0.5);
  const parts = [peScore, pegScore].filter((x) => x != null);
  return parts.length ? avg(parts) : null;
}

const RatingScore = {
  strong_buy: 1, buy: 0.75, outperform: 0.7, hold: 0.5, neutral: 0.5,
  underperform: 0.3, sell: 0.25, strong_sell: 0,
};

export function scoreAnalyst(f, livePrice) {
  if (!f || !f.numberOfAnalystOpinions) return null;
  const parts = [];
  if (f.recommendationKey && RatingScore[f.recommendationKey] != null) {
    parts.push(RatingScore[f.recommendationKey]);
  }
  if (f.targetMeanPrice && livePrice) {
    const upside = (f.targetMeanPrice - livePrice) / livePrice;
    parts.push(ramp(upside, -0.2, 0.5)); // -20%..+50% target upside → [0,1]
  }
  return parts.length ? avg(parts) : null;
}

export function computeQuality({ fundamentals, analyst, moat, livePrice, weights = DefaultWeights }) {
  const subScores = {
    fundamentals: scoreFundamentals(fundamentals),
    valuation: scoreValuation(fundamentals),
    analyst: scoreAnalyst(analyst, livePrice),
    moat: moat == null ? null : clamp01(moat),
  };
  const flags = [];
  let blend = 0;
  for (const key of Object.keys(weights)) {
    const s = subScores[key];
    if (s == null) flags.push(`quality:${key}-missing`);
    blend += weights[key] * (s == null ? NeutralSub : s);
  }
  return { qualityMult: QualityFloor + clamp01(blend), subScores, flags };
}
