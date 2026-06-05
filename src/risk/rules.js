// Deterministic risk rules. Returns the tightest applicable conviction cap and
// whether new longs are blocked, with a human-readable reason. Pure function —
// no LLM, fully unit-testable.
const VIX_ELEVATED = 30;
const VIX_EXTREME = 40;
const OUTSIZED_MOVE_PCT = 8;

export function computeConstraint(data) {
  const vix = Number(data.vix ?? 0);
  const move = Math.abs(Number(data.changePercent ?? 0));
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
  if (move >= OUTSIZED_MOVE_PCT) {
    caps.push(0.4);
    reasons.push(`outsized daily move ${move}%`);
  }

  return {
    capConviction: caps.length ? Math.min(...caps) : 1,
    blockBuy,
    reason: reasons.join('; ') || 'no risk flags',
  };
}
