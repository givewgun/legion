// Pure position-sizing engine, shared by the real-holdings book and the live
// paper book. targetWeight = clamp(baseWeight × conviction × qualityMult, 0,
// maxPerName) for long signals; SELL / NO_CONSENSUS / no-signal → target 0.
// No I/O — callers pass signals, quality, positions, and live prices.

export const BAND_LONG = new Set(['BUY', 'STRONG_BUY']);

const DefaultConfig = { baseWeight: 0.05, maxPerName: 0.10, rebalanceBandPct: 0.01 };
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

export function computeSizing({ signal, qualityMult, position, livePrice, portfolioValue, config = DefaultConfig, priceStale = false }) {
  const { baseWeight, maxPerName, rebalanceBandPct } = { ...DefaultConfig, ...config };
  const shares = position?.shares ?? 0;
  const avgCost = position?.avgCost ?? 0;
  const price = Number(livePrice) || 0;
  const flags = [];
  if (priceStale || !price) flags.push('sizing:stale-price');

  const band = signal?.band ?? 'NO_CONSENSUS';
  const conviction = Number(signal?.conviction ?? 0);
  const isLong = BAND_LONG.has(band) && conviction > 0;
  const targetWeight = isLong ? clamp(baseWeight * conviction * qualityMult, 0, maxPerName) : 0;

  const marketValue = shares * price;
  const currentWeight = portfolioValue > 0 ? marketValue / portfolioValue : 0;
  const deltaUSD = (targetWeight - currentWeight) * portfolioValue;
  const deltaShares = price > 0 ? deltaUSD / price : 0;
  const unrealizedPnl = (price - avgCost) * shares;
  const cost = avgCost * shares;
  const unrealizedPnlPct = cost > 0 ? unrealizedPnl / cost : 0;

  let action = 'hold';
  if (portfolioValue > 0 && Math.abs(deltaUSD) >= rebalanceBandPct * portfolioValue) {
    action = deltaUSD > 0 ? 'buy' : 'trim';
  }

  return {
    ticker: signal?.symbol ?? position?.ticker ?? null,
    band, conviction, qualityMult,
    currentWeight, targetWeight, marketValue,
    deltaUSD, deltaShares, action,
    unrealizedPnl, unrealizedPnlPct, flags,
  };
}

export function buildSizingBook({ holdings, signalsBySymbol, qualityBySymbol, pricesBySymbol, config = DefaultConfig }) {
  const priceOf = (t) => Number(pricesBySymbol[t]?.price) || 0;
  const totalValue = holdings.reduce((s, h) => s + h.shares * priceOf(h.ticker), 0);
  const totalCost = holdings.reduce((s, h) => s + h.shares * h.avgCost, 0);

  const rows = holdings.map((h) => {
    const q = qualityBySymbol[h.ticker] ?? { qualityMult: 1, flags: ['quality:missing'] };
    const price = pricesBySymbol[h.ticker]?.price;
    const row = computeSizing({
      signal: signalsBySymbol[h.ticker] ?? null,
      qualityMult: q.qualityMult,
      position: { shares: h.shares, avgCost: h.avgCost, ticker: h.ticker },
      livePrice: price,
      portfolioValue: totalValue,
      config,
      priceStale: price == null,
    });
    row.ticker = h.ticker;
    row.flags = [...row.flags, ...(q.flags ?? [])];
    return row;
  });

  const targetInvestedPct = rows.reduce((s, r) => s + r.targetWeight, 0);
  return {
    rows,
    summary: { totalValue, totalCost, unrealizedPnl: totalValue - totalCost, targetInvestedPct },
  };
}
