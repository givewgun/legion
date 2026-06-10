// Market-regime classification for conditional reliability (ADR 0023). A single
// unconditional ρ averages away an agent's actual edge: the Contrarian is most
// valuable at crowded extremes, Technical in orderly tape. Two coarse buckets
// (VIX above/below 20) keep per-bucket samples dense enough to learn from.
const VIX_STRESSED = 20;

// Regimes the learner builds buckets for; 'unknown' (VIX unavailable) is never
// bucketed and always falls back to the unconditional dials.
export const REGIMES = ['calm', 'stressed'];

export function classifyRegime(vix) {
  const v = Number(vix);
  if (vix == null || Number.isNaN(v)) return 'unknown';
  return v >= VIX_STRESSED ? 'stressed' : 'calm';
}
