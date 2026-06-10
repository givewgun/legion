// Risk inputs: the day's move (chasing risk) + macro fear gauge (VIX) + the
// ticker's own realized daily volatility, so the outsized-move trip is relative
// to how this name actually trades (ADR 0022).

// Trailing daily candles used for the sigma estimate (~a trading month).
const SigmaWindowDays = 30;

// Std-dev (%) of trailing daily log returns. Null when history is too thin —
// computeConstraint then falls back to its absolute threshold.
export function dailySigmaPct(candles) {
  const closes = (candles ?? []).map((c) => c.close).filter((c) => c > 0);
  if (closes.length < 5) return null;
  const rets = closes.slice(1).map((c, i) => Math.log(c / closes[i]));
  const mu = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mu) ** 2, 0) / rets.length;
  return Math.sqrt(variance) * 100;
}

export async function gatherRisk(gunvest, symbol) {
  const sym = symbol.toUpperCase();
  const [price, macro, candles] = await Promise.all([
    gunvest.getPrice(sym),
    gunvest.getMacro(),
    // Vol is an enhancement, not a requirement: degrade to the absolute
    // threshold rather than failing the whole constraint.
    gunvest.getCandles?.(sym, SigmaWindowDays).catch(() => null) ?? null,
  ]);
  return {
    changePercent: price?.changePercent,
    vix: macro?.vix,
    dailySigmaPct: dailySigmaPct(candles),
  };
}
