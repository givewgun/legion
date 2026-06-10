// Deterministic risk rules. Returns the tightest applicable conviction cap and
// whether new longs are blocked, with a human-readable reason. Pure function —
// no LLM, fully unit-testable.
const VIX_ELEVATED = 30;
const VIX_EXTREME = 40;
// Vol-normalized "outsized move" trip: a daily move beyond this many sigmas of
// the ticker's own realized daily volatility is chasing risk. A flat percentage
// mis-prices both tails — 8% is a five-sigma event in a utility and noise in a
// meme stock (ADR 0022).
const OUTSIZED_SIGMA = 3;
// Fallback when no per-ticker volatility is available (feed failure, thin
// history): the original absolute threshold.
const OUTSIZED_MOVE_PCT = 8;

export function computeConstraint(data) {
  const vix = Number(data.vix ?? 0);
  const move = Math.abs(Number(data.changePercent ?? 0));
  const dailySigma = Number(data.dailySigmaPct ?? 0);
  const caps = [];
  const reasons = [];
  let blockBuy = false;

  if (vix >= VIX_ELEVATED) {
    caps.push(0.5);
    reasons.push(`elevated VIX ${vix}`);
  }
  if (vix >= VIX_EXTREME) {
    blockBuy = true;
    reasons.push(`extreme VIX ${vix} blocks new longs`);
  }
  if (dailySigma > 0) {
    if (move >= OUTSIZED_SIGMA * dailySigma) {
      caps.push(0.4);
      reasons.push(
        `outsized daily move ${move}% (≥ ${OUTSIZED_SIGMA}σ of this name's ${dailySigma.toFixed(2)}% daily vol)`,
      );
    }
  } else if (move >= OUTSIZED_MOVE_PCT) {
    caps.push(0.4);
    reasons.push(`outsized daily move ${move}%`);
  }

  return {
    capConviction: caps.length ? Math.min(...caps) : 1,
    blockBuy,
    reason: reasons.join('; ') || 'no risk flags',
  };
}
